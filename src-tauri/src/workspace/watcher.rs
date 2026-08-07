//! Debounced workspace file watcher.
//!
//! Emits `workspace:changed` with the affected workspace-relative paths so the
//! frontend can reload previews and surface external-edit conflicts. Nothing is
//! reloaded automatically over unsaved editor content.

use std::path::Path;
use std::time::Duration;

use notify::event::{AccessKind, AccessMode, EventKind};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::security::{is_hidden_name, paths, APP_DIR};

pub struct WatcherHandle {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub paths: Vec<String>,
}

pub fn watch<R: Runtime>(app: AppHandle<R>, root: &Path) -> Option<WatcherHandle> {
    let root = root.to_path_buf();
    let emit_root = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut changed: Vec<String> = Vec::new();
            for event in events {
                if !is_content_change(event.kind) {
                    continue;
                }
                for path in &event.paths {
                    if is_ignored(&emit_root, path) {
                        continue;
                    }
                    if let Some(relative) = paths::relativize(&emit_root, path) {
                        if !changed.contains(&relative) {
                            changed.push(relative);
                        }
                    }
                }
            }
            if !changed.is_empty() {
                let _ = app.emit("workspace:changed", ChangeEvent { paths: changed });
            }
        },
    )
    .ok()?;

    debouncer.watch(&root, RecursiveMode::Recursive).ok()?;
    Some(WatcherHandle {
        _debouncer: debouncer,
    })
}

/// True for events that can have altered what a file contains.
///
/// Reads must be excluded: the inotify backend also reports opens, so a file the
/// app reads itself would come back as changed, and re-reading it to answer that
/// would report it again — a loop that never settles. `IN_CLOSE_WRITE` arrives as
/// an access event but does follow a write, so it stays.
fn is_content_change(kind: EventKind) -> bool {
    match kind {
        EventKind::Access(access) => {
            matches!(access, AccessKind::Close(AccessMode::Write))
        }
        EventKind::Other => false,
        _ => true,
    }
}

/// Ignore `.app`, hidden files and the temporary files produced by atomic writes.
fn is_ignored(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    relative.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        name == APP_DIR || is_hidden_name(&name) || name.ends_with(".tmp")
    })
}

#[cfg(test)]
mod tests {
    use super::{is_content_change, is_ignored};
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, EventKind, MetadataKind, ModifyKind,
        RemoveKind,
    };
    use std::path::Path;

    #[test]
    fn reads_are_not_changes() {
        assert!(!is_content_change(EventKind::Access(AccessKind::Open(
            AccessMode::Any
        ))));
        assert!(!is_content_change(EventKind::Access(AccessKind::Read)));
        assert!(!is_content_change(EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!is_content_change(EventKind::Other));
    }

    #[test]
    fn writes_are_changes() {
        assert!(is_content_change(EventKind::Create(CreateKind::File)));
        assert!(is_content_change(EventKind::Modify(ModifyKind::Data(
            DataChange::Any
        ))));
        assert!(is_content_change(EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::Any
        ))));
        assert!(is_content_change(EventKind::Remove(RemoveKind::File)));
        assert!(is_content_change(EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
    }

    #[test]
    fn app_data_and_hidden_paths_are_ignored() {
        let root = Path::new("/ws");
        assert!(is_ignored(root, Path::new("/ws/.app/thumbnails/a.png")));
        assert!(is_ignored(root, Path::new("/ws/Notes/.hidden.md")));
        assert!(is_ignored(root, Path::new("/ws/Notes/A.md.1234.tmp")));
        assert!(is_ignored(root, Path::new("/elsewhere/A.md")));
        assert!(!is_ignored(root, Path::new("/ws/Notes/A.md")));
    }
}

/// The watcher against a real directory, reporting to a real listener.
///
/// The rules above are about single events; these are about what the application
/// is told, which is where a loop or a missed change actually shows up.
#[cfg(test)]
mod watching {
    use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
    use std::time::{Duration, Instant};

    use serde_json::json;
    use tauri::Listener;

    use crate::test_support::TestApp;

    /// Long enough for the debounce plus a slow or busy machine.
    const REPORTED: Duration = Duration::from_secs(10);
    /// Long enough that an event which was going to arrive would have.
    const QUIET: Duration = Duration::from_secs(2);

    struct Changes {
        events: Receiver<String>,
    }

    impl Changes {
        fn of(app: &TestApp) -> Self {
            let (sender, events) = channel();
            app.app.listen("workspace:changed", move |event| {
                let _ = sender.send(event.payload().to_string());
            });
            Changes { events }
        }

        /// A change to `path` is reported, whether or not it arrives first.
        ///
        /// What else the watcher mentions along the way is not this test's
        /// business: a platform is free to report the directory holding a file
        /// as well as the file, in either order, and on Windows it does. That
        /// nothing spurious is reported is what [`Changes::nothing`] covers.
        fn reports(&self, path: &str) {
            let deadline = Instant::now() + REPORTED;
            let mut seen: Vec<String> = Vec::new();
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match self.events.recv_timeout(left) {
                    Ok(payload) if payload.contains(path) => return,
                    Ok(payload) => seen.push(payload),
                    Err(_) => break,
                }
            }
            panic!("{path} was not reported, only {seen:?}");
        }

        /// Nothing at all is reported for as long as anything would have been.
        fn nothing(&self) {
            match self.events.recv_timeout(QUIET) {
                Err(RecvTimeoutError::Timeout) => (),
                Ok(payload) => panic!("reported {payload}"),
                Err(other) => panic!("{other}"),
            }
        }

        /// Wait until the watcher has stopped talking about earlier work.
        fn settle(&self) {
            while self.events.recv_timeout(Duration::from_secs(1)).is_ok() {}
        }
    }

    #[test]
    fn a_file_changed_outside_the_application_is_reported() {
        let app = TestApp::opened();
        let changes = Changes::of(&app);

        std::fs::write(app.path("Notes/note.md"), b"# Changed elsewhere\n").unwrap();
        changes.reports("Notes/note.md");
    }

    #[test]
    fn a_new_file_and_a_deleted_one_are_both_reported() {
        let app = TestApp::opened();
        let changes = Changes::of(&app);

        std::fs::write(app.path("Notes/added.md"), b"# Added\n").unwrap();
        changes.reports("Notes/added.md");

        // Without this the create's report would answer for the delete's.
        changes.settle();
        std::fs::remove_file(app.path("Notes/added.md")).unwrap();
        changes.reports("Notes/added.md");
    }

    /// The loop this guards against: the inotify backend reports opens as well as
    /// writes, so a file the application read itself came back as changed, and
    /// re-reading it to answer that reported it again, forever.
    #[test]
    fn reading_a_file_through_a_command_is_not_a_change() {
        let app = TestApp::opened();
        let changes = Changes::of(&app);
        changes.settle();

        for _ in 0..3 {
            app.call("document_read", json!({ "relativePath": "Notes/note.md" }));
            app.call("file_facts", json!({ "relativePath": "Notes/note.md" }));
            app.call(
                "media_probe",
                json!({ "relativePath": "Attachments/tiny.mp3" }),
            );
        }
        changes.nothing();
    }

    /// Caches and settings are the application's own business, and reporting them
    /// would make every thumbnail look like an edit by the user.
    #[test]
    fn the_applications_own_state_is_not_a_change() {
        let app = TestApp::opened();
        let changes = Changes::of(&app);
        changes.settle();

        app.call(
            "thumbnail_request",
            json!({ "relativePath": "Attachments/wide.png" }),
        );
        app.call(
            "workspace_settings_write",
            json!({ "settings": {
                "lastCanvas": "Canvases/Main.canvas", "viewports": {},
                "authorizedExternalPaths": [], "ui": {},
            }}),
        );
        app.call(
            "recovery_write",
            json!({
                "relativePath": "Notes/note.md",
                "contents": "# Draft\n",
                "baseRevision": "",
            }),
        );
        changes.nothing();
    }
}

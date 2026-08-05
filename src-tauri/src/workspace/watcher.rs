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

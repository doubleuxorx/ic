//! Debounced workspace file watcher.
//!
//! Emits `workspace:changed` with the affected workspace-relative paths so the
//! frontend can reload previews and surface external-edit conflicts. Nothing is
//! reloaded automatically over unsaved editor content.

use std::path::Path;
use std::time::Duration;

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

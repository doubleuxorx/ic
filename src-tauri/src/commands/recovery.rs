//! Crash-recovery copies of unsaved editor content.
//!
//! Recovery files live in `.app/recovery` and are keyed by a hash of the
//! document path. They are never the source of truth: on startup the frontend
//! offers them for comparison and discards them once the user decides.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::security::{sanitize_relative, SecurityError};
use crate::workspace::{WorkspaceState, RECOVERY_DIR};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub relative_path: String,
    pub contents: String,
    /// Revision the editor was based on when the draft was captured.
    pub base_revision: String,
    pub saved_at_ms: u64,
}

fn recovery_file(relative: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative.as_bytes());
    format!("{RECOVERY_DIR}/{:x}.json", hasher.finalize())
}

#[tauri::command]
pub fn recovery_write(
    state: State<'_, WorkspaceState>,
    relative_path: String,
    contents: String,
    base_revision: String,
) -> Result<(), SecurityError> {
    let document = sanitize_relative(&relative_path)?;
    let record = RecoveryRecord {
        relative_path: document.clone(),
        contents,
        base_revision,
        saved_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let target = state.resolve(&recovery_file(&document))?;
    let json = serde_json::to_string(&record).map_err(|err| SecurityError::Io(err.to_string()))?;
    crate::persistence::write_atomic(&target.absolute, json.as_bytes())
        .map_err(|err| SecurityError::Io(err.to_string()))
}

#[tauri::command]
pub fn recovery_list(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<RecoveryRecord>, SecurityError> {
    let root = state.root()?;
    let dir = root.join(RECOVERY_DIR);
    let mut records = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(records);
    };
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(entry.path()) {
            if let Ok(record) = serde_json::from_str::<RecoveryRecord>(&text) {
                records.push(record);
            }
        }
    }
    records.sort_by_key(|record| std::cmp::Reverse(record.saved_at_ms));
    Ok(records)
}

#[tauri::command]
pub fn recovery_clear(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<(), SecurityError> {
    let document = sanitize_relative(&relative_path)?;
    let target = state.resolve(&recovery_file(&document))?;
    match std::fs::remove_file(&target.absolute) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

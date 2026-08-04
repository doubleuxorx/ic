//! Atomic persistence and revision tracking.
//!
//! A write never truncates the target in place: content goes to a temporary
//! file in the same directory, is flushed, and then replaces the target with a
//! rename. If the rename fails the temporary file is left behind so the content
//! is recoverable.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::security::SecurityError;

/// Identifies the exact bytes a caller last saw. Empty string means "the file
/// did not exist".
pub type Revision = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentContent {
    pub relative_path: String,
    pub contents: String,
    pub revision: Revision,
    pub modified_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum PersistenceError {
    #[error("the file changed on disk since it was loaded")]
    RevisionMismatch {
        current_revision: Revision,
        current_contents: String,
    },
    #[error("file is not valid UTF-8 text")]
    NotUtf8,
    #[error("file exceeds the maximum supported size of {0} bytes")]
    TooLarge(u64),
    #[error(transparent)]
    Security(#[from] SecurityError),
    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for PersistenceError {
    fn from(value: std::io::Error) -> Self {
        PersistenceError::Io(value.to_string())
    }
}

impl serde::Serialize for PersistenceError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(4))?;
        match self {
            PersistenceError::RevisionMismatch {
                current_revision,
                current_contents,
            } => {
                map.serialize_entry("kind", "revision-mismatch")?;
                map.serialize_entry("message", &self.to_string())?;
                map.serialize_entry("currentRevision", current_revision)?;
                map.serialize_entry("currentContents", current_contents)?;
            }
            other => {
                map.serialize_entry("kind", "error")?;
                map.serialize_entry("message", &other.to_string())?;
            }
        }
        map.end()
    }
}

/// Text documents are bounded so a hostile or accidental huge file cannot
/// exhaust memory through the IPC boundary.
pub const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;

pub fn revision_of_bytes(bytes: &[u8]) -> Revision {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn read_text(path: &Path) -> Result<(String, Revision), PersistenceError> {
    let meta = fs::metadata(path)?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(PersistenceError::TooLarge(MAX_TEXT_BYTES));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    File::open(path)?.read_to_end(&mut bytes)?;
    let revision = revision_of_bytes(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| PersistenceError::NotUtf8)?;
    Ok((text, revision))
}

/// Current revision of a path, or the empty string when it does not exist.
pub fn current_revision(path: &Path) -> Result<Revision, PersistenceError> {
    match fs::read(path) {
        Ok(bytes) => Ok(revision_of_bytes(&bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(err.into()),
    }
}

/// Write `contents` to `path`, refusing when the file changed underneath the
/// caller. Pass `expected` as an empty string to create a new file.
pub fn write_text_checked(
    path: &Path,
    contents: &str,
    expected: &Revision,
) -> Result<Revision, PersistenceError> {
    let current = current_revision(path)?;
    if &current != expected {
        let current_contents = if current.is_empty() {
            String::new()
        } else {
            read_text(path).map(|(text, _)| text).unwrap_or_default()
        };
        return Err(PersistenceError::RevisionMismatch {
            current_revision: current,
            current_contents,
        });
    }
    write_atomic(path, contents.as_bytes())?;
    Ok(revision_of_bytes(contents.as_bytes()))
}

/// Atomic replace: temp file in the same directory, flush, fsync, rename,
/// then fsync the directory so the rename itself is durable.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), PersistenceError> {
    let parent = path
        .parent()
        .ok_or_else(|| PersistenceError::Io("path has no parent directory".into()))?;
    fs::create_dir_all(parent)?;

    let temp = temp_sibling(path);
    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
    }

    #[cfg(windows)]
    let rename = {
        // ReplaceFile semantics: remove the target first if a plain rename is
        // refused, keeping the temp file intact on failure.
        fs::rename(&temp, path).or_else(|err| {
            if path.exists() {
                fs::remove_file(path)?;
                fs::rename(&temp, path)
            } else {
                Err(err)
            }
        })
    };
    #[cfg(not(windows))]
    let rename = fs::rename(&temp, path);

    if let Err(err) = rename {
        // Leave the temporary file: the content is still recoverable and the
        // previous version of the target is untouched.
        return Err(PersistenceError::Io(format!(
            "atomic replace failed, content preserved at {}: {err}",
            temp.display()
        )));
    }

    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".to_string());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let unique = format!(".{name}.{stamp}.{}.tmp", std::process::id());
    path.with_file_name(unique)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let rev = write_text_checked(&path, "hello", &String::new()).unwrap();
        let (text, read_rev) = read_text(&path).unwrap();
        assert_eq!(text, "hello");
        assert_eq!(read_rev, rev);

        let next = write_text_checked(&path, "hello world", &rev).unwrap();
        assert_ne!(next, rev);
    }

    #[test]
    fn detects_external_modification() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let rev = write_text_checked(&path, "one", &String::new()).unwrap();
        fs::write(&path, "changed outside").unwrap();

        let err = write_text_checked(&path, "two", &rev).unwrap_err();
        match err {
            PersistenceError::RevisionMismatch {
                current_contents, ..
            } => assert_eq!(current_contents, "changed outside"),
            other => panic!("unexpected error: {other:?}"),
        }
        // The external content survived the refused write.
        assert_eq!(fs::read_to_string(&path).unwrap(), "changed outside");
    }

    #[test]
    fn refuses_to_create_over_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write_text_checked(&path, "one", &String::new()).unwrap();
        assert!(write_text_checked(&path, "two", &String::new()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "one");
    }

    #[test]
    fn leaves_no_temp_files_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write_text_checked(&path, "content", &String::new()).unwrap();
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["note.md".to_string()]);
    }
}

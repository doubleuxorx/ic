//! Security policy: every privileged operation resolves its inputs here first.
//!
//! Invariants enforced by this module:
//!   * A relative path never escapes the workspace root.
//!   * Symlinks are never followed outside the workspace unless the user
//!     explicitly authorized the resolved target.
//!   * File kinds used for rendering decisions are derived from content, not
//!     from the extension alone.

pub mod kinds;
pub mod paths;

pub use kinds::{detect_kind, kind_for_extension, FileKind};
pub use paths::{resolve_in_workspace, sanitize_relative, ResolvedPath, SymlinkPolicy};

use std::fmt;

#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    #[error("path is empty")]
    EmptyPath,
    #[error("absolute paths are not accepted")]
    AbsolutePath,
    #[error("path escapes the workspace")]
    Traversal,
    #[error("path component is not permitted: {0}")]
    BadComponent(String),
    #[error("symlink target lies outside the workspace and is not authorized")]
    UnauthorizedSymlink,
    #[error("no workspace is open")]
    NoWorkspace,
    #[error("file type is not supported: {0}")]
    UnsupportedFile(String),
    #[error("path does not exist")]
    NotFound,
    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for SecurityError {
    fn from(value: std::io::Error) -> Self {
        match value.kind() {
            std::io::ErrorKind::NotFound => SecurityError::NotFound,
            _ => SecurityError::Io(value.to_string()),
        }
    }
}

impl serde::Serialize for SecurityError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Directory holding rebuildable caches, recovery data and settings.
pub const APP_DIR: &str = ".app";

/// Names that are never exposed through directory listings.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteScope {
    /// Canonical user content: markdown and canvas files.
    Document,
    /// Rebuildable data below `.app`.
    AppData,
}

impl fmt::Display for WriteScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteScope::Document => write!(f, "document"),
            WriteScope::AppData => write!(f, "app-data"),
        }
    }
}

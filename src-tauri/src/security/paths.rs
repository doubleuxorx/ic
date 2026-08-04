//! Workspace-relative path resolution.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use super::SecurityError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymlinkPolicy {
    /// Default: a symlink resolving outside the workspace is rejected.
    RejectExternal,
    /// The resolved target was explicitly authorized by the user.
    AllowAuthorized,
}

#[derive(Debug, Clone)]
pub struct ResolvedPath {
    /// Path relative to the workspace root, always `/`-separated.
    pub relative: String,
    /// Absolute path on disk. Canonicalized when the file exists.
    pub absolute: PathBuf,
    /// True when resolution crossed a symlink pointing outside the workspace.
    pub external: bool,
}

/// Normalize a caller-supplied relative path without touching the filesystem.
///
/// Rejects absolute paths, drive prefixes, parent traversal and NUL bytes.
/// `.` components are dropped. The result uses `/` separators.
pub fn sanitize_relative(input: &str) -> Result<String, SecurityError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(SecurityError::EmptyPath);
    }
    if trimmed.contains('\0') {
        return Err(SecurityError::BadComponent("NUL".into()));
    }
    // Treat both separators as separators regardless of host platform so that a
    // Windows-style path cannot smuggle a component past the checks below.
    let unified = trimmed.replace('\\', "/");
    if unified.starts_with('/') {
        return Err(SecurityError::AbsolutePath);
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(SecurityError::Traversal),
            other => {
                if other.contains(':') {
                    // Drive letters and NTFS alternate data streams.
                    return Err(SecurityError::BadComponent(other.to_string()));
                }
                if other.chars().all(|c| c == '.') {
                    return Err(SecurityError::BadComponent(other.to_string()));
                }
                parts.push(other);
            }
        }
    }
    if parts.is_empty() {
        return Err(SecurityError::EmptyPath);
    }
    Ok(parts.join("/"))
}

/// Resolve a workspace-relative path to an absolute path under `root`.
///
/// `root` must already be canonicalized. Existing paths are canonicalized so
/// that symlinks are resolved before the containment check; paths that do not
/// exist yet are checked against their canonicalized nearest existing parent so
/// that new files can be created without weakening the check.
pub fn resolve_in_workspace(
    root: &Path,
    relative: &str,
    policy: SymlinkPolicy,
    authorized: &BTreeSet<PathBuf>,
) -> Result<ResolvedPath, SecurityError> {
    let relative = sanitize_relative(relative)?;
    let candidate = root.join(&relative);

    // Defence in depth: joining must not have introduced traversal.
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(SecurityError::Traversal);
    }

    let (existing, missing_tail) = nearest_existing(&candidate);
    let real_existing = std::fs::canonicalize(&existing)?;
    let inside = real_existing.starts_with(root);

    let external = if inside {
        false
    } else {
        match policy {
            SymlinkPolicy::AllowAuthorized if is_authorized(&real_existing, authorized) => true,
            _ => return Err(SecurityError::UnauthorizedSymlink),
        }
    };

    let absolute = if missing_tail.as_os_str().is_empty() {
        real_existing
    } else {
        real_existing.join(&missing_tail)
    };

    Ok(ResolvedPath {
        relative,
        absolute,
        external,
    })
}

fn is_authorized(path: &Path, authorized: &BTreeSet<PathBuf>) -> bool {
    authorized.iter().any(|allowed| path.starts_with(allowed))
}

/// Split `path` into its deepest existing ancestor and the remaining tail.
fn nearest_existing(path: &Path) -> (PathBuf, PathBuf) {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut tail_path = PathBuf::new();
    for part in tail.iter().rev() {
        tail_path.push(part);
    }
    (existing, tail_path)
}

/// Convert an absolute path back to a workspace-relative path when possible.
pub fn relativize(root: &Path, absolute: &Path) -> Option<String> {
    absolute.strip_prefix(root).ok().map(|rel| {
        rel.components()
            .filter_map(|c| match c {
                Component::Normal(part) => Some(part.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal() {
        assert!(matches!(
            sanitize_relative("../secret"),
            Err(SecurityError::Traversal)
        ));
        assert!(matches!(
            sanitize_relative("Notes/../../etc/passwd"),
            Err(SecurityError::Traversal)
        ));
        assert!(matches!(
            sanitize_relative("Notes\\..\\..\\etc"),
            Err(SecurityError::Traversal)
        ));
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        assert!(matches!(
            sanitize_relative("/etc/passwd"),
            Err(SecurityError::AbsolutePath)
        ));
        assert!(matches!(
            sanitize_relative("\\\\server\\share"),
            Err(SecurityError::AbsolutePath)
        ));
        assert!(matches!(
            sanitize_relative("C:/Windows"),
            Err(SecurityError::BadComponent(_))
        ));
        assert!(matches!(
            sanitize_relative("note.md:stream"),
            Err(SecurityError::BadComponent(_))
        ));
    }

    #[test]
    fn normalizes_ordinary_paths() {
        assert_eq!(sanitize_relative("./Notes/./A.md").unwrap(), "Notes/A.md");
        assert_eq!(sanitize_relative("Notes\\A.md").unwrap(), "Notes/A.md");
    }

    #[test]
    fn resolves_new_file_under_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(root.join("Notes")).unwrap();
        let resolved = resolve_in_workspace(
            &root,
            "Notes/New.md",
            SymlinkPolicy::RejectExternal,
            &BTreeSet::new(),
        )
        .unwrap();
        assert_eq!(resolved.relative, "Notes/New.md");
        assert_eq!(resolved.absolute, root.join("Notes/New.md"));
        assert!(!resolved.external);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escaping_workspace() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), b"secret").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), root.join("link.md")).unwrap();

        let err = resolve_in_workspace(
            &root,
            "link.md",
            SymlinkPolicy::RejectExternal,
            &BTreeSet::new(),
        )
        .unwrap_err();
        assert!(matches!(err, SecurityError::UnauthorizedSymlink));

        let mut authorized = BTreeSet::new();
        authorized.insert(std::fs::canonicalize(outside.path()).unwrap());
        let ok = resolve_in_workspace(
            &root,
            "link.md",
            SymlinkPolicy::AllowAuthorized,
            &authorized,
        )
        .unwrap();
        assert!(ok.external);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_directory_symlink_traversal() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(outside.path().join("data")).unwrap();
        std::fs::write(outside.path().join("data/secret.md"), b"secret").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::os::unix::fs::symlink(outside.path().join("data"), root.join("data")).unwrap();

        let err = resolve_in_workspace(
            &root,
            "data/secret.md",
            SymlinkPolicy::RejectExternal,
            &BTreeSet::new(),
        )
        .unwrap_err();
        assert!(matches!(err, SecurityError::UnauthorizedSymlink));
    }
}

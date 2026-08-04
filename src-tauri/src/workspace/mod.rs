//! Workspace state: the single open directory and everything derived from it.

pub mod watcher;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::security::{
    self, detect_kind, kind_for_extension, paths, FileKind, ResolvedPath, SecurityError,
    SymlinkPolicy, APP_DIR,
};

/// Directories created on demand inside `.app`.
pub const RECOVERY_DIR: &str = ".app/recovery";
pub const THUMBNAIL_DIR: &str = ".app/thumbnails";
pub const MEDIA_CACHE_DIR: &str = ".app/media-cache";
pub const SETTINGS_FILE: &str = ".app/workspace-settings.json";

/// Directory listings are bounded so a pathological tree cannot hang the UI.
const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: usize = 12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub relative_path: String,
    pub is_directory: bool,
    pub kind: FileKind,
    pub size: u64,
    pub modified_ms: u64,
    /// Present for directories only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceSettings {
    /// Last active canvas, workspace-relative.
    pub last_canvas: Option<String>,
    /// Viewport per canvas path. Kept out of `.canvas` files deliberately.
    pub viewports: serde_json::Map<String, serde_json::Value>,
    /// Symlink targets outside the workspace the user authorized.
    pub authorized_external_paths: Vec<String>,
    /// Free-form UI preferences owned by the frontend.
    pub ui: serde_json::Map<String, serde_json::Value>,
}

pub struct Workspace {
    pub root: PathBuf,
    pub authorized: BTreeSet<PathBuf>,
    pub watcher: Option<watcher::WatcherHandle>,
}

#[derive(Default)]
pub struct WorkspaceState(pub Mutex<Option<Workspace>>);

impl WorkspaceState {
    /// Run `f` with the open workspace, or fail when none is open.
    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut Workspace) -> Result<T, SecurityError>,
    ) -> Result<T, SecurityError> {
        let mut guard = self.0.lock().map_err(|_| SecurityError::NoWorkspace)?;
        let workspace = guard.as_mut().ok_or(SecurityError::NoWorkspace)?;
        f(workspace)
    }

    pub fn root(&self) -> Result<PathBuf, SecurityError> {
        self.with(|w| Ok(w.root.clone()))
    }

    /// Resolve a workspace-relative path under the current workspace.
    pub fn resolve(&self, relative: &str) -> Result<ResolvedPath, SecurityError> {
        self.with(|w| {
            paths::resolve_in_workspace(
                &w.root,
                relative,
                SymlinkPolicy::AllowAuthorized,
                &w.authorized,
            )
        })
    }
}

impl Workspace {
    pub fn open(root: &Path) -> Result<Self, SecurityError> {
        let root = std::fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(SecurityError::NotFound);
        }
        let mut workspace = Workspace {
            root,
            authorized: BTreeSet::new(),
            watcher: None,
        };
        let settings = workspace.read_settings().unwrap_or_default();
        for allowed in &settings.authorized_external_paths {
            if let Ok(path) = std::fs::canonicalize(allowed) {
                workspace.authorized.insert(path);
            }
        }
        Ok(workspace)
    }

    pub fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            root: self.root.to_string_lossy().to_string(),
            name: self
                .root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| self.root.to_string_lossy().to_string()),
        }
    }

    pub fn settings_path(&self) -> PathBuf {
        self.root.join(SETTINGS_FILE)
    }

    pub fn read_settings(&self) -> Result<WorkspaceSettings, SecurityError> {
        let path = self.settings_path();
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(WorkspaceSettings::default())
            }
            Err(err) => Err(err.into()),
        }
    }

    pub fn write_settings(&self, settings: &WorkspaceSettings) -> Result<(), SecurityError> {
        let text = serde_json::to_string_pretty(settings)
            .map_err(|err| SecurityError::Io(err.to_string()))?;
        crate::persistence::write_atomic(&self.settings_path(), text.as_bytes())
            .map_err(|err| SecurityError::Io(err.to_string()))
    }

    /// Recursive listing of supported files, skipping `.app` and hidden names.
    pub fn tree(&self) -> Result<Vec<FileEntry>, SecurityError> {
        let mut budget = MAX_ENTRIES;
        list_dir(&self.root, &self.root, 0, &mut budget)
    }
}

fn list_dir(
    root: &Path,
    dir: &Path,
    depth: usize,
    budget: &mut usize,
) -> Result<Vec<FileEntry>, SecurityError> {
    if depth > MAX_DEPTH || *budget == 0 {
        return Ok(Vec::new());
    }
    let mut entries: Vec<FileEntry> = Vec::new();
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        Err(_) => return Ok(entries),
    };
    for entry in read.flatten() {
        if *budget == 0 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if security::is_hidden_name(&name) || name == APP_DIR {
            continue;
        }
        let path = entry.path();
        // Never descend through a symlink while building the tree.
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let Some(relative) = paths::relativize(root, &path) else {
            continue;
        };
        *budget -= 1;

        if meta.is_dir() {
            let children = list_dir(root, &path, depth + 1, budget)?;
            entries.push(FileEntry {
                name,
                relative_path: relative,
                is_directory: true,
                kind: FileKind::Unsupported,
                size: 0,
                modified_ms: crate::persistence::modified_ms(&path),
                children: Some(children),
            });
        } else {
            let kind = kind_for_extension(&path);
            if kind == FileKind::Unsupported {
                continue;
            }
            entries.push(FileEntry {
                name,
                relative_path: relative,
                is_directory: false,
                kind,
                size: meta.len(),
                modified_ms: crate::persistence::modified_ms(&path),
                children: None,
            });
        }
    }
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Verified metadata for a single file, including sniffed kind.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    pub relative_path: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified_ms: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub external: bool,
}

pub fn facts_for(resolved: &ResolvedPath) -> Result<FileFacts, SecurityError> {
    let meta = std::fs::metadata(&resolved.absolute)?;
    let kind = detect_kind(&resolved.absolute)?;
    let (width, height) = if kind == FileKind::Image {
        image::image_dimensions(&resolved.absolute)
            .map(|(w, h)| (Some(w), Some(h)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };
    Ok(FileFacts {
        relative_path: resolved.relative.clone(),
        kind,
        size: meta.len(),
        modified_ms: crate::persistence::modified_ms(&resolved.absolute),
        width,
        height,
        external: resolved.external,
    })
}

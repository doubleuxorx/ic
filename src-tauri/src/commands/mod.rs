//! Narrow, individually validated Tauri commands.
//!
//! There is deliberately no generic `read_any_file`, `write_any_file` or
//! `run_shell`. Every command below resolves its arguments through the security
//! module before touching the filesystem, and refuses when no workspace is open.

pub mod external;
pub mod recovery;

pub use external::{external_open_path, external_open_url, reveal_in_file_manager};
pub use recovery::{recovery_clear, recovery_list, recovery_write};

use serde::{Deserialize, Serialize};
use tauri::{Runtime, State, WebviewWindow};

use crate::media::{self, MediaProbe};
use crate::persistence::{self, DocumentContent, PersistenceError, Revision};
use crate::security::{FileKind, SecurityError};
use crate::thumbnails::{self, Thumbnail};
use crate::workspace::{
    self, FileEntry, Workspace, WorkspaceInfo, WorkspaceSettings, WorkspaceState,
};

#[tauri::command]
pub async fn workspace_open<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, WorkspaceState>,
    path: String,
) -> Result<WorkspaceInfo, SecurityError> {
    // `path` comes from the native directory picker, i.e. an explicit user
    // choice. It is still canonicalized and verified to be a directory.
    let mut workspace = Workspace::open(std::path::Path::new(&path))?;
    for dir in [
        workspace::RECOVERY_DIR,
        workspace::THUMBNAIL_DIR,
        workspace::MEDIA_CACHE_DIR,
    ] {
        let _ = std::fs::create_dir_all(workspace.root.join(dir));
    }
    workspace.watcher = crate::workspace::watcher::watch(app.clone(), &workspace.root);
    let info = workspace.info();
    *state.0.lock().map_err(|_| SecurityError::NoWorkspace)? = Some(workspace);
    Ok(info)
}

#[tauri::command]
pub fn workspace_close(state: State<'_, WorkspaceState>) -> Result<(), SecurityError> {
    *state.0.lock().map_err(|_| SecurityError::NoWorkspace)? = None;
    Ok(())
}

#[tauri::command]
pub fn workspace_tree(state: State<'_, WorkspaceState>) -> Result<Vec<FileEntry>, SecurityError> {
    state.with(|w| w.tree())
}

#[tauri::command]
pub fn workspace_create_directory(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<(), SecurityError> {
    let resolved = state.resolve(&relative_path)?;
    std::fs::create_dir_all(&resolved.absolute)?;
    Ok(())
}

#[tauri::command]
pub fn workspace_settings_read(
    state: State<'_, WorkspaceState>,
) -> Result<WorkspaceSettings, SecurityError> {
    state.with(|w| w.read_settings())
}

#[tauri::command]
pub fn workspace_settings_write(
    state: State<'_, WorkspaceState>,
    settings: WorkspaceSettings,
) -> Result<(), SecurityError> {
    state.with(|w| {
        w.write_settings(&settings)?;
        w.authorized = settings
            .authorized_external_paths
            .iter()
            .filter_map(|p| std::fs::canonicalize(p).ok())
            .collect();
        Ok(())
    })
}

/// Authorize a symlink target outside the workspace. Requires a path the user
/// chose explicitly in a native dialog.
#[tauri::command]
pub fn workspace_authorize_external(
    state: State<'_, WorkspaceState>,
    path: String,
) -> Result<Vec<String>, SecurityError> {
    let canonical = std::fs::canonicalize(&path)?;
    state.with(|w| {
        w.authorized.insert(canonical.clone());
        let mut settings = w.read_settings()?;
        let as_string = canonical.to_string_lossy().to_string();
        if !settings.authorized_external_paths.contains(&as_string) {
            settings.authorized_external_paths.push(as_string);
        }
        w.write_settings(&settings)?;
        Ok(settings.authorized_external_paths)
    })
}

#[tauri::command]
pub fn document_read(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<DocumentContent, PersistenceError> {
    let resolved = state.resolve(&relative_path)?;
    let kind = crate::security::detect_kind(&resolved.absolute)?;
    if !matches!(kind, FileKind::Markdown | FileKind::Canvas | FileKind::Text) {
        return Err(SecurityError::UnsupportedFile(resolved.relative).into());
    }
    let (contents, revision) = persistence::read_text(&resolved.absolute)?;
    Ok(DocumentContent {
        modified_ms: persistence::modified_ms(&resolved.absolute),
        relative_path: resolved.relative,
        contents,
        revision,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub relative_path: String,
    pub revision: Revision,
    pub modified_ms: u64,
}

#[tauri::command]
pub fn document_write(
    state: State<'_, WorkspaceState>,
    relative_path: String,
    expected_revision: String,
    contents: String,
) -> Result<WriteResult, PersistenceError> {
    let resolved = state.resolve(&relative_path)?;
    let kind = crate::security::kind_for_extension(&resolved.absolute);
    if !matches!(kind, FileKind::Markdown | FileKind::Canvas | FileKind::Text) {
        return Err(SecurityError::UnsupportedFile(resolved.relative).into());
    }
    if kind == FileKind::Canvas {
        validate_canvas(&contents)?;
    }
    let revision =
        persistence::write_text_checked(&resolved.absolute, &contents, &expected_revision)?;
    Ok(WriteResult {
        modified_ms: persistence::modified_ms(&resolved.absolute),
        relative_path: resolved.relative,
        revision,
    })
}

/// Reject anything that is not a JSON Canvas document before it reaches disk.
fn validate_canvas(contents: &str) -> Result<(), PersistenceError> {
    let value: serde_json::Value =
        serde_json::from_str(contents).map_err(|err| SecurityError::Io(err.to_string()))?;
    let object = value
        .as_object()
        .ok_or_else(|| SecurityError::Io("canvas must be a JSON object".into()))?;
    for key in ["nodes", "edges"] {
        if let Some(entry) = object.get(key) {
            if !entry.is_array() {
                return Err(SecurityError::Io(format!("canvas `{key}` must be an array")).into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn document_create(
    state: State<'_, WorkspaceState>,
    relative_path: String,
    contents: String,
) -> Result<WriteResult, PersistenceError> {
    document_write(state, relative_path, String::new(), contents)
}

#[tauri::command]
pub fn file_facts(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<workspace::FileFacts, SecurityError> {
    let resolved = state.resolve(&relative_path)?;
    workspace::facts_for(&resolved)
}

#[tauri::command]
pub async fn thumbnail_request(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<Thumbnail, SecurityError> {
    let root = state.root()?;
    let resolved = state.resolve(&relative_path)?;
    // Decoding happens on the blocking pool so the UI thread is never stalled.
    tauri::async_runtime::spawn_blocking(move || thumbnails::generate(&root, &resolved))
        .await
        .map_err(|err| SecurityError::Io(err.to_string()))?
}

#[tauri::command]
pub fn media_probe(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<MediaProbe, SecurityError> {
    let resolved = state.resolve(&relative_path)?;
    media::probe(&resolved)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    /// Absolute source path chosen by the user in a native file dialog.
    pub source_path: String,
    /// Destination directory inside the workspace.
    pub target_directory: String,
}

/// Copy a user-selected file into the workspace so canvases can reference it
/// with a workspace-relative path. The original is never modified.
#[tauri::command]
pub fn attachment_import(
    state: State<'_, WorkspaceState>,
    request: ImportRequest,
) -> Result<workspace::FileFacts, SecurityError> {
    let source = std::fs::canonicalize(&request.source_path)?;
    if !source.is_file() {
        return Err(SecurityError::NotFound);
    }
    if crate::security::detect_kind(&source)? == FileKind::Unsupported {
        return Err(SecurityError::UnsupportedFile(
            source.to_string_lossy().to_string(),
        ));
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or(SecurityError::NotFound)?;

    let directory = state.resolve(&request.target_directory)?;
    std::fs::create_dir_all(&directory.absolute)?;

    let mut relative = format!("{}/{}", directory.relative, name);
    let mut attempt = 1;
    while state
        .resolve(&relative)
        .map(|r| r.absolute.exists())
        .unwrap_or(false)
    {
        let stem = source
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let ext = source
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        relative = format!("{}/{stem}-{attempt}{ext}", directory.relative);
        attempt += 1;
        if attempt > 1000 {
            return Err(SecurityError::Io("could not find a free filename".into()));
        }
    }

    let target = state.resolve(&relative)?;
    std::fs::copy(&source, &target.absolute)?;
    workspace::facts_for(&target)
}

#[tauri::command]
pub fn window_toggle_fullscreen<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<bool, SecurityError> {
    let next = !window
        .is_fullscreen()
        .map_err(|err| SecurityError::Io(err.to_string()))?;
    window
        .set_fullscreen(next)
        .map_err(|err| SecurityError::Io(err.to_string()))?;
    Ok(next)
}

/// Frontend-visible constants so the UI never hardcodes privileged knowledge.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppFacts {
    pub protocol_scheme: String,
    pub protocol_host: String,
    pub platform: String,
    pub version: String,
    /// Directory passed on the command line, if it is one.
    pub initial_workspace: Option<String>,
}

/// A single positional argument naming a directory opens it as the workspace,
/// which is what `ic ~/notes` and "open with" do. It carries the same trust as
/// the directory picker and is validated identically by `workspace_open`.
fn workspace_from_arguments() -> Option<String> {
    let argument = std::env::args().nth(1)?;
    if argument.starts_with('-') {
        return None;
    }
    let path = std::fs::canonicalize(argument).ok()?;
    path.is_dir().then(|| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn app_facts<R: Runtime>(app: tauri::AppHandle<R>) -> AppFacts {
    AppFacts {
        protocol_scheme: crate::WORKSPACE_SCHEME.to_string(),
        // On Windows custom schemes are served over http://<scheme>.localhost.
        protocol_host: if cfg!(windows) {
            format!("http://{}.localhost", crate::WORKSPACE_SCHEME)
        } else {
            format!("{}://localhost", crate::WORKSPACE_SCHEME)
        },
        platform: std::env::consts::OS.to_string(),
        version: app.package_info().version.to_string(),
        initial_workspace: workspace_from_arguments(),
    }
}

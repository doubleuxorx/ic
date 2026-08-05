//! ic — offline-first infinite canvas.
//!
//! The Rust side owns every privileged operation. The webview reaches it only
//! through the narrow commands in [`commands`] and the read-only `ic://`
//! protocol below, both of which validate paths against the open workspace.

pub mod commands;
pub mod media;
pub mod persistence;
pub mod security;
pub mod thumbnails;
pub mod workspace;

use std::io::{Read, Seek, SeekFrom};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext};

use security::{detect_kind, kinds::mime_for, FileKind};
use workspace::WorkspaceState;

/// Scheme used to stream workspace files into the webview without sending
/// bytes through IPC.
pub const WORKSPACE_SCHEME: &str = "ic";

/// Streamed in slices so seeking a large video never buffers the whole file.
const RANGE_CHUNK: u64 = 2 * 1024 * 1024;
/// Upper bound for untrusted PDFs before PDF.js parsing or a full protocol
/// response can allocate memory for the document.
const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;

/// Origins allowed to read from the `ic://` protocol.
fn is_allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("http://localhost:")
}

fn deny(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'")
        .body(Vec::new())
        .expect("static response")
}

/// Serve `ic://localhost/<workspace-relative-path>` read-only.
fn handle_workspace_request<R: tauri::Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if !matches!(request.method().as_str(), "GET" | "HEAD") {
        return deny(StatusCode::METHOD_NOT_ALLOWED);
    }

    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !origin.is_empty() && !is_allowed_origin(&origin) {
        return deny(StatusCode::FORBIDDEN);
    }

    let state = context.app_handle().state::<WorkspaceState>();
    let raw_path = request.uri().path().trim_start_matches('/');
    let Ok(decoded) = percent_encoding::percent_decode_str(raw_path).decode_utf8() else {
        return deny(StatusCode::BAD_REQUEST);
    };

    let Ok(resolved) = state.resolve(&decoded) else {
        return deny(StatusCode::FORBIDDEN);
    };

    let kind = match detect_kind(&resolved.absolute) {
        Ok(kind) => kind,
        Err(_) => return deny(StatusCode::NOT_FOUND),
    };
    // Only passive content is ever served; unknown or executable content is not.
    if kind == FileKind::Unsupported {
        return deny(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    let Ok(mut file) = std::fs::File::open(&resolved.absolute) else {
        return deny(StatusCode::NOT_FOUND);
    };
    let Ok(metadata) = file.metadata() else {
        return deny(StatusCode::NOT_FOUND);
    };
    let total = metadata.len();
    if kind == FileKind::Pdf && total > MAX_PDF_BYTES {
        return deny(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mime = mime_for(&resolved.absolute, kind);

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, total));

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        // Served files are passive data: deny every capability inside them.
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; script-src 'none'; object-src 'none'; sandbox",
        );

    if !origin.is_empty() {
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.as_str());
    }

    let (status, start, length) = match range {
        Some((start, end)) => {
            builder = builder.header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            );
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        None => (StatusCode::OK, 0, total),
    };

    if request.method() == "HEAD" {
        return builder
            .status(status)
            .header(header::CONTENT_LENGTH, length.to_string())
            .body(Vec::new())
            .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR));
    }

    let mut buffer = vec![0u8; length as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buffer).is_err() {
        return deny(StatusCode::INTERNAL_SERVER_ERROR);
    }

    builder
        .status(status)
        .header(header::CONTENT_LENGTH, buffer.len().to_string())
        .body(buffer)
        .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Parse a single-range `bytes=` header. Multi-range requests are ignored.
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = value.strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (start_text, end_text) = spec.split_once('-')?;
    let (start, end) = match (start_text.trim(), end_text.trim()) {
        ("", "") => return None,
        ("", suffix) => {
            let len: u64 = suffix.parse().ok()?;
            let len = len.min(total);
            (total.saturating_sub(len), total - 1)
        }
        (start, "") => {
            let start: u64 = start.parse().ok()?;
            (start, (start + RANGE_CHUNK - 1).min(total - 1))
        }
        (start, end) => {
            let start: u64 = start.parse().ok()?;
            let end: u64 = end.parse().ok()?;
            (start, end.min(total - 1))
        }
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end))
}

/// Whether a Linux run should ask WebKitGTK to paint in software.
///
/// True only for a bundle that borrows the host's graphics stack, which is the
/// glibc AppImage: `linuxdeploy` deliberately leaves libEGL, libGL, libgbm and
/// libdrm out of it, so the bundle's own GLib, GTK and WebKitGTK — all of them
/// as old as the distribution CI builds on — meet whatever Mesa the host has.
/// On a host far enough ahead that the two no longer compose, WebKitGTK does
/// not degrade: it logs `Could not create default EGL display` and aborts the
/// process that paints, which is what leaves an empty white window.
///
/// Nothing else here is exposed to that. The deb, the rpm and the Flatpak use
/// the host's or the runtime's own WebKitGTK, and the musl AppImage carries a
/// matching Mesa of its own — it has to, as the host's glibc build of Mesa
/// cannot be loaded into a musl process at all.
#[cfg(target_os = "linux")]
fn wants_software_rendering(is_appimage: bool, gpu_override: Option<&str>) -> bool {
    // The musl AppImage sets APPIMAGE too, and does not have the problem.
    if cfg!(target_env = "musl") || !is_appimage {
        return false;
    }
    // IC_WEBKIT_GPU=1 keeps acceleration on a host where it works, mirroring
    // IC_GDK_BACKEND in the musl bundle's AppRun.
    !matches!(gpu_override, Some(value) if !value.is_empty() && value != "0")
}

/// Applies [`wants_software_rendering`] to the environment WebKitGTK reads.
///
/// Both variables are needed: the first turns off the DMA-BUF renderer the UI
/// and web processes share buffers through, the second stops the web process
/// compositing at all. Either one alone still leaves a path that initializes
/// EGL. A variable the caller already set is left alone, so a user debugging
/// their own host keeps the last word.
#[cfg(target_os = "linux")]
fn prefer_software_rendering() {
    use std::env;

    // The AppImage runtime exports APPIMAGE for a bundle it mounted; AppRun
    // exports APPDIR for itself either way, so the pair also covers a bundle
    // run with --appimage-extract-and-run and an AppDir executed in place.
    let is_appimage = env::var_os("APPIMAGE").is_some() || env::var_os("APPDIR").is_some();
    let gpu_override = env::var("IC_WEBKIT_GPU").ok();
    if !wants_software_rendering(is_appimage, gpu_override.as_deref()) {
        return;
    }

    for variable in [
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    ] {
        if env::var_os(variable).is_none() {
            // Called before the builder below, so before GTK, WebKitGTK or any
            // thread of ours exists.
            env::set_var(variable, "1");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    prefer_software_rendering();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WorkspaceState::default())
        .register_uri_scheme_protocol(WORKSPACE_SCHEME, handle_workspace_request)
        .invoke_handler(tauri::generate_handler![
            commands::app_facts,
            commands::workspace_open,
            commands::workspace_close,
            commands::workspace_tree,
            commands::workspace_create_directory,
            commands::workspace_settings_read,
            commands::workspace_settings_write,
            commands::workspace_authorize_external,
            commands::document_read,
            commands::document_write,
            commands::document_create,
            commands::file_facts,
            commands::thumbnail_request,
            commands::media_probe,
            commands::attachment_import,
            commands::external::external_open_url,
            commands::external::external_open_path,
            commands::external::reveal_in_file_manager,
            commands::recovery::recovery_write,
            commands::recovery::recovery_list,
            commands::recovery::recovery_clear,
            commands::window_toggle_fullscreen,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ic");
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_origin, parse_range};

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=990-", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
    }

    #[test]
    fn rejects_bad_ranges() {
        assert_eq!(parse_range("bytes=1000-1200", 1000), None);
        assert_eq!(parse_range("bytes=50-10", 1000), None);
        assert_eq!(parse_range("items=0-10", 1000), None);
        assert_eq!(parse_range("bytes=0-10,20-30", 1000), None);
        assert_eq!(parse_range("bytes=-", 1000), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn software_rendering_only_for_the_glibc_appimage() {
        use super::wants_software_rendering;

        // Held separately because the whole function is a no-op under musl.
        if cfg!(target_env = "musl") {
            assert!(!wants_software_rendering(true, None));
            return;
        }
        assert!(wants_software_rendering(true, None));
        // deb, rpm, Flatpak, a development build: host WebKitGTK, host Mesa.
        assert!(!wants_software_rendering(false, None));
        // Opted back into acceleration.
        assert!(!wants_software_rendering(true, Some("1")));
        // Neither of these asks for anything, so neither turns the fallback off.
        assert!(wants_software_rendering(true, Some("0")));
        assert!(wants_software_rendering(true, Some("")));
    }

    #[test]
    fn origin_allowlist() {
        assert!(is_allowed_origin("tauri://localhost"));
        assert!(is_allowed_origin("http://127.0.0.1:5173"));
        assert!(!is_allowed_origin("https://example.org"));
        assert!(!is_allowed_origin("file://"));
    }
}

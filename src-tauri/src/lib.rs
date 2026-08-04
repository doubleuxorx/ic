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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

    #[test]
    fn origin_allowlist() {
        assert!(is_allowed_origin("tauri://localhost"));
        assert!(is_allowed_origin("http://127.0.0.1:5173"));
        assert!(!is_allowed_origin("https://example.org"));
        assert!(!is_allowed_origin("file://"));
    }
}

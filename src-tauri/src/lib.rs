//! ic — offline-first infinite canvas.
//!
//! The Rust side owns every privileged operation. The webview reaches it only
//! through the narrow commands in [`commands`] and the read-only `ic://`
//! protocol below, both of which validate paths against the open workspace.

pub mod commands;
pub mod media;
pub mod persistence;
pub mod security;
#[cfg(test)]
mod test_support;
pub mod thumbnails;
pub mod workspace;

use std::io::{Read, Seek, SeekFrom};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::Manager;

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

/// Origins allowed to read from the `ic://` protocol and the media server.
pub(crate) fn is_allowed_origin(origin: &str) -> bool {
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
///
/// Takes the handle rather than the `UriSchemeContext` it is registered with,
/// whose fields are private: a test can build an application but cannot build
/// one of those, and this is the function worth testing.
fn handle_workspace_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
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

    let state = app.state::<WorkspaceState>();
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
        // The response is built in memory here, so an open-ended range is cut to
        // one chunk and the player asks again for the next.
        .and_then(|value| parse_range(value, total, Some(RANGE_CHUNK)));

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
///
/// `max_chunk` bounds an open-ended range, for a caller that has to hold the
/// whole response in memory. A caller that streams passes `None` and serves to
/// the end of the file.
pub(crate) fn parse_range(value: &str, total: u64, max_chunk: Option<u64>) -> Option<(u64, u64)> {
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
            let end = match max_chunk {
                Some(chunk) => (start + chunk - 1).min(total - 1),
                None => total - 1,
            };
            (start, end)
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

/// Everything the application is, short of running it.
///
/// Kept separate from [`run`] so a test can build the same application on
/// Tauri's mock runtime and reach the real commands, state and protocol handler
/// without a window. A wiring mistake — a command left out of the handler, state
/// never managed — then fails a test rather than only the application.
pub fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(WorkspaceState::default())
        .setup(|app| {
            // Where a webview will not play media from a custom scheme, the same
            // files are served over loopback HTTP instead. Failing to listen is
            // not fatal: media then falls back to `ic://`, and a node that cannot
            // play offers the system player.
            if media::server::is_needed() {
                if let Some(server) = media::server::start(app.handle().clone()) {
                    app.manage(server);
                }
            }
            Ok(())
        })
        .register_uri_scheme_protocol(WORKSPACE_SCHEME, |context, request| {
            handle_workspace_request(context.app_handle(), request)
        })
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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running ic");
}

#[cfg(test)]
mod tests {
    use super::{handle_workspace_request, is_allowed_origin, parse_range, RANGE_CHUNK};
    use crate::test_support::TestApp;
    use tauri::http::{Request, Response, StatusCode};

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000, None), Some((0, 99)));
        assert_eq!(parse_range("bytes=990-", 1000, None), Some((990, 999)));
        assert_eq!(parse_range("bytes=-100", 1000, None), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000, None), Some((0, 999)));
    }

    /// An open-ended range is the only one a chunk limit applies to: the others
    /// already say where they end.
    #[test]
    fn an_open_ended_range_honours_a_chunk_limit() {
        assert_eq!(parse_range("bytes=0-", 1000, Some(100)), Some((0, 99)));
        assert_eq!(parse_range("bytes=950-", 1000, Some(100)), Some((950, 999)));
        assert_eq!(parse_range("bytes=0-", 1000, None), Some((0, 999)));
        assert_eq!(parse_range("bytes=0-49", 1000, Some(100)), Some((0, 49)));
    }

    #[test]
    fn rejects_bad_ranges() {
        assert_eq!(parse_range("bytes=1000-1200", 1000, None), None);
        assert_eq!(parse_range("bytes=50-10", 1000, None), None);
        assert_eq!(parse_range("items=0-10", 1000, None), None);
        assert_eq!(parse_range("bytes=0-10,20-30", 1000, None), None);
        assert_eq!(parse_range("bytes=-", 1000, None), None);
    }

    #[test]
    fn origin_allowlist() {
        assert!(is_allowed_origin("tauri://localhost"));
        assert!(is_allowed_origin("http://127.0.0.1:5173"));
        assert!(!is_allowed_origin("https://example.org"));
        assert!(!is_allowed_origin("file://"));
    }

    /* ------------------------------------------------- the protocol handler */

    /// Ask the handler for something, the way the webview would.
    fn fetch(
        app: &TestApp,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
    ) -> Response<Vec<u8>> {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("ic://localhost/{path}"));
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        handle_workspace_request(
            &app.handle(),
            builder.body(Vec::new()).expect("a well-formed request"),
        )
    }

    fn get(app: &TestApp, path: &str) -> Response<Vec<u8>> {
        fetch(app, "GET", path, &[])
    }

    fn header(response: &Response<Vec<u8>>, name: &str) -> Option<String> {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().expect("a text header").to_string())
    }

    #[test]
    fn a_file_is_served_whole_with_the_headers_that_make_it_passive() {
        let app = TestApp::opened();
        let response = get(&app, "Notes/note.md");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"# Note\n\nA paragraph.\n");
        assert_eq!(
            header(&response, "content-type").as_deref(),
            Some("text/plain; charset=utf-8")
        );
        assert_eq!(header(&response, "content-length").as_deref(), Some("21"));
        assert_eq!(header(&response, "accept-ranges").as_deref(), Some("bytes"));
        assert_eq!(
            header(&response, "cache-control").as_deref(),
            Some("no-store")
        );
        assert_eq!(
            header(&response, "x-content-type-options").as_deref(),
            Some("nosniff")
        );
        // Whatever is inside a served file can do nothing at all.
        let csp = header(&response, "content-security-policy").unwrap_or_default();
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("sandbox"));
    }

    #[test]
    fn the_type_served_is_the_type_sniffed() {
        let app = TestApp::opened();
        assert_eq!(
            header(&get(&app, "Attachments/square.png"), "content-type").as_deref(),
            Some("image/png")
        );
        assert_eq!(
            header(&get(&app, "Attachments/tiny.mp4"), "content-type").as_deref(),
            Some("video/mp4")
        );
        assert_eq!(
            header(&get(&app, "Attachments/doc.pdf"), "content-type").as_deref(),
            Some("application/pdf")
        );
    }

    #[test]
    fn a_percent_encoded_path_reaches_the_same_file() {
        let app = TestApp::opened();
        std::fs::write(app.path("Notes/a note.md"), b"# Spaced\n").unwrap();
        let response = get(&app, "Notes/a%20note.md");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"# Spaced\n");
    }

    #[test]
    fn a_range_is_answered_with_exactly_that_range() {
        let app = TestApp::opened();
        let response = fetch(
            &app,
            "GET",
            "Notes/note.md",
            &[("range", "bytes=2-5"), ("origin", "tauri://localhost")],
        );

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"Note");
        assert_eq!(
            header(&response, "content-range").as_deref(),
            Some("bytes 2-5/21")
        );
        assert_eq!(header(&response, "content-length").as_deref(), Some("4"));
    }

    /// This handler builds its response in memory, so an open-ended range is cut
    /// to one chunk and the player comes back for the next.
    #[test]
    fn an_open_ended_range_is_cut_to_one_chunk() {
        let app = TestApp::opened();
        let size = (RANGE_CHUNK + 4096) as usize;
        std::fs::write(app.path("Notes/big.txt"), "x".repeat(size)).unwrap();

        let response = fetch(&app, "GET", "Notes/big.txt", &[("range", "bytes=0-")]);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len() as u64, RANGE_CHUNK);
        assert_eq!(
            header(&response, "content-range").as_deref(),
            Some(format!("bytes 0-{}/{size}", RANGE_CHUNK - 1).as_str())
        );
    }

    #[test]
    fn a_head_request_reports_the_length_and_sends_no_body() {
        let app = TestApp::opened();
        let response = fetch(&app, "HEAD", "Notes/note.md", &[]);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(header(&response, "content-length").as_deref(), Some("21"));
        assert!(response.body().is_empty());
    }

    #[test]
    fn only_reads_are_answered() {
        let app = TestApp::opened();
        for method in ["POST", "PUT", "DELETE", "OPTIONS"] {
            assert_eq!(
                fetch(&app, method, "Notes/note.md", &[]).status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} was answered"
            );
        }
    }

    #[test]
    fn only_the_applications_own_origins_may_read() {
        let app = TestApp::opened();

        // Echoed back, so the webview accepts the response.
        let response = fetch(
            &app,
            "GET",
            "Notes/note.md",
            &[("origin", "tauri://localhost")],
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            header(&response, "access-control-allow-origin").as_deref(),
            Some("tauri://localhost")
        );

        // A request with no origin at all is the ordinary case for a media
        // element, and gets no allowance header to echo.
        assert_eq!(
            header(&get(&app, "Notes/note.md"), "access-control-allow-origin"),
            None
        );

        for origin in ["https://example.org", "null", "file://"] {
            assert_eq!(
                fetch(&app, "GET", "Notes/note.md", &[("origin", origin)]).status(),
                StatusCode::FORBIDDEN,
                "{origin} was served"
            );
        }
    }

    #[test]
    fn nothing_outside_the_workspace_is_served() {
        let app = TestApp::opened();
        for path in [
            "../escape.md",
            "Notes/../../escape.md",
            "..%2Fescape.md",
            "%2Fetc%2Fpasswd",
        ] {
            assert_eq!(
                get(&app, path).status(),
                StatusCode::FORBIDDEN,
                "{path} was served"
            );
        }
        assert_eq!(
            get(&app, "Notes/missing.md").status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn nothing_unrenderable_is_served_however_it_is_named() {
        let app = TestApp::opened();
        // An ELF header behind a `.png` name.
        assert_eq!(
            get(&app, "Attachments/payload.png").status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        // The application's own settings are not content.
        app.call(
            "workspace_settings_write",
            serde_json::json!({ "settings": {
                "lastCanvas": null, "viewports": {},
                "authorizedExternalPaths": [], "ui": {},
            }}),
        );
        assert_eq!(
            get(&app, ".app/workspace-settings.json").status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }

    /// A hostile PDF must not be handed to the parser at all past this size.
    /// The file here is sparse, so the test costs no disk.
    #[test]
    fn a_pdf_past_the_limit_is_refused_before_it_is_read() {
        let app = TestApp::opened();
        let path = app.path("Attachments/huge.pdf");
        std::fs::write(&path, crate::test_support::TINY_PDF).unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(super::MAX_PDF_BYTES + 1).unwrap();
        drop(file);

        assert_eq!(
            get(&app, "Attachments/huge.pdf").status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        // One byte under the limit is still served.
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(super::MAX_PDF_BYTES).unwrap();
        drop(file);
        assert_eq!(get(&app, "Attachments/huge.pdf").status(), StatusCode::OK);
    }

    #[test]
    fn nothing_is_served_while_no_workspace_is_open() {
        let app = TestApp::new();
        assert_eq!(get(&app, "Notes/note.md").status(), StatusCode::FORBIDDEN);
    }
}

//! Loopback HTTP server for audio and video.
//!
//! WebKitGTK decodes media through GStreamer, which fetches only the schemes it
//! knows, so a file served from `ic://` never reaches a decoder: the protocol
//! handler is asked for the first few hundred bytes, never asked again, and the
//! element reports an unsupported source. Media elements are pointed here
//! instead — ordinary HTTP, over loopback, answering range requests, so seeking
//! a large file still does not buffer the whole of it.
//!
//! This is the narrowest server that can do that, and every rule it follows is
//! in this module:
//!
//! - it binds `127.0.0.1` on a port the kernel chooses, so nothing off this
//!   machine can reach it;
//! - every request path begins with a token drawn from the system generator when
//!   the application starts, so another local process cannot read workspace
//!   files by guessing the port;
//! - only `GET` and `HEAD` are answered, and only for one range at a time;
//! - paths are resolved by the open workspace and sniffed for content exactly as
//!   the `ic://` handler does, and only audio and video are served, so a note, a
//!   canvas or anything under `.app` is refused here even with the token;
//! - it answers nothing while no workspace is open, and it is started only on the
//!   platform whose webview needs it.

use std::io::{Seek, SeekFrom};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::security::{detect_kind, kinds::mime_for, FileKind};
use crate::workspace::WorkspaceState;

/// Requests served at once. A media element opens a few connections — metadata,
/// then playback, then one per seek — and abandons them freely, so a small fixed
/// number is enough, and being fixed means no request can make threads without
/// end.
const WORKERS: usize = 4;

/// Where the webview should fetch media from, token included.
pub struct MediaServer {
    origin: String,
}

impl MediaServer {
    pub fn origin(&self) -> &str {
        &self.origin
    }
}

/// What every request must satisfy before a path is even looked at.
struct Rules {
    token: String,
    host: String,
}

/// True on the platforms whose webview cannot play from the custom scheme.
///
/// Everywhere else `ic://` already streams media, and a listening socket that
/// nothing needs is surface for nothing.
pub fn is_needed() -> bool {
    cfg!(target_os = "linux")
}

/// Start listening, or report nothing and leave media to `ic://`.
pub fn start<R: Runtime>(app: AppHandle<R>) -> Option<MediaServer> {
    let token = random_token()?;
    let server = Arc::new(Server::http(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).ok()?);
    let port = server.server_addr().to_ip()?.port();
    let rules = Arc::new(Rules {
        token: token.clone(),
        host: format!("127.0.0.1:{port}"),
    });

    for _ in 0..WORKERS {
        let server = Arc::clone(&server);
        let rules = Arc::clone(&rules);
        let app = app.clone();
        std::thread::spawn(move || {
            while let Ok(request) = server.recv() {
                // A client that has gone away, which is what an abandoned seek
                // looks like, is not an error worth reporting anywhere.
                let _ = answer(&app, &rules, request);
            }
        });
    }

    Some(MediaServer {
        origin: format!("http://127.0.0.1:{port}/{token}"),
    })
}

fn answer<R: Runtime>(app: &AppHandle<R>, rules: &Rules, request: Request) -> std::io::Result<()> {
    if !matches!(request.method(), Method::Get | Method::Head) {
        return request.respond(refuse(405));
    }
    // A request naming another host reached this port by some other name, which
    // is never how the webview asks.
    if let Some(host) = header_value(&request, "Host") {
        if host != rules.host {
            return request.respond(refuse(403));
        }
    }
    let origin = header_value(&request, "Origin");
    if let Some(origin) = &origin {
        if !crate::is_allowed_origin(origin) {
            return request.respond(refuse(403));
        }
    }
    let Some(relative) = request_path(request.url(), &rules.token) else {
        return request.respond(refuse(404));
    };
    let range_header = header_value(&request, "Range");

    let Ok(resolved) = app.state::<WorkspaceState>().resolve(&relative) else {
        return request.respond(refuse(403));
    };
    let Ok(kind) = detect_kind(&resolved.absolute) else {
        return request.respond(refuse(404));
    };
    if !is_playable(kind) {
        return request.respond(refuse(415));
    }
    let Ok(mut file) = std::fs::File::open(&resolved.absolute) else {
        return request.respond(refuse(404));
    };
    let Ok(metadata) = file.metadata() else {
        return request.respond(refuse(404));
    };
    let total = metadata.len();

    let mut headers = vec![
        header("Content-Type", mime_for(&resolved.absolute, kind)),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "no-store"),
        header("X-Content-Type-Options", "nosniff"),
        // Served files are passive data: deny every capability inside them.
        header("Content-Security-Policy", "default-src 'none'; sandbox"),
    ];
    if let Some(origin) = origin {
        headers.push(header("Access-Control-Allow-Origin", &origin));
    }

    // Whole ranges are answered whole: the response streams from the file, so a
    // player asking for everything from a point costs one open file, not a copy
    // of the rest of the film.
    match range_header.and_then(|value| crate::parse_range(&value, total, None)) {
        Some((start, end)) => {
            let length = end - start + 1;
            headers.push(header(
                "Content-Range",
                &format!("bytes {start}-{end}/{total}"),
            ));
            file.seek(SeekFrom::Start(start))?;
            request.respond(sized(Response::new(
                StatusCode(206),
                headers,
                std::io::Read::take(file, length),
                Some(length as usize),
                None,
            )))
        }
        None => request.respond(sized(Response::new(
            StatusCode(200),
            headers,
            file,
            Some(total as usize),
            None,
        ))),
    }
}

/// Always answer with a `Content-Length`.
///
/// The library would otherwise send anything past a few tens of kilobytes with
/// chunked encoding, and a player that cannot see the length of what it is
/// fetching cannot show a duration or seek into it.
fn sized<R: std::io::Read>(response: Response<R>) -> Response<R> {
    response.with_chunked_threshold(usize::MAX)
}

fn is_playable(kind: FileKind) -> bool {
    matches!(kind, FileKind::Audio | FileKind::Video)
}

fn header(field: &str, value: &str) -> Header {
    // Both sides are ours: a static field name and a value built from a
    // validated path, so there is nothing here to reject at runtime.
    Header::from_bytes(field.as_bytes(), value.as_bytes()).expect("well-formed header")
}

fn header_value(request: &Request, field: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(field))
        .map(|header| header.value.as_str().to_string())
}

fn refuse(status: u16) -> Response<std::io::Empty> {
    Response::empty(StatusCode(status))
        .with_header(header("Content-Security-Policy", "default-src 'none'"))
}

/// Take the workspace-relative path out of `/<token>/<path>`.
///
/// Whether that path is one the workspace will hand over is not decided here;
/// resolution refuses traversal, absolute paths and everything outside the root
/// the same way it does for a path arriving through a command.
fn request_path(url: &str, token: &str) -> Option<String> {
    let path = url.split('?').next()?;
    let (candidate, relative) = path.strip_prefix('/')?.split_once('/')?;
    if !tokens_match(candidate.as_bytes(), token.as_bytes()) {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(relative)
        .decode_utf8()
        .ok()?;
    (!decoded.is_empty()).then(|| decoded.into_owned())
}

/// Compare without revealing where two tokens first differ.
fn tokens_match(candidate: &[u8], token: &[u8]) -> bool {
    if candidate.len() != token.len() {
        return false;
    }
    candidate
        .iter()
        .zip(token)
        .fold(0u8, |differences, (a, b)| differences | (a ^ b))
        == 0
}

/// 32 bytes from the system generator, hex encoded.
fn random_token() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::{is_playable, random_token, request_path, tokens_match};
    use crate::security::FileKind;
    use tiny_http::{Response, StatusCode};

    #[test]
    fn a_path_needs_the_token() {
        assert_eq!(
            request_path("/tok/Attachments/a.mp3", "tok"),
            Some("Attachments/a.mp3".to_string())
        );
        assert_eq!(request_path("/wrong/Attachments/a.mp3", "tok"), None);
        assert_eq!(request_path("/Attachments/a.mp3", "tok"), None);
        assert_eq!(request_path("/tok/", "tok"), None);
        assert_eq!(request_path("/tok", "tok"), None);
    }

    #[test]
    fn a_path_is_decoded_and_a_query_ignored() {
        assert_eq!(
            request_path("/tok/Attachments/a%20b.mp3?t=1", "tok"),
            Some("Attachments/a b.mp3".to_string())
        );
    }

    /// Traversal is not rejected here; it is handed to the workspace, which
    /// refuses it for every path that reaches it from anywhere.
    #[test]
    fn traversal_is_left_to_the_workspace() {
        assert_eq!(
            request_path("/tok/../../etc/passwd", "tok"),
            Some("../../etc/passwd".to_string())
        );
    }

    #[test]
    fn tokens_of_different_lengths_do_not_match() {
        assert!(tokens_match(b"abc", b"abc"));
        assert!(!tokens_match(b"abc", b"abd"));
        assert!(!tokens_match(b"ab", b"abc"));
        assert!(!tokens_match(b"", b"abc"));
    }

    #[test]
    fn only_audio_and_video_are_served() {
        assert!(is_playable(FileKind::Audio));
        assert!(is_playable(FileKind::Video));
        assert!(!is_playable(FileKind::Markdown));
        assert!(!is_playable(FileKind::Canvas));
        assert!(!is_playable(FileKind::Image));
        assert!(!is_playable(FileKind::Pdf));
        assert!(!is_playable(FileKind::Text));
        assert!(!is_playable(FileKind::Unsupported));
    }

    /// A player that cannot see how long a response is cannot show a duration or
    /// seek, so a body past the library's threshold must still be sent with a
    /// length rather than in chunks.
    #[test]
    fn a_long_response_reports_its_length() {
        let body = vec![0u8; 100_000];
        let length = body.len();
        let mut written: Vec<u8> = Vec::new();
        super::sized(Response::new(
            StatusCode(200),
            Vec::new(),
            std::io::Cursor::new(body),
            Some(length),
            None,
        ))
        .raw_print(&mut written, (1, 1).into(), &[], false, None)
        .expect("writing to a vector cannot fail");
        let head = String::from_utf8_lossy(&written[..written.len().min(400)]).to_lowercase();
        assert!(head.contains(&format!("content-length: {length}")));
        assert!(!head.contains("transfer-encoding: chunked"));
    }

    #[test]
    fn a_token_is_long_and_never_repeats() {
        let first = random_token().expect("system generator");
        let second = random_token().expect("system generator");
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}

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

/// The server as a client meets it: a real socket, real requests, real bytes.
///
/// Started here rather than taken from `app_facts`, so these run on every
/// platform and not only on the one whose webview needs the server.
#[cfg(test)]
mod over_the_wire {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    use crate::test_support::{TestApp, TINY_MP3, TINY_MP4};

    struct Answer {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Answer {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(field, _)| field.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }
    }

    /// One request per connection, closed by the server when it has answered.
    fn ask(origin: &str, method: &str, path: &str, extra: &[(&str, &str)]) -> Answer {
        let rest = origin.strip_prefix("http://").expect("an http origin");
        let (authority, token) = rest.split_once('/').expect("a token in the origin");

        let mut request = format!("{method} /{token}{path} HTTP/1.1\r\nHost: {authority}\r\n");
        for (name, value) in extra {
            // A test that wants to lie about the host says so explicitly.
            if name.eq_ignore_ascii_case("host") {
                request = request.replace(&format!("Host: {authority}\r\n"), "");
            }
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("Connection: close\r\n\r\n");

        let mut stream = TcpStream::connect(authority).expect("the server is listening");
        stream
            .write_all(request.as_bytes())
            .expect("the request is sent");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("the answer arrives");
        parse(&raw)
    }

    /// The same, for a path the token must not unlock.
    fn ask_raw(origin: &str, path: &str) -> Answer {
        let rest = origin.strip_prefix("http://").expect("an http origin");
        let authority = rest.split('/').next().expect("an authority");
        let mut stream = TcpStream::connect(authority).expect("the server is listening");
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .expect("the request is sent");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("the answer arrives");
        parse(&raw)
    }

    fn parse(raw: &[u8]) -> Answer {
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("headers end somewhere");
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .expect("a status line");
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(field, value)| (field.trim().to_string(), value.trim().to_string()))
            .collect();
        Answer {
            status,
            headers,
            body: raw[split + 4..].to_vec(),
        }
    }

    /// An application whose media server is listening, and where it listens.
    fn served() -> (TestApp, super::MediaServer) {
        let app = TestApp::opened();
        let server = super::start(app.handle()).expect("the server listens on loopback");
        (app, server)
    }

    #[test]
    fn media_is_served_whole_with_a_length_a_player_can_use() {
        let (_app, server) = served();
        let answer = ask(server.origin(), "GET", "/Attachments/tiny.mp3", &[]);

        assert_eq!(answer.status, 200);
        assert_eq!(answer.body, TINY_MP3);
        assert_eq!(answer.header("content-type"), Some("audio/mpeg"));
        assert_eq!(
            answer.header("content-length"),
            Some(TINY_MP3.len().to_string().as_str())
        );
        // Without this a player shows no duration and cannot seek.
        assert_eq!(answer.header("transfer-encoding"), None);
        assert_eq!(answer.header("accept-ranges"), Some("bytes"));
        assert_eq!(answer.header("cache-control"), Some("no-store"));
        assert_eq!(answer.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(
            answer.header("content-security-policy"),
            Some("default-src 'none'; sandbox")
        );
    }

    #[test]
    fn video_is_served_as_video() {
        let (_app, server) = served();
        let answer = ask(server.origin(), "GET", "/Attachments/tiny.mp4", &[]);
        assert_eq!(answer.status, 200);
        assert_eq!(answer.header("content-type"), Some("video/mp4"));
        assert_eq!(answer.body, TINY_MP4);
    }

    /// Unlike the in-memory protocol handler, this one streams, so an open-ended
    /// range runs to the end of the file rather than stopping at a chunk.
    #[test]
    fn an_open_ended_range_runs_to_the_end_of_the_file() {
        let (_app, server) = served();
        let total = TINY_MP3.len();
        let answer = ask(
            server.origin(),
            "GET",
            "/Attachments/tiny.mp3",
            &[("Range", "bytes=1000-")],
        );

        assert_eq!(answer.status, 206);
        assert_eq!(
            answer.header("content-range"),
            Some(format!("bytes 1000-{}/{total}", total - 1).as_str())
        );
        assert_eq!(answer.body, &TINY_MP3[1000..]);
    }

    #[test]
    fn a_bounded_range_is_exactly_the_bytes_asked_for() {
        let (_app, server) = served();
        let answer = ask(
            server.origin(),
            "GET",
            "/Attachments/tiny.mp3",
            &[("Range", "bytes=10-19")],
        );

        assert_eq!(answer.status, 206);
        assert_eq!(answer.header("content-length"), Some("10"));
        assert_eq!(answer.body, &TINY_MP3[10..=19]);
    }

    #[test]
    fn a_head_request_carries_the_length_and_no_body() {
        let (_app, server) = served();
        let answer = ask(server.origin(), "HEAD", "/Attachments/tiny.mp3", &[]);
        assert_eq!(answer.status, 200);
        assert_eq!(
            answer.header("content-length"),
            Some(TINY_MP3.len().to_string().as_str())
        );
        assert!(answer.body.is_empty());
    }

    #[test]
    fn a_request_without_the_token_is_not_answered() {
        let (_app, server) = served();
        let wrong = server
            .origin()
            .replace(server.origin().rsplit('/').next().unwrap(), &"a".repeat(64));

        assert_eq!(ask(&wrong, "GET", "/Attachments/tiny.mp3", &[]).status, 404);
        assert_eq!(
            ask_raw(server.origin(), "/Attachments/tiny.mp3").status,
            404
        );
        assert_eq!(ask_raw(server.origin(), "/").status, 404);
    }

    #[test]
    fn a_request_naming_another_host_is_refused() {
        let (_app, server) = served();
        for host in ["evil.example", "localhost:1", "127.0.0.1:1"] {
            assert_eq!(
                ask(
                    server.origin(),
                    "GET",
                    "/Attachments/tiny.mp3",
                    &[("Host", host)]
                )
                .status,
                403,
                "{host} was served"
            );
        }
    }

    #[test]
    fn only_the_applications_own_origins_may_read() {
        let (_app, server) = served();
        let allowed = ask(
            server.origin(),
            "GET",
            "/Attachments/tiny.mp3",
            &[("Origin", "tauri://localhost")],
        );
        assert_eq!(allowed.status, 200);
        assert_eq!(
            allowed.header("access-control-allow-origin"),
            Some("tauri://localhost")
        );

        for origin in ["https://example.org", "file://", "null"] {
            assert_eq!(
                ask(
                    server.origin(),
                    "GET",
                    "/Attachments/tiny.mp3",
                    &[("Origin", origin)]
                )
                .status,
                403,
                "{origin} was served"
            );
        }
    }

    #[test]
    fn only_reads_are_answered() {
        let (_app, server) = served();
        for method in ["POST", "PUT", "DELETE", "OPTIONS"] {
            assert_eq!(
                ask(server.origin(), method, "/Attachments/tiny.mp3", &[]).status,
                405,
                "{method} was answered"
            );
        }
    }

    /// The token opens audio and video and nothing else: a note, an image and the
    /// application's own settings are all refused here even with it.
    #[test]
    fn nothing_but_audio_and_video_is_served() {
        let (app, server) = served();
        app.call(
            "workspace_settings_write",
            serde_json::json!({ "settings": {
                "lastCanvas": null, "viewports": {},
                "authorizedExternalPaths": [], "ui": {},
            }}),
        );

        for path in [
            "/Notes/note.md",
            "/Canvases/Main.canvas",
            "/Attachments/square.png",
            "/Attachments/doc.pdf",
            "/Attachments/payload.png",
            "/.app/workspace-settings.json",
        ] {
            assert_eq!(
                ask(server.origin(), "GET", path, &[]).status,
                415,
                "{path} was served"
            );
        }
    }

    #[test]
    fn nothing_outside_the_workspace_is_served() {
        let (_app, server) = served();
        for path in [
            "/../../etc/passwd",
            "/Notes/../../escape.mp3",
            "/%2Fetc%2Fpasswd",
        ] {
            assert_eq!(
                ask(server.origin(), "GET", path, &[]).status,
                403,
                "{path} was served"
            );
        }
        assert_eq!(
            ask(server.origin(), "GET", "/Attachments/missing.mp3", &[]).status,
            404
        );
    }

    #[test]
    fn nothing_is_served_while_no_workspace_is_open() {
        let app = TestApp::new();
        let server = super::start(app.handle()).expect("the server listens on loopback");
        assert_eq!(
            ask(server.origin(), "GET", "/Attachments/tiny.mp3", &[]).status,
            403
        );
    }
}

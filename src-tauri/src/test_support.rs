//! A whole application, headless, for tests to drive.
//!
//! Tauri's mock runtime builds the real thing — the commands from
//! [`crate::configure`], the managed state, the protocol handler — with no window
//! and no display, so these tests run wherever `cargo test` does. What they
//! cannot do is paint: anything about decoding or rendering belongs to the
//! webview self-test instead.
//!
//! Two details are easy to get wrong and cost an afternoon each:
//!
//! - the invoke URL has to be the one this window is actually on, which is not
//!   the same on every platform: see [`TestApp::local_origin`]. Anything else
//!   counts as a remote origin, and the access-control layer then refuses the
//!   application's own commands with "not allowed. Plugin not found", which reads
//!   like a missing registration;
//! - the context comes from [`tauri::test::mock_context`], so nothing here needs
//!   `dist/` to exist and `cargo test` does not depend on a frontend build.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindow, WebviewWindowBuilder};

/// One second of silence, and one second of a 16x16 black picture.
///
/// Committed rather than generated: these need an encoder, and everything else a
/// test wants is cheaper to write out here. See `tests/fixtures/README.md`.
pub const TINY_MP3: &[u8] = include_bytes!("../../tests/fixtures/media/tiny.mp3");
pub const TINY_MP4: &[u8] = include_bytes!("../../tests/fixtures/media/tiny.mp4");
/// The same streams in a container no target webview plays.
pub const TINY_MKV: &[u8] = include_bytes!("../../tests/fixtures/media/tiny.mkv");

/// The smallest thing PDF.js and the protocol handler both accept as a document.
pub const TINY_PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n\
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n\
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 16 16]>>endobj\n\
trailer<</Root 1 0 R>>\n";

pub struct TestApp {
    /// Held so the temporary directory outlives the workspace opened inside it.
    pub dir: tempfile::TempDir,
    pub app: tauri::App<MockRuntime>,
    pub webview: WebviewWindow<MockRuntime>,
}

impl TestApp {
    /// An application with nothing open, as if it had just started.
    pub fn new() -> Self {
        let mut app = crate::configure(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("the mock application builds");
        // Building an application does not run its setup hook: Tauri runs that
        // when the event loop first reports itself ready. Under the mock runtime
        // one iteration is exactly that and nothing else, so this is how a test
        // reaches the application a user gets — the media server included.
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("the mock webview builds");
        TestApp {
            dir: tempfile::tempdir().expect("a temporary directory"),
            app,
            webview,
        }
    }

    /// An application with a workspace of fixtures open, as after the picker.
    pub fn opened() -> Self {
        let app = Self::new();
        write_fixtures(app.root());
        app.invoke("workspace_open", json!({ "path": app.root() }))
            .expect("the fixture workspace opens");
        app
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.dir.path().join(relative)
    }

    /// Where this window is, which is what makes a request a local one.
    ///
    /// Asked of the window rather than written down, because it is not the same
    /// everywhere: Windows and Android have no custom scheme to load a frontend
    /// from, so Tauri serves it over `http://tauri.localhost` there and uses
    /// `tauri://localhost` on every other platform. Sending the wrong one makes
    /// every command a remote request, and the access-control layer refuses the
    /// lot — which is how `cargo test` failed on Windows alone, 48 tests at once,
    /// while macOS and Linux passed.
    fn local_origin(&self) -> tauri::Url {
        self.webview.url().expect("the window reports where it is")
    }

    /// Call a command the way the webview does, and get back what it would.
    pub fn invoke(&self, command: &str, body: Value) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: self.local_origin(),
                body: body.into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| {
            body.deserialize::<Value>()
                .expect("a command answers with JSON")
        })
    }

    /// The same, for a command expected to succeed.
    pub fn call(&self, command: &str, body: Value) -> Value {
        match self.invoke(command, body.clone()) {
            Ok(value) => value,
            Err(error) => panic!("{command} {body} failed: {}", message(&error)),
        }
    }

    /// The same, for a command expected to be refused, giving its reason.
    pub fn refusal(&self, command: &str, body: Value) -> String {
        match self.invoke(command, body.clone()) {
            Ok(value) => panic!("{command} {body} was allowed, answering {value}"),
            Err(error) => message(&error),
        }
    }

    pub fn handle(&self) -> tauri::AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    pub fn read(&self, relative: &str) -> String {
        std::fs::read_to_string(self.path(relative)).expect("the file is readable")
    }
}

/// One file of every kind the application has an opinion about.
///
/// Written by hand rather than copied from a directory of samples, so what a test
/// asserts about a file is visible in the same repository as the assertion.
pub fn write_fixtures(root: &Path) {
    let write = |relative: &str, bytes: &[u8]| {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("a fixture directory");
        }
        std::fs::write(&path, bytes).expect("a fixture file");
    };

    write("Notes/note.md", b"# Note\n\nA paragraph.\n");
    write("Notes/nested/deep.md", b"# Deep\n");
    write("notes.txt", b"plain text\n");
    write("Canvases/Main.canvas", empty_canvas().as_bytes());
    write("Attachments/tiny.mp3", TINY_MP3);
    write("Attachments/tiny.mp4", TINY_MP4);
    write("Attachments/tiny.mkv", TINY_MKV);
    write("Attachments/doc.pdf", TINY_PDF);
    write("Attachments/square.png", &png(64, 64));
    write("Attachments/wide.png", &png(2048, 512));
    // Extension says image, content says executable: never renderable.
    write(
        "Attachments/payload.png",
        &[0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0],
    );
    // Not offered by the file tree at all.
    write("Attachments/notes.zip", b"PK\x03\x04nonsense");
}

/// What a refusal said, whether it arrived as a string or as a tagged object.
///
/// `SecurityError` serializes as its message; `PersistenceError` as
/// `{ kind, message, ... }` so a conflict can carry the disk contents with it.
pub fn message(error: &Value) -> String {
    match error {
        Value::String(text) => text.clone(),
        other => other
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| other.to_string()),
    }
}

pub fn empty_canvas() -> String {
    json!({ "nodes": [], "edges": [] }).to_string()
}

/// A PNG of the given size, through the same crate that decodes thumbnails.
pub fn png(width: u32, height: u32) -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    })
    .write_to(&mut buffer, image::ImageFormat::Png)
    .expect("encoding a PNG in memory cannot fail");
    buffer.into_inner()
}

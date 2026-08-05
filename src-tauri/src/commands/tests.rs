//! The command surface, driven the way the webview drives it.
//!
//! Every test here builds a real application on the mock runtime (see
//! [`crate::test_support`]) over a real temporary workspace, so what is asserted
//! is the same code path a click reaches: argument validation, path resolution,
//! content sniffing and the filesystem. Nothing is stubbed out, which is why the
//! refusals are worth as much as the successes — a check that stops applying is
//! invisible until something tries to get past it.

use serde_json::{json, Value};

use crate::test_support::{png, TestApp, TINY_MP3};

/// A revision no file will ever have, for asking a write to fail.
const STALE: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn names(entries: &Value) -> Vec<String> {
    entries
        .as_array()
        .expect("the tree is an array")
        .iter()
        .map(|entry| entry["name"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn child(entries: &Value, name: &str) -> Value {
    entries
        .as_array()
        .expect("the tree is an array")
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap_or_else(|| panic!("{name} is missing from {entries}"))
        .clone()
}

/* ------------------------------------------------------------------ workspace */

#[test]
fn a_workspace_lists_what_it_offers_and_hides_the_rest() {
    let app = TestApp::opened();
    let tree = app.call("workspace_tree", json!({}));

    // Directories first, then files, each alphabetically.
    assert_eq!(
        names(&tree),
        vec!["Attachments", "Canvases", "Notes", "notes.txt"]
    );
    // `.app` holds caches and settings and is never browsable.
    assert!(!names(&tree).iter().any(|name| name == ".app"));

    let attachments = child(&tree, "Attachments");
    assert_eq!(attachments["isDirectory"], true);
    // An extension nothing renders is not offered at all.
    assert!(!names(&attachments["children"])
        .iter()
        .any(|name| name == "notes.zip"));

    let notes = child(&tree, "Notes");
    let nested = child(&notes["children"], "nested");
    assert_eq!(names(&nested["children"]), vec!["deep.md"]);
    assert_eq!(child(&nested["children"], "deep.md")["kind"], "markdown");
    assert_eq!(
        child(&nested["children"], "deep.md")["relativePath"],
        "Notes/nested/deep.md"
    );
}

#[cfg(unix)]
#[test]
fn a_tree_never_descends_a_symlink() {
    let app = TestApp::opened();
    let outside = tempfile::tempdir().expect("a directory outside the workspace");
    std::fs::write(outside.path().join("secret.md"), b"secret").unwrap();
    std::os::unix::fs::symlink(outside.path(), app.path("linked")).unwrap();

    let tree = app.call("workspace_tree", json!({}));
    assert!(!names(&tree).iter().any(|name| name == "linked"));
}

#[test]
fn settings_round_trip_through_disk() {
    let app = TestApp::opened();
    assert_eq!(
        app.call("workspace_settings_read", json!({}))["lastCanvas"],
        Value::Null
    );

    app.call(
        "workspace_settings_write",
        json!({ "settings": {
            "lastCanvas": "Canvases/Main.canvas",
            "viewports": { "Canvases/Main.canvas": { "x": 10, "y": 20, "zoom": 1.5 } },
            "authorizedExternalPaths": [],
            "ui": { "minimap": true },
        }}),
    );

    let settings = app.call("workspace_settings_read", json!({}));
    assert_eq!(settings["lastCanvas"], "Canvases/Main.canvas");
    assert_eq!(settings["viewports"]["Canvases/Main.canvas"]["zoom"], 1.5);
    assert_eq!(settings["ui"]["minimap"], true);
    // Settings are workspace state, so they live with the workspace.
    assert!(app.path(".app/workspace-settings.json").exists());
}

#[test]
fn a_directory_is_created_only_inside_the_workspace() {
    let app = TestApp::opened();
    app.call(
        "workspace_create_directory",
        json!({ "relativePath": "Notes/Journal" }),
    );
    assert!(app.path("Notes/Journal").is_dir());

    for escape in ["../outside", "/etc/ic", "Notes/../../outside"] {
        app.refusal(
            "workspace_create_directory",
            json!({ "relativePath": escape }),
        );
    }
    assert!(!app.root().parent().unwrap().join("outside").exists());
}

#[test]
fn nothing_is_served_while_no_workspace_is_open() {
    let app = TestApp::new();
    let refusals = [
        ("workspace_tree", json!({})),
        ("workspace_settings_read", json!({})),
        ("document_read", json!({ "relativePath": "Notes/note.md" })),
        (
            "document_write",
            json!({ "relativePath": "a.md", "expectedRevision": "", "contents": "x" }),
        ),
        ("file_facts", json!({ "relativePath": "a.md" })),
        ("thumbnail_request", json!({ "relativePath": "a.png" })),
        ("media_probe", json!({ "relativePath": "a.mp3" })),
        ("recovery_list", json!({})),
        ("external_open_path", json!({ "relativePath": "a.md" })),
    ];
    for (command, body) in refusals {
        assert_eq!(
            app.refusal(command, body),
            "no workspace is open",
            "{command} answered while nothing was open"
        );
    }
}

#[test]
fn closing_a_workspace_stops_serving_it() {
    let app = TestApp::opened();
    app.call("document_read", json!({ "relativePath": "Notes/note.md" }));
    app.call("workspace_close", json!({}));
    assert_eq!(
        app.refusal("document_read", json!({ "relativePath": "Notes/note.md" })),
        "no workspace is open"
    );
}

/* ------------------------------------------------------------------ documents */

#[test]
fn only_text_documents_are_read_as_documents() {
    let app = TestApp::opened();

    let note = app.call("document_read", json!({ "relativePath": "Notes/note.md" }));
    assert_eq!(note["contents"], "# Note\n\nA paragraph.\n");
    assert_eq!(note["relativePath"], "Notes/note.md");
    assert_eq!(note["revision"].as_str().unwrap().len(), 64);

    app.call("document_read", json!({ "relativePath": "notes.txt" }));
    app.call(
        "document_read",
        json!({ "relativePath": "Canvases/Main.canvas" }),
    );

    // Bytes for these go through the protocol handler, never through IPC.
    for binary in [
        "Attachments/square.png",
        "Attachments/doc.pdf",
        "Attachments/tiny.mp3",
        "Attachments/payload.png",
    ] {
        assert!(app
            .refusal("document_read", json!({ "relativePath": binary }))
            .contains("not supported"));
    }
}

#[test]
fn a_write_that_did_not_see_the_current_file_is_refused() {
    let app = TestApp::opened();
    let before = app.read("Canvases/Main.canvas");

    let error = app
        .invoke(
            "document_write",
            json!({
                "relativePath": "Canvases/Main.canvas",
                "expectedRevision": STALE,
                "contents": "{\"nodes\":[],\"edges\":[]}",
            }),
        )
        .expect_err("a stale revision cannot write");

    // The frontend distinguishes this from any other failure by `kind`, and
    // shows both versions rather than choosing one.
    assert_eq!(error["kind"], "revision-mismatch");
    assert_eq!(error["currentContents"], before);
    assert_eq!(error["currentRevision"].as_str().unwrap().len(), 64);
    assert_eq!(app.read("Canvases/Main.canvas"), before);
}

#[test]
fn a_write_that_saw_the_current_file_succeeds_and_reports_the_next_revision() {
    let app = TestApp::opened();
    let read = app.call(
        "document_read",
        json!({ "relativePath": "Canvases/Main.canvas" }),
    );
    let contents = json!({ "nodes": [{
        "id": "a", "type": "text", "text": "hello", "x": 0, "y": 0, "width": 200, "height": 100,
    }], "edges": [] })
    .to_string();

    let result = app.call(
        "document_write",
        json!({
            "relativePath": "Canvases/Main.canvas",
            "expectedRevision": read["revision"],
            "contents": contents,
        }),
    );
    assert_ne!(result["revision"], read["revision"]);
    assert_eq!(app.read("Canvases/Main.canvas"), contents);

    // The revision just reported is the one the next write must present.
    app.call(
        "document_write",
        json!({
            "relativePath": "Canvases/Main.canvas",
            "expectedRevision": result["revision"],
            "contents": crate::test_support::empty_canvas(),
        }),
    );
}

#[test]
fn a_canvas_file_never_receives_anything_that_is_not_a_canvas() {
    let app = TestApp::opened();
    let revision = app.call(
        "document_read",
        json!({ "relativePath": "Canvases/Main.canvas" }),
    )["revision"]
        .clone();
    let before = app.read("Canvases/Main.canvas");

    for bad in [
        "[]",
        "\"text\"",
        "not json at all",
        "{\"nodes\":{}}",
        "{\"nodes\":[],\"edges\":\"none\"}",
    ] {
        app.refusal(
            "document_write",
            json!({
                "relativePath": "Canvases/Main.canvas",
                "expectedRevision": revision,
                "contents": bad,
            }),
        );
    }
    assert_eq!(app.read("Canvases/Main.canvas"), before);
}

#[test]
fn a_document_is_only_written_where_a_document_belongs() {
    let app = TestApp::opened();
    for target in [
        "Attachments/square.png",
        "Attachments/notes.zip",
        ".app/workspace-settings.json",
        "../escape.md",
        "/etc/ic.md",
    ] {
        app.refusal(
            "document_write",
            json!({ "relativePath": target, "expectedRevision": "", "contents": "x" }),
        );
    }
    // Nothing was created anywhere, `.app` included.
    assert!(!app.path(".app/workspace-settings.json").exists());
    assert!(!app.root().parent().unwrap().join("escape.md").exists());
}

#[test]
fn creating_a_document_never_overwrites_one() {
    let app = TestApp::opened();
    app.call(
        "document_create",
        json!({ "relativePath": "Notes/new.md", "contents": "# New\n" }),
    );
    assert_eq!(app.read("Notes/new.md"), "# New\n");

    app.refusal(
        "document_create",
        json!({ "relativePath": "Notes/new.md", "contents": "# Replaced\n" }),
    );
    assert_eq!(app.read("Notes/new.md"), "# New\n");
}

#[test]
fn a_document_larger_than_the_cap_is_not_read_into_memory() {
    let app = TestApp::opened();
    let huge = "x".repeat((crate::persistence::MAX_TEXT_BYTES + 1) as usize);
    std::fs::write(app.path("Notes/huge.md"), &huge).unwrap();

    assert!(app
        .refusal("document_read", json!({ "relativePath": "Notes/huge.md" }))
        .contains("maximum supported size"));
}

/* --------------------------------------------------------------------- facts */

#[test]
fn facts_come_from_the_file_rather_than_its_name() {
    let app = TestApp::opened();

    let image = app.call(
        "file_facts",
        json!({ "relativePath": "Attachments/square.png" }),
    );
    assert_eq!(image["kind"], "image");
    assert_eq!(image["width"], 64);
    assert_eq!(image["height"], 64);
    assert_eq!(image["external"], false);

    let note = app.call("file_facts", json!({ "relativePath": "Notes/note.md" }));
    assert_eq!(note["kind"], "markdown");
    assert_eq!(note["width"], Value::Null);

    // Named like an image, holding an ELF header.
    let payload = app.call(
        "file_facts",
        json!({ "relativePath": "Attachments/payload.png" }),
    );
    assert_eq!(payload["kind"], "unsupported");
}

#[test]
fn a_small_image_is_rendered_directly_and_a_large_one_is_cached() {
    let app = TestApp::opened();

    let small = app.call(
        "thumbnail_request",
        json!({ "relativePath": "Attachments/square.png" }),
    );
    assert_eq!(small["cached"], false);
    assert_eq!(small["relativePath"], "Attachments/square.png");

    let large = app.call(
        "thumbnail_request",
        json!({ "relativePath": "Attachments/wide.png" }),
    );
    assert_eq!(large["cached"], true);
    let path = large["relativePath"].as_str().unwrap().to_string();
    assert!(path.starts_with(".app/thumbnails/"));
    // 2048x512 scaled to a 512 long edge, aspect ratio kept.
    assert_eq!(large["width"], 512);
    assert_eq!(large["height"], 128);
    assert!(app.path(&path).exists());

    // Asking again reuses the file rather than decoding a second time.
    let again = app.call(
        "thumbnail_request",
        json!({ "relativePath": "Attachments/wide.png" }),
    );
    assert_eq!(again["relativePath"], path);

    for not_an_image in ["Notes/note.md", "Attachments/payload.png"] {
        app.refusal("thumbnail_request", json!({ "relativePath": not_an_image }));
    }
}

#[test]
fn a_probe_reports_the_container_and_whether_to_attempt_playback() {
    let app = TestApp::opened();

    let audio = app.call(
        "media_probe",
        json!({ "relativePath": "Attachments/tiny.mp3" }),
    );
    assert_eq!(audio["kind"], "audio");
    assert_eq!(audio["container"], "mp3");
    assert_eq!(audio["strategy"], "direct");
    assert_eq!(audio["size"], TINY_MP3.len());

    let video = app.call(
        "media_probe",
        json!({ "relativePath": "Attachments/tiny.mp4" }),
    );
    assert_eq!(video["kind"], "video");
    assert_eq!(video["strategy"], "direct");

    // A container no target webview handles is answered honestly, so the node
    // can offer the system player instead of failing silently.
    let matroska = app.call(
        "media_probe",
        json!({ "relativePath": "Attachments/tiny.mkv" }),
    );
    assert_eq!(matroska["kind"], "video");
    assert_eq!(matroska["container"], "mkv");
    assert_eq!(matroska["strategy"], "external-player");

    for not_media in ["Notes/note.md", "Attachments/square.png"] {
        app.refusal("media_probe", json!({ "relativePath": not_media }));
    }
}

/* ---------------------------------------------------------------- attachments */

#[test]
fn an_imported_file_is_copied_beside_the_canvas_and_the_original_is_left_alone() {
    let app = TestApp::opened();
    let source_dir = tempfile::tempdir().expect("a source directory");
    let source = source_dir.path().join("photo.png");
    let bytes = png(32, 48);
    std::fs::write(&source, &bytes).unwrap();

    let facts = app.call(
        "attachment_import",
        json!({ "request": {
            "sourcePath": source.to_string_lossy(),
            "targetDirectory": "Attachments",
        }}),
    );
    assert_eq!(facts["relativePath"], "Attachments/photo.png");
    assert_eq!(facts["width"], 32);
    assert_eq!(facts["height"], 48);
    assert_eq!(
        std::fs::read(app.path("Attachments/photo.png")).unwrap(),
        bytes
    );
    // Importing is a copy: the file the user chose is never touched.
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
}

#[test]
fn importing_the_same_name_twice_does_not_overwrite() {
    let app = TestApp::opened();
    let source_dir = tempfile::tempdir().expect("a source directory");
    let source = source_dir.path().join("square.png");
    std::fs::write(&source, png(16, 16)).unwrap();
    let existing = std::fs::read(app.path("Attachments/square.png")).unwrap();

    let first = app.call(
        "attachment_import",
        json!({ "request": {
            "sourcePath": source.to_string_lossy(),
            "targetDirectory": "Attachments",
        }}),
    );
    let second = app.call(
        "attachment_import",
        json!({ "request": {
            "sourcePath": source.to_string_lossy(),
            "targetDirectory": "Attachments",
        }}),
    );

    assert_eq!(first["relativePath"], "Attachments/square-1.png");
    assert_eq!(second["relativePath"], "Attachments/square-2.png");
    assert_eq!(
        std::fs::read(app.path("Attachments/square.png")).unwrap(),
        existing
    );
}

#[test]
fn an_import_is_refused_by_content_and_by_destination() {
    let app = TestApp::opened();
    let source_dir = tempfile::tempdir().expect("a source directory");

    let disguised = source_dir.path().join("nice.png");
    std::fs::write(&disguised, [0x7f, b'E', b'L', b'F', 2, 1, 1, 0]).unwrap();
    assert!(app
        .refusal(
            "attachment_import",
            json!({ "request": {
                "sourcePath": disguised.to_string_lossy(),
                "targetDirectory": "Attachments",
            }}),
        )
        .contains("not supported"));

    let fine = source_dir.path().join("fine.png");
    std::fs::write(&fine, png(8, 8)).unwrap();
    for destination in ["../outside", "/etc", ".app/thumbnails/../../outside"] {
        app.refusal(
            "attachment_import",
            json!({ "request": {
                "sourcePath": fine.to_string_lossy(),
                "targetDirectory": destination,
            }}),
        );
    }

    app.refusal(
        "attachment_import",
        json!({ "request": {
            "sourcePath": source_dir.path().join("missing.png").to_string_lossy(),
            "targetDirectory": "Attachments",
        }}),
    );
}

/* -------------------------------------------------------------------- symlinks */

#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_workspace_is_refused_until_the_user_authorizes_it() {
    let app = TestApp::opened();
    let outside = tempfile::tempdir().expect("a directory outside the workspace");
    std::fs::write(outside.path().join("secret.md"), b"# Secret\n").unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret.md"), app.path("link.md")).unwrap();

    assert!(app
        .refusal("document_read", json!({ "relativePath": "link.md" }))
        .contains("not authorized"));

    let authorized = app.call(
        "workspace_authorize_external",
        json!({ "path": outside.path().to_string_lossy() }),
    );
    assert_eq!(authorized.as_array().unwrap().len(), 1);

    let document = app.call("document_read", json!({ "relativePath": "link.md" }));
    assert_eq!(document["contents"], "# Secret\n");
    // Reading it says so, so the interface can show where the bytes came from.
    assert_eq!(
        app.call("file_facts", json!({ "relativePath": "link.md" }))["external"],
        true
    );

    // The authorization is remembered with the workspace, not just in memory.
    let settings = app.call("workspace_settings_read", json!({}));
    assert_eq!(
        settings["authorizedExternalPaths"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[cfg(unix)]
#[test]
fn authorizing_one_directory_does_not_authorize_another() {
    let app = TestApp::opened();
    let allowed = tempfile::tempdir().expect("an allowed directory");
    let other = tempfile::tempdir().expect("another directory");
    std::fs::write(other.path().join("secret.md"), b"secret").unwrap();
    std::os::unix::fs::symlink(other.path().join("secret.md"), app.path("other.md")).unwrap();

    app.call(
        "workspace_authorize_external",
        json!({ "path": allowed.path().to_string_lossy() }),
    );
    assert!(app
        .refusal("document_read", json!({ "relativePath": "other.md" }))
        .contains("not authorized"));
}

/* -------------------------------------------------------------------- recovery */

#[test]
fn a_draft_survives_until_it_is_cleared() {
    let app = TestApp::opened();
    assert_eq!(
        app.call("recovery_list", json!({}))
            .as_array()
            .unwrap()
            .len(),
        0
    );

    app.call(
        "recovery_write",
        json!({
            "relativePath": "Notes/note.md",
            "contents": "# Unsaved\n",
            "baseRevision": STALE,
        }),
    );

    let records = app.call("recovery_list", json!({}));
    let records = records.as_array().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["relativePath"], "Notes/note.md");
    assert_eq!(records[0]["contents"], "# Unsaved\n");
    assert_eq!(records[0]["baseRevision"], STALE);
    // A draft is cache, so it lives under `.app` and never beside the document.
    assert!(!app.path("Notes/note.md.recovery").exists());

    app.call("recovery_clear", json!({ "relativePath": "Notes/note.md" }));
    assert_eq!(
        app.call("recovery_list", json!({}))
            .as_array()
            .unwrap()
            .len(),
        0
    );
    // Clearing one that is already gone is not a failure.
    app.call("recovery_clear", json!({ "relativePath": "Notes/note.md" }));
}

#[test]
fn a_draft_path_is_validated_like_any_other() {
    let app = TestApp::opened();
    for escape in ["../outside.md", "/etc/passwd", "Notes/../../outside.md"] {
        app.refusal(
            "recovery_write",
            json!({ "relativePath": escape, "contents": "x", "baseRevision": "" }),
        );
    }
}

/* -------------------------------------------------------------------- external */

/// Only the refusals are exercised: a URL or path that passes validation
/// launches the platform opener, which a test has no business doing.
#[test]
fn opening_something_outside_is_refused_before_anything_is_launched() {
    let app = TestApp::opened();

    for url in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,<script>",
        "-hello",
        "smb://host/share",
    ] {
        assert!(app
            .refusal("external_open_url", json!({ "url": url }))
            .contains("not supported"));
    }

    for path in ["../outside.md", "/etc/passwd", "Notes/../../outside.md"] {
        app.refusal("external_open_path", json!({ "relativePath": path }));
        app.refusal("reveal_in_file_manager", json!({ "relativePath": path }));
    }

    // Inside the workspace but not there at all.
    assert_eq!(
        app.refusal(
            "external_open_path",
            json!({ "relativePath": "Notes/missing.md" })
        ),
        "path does not exist"
    );
}

/* ------------------------------------------------------------------ app facts */

#[test]
fn facts_tell_the_frontend_what_it_cannot_work_out_for_itself() {
    let app = TestApp::opened();
    let facts = app.call("app_facts", json!({}));

    assert_eq!(facts["protocolScheme"], "ic");
    if cfg!(windows) {
        assert_eq!(facts["protocolHost"], "http://ic.localhost");
    } else {
        assert_eq!(facts["protocolHost"], "ic://localhost");
    }
    assert_eq!(facts["platform"], std::env::consts::OS);
    assert!(facts["version"]
        .as_str()
        .unwrap()
        .starts_with(char::is_numeric));

    // Where media is fetched from is Rust's answer, and it is the loopback
    // server exactly where the webview will not decode from `ic://`.
    let origin = facts["mediaOrigin"].as_str();
    if crate::media::server::is_needed() {
        let origin = origin.expect("a media origin on a platform that needs one");
        assert!(origin.starts_with("http://127.0.0.1:"));
        // The token is part of the origin, not something the frontend adds.
        assert_eq!(origin.rsplit('/').next().unwrap().len(), 64);
    } else {
        assert_eq!(origin, None);
    }
}

/* ------------------------------------------------- the directory on the command line */

mod arguments {
    use super::super::resolve_workspace_argument;

    #[test]
    fn absolute_directory_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let expected = std::fs::canonicalize(dir.path()).unwrap();
        let resolved = resolve_workspace_argument(dir.path().to_str().unwrap(), None);
        assert_eq!(resolved, Some(expected.to_string_lossy().to_string()));
    }

    #[test]
    fn relative_directory_resolves_against_the_launch_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("notes")).unwrap();
        let expected = std::fs::canonicalize(dir.path().join("notes")).unwrap();
        let resolved = resolve_workspace_argument("notes", Some(dir.path()));
        assert_eq!(resolved, Some(expected.to_string_lossy().to_string()));
    }

    /// Without `OWD` a relative argument resolves against the process working
    /// directory, which inside an AppImage is the mounted bundle rather than
    /// where the user typed the command.
    #[test]
    fn relative_directory_is_not_found_without_a_launch_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("notes")).unwrap();
        assert_eq!(resolve_workspace_argument("notes", None), None);
    }

    #[test]
    fn launch_directory_is_ignored_for_absolute_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let expected = std::fs::canonicalize(dir.path()).unwrap();
        let resolved = resolve_workspace_argument(dir.path().to_str().unwrap(), Some(other.path()));
        assert_eq!(resolved, Some(expected.to_string_lossy().to_string()));
    }

    #[test]
    fn flags_and_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(resolve_workspace_argument("--help", Some(dir.path())), None);
        assert_eq!(
            resolve_workspace_argument("note.md", Some(dir.path())),
            None
        );
        assert_eq!(
            resolve_workspace_argument("missing", Some(dir.path())),
            None
        );
    }
}

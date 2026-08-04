# ic

An offline-first infinite canvas for arranging and editing knowledge: Markdown,
documents and media on one surface, stored as ordinary files.

The whole window is the canvas. There is no sidebar, no toolbar and no menu
bar — commands live in the command palette (`Ctrl+P` / `Cmd+P`), and the few
buttons that exist appear only when the pointer is over a node. Hovering a node
shows a connection dot centred on each of its four sides; dragging one draws an
arrow.

Canvases are [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) and notes are
plain Markdown, so a workspace opens in Obsidian Canvas and other compatible
applications without conversion.

## Priorities

1. Security  2. Simplicity  3. Extensibility  4. Performance

No network access, no scripting, no plugins, no executable nodes, no accounts,
no telemetry. Opening a workspace never executes anything. See
[docs/security-model.md](docs/security-model.md).

## Requirements

- Node 22+ and Yarn
- Rust 1.77+
- Linux additionally needs `webkit2gtk-4.1` development packages

## Running

```sh
yarn install
node scripts/prepare-assets.mjs   # copies PDF.js runtime assets into public/
yarn app:dev                      # development window with hot reload
yarn app:build                    # installers in src-tauri/target/release/bundle
```

Open a directory with `Open workspace…` from the palette, or pass one on the
command line:

```sh
ic ~/notes
```

The first time a workspace is opened the application asks whether to reopen it
next time; nothing is remembered without that consent.

## Workspace

```
Workspace/
├── Notes/          Markdown
├── Canvases/       .canvas files
├── Attachments/    images, PDFs, audio, video
└── .app/           caches, recovery, settings — safe to delete
```

Everything outside `.app` is canonical user data. Uninstalling the application
does not touch it, and deleting `.app` loses nothing but caches.

## What it does

- Inline Markdown nodes, plain text and title boxes, Markdown file nodes
- PDF viewing, images with thumbnails, MP4/WebM video, audio
- Link nodes, groups, labelled and coloured arrows with four connection sides
- Obsidian-compatible document colours (presets `1`–`6` plus custom hex)
- White light theme and true-black dark theme
- CodeMirror editing with an optional Vi Lite mode
- Command palette with fuzzy search and shortcut display
- Operation-based undo/redo, debounced autosave, atomic writes, crash recovery
- External-edit detection with explicit conflict resolution

Not in this release, deliberately: scripting, plugins, program nodes,
collaboration, sync, mobile, freehand drawing, embedded web pages. See
[PLAN.md](PLAN.md).

## Tests

```sh
yarn test        # TypeScript: JSON Canvas round-trip, undo/redo, commands, sanitization
yarn test:rust   # Rust: path traversal, symlink policy, atomic writes, sniffing, ranges
```

Performance fixtures (100, 500, 1000 nodes; 1000 edges; media) are generated
with `node scripts/make-fixtures.mjs` into `fixtures/performance/`.

## Verification status

Linux (X11, WebKitGTK 2.48) was exercised end to end under Xvfb: opening a
workspace, the palette, the file picker, loading an Obsidian-style canvas,
rendering every node type, editing inline and file-backed Markdown nodes, Vi
mode (insert, normal, motions, `x`, `dd`, `o`, visual), repeatedly entering and
leaving editors, undo and redo, the resulting atomic write with unknown vendor
fields preserved, the 500-node performance fixture, and the theme toggle. The
release build was verified to run with no dev server and no network, serving its
embedded frontend under the production content security policy.

A render error no longer empties the window: an error boundary and a global
handler draw an overlay naming the failure and offering a reload
(`src/shared/fatal.ts`).

One intermittent defect is open and not yet reproducible: a file node
occasionally stays on `Reading file`, which is its `fileFacts` request never
settling. It has only been seen after the window reloaded mid-request, and it
clears on reload.

Windows (WebView2) and macOS (WKWebView) build in CI but have not been run
interactively here; the Milestone 0 cross-platform questions in `PLAN.md` —
`Escape` ordering, PDF.js consistency, video behaviour under transforms — remain
open on those targets.

## Documentation

- [docs/architecture.md](docs/architecture.md)
- [docs/security-model.md](docs/security-model.md)
- [docs/file-format.md](docs/file-format.md)
- [docs/keyboard-model.md](docs/keyboard-model.md)
- [docs/media-roadmap.md](docs/media-roadmap.md)

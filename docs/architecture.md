# Architecture

```
React frontend (webview)
├── Canvas UI            src/canvas/CanvasView.tsx
├── Node components      src/canvas/node-types/
├── Markdown editor      src/editor/
├── PDF viewer           src/media/PdfNode.tsx
├── Media controls       src/media/
├── Command palette      src/command-palette/
├── Theme system         src/theme/
└── Application state    zustand stores
        │
        │ narrow typed commands (src/shared/ipc-types.ts)
        │ read-only ic:// protocol for file bytes
        ▼
Rust core (src-tauri/src)
├── Workspace service    workspace/
├── File validation      security/
├── Atomic persistence   persistence/
├── File watcher         workspace/watcher.rs
├── Thumbnail service    thumbnails/
├── Security policy      security/
└── Media service        media/   (probing only in this release)
```

## Division of responsibility

The webview owns presentation and transient interaction state. It has no
filesystem access, no shell access and no network capability: every privileged
operation is a named Rust command that validates its own arguments.

| Concern | Owner |
| --- | --- |
| Rendering, selection, dragging, editor state, keyboard routing | Frontend |
| Path resolution, symlink policy, reading and writing files | Rust |
| Revision tracking, atomic writes, crash recovery | Rust |
| File watching, thumbnails, content sniffing | Rust |
| Opening external URLs and files | Rust |
| Native window state (fullscreen) | Rust |

## State

Three layers, deliberately separated:

1. **Canonical document** — `CanvasDocument` in `src/shared/json-canvas.ts`.
   Exactly what is written to `.canvas` files. Nothing else is persisted there.
2. **Interaction state** — selection, the active node, hover, drag previews,
   playback, viewport, fit mode. Lives in stores beside the document and is
   never serialized into a canvas.
3. **Workspace state** — the open directory, its file tree, and
   `.app/workspace-settings.json` (last canvas, per-canvas viewport, authorized
   external paths, UI preferences).

There is no database. `.app/` holds only rebuildable caches, recovery copies and
settings; deleting it loses no user content.

## Mutation and undo

Every change to the canonical document goes through `mutate(op)` in
`src/canvas/canvas-store.ts`. Operations (`src/canvas/history.ts`) are
invertible against the document they were applied to, so undo never snapshots a
whole canvas. Geometry is committed once, at the end of a drag or resize, and
consecutive text edits within 700 ms coalesce into one undo step.

## Rendering path

`canvas-adapter.ts` converts the document into React Flow nodes and edges.
React Flow fields exist only on that side of the boundary. Node array order is
z-order; groups are given a lower `zIndex` so they stay behind their contents
without reordering the document.

Only the active node mounts an editor or a full viewer. Everything else renders
a lightweight preview: sanitized HTML for Markdown, a cached thumbnail for
images, a single rendered page for PDFs, and a metadata-only media element for
video and audio.

### Single ownership

Two pieces of state are shared with a component that also owns them, and each
needs an explicit rule about who wins. Both rules exist because breaking them
produced an endless render loop that emptied the window.

**Which elements are selected** belongs to React Flow while the user is
interacting. `reportSelection` records what it says; the adapter never writes
`selected` back, and a rebuild carries the existing flags across. A command that
wants a particular selection raises `selectionRequest`, whose identity changes
only when something asks, so applying it cannot be mistaken for a report.

**The text in an editor** belongs to CodeMirror while it is mounted. Every
keystroke travels up to the store and returns as a new value, so an incoming
value is usually an echo rather than an external change. `echo-guard.ts` counts
the edits whose echo has not yet returned; only a value that arrives with none
outstanding is treated as an external write and adopted.

## File bytes

Media never crosses the IPC boundary as serialized data. The `ic://` protocol
handler in `src-tauri/src/lib.rs` streams files that resolve inside the open
workspace, supports HTTP range requests so seeking a large video does not buffer
the whole file, and refuses anything whose sniffed type is not renderable.

## Extension boundaries

The plan defers scripting, program nodes and extensions. The seams that would
host them exist but are empty:

- `media/` is a service boundary; remuxing, proxy transcoding and a native
  player fit behind `media_probe` without changing the frontend contract.
- Commands are a registry; a future capability system would gate registration.
- The canvas model preserves unknown fields, so another application's node
  metadata survives a round trip.

Nothing speculative is built for those features.

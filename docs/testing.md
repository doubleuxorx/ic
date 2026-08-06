# Testing

Three layers, of which only the last needs a display. The split is deliberate:
each layer answers a question the layers below it cannot, and every layer runs
from one command.

```
cargo test   Rust: commands, ic:// handler, media server, watcher   no display
yarn test    frontend: nodes, stores, every palette command         no display
self-test.sh the real webview: decode, paint, play, CSP             Xvfb
```

## Rust, headless

`cargo test` builds the whole application on Tauri's mock runtime — the real
commands from `configure()`, the real managed state, the real protocol handler —
with no window and no display. `src-tauri/src/test_support.rs` is the seam:
`TestApp::opened()` gives an application with a temporary workspace of fixtures
open, and `invoke(command, json)` calls a command exactly as the webview does.

What it covers: every command against real files, and every refusal — traversal,
absolute paths, a symlink out of the workspace before and after authorization,
paths under `.app`, unsupported content, a stale revision, a canvas that is not a
canvas, no workspace open. The `ic://` handler's real responses, headers
included. The media server started for real and driven over TCP. The watcher
against a real directory, including that the application's own reads and its own
cache writes are not reported as changes.

Three details cost an afternoon each if rediscovered: the invoke URL must be
`tauri://localhost`, or the request counts as a remote origin and the ACL refuses
the application's own commands; the setup hook does not run when an
application is built, only when its event loop first reports itself ready, which
under the mock runtime is one iteration; and on Windows the test executable needs
the application manifest that `build.rs` embeds, or it does not load at all —
`STATUS_ENTRYPOINT_NOT_FOUND`, before any test runs.

## Frontend, in jsdom

`yarn test` runs vitest. Files that render declare `// @vitest-environment jsdom`;
`tests/support/` holds the four pieces they share:

- `render.tsx` — `createRoot` plus `act`, with queries and cleanup. No testing
  library is involved.
- `fake-ipc.ts` — every command over an in-memory workspace, with SHA-256
  revisions as Rust computes them, so a conflict happens for the same reason it
  happens in the application.
- `fake-events.ts` — the Tauri events Rust sends the window, and the window it
  sends them to, so the watcher, drag-and-drop and the close request can be
  driven at all.
- `dom-stubs.ts` — the geometry and observers jsdom lacks, loaded through
  `setupFiles` because React Flow and PDF.js reach for them while they load.

Two seams in the application itself mean the real paths run rather than mocked
ones: a modal request carries its own `resolve`, so a test answers a prompt the
way a user does, and `setFlowInstance` accepts a stub for the view commands.

`tests/commands.test.tsx` runs all ~50 palette commands for their effect and
fails when a registered command has no entry in its table, so a command added
later cannot go untested. What jsdom cannot do is lay out, paint or decode, so
tests there assert what the application *did*, never what it looked like.

## The real webview

`sh scripts/self-test.sh` is the only test that runs in a browser, and the only
one that can see a failure inside WebKitGTK. It exists because one shipped:
audio and video served from `ic://` never reached a decoder on Linux, and nothing
in the window said so.

It starts the dev server in vite's `selftest` mode, runs the debug binary under
Xvfb with a scratch workspace as its only argument, and the window then tests
itself: `src/self-test/runner.ts` mounts a real node per fixture and asks the
browser for its own numbers — `naturalWidth`, `duration`, `currentTime`
advancing, the pixels on the PDF canvas — collects any
`securitypolicyviolation`, and writes a report into the scratch workspace with
the ordinary `document_create` command. No command exists for testing, and the
harness is selected by build mode, so a release bundle contains neither.

No synthetic input is involved: no xdotool, no screenshots, nothing compared by
eye. A display is, though — WebKitGTK has no headless mode.

## What is still manual

Visual appearance, theme and layout; real input devices, including trackpad
gestures and IME; native dialogs; multi-monitor and HiDPI; macOS and Windows
webview behaviour beyond the first two layers, which do run there; and
performance, for which `fixtures/performance/` holds canvases of increasing size.

# Security model

Security is the first priority in this project, ahead of simplicity,
extensibility and performance.

## Threat model

Assumed hostile:

- Every file in a workspace: Markdown, canvases, PDFs, images, audio and video
  may be crafted by an attacker and arrive by download, sync or shared drive.
- Every path, URL and identifier that reaches a Rust command from the webview.

Assumed trusted:

- The user, the operating system, and the directory the user explicitly chose.
- The application's own bundled code.

Out of scope: a compromised operating system, an attacker with write access to
the installed application, and physical access.

## Invariants

1. **Opening a workspace or canvas never executes anything.** There is no
   scripting engine, no plugin loader, no program node and no shell access.
2. **No network.** The application makes no outbound requests, and the only
   socket it listens on is the loopback media server described below. Every
   asset —
   PDF.js and its worker, character maps, standard fonts, WASM decoders, fonts,
   styles — is bundled locally. Remote images referenced from Markdown are
   dropped rather than fetched.
3. **The webview has no general filesystem access.** No `fs`, `shell`, `http`
   or `process` plugin is enabled. The capability file grants only core events
   and the native file picker.
4. **Every command validates its own arguments**, regardless of what the
   runtime authority already checked.
5. **No command exists for testing.** The webview self-test
   (`docs/testing.md`) reports by writing a text file through the same validated
   `document_create` and `document_write` the editor uses, and its harness is
   selected by build mode,
   so a release bundle contains neither it nor any extra privileged surface.

## Path handling

`src-tauri/src/security/paths.rs` is the only place relative paths are resolved.

- Absolute paths, drive prefixes, `..` components, `:` in a component and NUL
  bytes are rejected before touching the filesystem.
- Both `/` and `\` are treated as separators on every platform, so a
  Windows-style path cannot smuggle a component past the checks.
- Existing paths are canonicalized, which resolves symlinks, and the result must
  be inside the workspace root. Paths that do not exist yet are checked against
  their nearest existing parent, so new files can be created without weakening
  the check.
- **Symlink policy:** a link resolving outside the workspace is refused. The
  user can authorize a specific external target through
  `workspace_authorize_external`; authorizations are stored in workspace
  settings and re-checked on every access. Directory listings never descend
  through symlinks at all.

Covered by tests in `paths.rs`, including a file symlink and a directory
symlink escaping the workspace.

## File type handling

Extensions decide what is *offered*; content decides how a file is *rendered*
(`security/kinds.rs`). A `.png` containing a PDF is treated as a PDF, and a file
whose magic bytes match nothing renderable is refused rather than handed to a
viewer. The `ic://` handler applies the same check before serving bytes.

## Writing files

`persistence/` never truncates a file in place:

1. Write to a temporary file in the same directory.
2. Flush and `fsync`.
3. Rename over the target.
4. `fsync` the directory so the rename itself is durable.

If the rename fails, the temporary file is left behind and the previous version
of the target is untouched, so content is always recoverable.

Every write carries the revision (SHA-256 of the bytes) the caller last saw. A
mismatch means the file changed externally: the write is refused and the
conflict is surfaced with both versions, never silently resolved. Text documents
are capped at 16 MiB so a hostile file cannot exhaust memory through IPC.

## Markdown

- The parser runs with raw HTML disabled.
- Output is sanitized again with DOMPurify against an explicit tag and attribute
  allowlist; `script`, `style`, `iframe`, `object`, `embed`, `form`, `input`,
  `svg` and `math` are removed, along with `style` and every event-handler
  attribute.
- Links are rendered **inert**: the `href` is moved to `data-href`, so a click
  cannot navigate the webview. Opening one requires a confirmation dialog that
  shows the full URL, and only `https:`, `http:` and `mailto:` are accepted.
- Relative images resolve to workspace files through `ic://`; remote and `data:`
  images are dropped.

Covered by `tests/markdown.test.ts`, which asserts against the parsed DOM.

## PDFs

PDF.js's core API and worker are bundled locally. Neither is modified: the worker
the application ships is PDF.js's own with one thing loaded ahead of it,
`src/shared/map-upsert.ts`, which adds `Map.prototype.getOrInsert` and its
computed form where the engine lacks them. Without it PDF.js 6 cannot open a
document at all on WebKitGTK 2.48. The application renders pages
directly to a canvas; it does not instantiate PDF.js's annotation or scripting
layers, does not ship the QuickJS sandbox assets, and disables XFA rendering.
PDFs nevertheless remain hostile input to the parser and bundled image/colour
WASM decoders.

PDFs are served through the same validated protocol as other files and are
limited to 128 MiB. PDF.js rejects individual images above 16 megapixels and is
asked to resize oversized image-conversion canvases; the visible page canvas is
capped at 16 megapixels and 8192 pixels per dimension. Each document owns an
explicit native worker—fake-worker fallback to the UI thread is not allowed.
Loading and complete page operations have a 30-second deadline; PDF.js gets a
short cleanup grace period before the worker is forcibly terminated. A local
protocol read already in progress may still complete within the 128 MiB file
limit, and PDF.js may create other internal scratch canvases, so these are risk
reductions rather than total memory or CPU bounds.

Streaming and automatic pre-fetching are disabled. The Windows HTTP custom
protocol can use range requests to fetch only required chunks. PDF.js does not
range-load the non-HTTP `ic://` scheme used on macOS and Linux, so those platforms
buffer the complete document subject to the 128 MiB limit. These protections do
not replace prompt PDF.js and webview security updates.

## Loopback media server

WebKitGTK decodes media through GStreamer, which fetches only the schemes it
knows, so nothing served from `ic://` ever reaches a decoder there. On that
platform, and only there, `media/server.rs` serves audio and video over HTTP
instead. It listens on `127.0.0.1` on a port the kernel chooses, so nothing off
the machine can reach it, and it is subject to the same rules as everything else
plus its own:

- every request path begins with a 32-byte token from the system generator,
  compared without revealing where two tokens differ, so another local process
  cannot read workspace files by guessing the port;
- a `Host` header naming anything other than the address it listens on is
  refused, as is an `Origin` outside the same allowlist the `ic://` handler uses;
- only `GET` and `HEAD`, and only one range per request;
- paths are resolved by the open workspace and sniffed for content exactly as the
  protocol handler does, and **only audio and video are served** — a note, a
  canvas, an image or anything under `.app` is refused even with the token;
- nothing is served while no workspace is open;
- responses carry the same `no-store`, `nosniff` and `default-src 'none';
  sandbox` headers as the protocol handler, and always a `Content-Length`.

Requests are answered by a fixed, small pool of threads, so no client can make
the process spawn threads without end. Failing to listen is not fatal: media
falls back to `ic://`, and a node whose source the webview refuses offers the
system player.

Covered by tests in `media/server.rs` for the token, the path split and the kinds
served.

## External opening

`commands/external.rs` never invokes a shell. The platform opener is executed
directly with one argument. URLs are length-limited, rejected if they contain
control characters or start with `-`, and must use `https:`, `http:` or
`mailto:`. Paths must resolve inside the workspace.

## Content Security Policy

```text
default-src 'none';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' ic: http://ic.localhost data: blob:;
media-src 'self' ic: http://ic.localhost http://127.0.0.1:* blob:;
font-src 'self' data:;
connect-src 'self' ic: http://ic.localhost ipc: http://ipc.localhost;
worker-src 'self' blob:;
object-src 'none'; frame-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

No remote origin appears anywhere in it: `http://127.0.0.1:*` is the loopback
media server above, whose port is only known to this process and whose paths need
its token. `'wasm-unsafe-eval'` is required by
PDF.js image decoders; unlike `'unsafe-eval'`, it permits WebAssembly compilation
but not JavaScript evaluation. `'unsafe-inline'` for styles is required by
CodeMirror and React Flow, which set element styles directly; it grants no
script execution.

Responses from the `ic://` handler carry `default-src 'none'; sandbox`,
`X-Content-Type-Options: nosniff`, and an `Access-Control-Allow-Origin` echoed
only for the application's own origins.

## Known trade-off: `freezePrototype`

Tauri's `freezePrototype` hardening is **off**. It freezes `Object.prototype`,
which breaks `d3-color` — a transitive dependency of React Flow — at import
time (`prototype.constructor = constructor` throws), leaving a blank window.

This is acceptable here because prototype pollution needs attacker-controlled
JavaScript, and there is no path to executing any: no remote scripts, no `eval`,
a strict CSP, sanitized Markdown, no plugin runtime and no scripting engine.
Revisit if a dependency ever gains a JS execution surface.

## Patched dependency: `glib` 0.18.5

RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g) reports unsoundness in
`glib::VariantStrIter`: a C out-argument was passed as `&p` instead of `&mut p`,
so optimizing builds of current rustc discard the write and the iterator then
dereferences NULL. Reproduced here as a SIGSEGV on rustc 1.96.1 with the release
profile.

The advisory cannot be resolved by upgrading. Upstream fixed it in glib 0.20,
but gtk3-rs never went past 0.18 and every WebKitGTK crate under Tauri —
`gtk`, `gdk`, `webkit2gtk`, `tao`, `muda`, `wry` — pins glib 0.18. Tauri tracks
this as an upstream problem and closed
[tauri-apps/tauri#12048](https://github.com/tauri-apps/tauri/issues/12048) as
not planned, pending its GTK 4 migration.

Instead of accepting the advisory, `src-tauri/third_party/glib-0.18.5` vendors
the published crate with the upstream one-line fix applied, wired in through
`[patch.crates-io]`. Provenance, the exact diff and how to verify it are in
`src-tauri/third_party/README.md`. Nothing in the dependency graph constructs a
`VariantStrIter` today, so this closes a latent crash rather than a live one.

## Operational rules

- Do not run the application as administrator or root.
- Native libraries are never loaded from a workspace.
- Dependency auditing runs in CI (`.github/workflows/ci.yml`): `cargo audit` for
  Rust and `yarn npm audit` for JavaScript.
- Release builds ship no source maps and no debug assets.

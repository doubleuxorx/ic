# Implementation Plan: Offline-First Infinite Canvas Knowledge App

## 1. Product Goal

Build a secure, simple, offline-first desktop application for arranging and editing knowledge on an infinite canvas.

The application should combine the strongest parts of:

* Obsidian Canvas
* Markdown note-taking
* Mind maps
* Lightweight whiteboarding
* Local document and media viewing

Priority order:

1. **Security**
2. **Simplicity**
3. **Extensibility**
4. **Performance**

The first stable release must work well as a note-taking and canvas application without scripting, extensions, executable nodes, or visual programming.

---

## 2. Assumptions

* Target desktop platforms are Windows, macOS, and Linux.
* All user content remains local unless the user explicitly exports or opens a link.
* A workspace is an ordinary directory owned by the user.
* Markdown files and JSON Canvas files are the canonical data.
* The application has no required account, cloud service, background server, or network connection.
* The initial implementation prioritizes interoperability and reliability over advanced visual effects.
* React and React Flow will be used unless an early technical spike reveals a blocking limitation.

---

## 3. Chosen Technology Stack

### Desktop shell

* **Tauri 2**
* **Rust** for privileged operations, filesystem access, media process management, file watching, and application commands
* Use Tauri’s native window fullscreen APIs rather than the browser Fullscreen API. Tauri exposes native fullscreen state through `setFullscreen` and `isFullscreen`. ([Tauri][1])

### Frontend

* **Vite**
* **React**
* **TypeScript**
* **React Flow / `@xyflow/react`**

React Flow supports custom interactive node components, connection handles, parent-child relationships, groups, subflows, viewport controls, and visible-element rendering. These capabilities match document cards, media cards, arrows, and visual groups. ([React Flow][2])

### Editing and rendering

* **CodeMirror 6** for Markdown editing
* A locally bundled Markdown parser and renderer
* Raw HTML disabled by default
* Sanitization applied to any HTML that is intentionally supported
* **PDF.js**, bundled locally, for consistent PDF rendering inside canvas nodes; PDF.js provides a display layer and viewer components suitable for building an embedded viewer. ([mozilla.github.io][3])

### State

Begin with:

* A small application store, preferably Zustand
* React Flow state adapted from the canonical JSON Canvas document
* No database in the initial implementation

Add a rebuildable SQLite search index only when workspace size or search performance justifies it.

---

## 4. Canonical Workspace Layout

Use ordinary files and directories:

```text
Workspace/
├── Notes/
│   ├── Example.md
│   └── Project.md
├── Canvases/
│   └── Main.canvas
├── Attachments/
│   ├── image.png
│   ├── document.pdf
│   └── video.mp4
└── .app/
    ├── recovery/
    ├── thumbnails/
    ├── media-cache/
    └── workspace-settings.json
```

Rules:

* Markdown notes remain normal `.md` files.
* Canvases remain normal `.canvas` JSON files.
* Attachments remain in their original formats.
* The `.app` directory contains only rebuildable caches, recovery data, and application-specific settings.
* Never make a proprietary database the sole source of truth.
* Never alter or permanently convert original media merely to display it.
* Paths stored in `.canvas` files should be workspace-relative whenever possible.

---

## 5. JSON Canvas Compatibility

Implement JSON Canvas 1.0 as the canonical canvas format.

The specification defines:

* `text` nodes
* `file` nodes
* `link` nodes
* `group` nodes
* Directed or undirected edges
* Edge labels
* Node and edge colors
* Six portable preset color identifiers and arbitrary hexadecimal colors ([JSON Canvas][4])

### Compatibility rules

* Read and write valid JSON Canvas 1.0.
* Do not persist React Flow-specific fields in `.canvas` files.
* Preserve unknown fields when loading and saving where practical.
* Preserve node array order because it represents z-order.
* Use integer coordinates and dimensions when writing files.
* Generate stable, unique string IDs.
* Store viewport position and zoom in workspace settings rather than inventing required JSON Canvas fields.
* Avoid proprietary node types during the initial releases.

### Node mappings

| Application entity       | JSON Canvas representation        |
| ------------------------ | --------------------------------- |
| Inline Markdown card     | `text` node                       |
| Plain text/title box     | `text` node containing plain text |
| Markdown file            | `file` node referencing `.md`     |
| PDF                      | `file` node referencing `.pdf`    |
| Image                    | `file` node referencing the image |
| Video                    | `file` node referencing the video |
| Audio                    | `file` node referencing the audio |
| URL                      | `link` node                       |
| Visual container         | `group` node                      |
| Arrow or relationship    | `edge`                            |
| Relationship description | Edge `label`                      |

Plain text is valid inside a JSON Canvas text node because the field is plain text that may contain Markdown syntax. A title box therefore does not require a proprietary node type. ([JSON Canvas][4])

---

## 6. Initial Product Scope

### Required node types

1. **Inline Markdown node**

   * Stores Markdown directly in the canvas file
   * Preview mode
   * Editing mode
   * Resizable
   * Searchable

2. **Markdown file node**

   * References an external `.md` file
   * Shows rendered preview when inactive
   * Opens CodeMirror when activated
   * Updates the original Markdown file

3. **Plain text/title node**

   * Optimized for labels, headings, annotations, and relationship descriptions
   * Does not expose Markdown formatting controls
   * Stored as an ordinary JSON Canvas text node

4. **PDF node**

   * Shows first-page thumbnail when small or inactive
   * Opens an embedded PDF.js viewer when activated
   * Supports page navigation and zoom
   * Does not execute embedded PDF JavaScript

5. **Image node**

   * Supports common webview-compatible image formats initially
   * Preserves aspect ratio by default
   * Supports fit, fill, and original-size modes
   * Generates cached thumbnails for large images

6. **Video node**

   * Initial support through an ordinary HTML `<video>` element
   * Support webview-compatible MP4 and WebM files first
   * Show poster frame, duration, filename, and playback controls
   * Only actively play selected or explicitly started video nodes

7. **Group node**

   * Visual container
   * Optional title
   * Optional color
   * Moving a group moves its contained nodes
   * Group behavior must remain compatible with JSON Canvas semantics

8. **Edges**

   * Arrow at either end
   * Optional label
   * Optional color
   * Connection points on top, right, bottom, and left
   * Selectable and removable
   * Reconnectable

---

## 7. Explicit Non-Goals for the Initial Release

Do not implement the following during the first release cycle:

* Extension marketplace
* Third-party plugins
* Lua, Python, JavaScript, or other embedded scripting
* Program or executable nodes
* Typed program inputs and outputs
* Nested executable graphs
* Shell-command nodes
* Collaborative editing
* Accounts or cloud synchronization
* Mobile applications
* Full Excalidraw-style freehand drawing
* General-purpose WYSIWYG block editing
* Native libmpv surfaces positioned over every video node
* Arbitrary web pages embedded inside canvas nodes
* Remote CDN dependencies
* Background telemetry

Create architectural boundaries that permit later investigation, but do not build speculative infrastructure for these features yet.

---

## 8. Application Architecture

```text
React frontend
├── Canvas UI
├── Node components
├── Markdown editor
├── PDF viewer
├── Media controls
├── Command palette
├── Theme system
└── Application state
        │
        │ Narrow typed Tauri commands
        ▼
Rust core
├── Workspace service
├── File validation
├── Atomic persistence
├── File watcher
├── Thumbnail service
├── Security policy
└── Media service
    └── Added progressively
```

### Frontend responsibilities

* Rendering the canvas
* Temporary interaction state
* Selection
* Dragging and resizing
* Keyboard routing
* Editor state
* Command palette UI
* Theme presentation
* Media controls
* Converting canonical canvas data to React Flow data

### Rust responsibilities

* Opening workspaces
* Validating workspace paths
* Reading and writing files
* Preventing path traversal
* Handling symlinks deliberately
* Atomic writes and recovery
* File watching
* Thumbnail generation
* Launching approved media tools in later phases
* Native window management
* Security-sensitive validation

### IPC rule

Never expose a generic command such as:

```text
run_shell(command)
read_any_file(path)
write_any_file(path, data)
```

Expose narrow operations such as:

```text
workspace_open()
workspace_list_directory(relative_path)
document_read(relative_path)
document_write(relative_path, expected_revision, contents)
canvas_write(relative_path, expected_revision, document)
thumbnail_request(file_token)
window_toggle_fullscreen()
```

Every Rust command must independently validate its inputs.

---

## 9. Repository Structure

```text
/
├── src/
│   ├── app/
│   │   ├── App.tsx
│   │   ├── routes.ts
│   │   └── commands.ts
│   ├── canvas/
│   │   ├── CanvasView.tsx
│   │   ├── canvas-store.ts
│   │   ├── canvas-adapter.ts
│   │   ├── selection.ts
│   │   ├── history.ts
│   │   └── node-types/
│   ├── editor/
│   │   ├── MarkdownEditor.tsx
│   │   ├── markdown-renderer.ts
│   │   └── vi-mode.ts
│   ├── media/
│   │   ├── ImageNode.tsx
│   │   ├── VideoNode.tsx
│   │   ├── AudioNode.tsx
│   │   └── PdfNode.tsx
│   ├── command-palette/
│   │   ├── CommandPalette.tsx
│   │   └── command-registry.ts
│   ├── theme/
│   │   ├── theme.css
│   │   └── theme-store.ts
│   ├── workspace/
│   │   ├── FileTree.tsx
│   │   └── workspace-store.ts
│   └── shared/
│       ├── json-canvas.ts
│       ├── ipc-types.ts
│       └── errors.ts
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/
│   │   ├── workspace/
│   │   ├── persistence/
│   │   ├── security/
│   │   ├── thumbnails/
│   │   └── media/
│   ├── capabilities/
│   └── tauri.conf.json
├── tests/
├── fixtures/
└── docs/
    ├── architecture.md
    ├── security-model.md
    ├── file-format.md
    ├── keyboard-model.md
    └── media-roadmap.md
```

---

## 10. Milestone 0: Technical Validation

Before building the full application, create a disposable vertical prototype.

### Prototype requirements

* Tauri window starts successfully.
* Vite, React, and TypeScript compile.
* React Flow renders at least:

  * One text node
  * One image node
  * One edge
  * One group
* CodeMirror edits Markdown inside a node.
* PDF.js renders one test PDF.
* An MP4 or WebM video plays inside a node.
* A workspace-relative file can be loaded through a secure Rust-mediated mechanism.
* Light and dark themes switch correctly.
* A native fullscreen command works.
* The prototype is tested on all three target operating systems before architecture is considered stable.

### Validation questions

* Does editing inside a node conflict with canvas dragging?
* Does wheel input scroll the editor or zoom the canvas correctly based on focus?
* Does a video remain positioned correctly during pan and zoom?
* Does PDF.js behave consistently across WebView2, WKWebView, and WebKitGTK?
* Does CodeMirror receive Escape before native fullscreen behavior on each platform?
* Do large images cause unacceptable memory use?
* Does React Flow preserve acceptable interaction performance with 500 simple nodes?

### Exit criterion

Proceed only after any cross-platform blockers are documented with an agreed fallback.

---

## 11. Milestone 1: Workspace and Persistence

### Tasks

* Implement workspace selection through a native directory picker.
* Store the last opened workspace only after explicit user approval.
* Build a recursive file tree for supported files.
* Ignore `.app` caches in normal file browsing.
* Implement secure relative-path resolution.
* Reject paths escaping the workspace.
* Define a deliberate symlink policy:

  * Default: do not follow symlinks outside the workspace.
  * Allow external targets only after explicit authorization.
* Implement atomic file writes:

  1. Write temporary file.
  2. Flush data.
  3. Replace target atomically where supported.
  4. Retain recoverable content if replacement fails.
* Add revision identifiers or modification timestamps to detect external edits.
* Add a file watcher.
* Surface conflicts rather than silently overwriting externally changed files.
* Add debounced autosave.
* Save immediately on explicit user command and application shutdown.
* Maintain crash-recovery copies for unsaved editor content.

### Acceptance criteria

* The user can open an ordinary directory as a workspace.
* Existing Markdown and `.canvas` files remain externally editable.
* A failed write does not corrupt the previous version.
* External modifications are detected.
* Attempted `../` path traversal is rejected.
* Reopening the workspace restores the previous canvas and view state.

---

## 12. Milestone 2: JSON Canvas Core

### Tasks

* Define strict TypeScript types for JSON Canvas 1.0.
* Define matching Rust `serde` structures or validation logic.
* Build a canonical in-memory `CanvasDocument`.
* Build adapters:

  * JSON Canvas → React Flow
  * React Flow changes → JSON Canvas operations
* Keep temporary UI state outside the canonical document:

  * Hover
  * Selection
  * Active editor
  * Drag previews
  * Playback state
  * Viewport
* Implement:

  * Node creation
  * Node deletion
  * Node movement
  * Node resizing
  * Multi-selection
  * Copy and paste
  * Z-order changes
  * Edge creation
  * Edge deletion
  * Edge labels
  * Group creation
  * Group movement
  * Color assignment
* Implement an operation-based undo and redo system.
* Do not serialize a full canvas on every pointer movement.
* Persist final geometry at the end of drag and resize operations.
* Preserve valid files created by Obsidian Canvas and verify round-trip behavior with fixtures.

### Acceptance criteria

* A canvas created by the application opens in another JSON Canvas-compatible application.
* A representative Obsidian Canvas file opens without data loss.
* Saving without editing does not unnecessarily rewrite or reorder unrelated data.
* Undo and redo cover node, edge, group, color, text, move, and resize operations.
* Edge direction, labels, sides, and endpoint arrows round-trip correctly.

---

## 13. Milestone 3: Markdown and Text Nodes

### Markdown editing behavior

* Double-click or press Enter to edit a selected Markdown node.
* Use CodeMirror only for the active editor.
* Render a lightweight Markdown preview when not editing.
* Do not mount an editor instance inside every visible node.
* Disable raw HTML by default.
* Render links as inert until explicitly activated.
* Opening external links requires a deliberate action.
* Prevent link clicks from accidentally dragging nodes.
* Support ordinary Markdown syntax before application-specific syntax.

### Plain text/title boxes

* Add a separate “Text box” creation command.
* Store its content as an ordinary JSON Canvas `text` node.
* Render it without Markdown chrome.
* Provide title-oriented font-size presets as presentation state.
* Prefer portable Markdown representations such as `# Heading` where styling must survive other applications.
* Avoid storing proprietary typography metadata until a clear interoperability policy is defined.

### Markdown file nodes

* A file node referencing Markdown should display:

  * Filename
  * Optional heading subpath
  * Rendered preview
* Activating the node opens the source in the same CodeMirror editor component.
* External edits update the preview.
* Unsaved editor content must not be discarded when the node loses focus.

### Acceptance criteria

* Inline text nodes persist inside `.canvas`.
* Markdown file nodes update their referenced `.md` files.
* Editing, panning, dragging, and selecting do not steal one another’s input.
* Untrusted Markdown cannot execute scripts.
* Large notes do not block canvas movement while inactive.

---

## 14. Milestone 4: Images, PDFs, and Web-Compatible Video

### Images

* Support PNG, JPEG, WebP, GIF, and other formats directly supported across target webviews.
* Read dimensions in Rust when possible.
* Generate cached thumbnails for large images.
* Never decode full-resolution images merely to render a distant node.
* Add context commands:

  * Open externally
  * Reveal in file manager
  * Reset aspect ratio
  * Fit
  * Fill
  * Original size

### PDFs

* Bundle PDF.js locally; do not use a CDN.
* Render a thumbnail or selected page in the inactive node.
* Mount the heavier viewer only when active.
* Support:

  * Page navigation
  * Zoom
  * Fit width
  * Open externally
* Keep PDF scripting disabled.
* Apply memory limits by unloading inactive PDF documents.
* Do not pre-render every page.

### Initial video support

* Use HTML `<video>` for the first implementation.
* Detect support at runtime rather than relying only on filename extensions.
* Prioritize:

  * MP4 with webview-compatible codecs
  * WebM with webview-compatible codecs
* Show:

  * Thumbnail/poster
  * Duration
  * Current position
  * Play/pause
  * Seek
  * Volume
  * Mute
  * Fullscreen or expanded-player command
* Pause videos when their nodes are removed.
* Limit simultaneous active playback.
* Do not autoplay media.
* Do not permanently convert unsupported files during this milestone.

### Acceptance criteria

* Images and PDFs render without network access.
* Large files do not freeze initial workspace opening.
* Supported video files play inside transformed canvas nodes.
* Inactive media nodes use lightweight previews.
* Original files remain untouched.

---

## 15. Milestone 5: Themes and Canvas Colors

### Light theme

Use the following base colors:

```css
--app-background: #ffffff;
--canvas-background: #ffffff;
--text-primary: #000000;
```

### Dark theme

Use true black as required:

```css
--app-background: #000000;
--canvas-background: #000000;
--text-primary: #ffffff;
```

Secondary dark surfaces may use near-black values for hierarchy, but the main application background and canvas must remain exactly `#000000`.

### Theme requirements

* Default to light theme on first launch.
* Provide a visible theme toggle.
* Add commands:

  * `Theme: Use Light`
  * `Theme: Use Dark`
  * `Theme: Toggle`
* Persist the user’s explicit choice locally.
* Define all theme values through CSS custom properties.
* Ensure PDF controls, editors, scrollbars, menus, edges, selection outlines, and media controls remain visible in both themes.
* Meet accessible contrast requirements.
* Avoid hard-coded component colors outside the theme system.

### Document colors

* Support JSON Canvas preset colors `"1"` through `"6"`.
* Support arbitrary hexadecimal colors.
* Preserve preset identifiers rather than replacing them with fixed hex values.
* Map preset identifiers to theme-aware application colors.
* Provide colors for:

  * Nodes
  * Groups
  * Edges
* Include:

  * No color
  * Six JSON Canvas presets
  * Custom hex color
* Ensure text contrast is calculated independently for each colored surface.

The JSON Canvas specification intentionally leaves exact preset shades undefined so applications can adapt them to their visual identity and theme. ([JSON Canvas][4])

---

## 16. Milestone 6: Command Palette and Command System

Build the command system before building the palette UI.

### Command model

```ts
interface AppCommand {
  id: string;
  title: string;
  category: string;
  defaultShortcut?: string;
  isAvailable(context: CommandContext): boolean;
  execute(context: CommandContext): void | Promise<void>;
}
```

### Requirements

* Every significant action must be registered as a command.
* UI buttons and menus should execute commands rather than duplicate logic.
* Open the palette with:

  * `Ctrl+P` or `Ctrl+Shift+P` on Windows/Linux
  * `Cmd+P` or `Cmd+Shift+P` on macOS
* Choose one default and make the alternative configurable.
* Provide fuzzy searching by command title and aliases.
* Display current shortcuts.
* Disable unavailable commands rather than failing silently.
* Commands should receive explicit context:

  * Active workspace
  * Active canvas
  * Selection
  * Active editor
  * Active media node

### Initial commands

* New canvas
* New Markdown note
* Add inline Markdown node
* Add text box
* Add group
* Add file
* Add link
* Open file
* Save
* Save all
* Undo
* Redo
* Cut
* Copy
* Paste
* Duplicate
* Delete
* Select all
* Group selection
* Ungroup
* Fit canvas
* Zoom in
* Zoom out
* Reset zoom
* Toggle minimap
* Toggle fullscreen
* Toggle theme
* Change node color
* Change edge color
* Open externally
* Reveal in file manager
* Toggle editor Vim mode
* Open settings

### Acceptance criteria

* Commands work from the palette, menus, toolbar, and shortcuts.
* There is one execution path per action.
* Shortcut conflicts are detected.
* Commands correctly enable and disable based on context.

---

## 17. Milestone 7: Keyboard Model and Vi-Style Editing

### General keyboard routing order

1. Active modal or command palette
2. Active CodeMirror editor
3. Active media viewer
4. Canvas selection
5. Global application commands

Do not register every shortcut as an unrestricted global browser listener.

### Initial Vi-style mode

Implement Vi support as an optional editor setting.

Start with a constrained “Vi Lite” mode:

#### Insert mode

* Normal text entry
* `Escape` enters normal mode

#### Normal mode

* `i`: insert before cursor
* `a`: insert after cursor
* `I`: insert at line start
* `A`: insert at line end
* `o`: open line below
* `O`: open line above
* `h`, `j`, `k`, `l`: basic movement
* `w`, `b`: basic word movement
* `0`, `$`: line boundaries
* `x`: delete character
* `dd`: delete line
* `u`: undo
* `Ctrl+R`: redo
* `v`: optional visual selection if straightforward

Defer:

* Registers
* Macros
* Marks
* Text objects
* Complex operator composition
* Ex commands
* Vim configuration files
* Plugins
* Full Vim emulation

CodeMirror 6 supports configurable keymaps, and a maintained `@replit/codemirror-vim` package exists if full Vim behavior becomes preferable to maintaining a custom subset. ([CodeMirror][5])

### Escape and fullscreen

Do not assume that Tauri completely eliminates Escape conflicts.

Tauri can set native window fullscreen independently of the browser Fullscreen API, but native fullscreen behavior still differs by operating system and window manager. Tauri also exposes a separate simple-fullscreen mode on macOS, with fallback behavior elsewhere. ([Tauri][1])

Use this policy:

* When CodeMirror is focused, the editor receives the first `Escape`.
* In insert mode, `Escape` switches to normal mode and does not close the editor.
* In normal mode, a second `Escape` may clear selection or leave the editor.
* Do not use `Escape` as the only fullscreen exit mechanism.
* Register `Ctrl/Cmd+Shift+F` as the reliable fullscreen toggle.
* Provide an explicit fullscreen command in the command palette.
* Test Escape behavior on Windows, macOS, X11, and Wayland.
* If native fullscreen consumes Escape before the editor on any target, provide a borderless “focus mode” as an alternative to native fullscreen.
* Never depend on preventing an operating-system-reserved key event.

### Acceptance criteria

* Vi mode can be enabled and disabled without recreating the document.
* Escape reliably enters normal mode during ordinary windowed editing.
* Canvas shortcuts do not run while the editor consumes the same keys.
* Fullscreen remains escapable through an explicit command even when Escape is consumed by the editor.
* Keyboard behavior is documented in `docs/keyboard-model.md`.

---

## 18. Milestone 8: Reliability, Security, and Performance

### Security requirements

* No remote JavaScript.
* No CDN assets.
* No direct frontend shell access.
* No generic process-execution command.
* No unrestricted filesystem APIs exposed to the webview.
* Strict Tauri capability configuration.
* Strict content security policy.
* Network access disabled unless a future feature explicitly requires it.
* Raw Markdown HTML disabled by default.
* External links opened through a validated native command.
* No automatic execution when opening a workspace.
* Treat PDFs, images, Markdown, and media files as untrusted input.
* Validate file type using content inspection where security-sensitive; do not trust extensions alone.
* Do not run as administrator or root.
* Do not load arbitrary native libraries from the workspace.
* Add dependency auditing to continuous integration.

Tauri’s runtime authority validates whether an invoking origin belongs to an allowed capability before passing an IPC request to the command implementation. Application commands must still perform their own argument and path validation. ([Tauri][6])

### Performance requirements

* Render lightweight previews for inactive nodes.
* Mount CodeMirror only for active editors.
* Mount full PDF viewers only for active PDF nodes.
* Pause or unload inactive videos.
* Generate thumbnails asynchronously.
* Avoid storing large binary data in React state.
* Avoid sending media bytes through ordinary serialized Tauri IPC.
* Subscribe node components only to the state they require.
* Use React Flow’s visible-element rendering option where beneficial.
* Memoize custom node types and stable callbacks.
* Batch drag-related updates.
* Avoid expensive blur and shadow effects across many nodes.
* Add performance fixtures containing:

  * 100 nodes
  * 500 nodes
  * 1,000 lightweight nodes
  * 100 edges
  * 1,000 edges
  * Several large images
  * Several PDFs

### Performance targets

On a representative midrange computer:

* Canvas input should remain responsive at 500 ordinary nodes.
* Dragging should normally remain near display refresh rate.
* Workspace opening should not decode every attachment.
* Node selection should feel immediate.
* Autosave should not visibly interrupt interaction.
* Large file parsing should not occur on the main UI thread.

---

## 19. Milestone 9: Packaging and Cross-Platform Testing

### Continuous integration

Build and test on:

* Windows
* macOS
* Linux

### Test categories

* Rust unit tests
* TypeScript unit tests
* JSON Canvas round-trip tests
* Path traversal tests
* Symlink-policy tests
* Markdown sanitization tests
* Command-context tests
* Undo/redo tests
* Theme screenshot tests
* Keyboard interaction tests
* Cross-platform startup tests

### Release requirements

* No network is required after installation.
* All frontend dependencies are bundled.
* PDF.js and its worker are bundled.
* Installer contains no unnecessary development assets.
* Source maps are excluded from production unless deliberately shipped.
* Debug tools are disabled in release builds.
* Application data locations are documented.
* Uninstalling does not delete user workspaces.
* Cache deletion does not remove canonical files.

---

# Phase 2: Broad Video and Audio Compatibility

Begin this phase only after Markdown, canvas editing, PDFs, images, web-compatible video, themes, commands, and persistence are stable.

## 20. Phase 2 Goals

Support:

* MKV
* Additional MP4 and WebM codec combinations
* AVI and MOV where practical
* Video codecs not supported by the host webview
* Audio-only files not supported consistently by the host webview
* Multiple audio tracks
* Subtitles where practical
* Reliable metadata inspection
* Thumbnail and waveform generation

FFmpeg provides demuxing, decoding, encoding, transcoding, and format conversion across a broad range of formats and codecs. ([FFmpeg][7])

---

## 21. Phase 2 Media Architecture

```text
Media node
    │
    ▼
Rust media service
    │
    ├── Probe file
    ├── Check webview compatibility
    ├── Direct playback
    ├── Lossless remux
    ├── Temporary playback proxy
    └── Native-player fallback
```

### Step 2.1: Media probing

Bundle or locate a controlled `ffprobe` binary.

Extract:

* Container
* Video codec
* Audio codec
* Resolution
* Duration
* Frame rate
* Bitrate
* Track list
* Subtitle streams
* Rotation
* Color and HDR metadata where relevant

Return structured data to the frontend.

Do not expose arbitrary `ffprobe` arguments.

### Step 2.2: Direct playback

Attempt direct playback when the current webview reports compatible support.

The media service should record which combinations succeed on each platform without assuming all system webviews behave identically.

### Step 2.3: Lossless remuxing

When codecs are compatible but the container is not:

* Remux without re-encoding.
* Stream or cache a temporary MP4 or WebM representation.
* Preserve the original.
* Key the cache by source content hash and selected tracks.
* Evict caches using a configurable size limit.

### Step 2.4: Temporary proxy transcoding

When codecs are incompatible:

* Generate a temporary web-compatible playback proxy.
* Prefer hardware encoding only when reliably available and explicitly tested.
* Begin playback before the whole proxy is complete when possible.
* Provide progress and cancellation.
* Keep the original file unchanged.
* Clearly distinguish a proxy from an exported conversion.

### Step 2.5: Audio-only files

Add an audio node with:

* Play/pause
* Seek
* Duration
* Volume
* Waveform
* Track metadata
* Optional cover art

Use direct HTML audio when supported.

Use remuxing, temporary proxy generation, or the native player for unsupported formats.

### Step 2.6: Native-player evaluation

Evaluate libmpv only after direct playback, remuxing, and proxy playback are implemented.

mpv provides a C API and render API intended for embedding in other applications. ([mpv][8])

Preferred first libmpv integration:

* One active player
* Docked media inspector, expanded panel, or separate native window
* Controlled through a Rust media helper process
* Thumbnail remains on the canvas node

Do not initially attempt:

* A native libmpv child surface for every visible node
* Precise native overlays for many simultaneously transformed nodes
* Shared GPU textures between libmpv and the webview
* Frame copying through JavaScript IPC

### Step 2.7: Media helper isolation

Long-term preferred structure:

```text
Tauri application
       │
       │ Structured local IPC
       ▼
Media helper process
├── ffprobe
├── FFmpeg
└── optional libmpv
```

The media helper must:

* Accept structured operations
* Accept approved file tokens rather than arbitrary command strings
* Never invoke a shell
* Run without elevated privileges
* Disable networking by default
* Restrict output to approved cache or workspace locations
* Be cancellable
* Be restartable after crashes
* Enforce job concurrency and output-size limits

---

## 22. Media Phase Acceptance Criteria

* An MKV containing browser-compatible streams can play through lossless remuxing.
* Unsupported codecs can play through a temporary proxy without modifying the original.
* A user can cancel proxy generation.
* Cache size is bounded.
* Audio-only files have a proper node and player.
* A corrupted media file cannot permanently destabilize the application.
* Media subprocess arguments are never constructed through a shell string.
* Users can always choose “Open in external player.”
* Native-player integration is optional and does not block the core application.

---

# Deferred Research: Extensions and Executable Blocks

## 23. Status

This is an explicitly deferred research area.

Do not implement extension runtimes, scripting languages, program nodes, or nested executable graphs until the primary note-taking application is stable and useful.

Do not let speculative extension requirements complicate the initial JSON Canvas model, security model, or UI.

---

## 24. Questions for Later Investigation

Research these topics in a separate design phase:

* Should executable workflows live in standard `.canvas` files or separate sidecar documents?
* How should ordinary JSON Canvas applications display program nodes?
* Should a program node be represented by:

  * A standard text-node fallback
  * A file-node reference
  * An application-specific sidecar
  * A separate workflow format
* How should typed inputs and outputs be represented?
* How should nested executable blocks expose their external interface?
* How should visual grouping differ from functional subgraphs?
* Should simple automation use Lua, Luau, Rhai, or another embedded language?
* Should complex portable extensions use WebAssembly?
* Should native extensions run only as isolated helper processes?
* Which capabilities can extensions request?
* How should users review and revoke permissions?
* How should deterministic execution and output caching work?
* How should executable nodes behave when opened by another JSON Canvas application?
* How should executable content be clearly distinguished from passive notes?
* How can opening a workspace remain non-executing by default?

### Security invariant

Opening a canvas or workspace must never execute code automatically.

Execution must always require a deliberate user action and an explicit permission decision.

---

# Suggested Delivery Sequence

## Release 0.1: Foundation

* Tauri shell
* Workspace opening
* Secure filesystem service
* React Flow canvas
* JSON Canvas reading and writing
* Basic nodes and edges
* Light and dark themes
* Atomic persistence

## Release 0.2: Notes

* Inline Markdown nodes
* Markdown file nodes
* CodeMirror
* Plain text/title boxes
* Undo and redo
* File watcher
* Crash recovery
* Initial Vi Lite mode

## Release 0.3: Documents and Media

* Images
* PDF.js
* Web-compatible MP4/WebM video
* Thumbnails
* Media controls
* External-open commands

## Release 0.4: Productivity

* Command palette
* Complete command registry
* Shortcut customization
* Groups
* Node and edge colors
* Improved copy and paste
* Minimap and navigation
* Obsidian Canvas compatibility testing

## Release 0.5: Hardening

* Security review
* Threat model
* Accessibility review
* Performance profiling
* Large-canvas tests
* Cross-platform packaging
* Recovery and conflict testing

## Release 0.6: Media Compatibility

* ffprobe
* FFmpeg remuxing
* Temporary playback proxies
* Non-web-compatible audio
* Bounded media cache
* Optional libmpv prototype

## Later

* Search index
* Backlinks
* Mind-map assistance
* Freehand drawing
* Extensions
* Scripting
* Program nodes
* Nested executable subgraphs

---

# Final Definition of Done for the First Stable Release

The first stable release is complete when a user can:

* Open an ordinary local directory.
* Create and edit Markdown files.
* Create and edit interoperable JSON Canvas files.
* Add inline Markdown and plain text boxes.
* Add Markdown, PDF, image, and supported video files to a canvas.
* Connect entities with labeled, colored arrows.
* Create and move visual groups.
* Assign Obsidian-style document colors while preserving JSON Canvas color values.
* Use a white light theme or a true-black dark theme.
* Edit Markdown with ordinary or optional Vi-style keybindings.
* Find and run application actions through a command palette.
* Work without a network connection.
* Edit files externally without silent data loss.
* Recover from interrupted writes or crashes.
* Use the application without granting shell access.
* Open every workspace without causing code execution.
* Move the resulting Markdown and `.canvas` files to another compatible application without losing their core content.

[1]: https://v2.tauri.app/reference/javascript/api/namespacewindow/?utm_source=chatgpt.com "window"
[2]: https://reactflow.dev/examples/grouping/sub-flows?utm_source=chatgpt.com "Sub Flow - React Flow"
[3]: https://mozilla.github.io/pdf.js/getting_started/?lang=en&utm_source=chatgpt.com "PDF.js - Getting Started"
[4]: https://jsoncanvas.org/spec/1.0/ "JSON Canvas — JSON Canvas Spec"
[5]: https://codemirror.net/docs/ref/?utm_source=chatgpt.com "CodeMirror Reference Manual"
[6]: https://v2.tauri.app/security/runtime-authority/?utm_source=chatgpt.com "Runtime Authority | Tauri"
[7]: https://www.ffmpeg.org/general.html?utm_source=chatgpt.com "General Documentation"
[8]: https://mpv.io/manual/stable/?utm_source=chatgpt.com "mpv.io"

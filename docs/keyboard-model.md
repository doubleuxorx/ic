# Keyboard model

`Mod` is `Cmd` on macOS and `Ctrl` elsewhere.

## Routing order

A key event is offered to each layer in turn:

1. **Modal or command palette** — while either is open they handle their own
   keys and nothing else runs.
2. **Active CodeMirror editor** — an editor with focus keeps every key except a
   small safe set: `Mod+S`, `Mod+Shift+S`, `Mod+Shift+F` and `Mod+P`.
3. **Active media viewer** — the PDF and media controls handle their own keys
   and pointer events.
4. **Canvas selection** — `Enter`, `Escape`, `Delete`, `Backspace`.
5. **Global commands** — everything registered with a shortcut.

Shortcuts are not registered as unrestricted global listeners: one window-level
handler resolves the event against the command registry, checks whether the
matched command is available in the current context, and only then runs it.
Conflicts between two commands claiming the same shortcut are detected at
registration and logged.

Layer 2 is enforced by that handler alone, which ignores any key aimed at a text
entry. The editor must not intercept keys itself: React dispatches its
capture-phase handlers from the root container, so stopping an event there stops
the native event too and CodeMirror, further down the tree, never sees the key.

## Commands and shortcuts

| Shortcut | Command |
| --- | --- |
| `Mod+P` | Command palette (`Mod+Shift+P` also works) |
| `Mod+O` | Open file |
| `Mod+S` | Save |
| `Mod+Shift+S` | Save all |
| `Mod+Z` / `Mod+Shift+Z` | Undo / Redo |
| `Mod+X` / `Mod+C` / `Mod+V` | Cut / Copy / Paste |
| `Mod+D` | Duplicate |
| `Delete` or `Backspace` | Delete selection |
| `Mod+A` | Select all |
| `Mod+G` / `Mod+Shift+G` | Group selection / Ungroup |
| `Mod+Shift+M` | Add inline Markdown node |
| `Mod+1` | Fit canvas |
| `Mod+=` / `Mod+-` / `Mod+0` | Zoom in / out / reset |
| `Mod+M` | Toggle minimap |
| `Mod+Shift+F` | Toggle fullscreen |
| `Mod+Shift+T` | Toggle theme |

Everything else — new canvas, new note, add text box, add group, add file, add
link, import file, colours, z-order, open externally, reveal in file manager,
Vi mode, settings — is in the palette. There are no menus and no toolbar.

## Canvas keys

| Key | Effect |
| --- | --- |
| `Enter` | Edit the selected node |
| `Escape` | Leave the editor, then clear the selection |
| `Delete` / `Backspace` | Delete selected nodes and edges |
| Drag on empty canvas | Rubber-band selection |
| Middle or right drag | Pan |
| Scroll | Pan; pinch or `Mod`+scroll zooms |
| Hover a node | Connection dots appear centred on each side |
| Drag a dot | Create an edge |

## Vi Lite

Optional, off by default, toggled by `Toggle editor Vi mode`. Enabling or
disabling it reconfigures a CodeMirror compartment; the document is not
recreated and nothing is lost.

**Insert mode** behaves like ordinary editing. `Escape` enters normal mode.

**Normal mode**

| Key | Effect |
| --- | --- |
| `i` `a` `I` `A` | Insert before / after cursor, at line start / end |
| `o` `O` | Open a line below / above |
| `h` `j` `k` `l` | Move by character and line |
| `w` `b` | Move by word |
| `0` `$` | Line start / end |
| `x` | Delete character |
| `dd` | Delete line |
| `u` / `Ctrl+R` | Undo / redo |
| `v` | Visual selection; motions extend it, `x` or `d` deletes it |

Unbound printable keys are swallowed so normal mode never inserts text.
Registers, macros, marks, text objects, operator composition, ex commands, Vim
configuration files and plugins are deliberately not implemented.

## Escape and fullscreen

- With an editor focused, the editor receives the first `Escape`.
- In Vi insert mode, `Escape` switches to normal mode and is consumed; it does
  not close the editor or leave fullscreen.
- In normal mode, `Escape` passes through, so a second press leaves the editor.
- With no editor focused, `Escape` clears the active node, then the selection.

`Escape` is never the only way out of fullscreen. `Mod+Shift+F` toggles it, and
`Toggle fullscreen` is in the palette. Fullscreen uses the native window API
rather than the browser Fullscreen API, so the webview cannot trap it.

## Cross-platform status

Verified on Linux (X11, WebKitGTK 2.48) with the automated smoke run described
in `README.md`. Windows (WebView2), macOS (WKWebView) and Wayland still need the
manual pass listed in the plan's Milestone 0 exit criteria, in particular
`Escape` ordering under each window manager. If native fullscreen consumes
`Escape` on a target, the fallback is a borderless focus mode rather than
depending on an OS-reserved key.

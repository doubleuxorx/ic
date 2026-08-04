# File format

The canonical data is ordinary files in an ordinary directory. Nothing is stored
only in a database, and the application can be uninstalled without touching a
workspace.

## Workspace layout

```
Workspace/
├── Notes/                      Markdown files
├── Canvases/                   .canvas files
├── Attachments/                images, PDFs, audio, video
└── .app/                       rebuildable, safe to delete
    ├── recovery/               unsaved editor content
    ├── thumbnails/             cached image thumbnails
    ├── media-cache/            reserved for the media phase
    └── workspace-settings.json last canvas, viewports, preferences
```

`Notes`, `Canvases` and `Attachments` are created when a workspace is opened;
files anywhere else in the tree work exactly the same. `.app` is hidden from
file listings, ignored by the watcher, and never the source of truth.

## JSON Canvas 1.0

Canvases are [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/). Files written
by this application open in other JSON Canvas applications, and files written by
them open here.

### Nodes

Every node has `id`, `type`, `x`, `y`, `width`, `height` and an optional
`color`. Geometry is always written as integers.

| Type | Extra fields | Used for |
| --- | --- | --- |
| `text` | `text` | inline Markdown cards and plain title boxes |
| `file` | `file`, `subpath` | Markdown, PDF, image, video, audio |
| `link` | `url` | URL cards |
| `group` | `label`, `background`, `backgroundStyle` | visual containers |

### Edges

`id`, `fromNode`, `toNode`, and optionally `fromSide`, `toSide`, `fromEnd`,
`toEnd`, `color` and `label`. Sides are `top`, `right`, `bottom`, `left`. Ends
are `none` or `arrow`; `fromEnd` defaults to `none` and `toEnd` to `arrow`. When
a file omits sides, the rendered attachment points are inferred from geometry
and the file is left unchanged.

### Colours

`"1"` to `"6"` are portable preset identifiers; any `#rgb`, `#rrggbb` or
`#rrggbbaa` value is also accepted. Presets are **kept as identifiers** in the
file and mapped to theme-aware colours at render time, which is what the
specification intends. Text contrast is computed per coloured surface.

### Compatibility rules

- Only specification fields are written. No React Flow state, no viewport, no
  selection, no fit mode and no typography metadata reaches a `.canvas` file.
- **Unknown fields are preserved** — at the top level, on nodes and on edges —
  and written back before the known fields, so another application's data
  survives a round trip.
- Node array order is z-order and is never reordered implicitly. Only the
  explicit "Bring to front" and "Send to back" commands change it.
- Entries the specification cannot represent are dropped on load: unknown node
  types, file nodes without a path, and edges referencing missing nodes.
- Identifiers are 64 random bits, hex encoded.
- Files are written with tab indentation and a trailing newline, so diffs stay
  readable in version control.

Round-trip behaviour is covered by `tests/json-canvas.test.ts` against
`fixtures/obsidian-sample.canvas`.

## Text boxes and titles

A title box is an ordinary `text` node. Whether content renders as prose or as a
title is decided from the content itself — a short single line with no Markdown
syntax reads as a title — so no proprietary typography metadata is stored. For
styling that must survive in other applications, use portable Markdown such as
`# Heading`.

## Revisions and conflicts

Every read returns a revision: the SHA-256 of the file's bytes. Every write
sends back the revision it was based on. If the file changed in between, the
write is refused and both versions are offered. External edits made while the
application is idle are adopted automatically; external edits made while there
are unsaved changes always ask.

## Paths inside canvases

`file` node paths are workspace-relative and use `/` separators, which keeps a
workspace portable across platforms and between machines.

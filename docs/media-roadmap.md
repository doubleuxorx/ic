# Media roadmap

## Where this release stands

Media plays through ordinary HTML elements, streamed from the local `ic://`
protocol, which serves byte ranges so seeking a large file does not buffer the
whole thing.

Supported now:

- Images: PNG, JPEG, WebP, GIF, BMP, AVIF and SVG, with cached thumbnails for
  anything larger than 1024 px on its long edge.
- PDFs: bundled PDF.js, page navigation, zoom, fit width, open externally.
- Video: MP4 and WebM containers with codecs the host webview supports.
- Audio: MP3, M4A, OGG, Opus, WAV, FLAC where the webview supports them.

Video and audio are the exception on Linux, where nothing plays in the window.
WebKitGTK decodes through GStreamer, which fetches only the schemes it knows, so
a file served from `ic://` never reaches a decoder and the element reports an
unsupported source however ordinary the file is. Those nodes offer the system
player instead. Playing media there needs the bytes delivered another way:
a loopback HTTP server, which keeps range streaming and needs an origin check of
its own, or a blob URL, which is a few lines but gives up streaming and holds
the whole file in memory.

Rules that hold throughout: nothing autoplays, one node plays at a time,
playback stops when a node unmounts, inactive nodes show lightweight previews,
and original files are never modified or converted.

`media_probe` reports the container and a playback strategy. Containers that no
target webview handles consistently (MKV, AVI, MOV) report `external-player`,
and the node offers to open the file in the system player instead of failing
silently.

## Phase 2

Begin only after Markdown, canvas editing, PDFs, images, web-compatible video,
themes, commands and persistence are stable.

```
Media node
    │
    ▼
Rust media service
    ├── Probe file          ffprobe
    ├── Check compatibility recorded per platform, not assumed
    ├── Direct playback     today's path
    ├── Lossless remux      compatible codecs, wrong container
    ├── Playback proxy      incompatible codecs
    └── Native player       libmpv, evaluated last
```

### Steps

1. **Probing** — bundle a controlled `ffprobe`. Extract container, codecs,
   resolution, duration, frame rate, bitrate, track list, subtitles, rotation
   and colour metadata. Never expose arbitrary arguments.
2. **Direct playback** — keep attempting it first, recording which combinations
   actually succeed on each platform rather than assuming webviews agree.
3. **Lossless remuxing** — compatible codecs in an unsupported container are
   remuxed without re-encoding into `.app/media-cache`, keyed by content hash and
   selected tracks, with a configurable size limit. The original is untouched.
4. **Proxy transcoding** — incompatible codecs get a temporary playback proxy,
   with progress and cancellation, clearly distinguished from an exported
   conversion.
5. **Audio** — a dedicated node with waveform, track metadata and optional cover
   art, falling back to remuxing or the native player.
6. **Native player** — evaluate libmpv only after the above works. First
   integration is a single player in a docked inspector or separate window,
   driven by a Rust helper, with the thumbnail staying on the canvas node. Do
   not attempt a native surface per visible node, precise overlays for many
   transformed nodes, shared GPU textures, or frame copying through JS IPC.

### Helper process requirements

A separate media helper, not the main process:

- accepts structured operations and approved file tokens, never command strings;
- never invokes a shell;
- runs unprivileged with networking disabled;
- writes only into approved cache locations;
- is cancellable, restartable after a crash, and enforces concurrency and
  output-size limits.

### Acceptance criteria

- An MKV with browser-compatible streams plays via lossless remuxing.
- Unsupported codecs play via a temporary proxy without modifying the original.
- Proxy generation is cancellable and the cache is bounded.
- Audio-only files have a proper node and player.
- A corrupted media file cannot permanently destabilize the application.
- "Open in external player" is always available.
- Native-player integration stays optional and never blocks the core
  application.

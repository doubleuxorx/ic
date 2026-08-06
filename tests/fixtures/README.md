# Test fixtures

Everything a test needs is generated in the test itself where that is possible:
images through the `image` crate, PDFs, canvases, Markdown and plain text as
literal bytes. Audio and video are the exception — they need a real encoder — so
the three files under `media/` are committed instead.

The two files under `documents/` are for the webview self-test, which runs as a
shell script and so cannot generate anything itself. The PDF is a real one-page
document, because the point of that test is that PDF.js paints it.

```sh
cd tests/fixtures/documents
magick -size 96x64 gradient:blue-white sample.png
magick sample.png -page 96x64 sample.pdf
```

They are one second long, silent, and 16x16 where there is a picture at all, so
each is a few kilobytes. A second is deliberate rather than minimal: the
webview self-test plays them and watches `currentTime` advance, which needs
something to advance through.

Regenerate them with the commands below; ffmpeg is not a dependency of this
project, only of this directory.

```sh
cd tests/fixtures/media

ffmpeg -y -f lavfi -i anullsrc=r=8000:cl=mono -t 1 \
  -codec:a libmp3lame -b:a 32k tiny.mp3

ffmpeg -y -f lavfi -i color=c=black:s=16x16:r=8 -t 1 \
  -codec:v libx264 -pix_fmt yuv420p -movflags +faststart tiny.mp4

# Same streams in a container no target webview handles, which is what
# `media_probe` should report as `external-player`.
ffmpeg -y -i tiny.mp4 -codec copy tiny.mkv
```

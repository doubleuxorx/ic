# Pinned by digest: the application is linked against whatever WebKitGTK and
# musl the builder has, so an unpinned base would silently change which hosts
# the result runs on and make an artifact impossible to reproduce. alpine:3.24
# as of 2026-08-04.
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

# Keep the build native to musl. In particular, do not add gcompat: the
# AppImage tool used by scripts/build-musl-appimage.sh is statically linked.
# Everything here is used at build time only; the bundle carries nothing from
# this image but the application binary.
RUN apk add --no-cache \
      build-base \
      ca-certificates \
      cargo \
      coreutils \
      curl \
      desktop-file-utils \
      file \
      findutils \
      git \
      grep \
      libayatana-appindicator-dev \
      librsvg-dev \
      linux-headers \
      nodejs \
      npm \
      openssl-dev \
      pkgconf \
      sed \
      squashfs-tools \
      webkit2gtk-4.1-dev \
      xdg-utils \
      yarn

ENV CARGO_TERM_COLOR=always \
    CI=true

WORKDIR /workspace

CMD ["/bin/sh", "scripts/build-musl-appimage.sh"]

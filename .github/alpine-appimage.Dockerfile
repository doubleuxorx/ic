FROM alpine:latest

# Keep the build native to musl. In particular, do not add gcompat: the
# AppImage tool used by scripts/build-musl-appimage.sh is statically linked.
RUN apk add --no-cache \
      build-base \
      ca-certificates \
      cargo \
      coreutils \
      curl \
      desktop-file-utils \
      file \
      findutils \
      font-dejavu \
      git \
      grep \
      libayatana-appindicator-dev \
      librsvg-dev \
      linux-headers \
      nodejs \
      npm \
      openssl-dev \
      patchelf \
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

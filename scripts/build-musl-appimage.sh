#!/bin/sh
set -eu

repo_root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_root"

if ! grep -q '^ID=alpine$' /etc/os-release; then
	echo "error: the musl AppImage must be built inside Alpine Linux" >&2
	exit 1
fi

if [ "$(uname -m)" != "x86_64" ]; then
	echo "error: expected an x86_64 Alpine builder, got $(uname -m)" >&2
	exit 1
fi

rust_host="$(rustc -vV | awk '/^host:/ { print $2 }')"
case "$rust_host" in
x86_64-*-linux-musl) ;;
*)
	echo "error: expected an x86_64 musl Rust host, got $rust_host" >&2
	exit 1
	;;
esac

# The bundle holds the application and nothing else. WebKitGTK, GTK and Mesa
# come from the host, the same terms the glibc AppImage offers a glibc host, so
# this one runs on a musl host with webkit2gtk-4.1 installed and nowhere else.
# Bundling them instead cost 198 MB and three rounds of blank windows on
# machines none of it could be tested on: a Mesa with no driver for the host's
# GPU, a loader sealed off from the host's libraries, an ICU without its data.
#
# go-appimage is used rather than Tauri's linuxdeploy AppImage, which is a glibc
# payload and cannot execute natively in Alpine. Only its packaging mode is used
# here; its deploy mode is what pulled the libraries in.
appimagetool_url="https://github.com/probonopd/go-appimage/releases/download/continuous/appimagetool-947-x86_64.AppImage"
appimagetool_sha256="376998aba63bb3a35a02ea3196f77268f8543a35a3b6b7db0dc2181365119b62"

version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
output_dir="$repo_root/src-tauri/target/release/bundle/appimage-musl"
artifact="$output_dir/ic-${version}-x86_64-musl.AppImage"

workdir="$(mktemp -d)"
cleanup() {
	rm -rf "$workdir"
}
trap cleanup EXIT

appdir="$workdir/ic.AppDir"
tool_dir="$workdir/appimagetool"
package_dir="$workdir/package"
extract_dir="$workdir/extracted"
mkdir -p \
	"$appdir/usr/bin" \
	"$appdir/usr/share/applications" \
	"$appdir/usr/share/icons/hicolor/256x256/apps" \
	"$tool_dir" \
	"$package_dir" \
	"$extract_dir"

# Tauri embeds the frontend when building the unbundled application binary.
yarn install --frozen-lockfile
npx tauri build --no-bundle

binary="$repo_root/src-tauri/target/release/ic"
if ! file "$binary" | grep -q 'interpreter /lib/ld-musl-x86_64.so.1'; then
	echo "error: Tauri did not produce an x86_64 musl executable" >&2
	file "$binary" >&2
	exit 1
fi

install -m 0755 "$binary" "$appdir/usr/bin/ic"
install -m 0644 \
	"$repo_root/src-tauri/icons/128x128@2x.png" \
	"$appdir/usr/share/icons/hicolor/256x256/apps/ic.png"
cp "$appdir/usr/share/icons/hicolor/256x256/apps/ic.png" "$appdir/ic.png"
cp "$appdir/ic.png" "$appdir/.DirIcon"

# %F rather than %U: the application resolves its positional argument with
# `canonicalize`, so it takes local paths and not file:// URIs.
cat >"$appdir/usr/share/applications/ic.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=ic
Comment=Offline-first infinite canvas
Exec=ic %F
Icon=ic
Categories=Office;Utility;
Terminal=false
DESKTOP
cp "$appdir/usr/share/applications/ic.desktop" "$appdir/ic.desktop"

# Written here rather than generated: go-appimage's template exists to set up
# the library and data paths of a bundle that carries its own copies of
# everything, and this one carries none.
cat >"$appdir/AppRun" <<'APPRUN'
#!/bin/sh
set -eu
HERE="$(dirname "$(readlink -f "$0")")"

# The AppImage runtime exports the directory it was invoked from as OWD, but
# only when it mounts the bundle with FUSE; in extract-and-run mode it does
# not. src-tauri/src/commands/mod.rs resolves a relative path argument against
# this, so fill it in either way.
[ -n "${OWD:-}" ] || OWD="$(pwd)"
export OWD

# WebKitGTK's Wayland path is unreliable, so prefer X11 whenever an X server is
# reachable. On a Wayland-only session there is no XWayland to fall back to and
# forcing x11 would stop the application from starting at all, so leave the
# choice to GDK. IC_GDK_BACKEND overrides both.
if [ -n "${IC_GDK_BACKEND:-}" ]; then
	export GDK_BACKEND="${IC_GDK_BACKEND}"
elif [ -n "${DISPLAY:-}" ]; then
	export GDK_BACKEND=x11
fi

exec "$HERE/usr/bin/ic" "$@"
APPRUN
chmod 0755 "$appdir/AppRun"

appimagetool_image="$tool_dir/appimagetool.AppImage"
if ! curl --proto '=https' --tlsv1.2 -fsSL "$appimagetool_url" -o "$appimagetool_image"; then
	# go-appimage publishes to a single rolling "continuous" release and drops
	# the assets of older builds, so this URL 404s rather than changing content
	# whenever a new build lands.
	echo "error: could not download $appimagetool_url" >&2
	echo "hint: if this is a 404, pick the current build from" >&2
	echo "      https://github.com/probonopd/go-appimage/releases/tag/continuous" >&2
	echo "      and update appimagetool_url and appimagetool_sha256 below." >&2
	exit 1
fi
printf '%s  %s\n' "$appimagetool_sha256" "$appimagetool_image" | sha256sum -c -
chmod +x "$appimagetool_image"

# FUSE is intentionally not exposed to the build container. Extract the static
# tool and execute its payload directly instead of adding a glibc compatibility
# layer such as gcompat.
(
	cd "$tool_dir"
	./appimagetool.AppImage --appimage-extract >/dev/null
)
appimagetool="$tool_dir/squashfs-root/AppRun"

# ARCH: with no library to read it off, appimagetool cannot tell what the
# AppDir is for and stops. Unsetting the rest matters when this script runs on
# an Alpine host directly rather than in the container, where none of them are
# set: go-appimage treats them as a request to upload the result to a GitHub
# release.
(
	cd "$package_dir"
	unset GITHUB_REPOSITORY GITHUB_REF GITHUB_TOKEN
	ARCH=x86_64 VERSION="$version" "$appimagetool" "$appdir"
)

built_artifact="$package_dir/ic-${version}-x86_64.AppImage"
test -f "$built_artifact"
mkdir -p "$output_dir"
rm -f "$output_dir"/*.AppImage
install -m 0755 "$built_artifact" "$artifact"

if ! file "$artifact" | grep -q 'statically linked'; then
	echo "error: AppImage runtime is not statically linked" >&2
	file "$artifact" >&2
	exit 1
fi

(
	cd "$extract_dir"
	"$artifact" --appimage-extract >/dev/null
)
extracted="$extract_dir/squashfs-root"
test -x "$extracted/AppRun"
test -x "$extracted/usr/bin/ic"
test -f "$extracted/usr/share/applications/ic.desktop"
if ! file "$extracted/usr/bin/ic" | grep -q 'interpreter /lib/ld-musl-x86_64.so.1'; then
	echo "error: packaged application payload is not musl x86_64" >&2
	exit 1
fi

# The point of this bundle, asserted rather than assumed: appimagetool's
# packaging mode leaves an AppDir alone, but its deploy mode is one flag away
# and would fill it with the builder's copy of WebKitGTK, GTK and Mesa without
# saying so.
bundled_libraries="$(command find "$extracted" -name '*.so' -o -name '*.so.*' | head -n 5)"
if [ -n "$bundled_libraries" ]; then
	echo "error: the bundle carries libraries; it is meant to link against the" >&2
	echo "       host's, as the glibc AppImage does" >&2
	echo "$bundled_libraries" >&2
	exit 1
fi

# Nothing above launches anything. scripts/test-appimage.sh does, in an
# Alpine container with the runtime packages this bundle expects a host to have
# and nothing else, which is also what checks that the list in CI is complete.
printf 'Created %s\n' "$artifact"

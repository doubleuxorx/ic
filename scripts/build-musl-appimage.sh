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

# go-appimage is used instead of Tauri's linuxdeploy AppImage. linuxdeploy is a
# glibc payload and cannot execute natively in Alpine. This pinned appimagetool
# has a statically linked runtime and its standalone deploy mode bundles musl.
appimagetool_url="https://github.com/probonopd/go-appimage/releases/download/continuous/appimagetool-947-x86_64.AppImage"
appimagetool_sha256="376998aba63bb3a35a02ea3196f77268f8543a35a3b6b7db0dc2181365119b62"

version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
output_dir="$repo_root/src-tauri/target/release/bundle/appimage-musl"
artifact="$output_dir/ic_${version}_musl-x86_64.AppImage"

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
	"$appdir/usr/lib/webkit2gtk-4.1" \
	"$appdir/usr/libexec/webkit2gtk-4.1" \
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
cp -a /usr/lib/webkit2gtk-4.1/. "$appdir/usr/lib/webkit2gtk-4.1/"
cp -a /usr/libexec/webkit2gtk-4.1/. "$appdir/usr/libexec/webkit2gtk-4.1/"

cat >"$appdir/usr/share/applications/ic.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=ic
Comment=Offline-first infinite canvas
Exec=ic %U
Icon=ic
Categories=Office;Utility;
Terminal=false
DESKTOP

appimagetool_image="$tool_dir/appimagetool.AppImage"
curl --proto '=https' --tlsv1.2 -fsSL "$appimagetool_url" -o "$appimagetool_image"
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

"$appimagetool" -s deploy "$appdir/usr/share/applications/ic.desktop"

# Align GTK's runtime paths with the AppDir. The generated AppRun already starts
# the application from AppDir/usr; these variables make its data and theme
# resources resolve from that same prefix.
app_run_tmp="$workdir/AppRun"
awk '
  { print }
  /^HERE=/ {
    print "export GTK_DATA_PREFIX=\"${HERE}/usr\""
    print "export GTK_THEME=Adwaita"
    print "export GDK_BACKEND=x11"
  }
' "$appdir/AppRun" >"$app_run_tmp"
install -m 0755 "$app_run_tmp" "$appdir/AppRun"
sed -i 's/export GTK_THEME=Default/export GTK_THEME=Adwaita/' "$appdir/AppRun"

# WebKitGTK records its helper directory as an absolute /usr path. AppRun starts
# in AppDir/usr, so the same-length replacement resolves helpers from the bundle.
command find "$appdir/usr/lib" -type f -name 'libwebkit*.so*' -print |
	while IFS= read -r webkit_library; do
		sed -i 's|/usr|././|g' "$webkit_library"
	done

# Include compiled GLib schemas used by GTK and WebKitGTK.
mkdir -p "$appdir/usr/share/glib-2.0/schemas"
cp -a /usr/share/glib-2.0/schemas/. "$appdir/usr/share/glib-2.0/schemas/"
glib-compile-schemas "$appdir/usr/share/glib-2.0/schemas"

loader="$appdir/lib/ld-musl-x86_64.so.1"
webkit_library="$(command find "$appdir/usr/lib" -type f -name 'libwebkit2gtk-4.1.so*' -print -quit)"
test -x "$appdir/AppRun"
test -e "$loader"
test -n "$webkit_library"
test -x "$appdir/usr/libexec/webkit2gtk-4.1/WebKitNetworkProcess"
test -x "$appdir/usr/libexec/webkit2gtk-4.1/WebKitWebProcess"
test -f "$appdir/usr/lib/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so"
if strings "$webkit_library" | grep -q '/usr/libexec/webkit2gtk-4.1'; then
	echo "error: WebKitGTK still contains an absolute helper-process path" >&2
	exit 1
fi

# Prevent go-appimage from inferring release-upload metadata from GitHub Actions.
(
	cd "$package_dir"
	unset GITHUB_REPOSITORY GITHUB_REF GITHUB_TOKEN
	VERSION="$version" "$appimagetool" "$appdir"
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
test -e "$extracted/lib/ld-musl-x86_64.so.1"
test -x "$extracted/usr/bin/ic"
test -x "$extracted/usr/libexec/webkit2gtk-4.1/WebKitNetworkProcess"
test -f "$extracted/usr/lib/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so"
if ! file "$extracted/usr/bin/ic" | grep -q 'interpreter /lib/ld-musl-x86_64.so.1'; then
	echo "error: packaged application payload is not musl x86_64" >&2
	exit 1
fi

printf 'Created %s\n' "$artifact"

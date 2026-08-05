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

"$appimagetool" -s deploy "$appdir/usr/share/applications/ic.desktop"

# appimagetool gives every library it deploys a long RUNPATH, and patchelf makes
# room for one by moving the sections at the start of the file to its end and
# filling the bytes it vacates with 'Z'. Nothing adjusts the pointer through
# which a static GResource is registered, so a library whose .gresource.*
# section is moved this way hands GLib the filler and every lookup against it
# fails. GTK keeps its composite templates in such a section, which is what
# leaves GtkFileChooserDialog, the application's open dialog, unbuildable. Copy
# each moved payload back to the offset the stale pointer still reads.
build_id() {
	readelf -nW "$1" | sed -n 's/.*Build ID: //p'
}

gresource_sections="$workdir/gresource-sections"
gresource_payload="$workdir/gresource-payload.bin"
command find "$appdir" -type f -print |
	while IFS= read -r deployed; do
		readelf -SW "$deployed" 2>/dev/null | awk -v lib="$deployed" '{
			for (i = 1; i <= NF; i++)
				if ($i ~ /^\.gresource/)
					print lib, $i, $(i + 3), $(i + 4)
		}'
	done >"$gresource_sections"

# Positive guard: the section this exists for has to be among the ones found.
if ! awk '$2 == ".gresource.gtk" { found = 1 } END { exit !found }' "$gresource_sections"; then
	echo "error: no deployed library carries GTK's GResource section" >&2
	exit 1
fi

while read -r deployed section deployed_offset size; do
	# Only the library as it was before appimagetool copied it records the
	# offset the pointer refers to, so read that from the builder's own copy.
	original="/usr/lib/$(basename "$deployed")"
	if [ ! -e "$original" ]; then
		echo "error: no builder copy of $(basename "$deployed") to read the" >&2
		echo "       original offset of $section from" >&2
		exit 1
	fi
	if [ "$(build_id "$deployed")" != "$(build_id "$original")" ]; then
		echo "error: $original is not what was deployed as $deployed" >&2
		exit 1
	fi
	original_offset="$(readelf -SW "$original" | awk -v section="$section" '{
		for (i = 1; i <= NF; i++)
			if ($i == section)
				print $(i + 3)
	}')"
	if [ "$original_offset" = "$deployed_offset" ]; then
		continue
	fi

	start="$((0x$original_offset))"
	length="$((0x$size))"
	filler="$(tail -c "+$((start + 1))" "$deployed" | head -c "$length" | tr -d 'Z' | wc -c)"
	if [ "$filler" -ne 0 ]; then
		echo "error: the bytes $section was moved away from are not patchelf" >&2
		echo "       filler, so restoring it there would destroy something" >&2
		exit 1
	fi
	objcopy -O binary --only-section="$section" "$deployed" "$gresource_payload"
	dd if="$gresource_payload" of="$deployed" bs=1 seek="$start" conv=notrunc 2>/dev/null
	if ! tail -c "+$((start + 1))" "$deployed" | head -c "$length" |
		cmp -s - "$gresource_payload"; then
		echo "error: $section was not restored to offset $original_offset of" >&2
		echo "       $deployed" >&2
		exit 1
	fi
	printf 'Restored %s at offset 0x%s of %s\n' \
		"$section" "$original_offset" "$(basename "$deployed")"
done <"$gresource_sections"

# Environment the generated AppRun does not set up for us: GTK's prefix, the
# invocation directory, and the GDK backend. Injected directly after AppRun
# defines HERE, so it runs before anything else the template does.
app_run_env="$workdir/apprun-env.sh"
cat >"$app_run_env" <<'APPRUN_ENV'
export GTK_DATA_PREFIX="${HERE}/usr"

# AppRun cd's into the bundle further down, so a relative path on the command
# line would otherwise resolve against AppDir/usr. The AppImage runtime exports
# the invocation directory as OWD, but only when it mounts the bundle with
# FUSE; in extract-and-run mode it does not. Fill it in either way, before the
# first cd. src-tauri/src/commands/mod.rs resolves arguments against this.
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
APPRUN_ENV

# The insertion point and the GTK_THEME assignment below both come from
# go-appimage's built-in AppRun template. Neither substitution failing is
# visible at runtime, so both are asserted right after they are applied.
app_run_tmp="$workdir/AppRun"
awk -v env_file="$app_run_env" '
  { print }
  /^HERE=/ && !inserted {
    while ((getline line < env_file) > 0) print line
    close(env_file)
    inserted = 1
  }
' "$appdir/AppRun" >"$app_run_tmp"
install -m 0755 "$app_run_tmp" "$appdir/AppRun"

# GTK 3 carries Adwaita inside libgtk-3.so as a GResource, so it resolves from
# the bundle. go-appimage's default of "Default" needs theme files on disk.
sed -i 's/export GTK_THEME=Default/export GTK_THEME=Adwaita/' "$appdir/AppRun"

if ! grep -q 'GTK_DATA_PREFIX' "$appdir/AppRun" || ! grep -q 'export OWD' "$appdir/AppRun"; then
	echo "error: AppRun environment block was not inserted; the generated" >&2
	echo "       AppRun no longer has a line starting with HERE=" >&2
	exit 1
fi
# Both halves matter. OWD has to be captured before AppRun cd's into the
# bundle, and that cd has to happen at all, because the /usr rewriting below
# makes WebKitGTK's helper paths relative to exactly that directory.
owd_line="$(grep -n 'export OWD' "$appdir/AppRun" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # matching a literal $HERE in the generated AppRun
cd_line="$(grep -n 'cd "\$HERE/usr"' "$appdir/AppRun" | head -n 1 | cut -d: -f1)"
if [ -z "$owd_line" ] || [ -z "$cd_line" ] || [ "$owd_line" -ge "$cd_line" ]; then
	echo "error: AppRun does not cd into the bundle after capturing OWD" >&2
	exit 1
fi
if grep -q 'GTK_THEME=Default' "$appdir/AppRun" || ! grep -q 'GTK_THEME=Adwaita' "$appdir/AppRun"; then
	echo "error: AppRun still selects go-appimage's on-disk GTK theme" >&2
	exit 1
fi

# WebKitGTK records its helper directory as an absolute /usr path. AppRun starts
# in AppDir/usr, so the same-length replacement resolves helpers from the bundle.
webkit_library="$(command find "$appdir/usr/lib" -type f -name 'libwebkit2gtk-4.1.so*' -print -quit)"
test -n "$webkit_library"
if ! strings "$webkit_library" | grep -qF '/usr/libexec/webkit2gtk-4.1'; then
	echo "error: WebKitGTK does not record the expected absolute helper path;" >&2
	echo "       the rewrite below would silently do nothing" >&2
	exit 1
fi
command find "$appdir/usr/lib" -type f -name 'libwebkit*.so*' -print |
	while IFS= read -r library; do
		sed -i 's|/usr|././|g' "$library"
	done
if ! strings "$webkit_library" | grep -qF '././/libexec/webkit2gtk-4.1'; then
	echo "error: WebKitGTK's helper-process path was not rewritten into the bundle" >&2
	exit 1
fi

# Include compiled GLib schemas used by GTK and WebKitGTK.
mkdir -p "$appdir/usr/share/glib-2.0/schemas"
cp -a /usr/share/glib-2.0/schemas/. "$appdir/usr/share/glib-2.0/schemas/"
glib-compile-schemas "$appdir/usr/share/glib-2.0/schemas"

# go-appimage points FONTCONFIG_FILE at AppDir/etc/fonts/fonts.conf, which it
# creates as an absolute symlink into the host. That dangles on a host without
# fontconfig and leaves the WebView with no fonts at all. Bundle a real
# configuration and the DejaVu faces instead; -L flattens fontconfig's conf.d
# symlinks, which otherwise point back into the builder's /usr.
test -d /usr/share/fonts/dejavu
rm -rf "$appdir/etc/fonts"
mkdir -p "$appdir/etc/fonts" "$appdir/usr/share/fonts"
cp -aL /etc/fonts/. "$appdir/etc/fonts/"
cp -aL /usr/share/fonts/dejavu "$appdir/usr/share/fonts/"
# Relative to the directory holding this file, i.e. AppDir/etc/fonts/conf.d,
# which fonts.conf pulls in with <include ignore_missing="yes">conf.d</include>.
mkdir -p "$appdir/etc/fonts/conf.d"
cat >"$appdir/etc/fonts/conf.d/00-ic-bundled-fonts.conf" <<'FONTS'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir prefix="relative">../../../usr/share/fonts</dir>
</fontconfig>
FONTS
test -f "$appdir/usr/share/fonts/dejavu/DejaVuSans.ttf"
test ! -L "$appdir/etc/fonts/fonts.conf"

loader="$appdir/lib/ld-musl-x86_64.so.1"
test -x "$appdir/AppRun"
test -e "$loader"
test -x "$appdir/usr/libexec/webkit2gtk-4.1/WebKitNetworkProcess"
test -x "$appdir/usr/libexec/webkit2gtk-4.1/WebKitWebProcess"
test -f "$appdir/usr/lib/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so"

# Matters when this script runs on an Alpine host directly rather than in the
# container, where none of these are set: go-appimage treats them as a request
# to upload the result to a GitHub release.
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
test -f "$extracted/usr/share/glib-2.0/schemas/gschemas.compiled"
test -f "$extracted/usr/share/fonts/dejavu/DejaVuSans.ttf"
test ! -L "$extracted/etc/fonts/fonts.conf"
if ! file "$extracted/usr/bin/ic" | grep -q 'interpreter /lib/ld-musl-x86_64.so.1'; then
	echo "error: packaged application payload is not musl x86_64" >&2
	exit 1
fi

# Nothing above launches anything. scripts/smoke-test-appimage.sh does, and CI
# runs it in a bare Alpine container so that a bundle which only works because
# the builder happens to have the libraries installed cannot pass.
printf 'Created %s\n' "$artifact"

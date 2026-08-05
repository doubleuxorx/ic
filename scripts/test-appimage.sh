#!/bin/sh
# Launch an AppImage under a virtual X server and confirm it reaches the point
# of rendering: the UI process must survive startup and spawn a WebKit web
# process that then keeps running. Run this in a container that has nothing
# installed but xvfb, so that
# a bundle which only works because the build host had GTK or WebKitGTK
# available cannot pass.
set -eu

appimage="${1:-}"
if [ ! -x "$appimage" ]; then
	echo "usage: $0 <path-to-AppImage>" >&2
	exit 2
fi

timeout_seconds="${IC_TEST_TIMEOUT:-90}"
# Long enough to cover several restarts: WebKitGTK replaced a web process that
# aborted on startup about every four seconds.
settle_seconds="${IC_TEST_SETTLE:-12}"

workdir="$(mktemp -d)"
cleanup() {
	rm -rf "$workdir"
}
trap cleanup EXIT

# A writable HOME the application has not seen before, so this also covers
# first-run state creation rather than reusing anything from the build.
HOME="$workdir/home"
XDG_RUNTIME_DIR="$workdir/run"
export HOME XDG_RUNTIME_DIR
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# FUSE is deliberately not available to the container, and mounting would need
# privileges this job should not have.
export APPIMAGE_EXTRACT_AND_RUN=1

log="$workdir/app.log"
xvfb-run -a -s '-screen 0 1280x820x24' "$appimage" >"$log" 2>&1 &
app_pid=$!

web_pid=''
elapsed=0
while [ "$elapsed" -lt "$timeout_seconds" ]; do
	# Newest match: outside a container, a web process left behind by an
	# earlier run would otherwise be picked up and outlive the whole test.
	# || true: pgrep exits non-zero until the process exists, which set -e
	# would otherwise take for a failure of this script.
	web_pid="$(pgrep -n -f 'WebKitWebProcess' 2>/dev/null || true)"
	if [ -n "$web_pid" ]; then
		break
	fi
	# xvfb-run exiting early means the application failed to come up.
	if ! kill -0 "$app_pid" 2>/dev/null; then
		break
	fi
	sleep 1
	elapsed=$((elapsed + 1))
done

# One that starts is not one that runs. A web process which aborts during
# startup is replaced by WebKitGTK immediately, so a bundle it cannot survive in
# has a web process at every moment anyone looks and an empty window throughout.
# That is what missing ICU data did, and it reached users because this test
# looked once. Wait for the process found above, by pid, to still be there.
survived=0
if [ -n "$web_pid" ]; then
	sleep "$settle_seconds"
	if kill -0 "$web_pid" 2>/dev/null; then
		survived=1
	fi
fi

kill "$app_pid" 2>/dev/null || true
wait "$app_pid" 2>/dev/null || true

if [ -z "$web_pid" ]; then
	echo "error: the AppImage did not reach a running WebKit web process" >&2
	echo "--- application output ---" >&2
	cat "$log" >&2
	exit 1
fi

if [ "$survived" -ne 1 ]; then
	echo "error: the WebKit web process died within ${settle_seconds}s of" >&2
	echo "       starting, so nothing was ever painted" >&2
	echo "--- application output ---" >&2
	cat "$log" >&2
	exit 1
fi

# Fontconfig failing open leaves the WebView with no glyphs while everything
# else looks healthy, so treat its startup complaints as a failure too.
if grep -qi 'Fontconfig error\|no fonts configured' "$log"; then
	echo "error: fontconfig did not resolve inside the bundle" >&2
	cat "$log" >&2
	exit 1
fi

# GLib logs at these levels for things the bundle got wrong but which do not
# stop the window from appearing. A packaging step that damaged GTK's embedded
# GResource is the case that matters: startup survives it, and only the widgets
# built from a composite template, the file chooser included, are broken.
if grep -q -e '-CRITICAL \*\*' -e '-ERROR \*\*' "$log"; then
	echo "error: the bundle logged GLib criticals during startup" >&2
	cat "$log" >&2
	exit 1
fi

printf 'Tested %s\n' "$appimage"

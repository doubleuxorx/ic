#!/bin/sh
# Run the application in a real webview and let it test itself.
#
# Everything else in this repository is tested without a browser. This is for the
# part that cannot be: whether the webview decodes the media it is given, whether
# PDF.js paints, and whether the content security policy blocks something the
# application needs. The window runs the checks in `src/self-test/runner.ts` and
# writes a report into a scratch workspace; this script waits for it, prints it,
# and exits non-zero if anything failed.
#
# No synthetic input is involved — no xdotool, no screenshots — but a display is:
# WebKitGTK has no headless mode, so it runs under Xvfb.
#
#   sh scripts/self-test.sh
#
# Environment:
#   IC_SELF_TEST_TIMEOUT  seconds to wait for the report (default 240)
#   IC_SELF_TEST_KEEP     set to keep the scratch workspace and logs
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
timeout_seconds="${IC_SELF_TEST_TIMEOUT:-240}"
cd "$root"

for tool in xvfb-run setsid cargo node; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "error: $tool is required" >&2
		exit 2
	fi
done

workdir="$(mktemp -d)"
workspace=''
vite_pid=''
app_pid=''

cleanup() {
	# Both jobs below are started without a wrapping subshell so that these are
	# the processes themselves: killing a subshell would leave the dev server
	# holding port 5173 and xvfb-run's display running.
	[ -n "$vite_pid" ] && kill "$vite_pid" 2>/dev/null || true
	# The application runs in a session of its own, so one signal reaches
	# xvfb-run, the X server it started and the window: xvfb-run itself passes
	# nothing on, and its display would otherwise stay up for good.
	[ -n "$app_pid" ] && kill -- -"$app_pid" 2>/dev/null || true
	# Belt and braces, in case the session was already gone. The scratch path is
	# unique to this run, which makes it the safe thing to match on — and no
	# pattern at all is matched before there is one.
	[ -n "$workspace" ] && pkill -f "ic $workspace" 2>/dev/null || true
	if [ -n "${IC_SELF_TEST_KEEP:-}" ]; then
		echo "kept $workdir"
	else
		rm -rf "$workdir"
	fi
}
trap cleanup EXIT INT TERM

# A workspace the application has never seen, holding one file of every kind the
# self-test has an opinion about.
workspace="$workdir/workspace"
mkdir -p "$workspace/Attachments" "$workspace/Canvases" "$workspace/Notes"
cp "$root/tests/fixtures/media/tiny.mp3" "$workspace/Attachments/"
cp "$root/tests/fixtures/media/tiny.mp4" "$workspace/Attachments/"
cp "$root/tests/fixtures/documents/sample.png" "$workspace/Attachments/"
cp "$root/tests/fixtures/documents/sample.pdf" "$workspace/Attachments/"
printf '# Note\n\nA paragraph.\n' >"$workspace/Notes/note.md"

# A fresh HOME for the application too, so this also covers first-run state
# creation. It goes to that one process rather than to this whole script:
# rustup keeps its toolchains under the real HOME, and where cargo is a rustup
# shim — as it is on a CI runner — exporting a different HOME leaves it unable
# to choose a toolchain at all.
app_home="$workdir/home"
runtime_dir="$workdir/run"
mkdir -p "$app_home" "$runtime_dir"
chmod 700 "$runtime_dir"

# The frontend is served rather than bundled: the self-test harness is selected by
# vite's mode, and a debug binary loading a dev server is far quicker than a
# release build with link-time optimization.
node scripts/prepare-assets.mjs >/dev/null
node_modules/.bin/vite --mode selftest --clearScreen false >"$workdir/vite.log" 2>&1 &
vite_pid=$!

waited=0
while ! grep -q 'ready in' "$workdir/vite.log" 2>/dev/null; do
	if [ "$waited" -ge 60 ]; then
		echo "error: the dev server did not come up" >&2
		cat "$workdir/vite.log" >&2
		exit 1
	fi
	sleep 1
	waited=$((waited + 1))
done

# Built before the clock starts: a compile can take minutes and has nothing to do
# with how long the window should need to answer.
cargo build --quiet --manifest-path src-tauri/Cargo.toml

# A single positional argument opens it as the workspace, exactly as `ic ~/notes`
# does, so nothing has to drive the file picker.
setsid env HOME="$app_home" XDG_RUNTIME_DIR="$runtime_dir" \
	xvfb-run -a -s '-screen 0 1400x900x24' \
	src-tauri/target/debug/ic "$workspace" >"$workdir/app.log" 2>&1 &
app_pid=$!

report="$workspace/self-test-report.txt"
waited=0
while [ ! -f "$report" ]; do
	if ! kill -0 "$app_pid" 2>/dev/null; then
		echo "error: the application exited before reporting" >&2
		tail -40 "$workdir/app.log" >&2
		exit 1
	fi
	if [ "$waited" -ge "$timeout_seconds" ]; then
		echo "error: no report after ${timeout_seconds}s" >&2
		tail -40 "$workdir/app.log" >&2
		exit 1
	fi
	sleep 1
	waited=$((waited + 1))
done

cat "$report"

if ! node -e '
	const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
	const failed = report.checks.filter((check) => !check.ok);
	for (const check of failed) console.error(`FAILED ${check.name}: ${check.detail}`);
	if (report.fatal) console.error(`FAILED the run itself: ${report.fatal}`);
	process.exit(report.ok ? 0 : 1);
' "$report"; then
	echo "--- application output ---" >&2
	tail -60 "$workdir/app.log" >&2
	exit 1
fi

printf 'self-test passed in a real webview\n'

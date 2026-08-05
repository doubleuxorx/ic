#!/bin/sh
set -eu

TOOLS_REV=737c0085912f9f7dabf9341d4608e2a77a51a73a
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM

TOOLS_DIR="$WORK_DIR/flatpak-builder-tools"
VENV_DIR="$WORK_DIR/venv"

git init -q "$TOOLS_DIR"
git -C "$TOOLS_DIR" fetch -q --depth=1 \
	https://github.com/flatpak/flatpak-builder-tools.git "$TOOLS_REV"
git -C "$TOOLS_DIR" checkout -q --detach FETCH_HEAD

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install -q "$TOOLS_DIR/node" tomlkit==0.15.1 aiohttp==3.14.3

cd "$PROJECT_DIR"
"$VENV_DIR/bin/flatpak-node-generator" --no-requests-cache \
	-o flatpak/node-sources.json yarn yarn.lock
"$VENV_DIR/bin/python" \
	"$TOOLS_DIR/cargo/flatpak-cargo-generator.py" \
	src-tauri/Cargo.lock -o flatpak/cargo-sources.json

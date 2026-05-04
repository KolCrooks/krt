#!/usr/bin/env bash
# clean.sh — reset vscode/ to a clean state at the pinned tag.
# Destroys any local changes inside vscode/ — it's a vendored submodule, not
# a place to keep work. Patches under build/patches/krt/ are the source of
# truth for KRT's own changes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"
PIN_FILE="$REPO_ROOT/build/upstream-pin"

if [[ ! -d "$VSCODE_DIR/.git" ]]; then
  echo "[clean] no submodule at $VSCODE_DIR — nothing to do"
  exit 0
fi

PIN="$(tr -d '[:space:]' < "$PIN_FILE")"

cd "$VSCODE_DIR"

if [[ -d .git/rebase-apply ]]; then
  echo "[clean] aborting in-progress git am"
  git am --abort || true
fi

echo "[clean] reset vscode/ to $PIN"
git reset --hard "refs/tags/$PIN" >/dev/null 2>&1 || git reset --hard "$PIN"

echo "[clean] git clean -xdf inside vscode/"
git clean -xdf

cd "$REPO_ROOT"
echo "[clean] done"

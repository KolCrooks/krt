#!/usr/bin/env bash
# prepare_vscode.sh — overlay KRT branding + patches onto the vscode/ submodule.
#
# Run from the repo root: `bash build/prepare_vscode.sh`.
#
# This is a Phase 0 stub. The full implementation lands as part of
# docs/phases/phase-00-scaffold.md. See PLAN.md §4 Phase 0 for the demo gate.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"
BUILD_DIR="$REPO_ROOT/build"
PATCHES_DIR="$BUILD_DIR/patches/krt"

if [[ ! -d "$VSCODE_DIR" ]]; then
  echo "error: $VSCODE_DIR does not exist. Add the upstream submodule first:" >&2
  echo "  git submodule add https://github.com/microsoft/vscode.git vscode" >&2
  exit 1
fi

echo "[prepare_vscode] repo root: $REPO_ROOT"
echo "[prepare_vscode] vscode submodule: $VSCODE_DIR"
echo "[prepare_vscode] patches dir: $PATCHES_DIR"

# TODO(phase-0): Reset vscode/ to the pinned tag before applying anything.
# TODO(phase-1): Overlay build/product.json onto vscode/product.json.
# TODO(phase-0): Apply patches in $PATCHES_DIR in lexical order via `git am`
#                or `git apply`. The first patch lands the trivial KRT
#                status-bar contribution under
#                vscode/src/vs/workbench/contrib/krt/.

echo "[prepare_vscode] stub complete — nothing to do yet"

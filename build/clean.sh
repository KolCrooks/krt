#!/usr/bin/env bash
# clean.sh — wipe build artifacts inside vscode/ (compile output, node_modules,
# downloaded Electron). Does NOT touch source files — vscode/ is vendored, so
# anything outside the ignored set is committed work.
#
# Run from the repo root: `bash build/clean.sh`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"

if [[ ! -d "$VSCODE_DIR" ]]; then
  echo "[clean] $VSCODE_DIR missing — nothing to do"
  exit 0
fi

cd "$VSCODE_DIR"

# Targets match vscode/.gitignore — everything here is build-time output.
echo "[clean] removing vscode/ build artifacts"
rm -rf \
  node_modules \
  out \
  out-build \
  out-vscode \
  out-vscode-min \
  .build \
  .tmp \
  .cache \
  .profile-oss

# Per-extension build output (out/ + node_modules/ + tsbuildinfo).
find extensions .vscode/extensions -mindepth 1 -maxdepth 4 \
  \( -name node_modules -o -name out -o -name dist -o -name 'tsconfig.tsbuildinfo' \) \
  -exec rm -rf {} + 2>/dev/null || true

# Nested build dirs that ship their own node_modules.
rm -rf build/node_modules build/npm/gyp/node_modules build/rspack/node_modules build/vite/node_modules
rm -rf remote/node_modules remote/web/node_modules

cd "$REPO_ROOT"
echo "[clean] done"

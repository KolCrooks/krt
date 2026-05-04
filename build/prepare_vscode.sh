#!/usr/bin/env bash
# prepare_vscode.sh — clone microsoft/vscode into vscode/ if missing,
# reset to the pinned upstream tag, apply KRT patches on top.
#
# Run from the repo root: `bash build/prepare_vscode.sh`.
# Idempotent: running twice yields the same tree.
#
# vscode/ is gitignored — it's a working clone, not vendored. See
# docs/upstream-vscode.md for the bump workflow.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"
BUILD_DIR="$REPO_ROOT/build"
PATCHES_DIR="$BUILD_DIR/patches/krt"
PIN_FILE="$BUILD_DIR/upstream-pin"
UPSTREAM_URL="https://github.com/microsoft/vscode.git"

if [[ ! -f "$PIN_FILE" ]]; then
  echo "error: $PIN_FILE missing — can't determine upstream tag" >&2
  exit 1
fi

PIN="$(tr -d '[:space:]' < "$PIN_FILE")"
echo "[prepare_vscode] pinned upstream tag: $PIN"

# Clone if vscode/ isn't a checkout yet.
if [[ ! -d "$VSCODE_DIR/.git" ]]; then
  echo "[prepare_vscode] vscode/ not present — cloning $UPSTREAM_URL"
  git clone --filter=blob:none "$UPSTREAM_URL" "$VSCODE_DIR"
fi

cd "$VSCODE_DIR"

# Bail any in-progress `git am` from a previous failed run.
if [[ -d .git/rebase-apply ]]; then
  echo "[prepare_vscode] aborting in-progress git am from previous run"
  git am --abort || true
fi

# Make sure the pinned tag is locally available.
if ! git rev-parse "refs/tags/$PIN" >/dev/null 2>&1; then
  echo "[prepare_vscode] tag $PIN not found locally, fetching..."
  git fetch origin "refs/tags/$PIN:refs/tags/$PIN" --no-tags
fi

# Reset to the pinned tag, scrubbing any local edits.
echo "[prepare_vscode] resetting vscode/ to $PIN"
git reset --hard "refs/tags/$PIN" >/dev/null

# Apply patches in lexical order, if any.
shopt -s nullglob
patches=("$PATCHES_DIR"/*.patch)
shopt -u nullglob

if (( ${#patches[@]} == 0 )); then
  echo "[prepare_vscode] no patches in $PATCHES_DIR — nothing to apply"
else
  echo "[prepare_vscode] applying ${#patches[@]} patch(es) from $PATCHES_DIR"
  for p in "${patches[@]}"; do
    echo "  - $(basename "$p")"
  done
  git am --keep-cr "${patches[@]}"
fi

cd "$REPO_ROOT"

# Overlay our product.json overrides (KRT branding, open-vsx gallery, MS strips)
# onto upstream's product.json. Done after `git am` so patches apply against
# pristine upstream. Result lands as a working-tree modification, not a commit —
# clean.sh / a fresh reset wipes it cleanly.
echo "[prepare_vscode] overlaying $BUILD_DIR/product.json onto vscode/product.json"
node "$BUILD_DIR/merge-product.mjs" \
  "$VSCODE_DIR/product.json" \
  "$BUILD_DIR/product.json" \
  "$VSCODE_DIR/product.json"

# Remove MS-coupled built-in extensions we don't ship. The companion patch in
# build/patches/krt strips references from build/npm/dirs.ts, build/lib/extensions.ts,
# and build/gulpfile.extensions.ts so the build pipeline doesn't try to compile them.
# Done as an rm here (not a patch) because the diff would be 2GB+ of dependency
# tree noise; the rm is reproducible and the deleted set is small + explicit.
echo "[prepare_vscode] removing MS-coupled built-in extensions"
rm -rf \
  "$VSCODE_DIR/extensions/copilot" \
  "$VSCODE_DIR/extensions/microsoft-authentication" \
  "$VSCODE_DIR/extensions/mermaid-chat-features"

# Swap in KRT placeholder icons. The .icns / .png assets live in build/icons/
# (committed, regenerable via build/icons/build-icns.sh). Phase 11 swaps these
# for polished assets. We don't touch the win32 .ico — that's packaging
# territory and the dev launch doesn't need it.
echo "[prepare_vscode] swapping in KRT icons"
cp "$BUILD_DIR/icons/krt.icns" "$VSCODE_DIR/resources/darwin/code.icns"
cp "$BUILD_DIR/icons/krt.png"  "$VSCODE_DIR/resources/linux/code.png"

echo "[prepare_vscode] done"

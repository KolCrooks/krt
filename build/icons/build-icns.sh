#!/usr/bin/env bash
# build-icns.sh — turn build/icons/krt-1024.png into a macOS .icns file.
#
# Run from repo root: `bash build/icons/build-icns.sh`.
# Output: build/icons/krt.icns (committed) and build/icons/krt.png (1024 PNG
# for Linux). The Windows .ico is left to Phase 11 packaging.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ICONS_DIR="$REPO_ROOT/build/icons"
SRC="$ICONS_DIR/krt-1024.png"

if [[ ! -f "$SRC" ]]; then
  echo "error: $SRC missing — run build/icons/generate.py first" >&2
  exit 1
fi

ICONSET="$ICONS_DIR/krt.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
trap 'rm -rf "$ICONSET"' EXIT

# Apple's required sizes for a fully-fledged .icns.
declare -a SIZES=(16 32 64 128 256 512 1024)
for s in "${SIZES[@]}"; do
  sips -z "$s" "$s" "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
done
# @2x variants — copy the larger size and rename.
cp "$ICONSET/icon_32x32.png"    "$ICONSET/icon_16x16@2x.png"
cp "$ICONSET/icon_64x64.png"    "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png"  "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png"  "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
# 64x64 was only needed as 32x32@2x; iconutil doesn't accept it bare.
rm "$ICONSET/icon_64x64.png"

iconutil -c icns "$ICONSET" -o "$ICONS_DIR/krt.icns"

# Linux just takes a PNG.
cp "$SRC" "$ICONS_DIR/krt.png"

echo "wrote $ICONS_DIR/krt.icns ($(wc -c < "$ICONS_DIR/krt.icns") bytes)"
echo "wrote $ICONS_DIR/krt.png  ($(wc -c < "$ICONS_DIR/krt.png") bytes)"

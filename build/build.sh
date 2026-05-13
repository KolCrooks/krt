#!/usr/bin/env bash
# build.sh — full one-shot build of KRT.
#
# Run from the repo root: `bash build/build.sh`.
# Steps: npm install, compile, rebuild native modules against Electron.
# vscode/ is vendored source — edit it directly, no patch step.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"

# Use Node 22 if system node is a different major version.
# brew install node@22  (one-time on macOS, if missing)
for node22 in /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
  if [[ -d "$node22" ]]; then
    export PATH="$node22:$PATH"
    break
  fi
done

if ! command -v node &>/dev/null; then
  echo "[build] ERROR: node not found. Install Node 22 (brew install node@22)." >&2
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [[ "$NODE_MAJOR" != "22" ]]; then
  echo "[build] ERROR: Node 22 required (got $NODE_MAJOR). Run: brew install node@22" >&2
  exit 1
fi

# Fail fast on Microsoft endpoints in shipping source — runs before the
# compile so we don't waste a build on a stripped-feature regression.
bash "$REPO_ROOT/build/check-no-ms-endpoints.sh"

cd "$VSCODE_DIR"

# @vscode/ripgrep postinstall fetches a binary from the GitHub API. Unauthenticated
# requests are limited to 60/hour and fail with 403 when exhausted. Pre-populate
# bin/ so the postinstall skips the download entirely (it exits early if bin/ exists).
#
# We seed both the root and remote/ locations before their respective npm installs.
# remote/ is installed by root's postinstall.ts, so we can't seed it beforehand —
# instead remote/.npmrc sets ignore-scripts=true and we seed after the fact.
# Native modules skipped by ignore-scripts are caught by electron-rebuild below.
ARCH=$(uname -m)  # arm64 or x86_64
RG_DEST="$VSCODE_DIR/node_modules/@vscode/ripgrep/bin/rg"
REMOTE_RG_DEST="$VSCODE_DIR/remote/node_modules/@vscode/ripgrep/bin/rg"
RG_SRC=$(command -v rg 2>/dev/null || true)
if [[ -z "$RG_SRC" ]]; then
  for search_root in /opt/homebrew/lib/node_modules /usr/local/lib/node_modules; do
    found=$(find "$search_root" -path "*ripgrep/${ARCH}-darwin/rg" -type f 2>/dev/null | head -1 || true)
    if [[ -n "$found" ]]; then
      RG_SRC="$found"
      break
    fi
  done
fi

seed_ripgrep() {
  local dest="$1"
  if [[ -n "$RG_SRC" && ! -f "$dest" ]]; then
    mkdir -p "$(dirname "$dest")"
    cp "$RG_SRC" "$dest"
    echo "[build] seeded $(dirname "$dest") with system rg"
  fi
}

# Seed root before npm install so the postinstall skips the download.
seed_ripgrep "$RG_DEST"

echo "[build] npm install"
npm install --no-audit --no-fund

# Seed remote/ after its install (remote/.npmrc skips scripts; we fill in rg manually).
seed_ripgrep "$REMOTE_RG_DEST"

# Download Electron (needed to determine ABI for native module rebuild).
echo "[build] downloading Electron"
npm run electron

ELECTRON_VERSION=$(cat "$VSCODE_DIR/.build/electron/version" 2>/dev/null || true)
if [[ -n "$ELECTRON_VERSION" ]]; then
  echo "[build] rebuilding native modules against Electron $ELECTRON_VERSION"
  npx --yes @electron/rebuild --version "$ELECTRON_VERSION"
fi

echo "[build] npm run compile"
npm run compile

cd "$REPO_ROOT"
echo "[build] done — launch with: ./vscode/scripts/code.sh"

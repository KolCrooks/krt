#!/usr/bin/env bash
# build.sh — full one-shot build of KRT.
#
# Run from the repo root: `bash build/build.sh`.
# Steps: prepare_vscode.sh (reset + patch), npm install, compile.
#
# For dev iteration, use build/watch.sh once it exists (Phase 0 follow-up).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"

bash "$REPO_ROOT/build/prepare_vscode.sh"

# Fail fast on Microsoft endpoints in shipping source — runs before the
# 5-minute compile so we don't waste a build on a stripped-feature regression.
bash "$REPO_ROOT/build/check-no-ms-endpoints.sh"

cd "$VSCODE_DIR"

echo "[build] npm install"
npm install --no-audit --no-fund

echo "[build] npm run compile"
npm run compile

cd "$REPO_ROOT"
echo "[build] done — launch with: ./vscode/scripts/code.sh"

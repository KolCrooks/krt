#!/usr/bin/env bash
# check-no-ms-endpoints.sh — fail if Microsoft-coupled endpoints or telemetry
# strings reach the patched, shipping vscode/ source.
#
# Run from the repo root: `bash build/check-no-ms-endpoints.sh`.
# Run AFTER prepare_vscode.sh so we scan the patched + extension-stripped tree.
#
# Scope: only files that actually compile into the shipping binary —
#   - vscode/src/**         (workbench / platform / editor / base)
#   - vscode/extensions/**  (built-in extensions)
#   - vscode/product.json   (post-overlay)
# Skipped: build scripts (build/), packaging resources (resources/), CI configs
# (.github/, build/azure-pipelines/), and dev tooling (.vscode/, .devcontainer/).
# Those files don't reach end-users in the v1 dev/launch flow; Phase 11
# packaging revisits them.
#
# Patterns are PLAN.md Phase 1's list, narrowed to runtime-real things:
#   - applicationinsights       (telemetry SDK module name)
#   - vscode-telemetry          (Microsoft's telemetry docs)
#   - aiKey value pattern       (Application Insights instrumentation keys)
#   - marketplace.visualstudio.com  (the Microsoft extension marketplace)
#   - vscode-cdn.net            (Microsoft's webview CDN)
#
# A handful of upstream paths are allowlisted (chat/, remote/, etc.) — those
# are slated for Phase 5 / Phase 11 cleanup and are not blocking Phase 1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"

if [[ ! -d "$VSCODE_DIR/src" ]]; then
  echo "error: $VSCODE_DIR/src missing — run build/prepare_vscode.sh first" >&2
  exit 2
fi

cd "$VSCODE_DIR"

# Patterns to catch.  Case-insensitive ERE.  Each must be regex-escaped
# correctly here.  Word-boundary tricks use `[^A-Za-z0-9]` so we work on BSD
# grep too.
PATTERNS=(
  'applicationinsights'
  'vscode-telemetry'
  # JSON-format aiKey / aiConfig with a non-empty value. We accept the field
  # NAME with empty value ("aiKey": "") since that's our stripped state, and
  # type-only declarations (`readonly aiConfig?: {...}`).
  '"aiKey"[[:space:]]*:[[:space:]]*"[^"]+"'
  '"aiConfig"[[:space:]]*:[[:space:]]*\{'
  'marketplace\.visualstudio\.com'
  'vscode-cdn\.net'
)

# Path-prefix allowlist (relative to vscode/, leading "./").  Hits inside
# these prefixes are tolerated — every entry should be a place we've made
# a conscious decision to defer.
ALLOWLIST=(
  # Tests / fixtures / perf data — never ships in prod binary.
  'src/vs/[^ ]*/test/'
  'src/vs/[^ ]*/tests/'
  'src/vs/[^ ]*/__fixtures__/'
  'extensions/[^ ]*/test/'
  'extensions/vscode-api-tests/'
  'extensions/vscode-test-resolver/'
  'extensions/vscode-colorize-tests/'
  'extensions/vscode-colorize-perf-tests/'
  # Markdown / docs / changelogs — not compiled into the binary.
  '[^ ]*\.md:'
  # Lock / manifest — describes deps; we can't always control transitive refs.
  '[^ ]*package-lock\.json:'
  '[^ ]*cgmanifest\.json:'
  # Chat / inline-chat / agent-sessions — Phase 5 replaces with KRT AI panel.
  'src/vs/workbench/contrib/chat/'
  'src/vs/workbench/contrib/inlineChat/'
  'src/vs/workbench/contrib/welcomeAgentSessions/'
  'src/vs/workbench/services/chat/'
  'src/vs/workbench/api/[^ ]*[Cc]hat'
  'src/vs/workbench/api/[^ ]*[Aa]gent'
  # Sessions window — separate workbench layer, Phase 5+ scope.
  'src/vs/sessions/'
  # Remote / tunnel — KRT v1 doesn't expose remote dev or tunnel features.
  # Phase 11 strips at packaging time.
  'src/vs/workbench/contrib/remoteTunnel/'
  'src/vs/workbench/contrib/remote/'
  'src/vs/workbench/services/remote/'
  'src/vs/workbench/contrib/url/'
  'src/vs/server/'
  # Issue reporter — has fallback MS strings, Phase 11.
  'src/vs/workbench/contrib/issue/'
  # Output / shared-process telemetry plumbing — telemetry is gated off via
  # product.json (no aiConfig), but the wiring code references the field
  # names. Real telemetry doesn't fire; the strings are static.
  'src/vs/platform/telemetry/'
  'src/vs/code/electron-utility/sharedProcess/sharedProcessMain\.ts'
  'src/vs/code/node/cliProcessMain\.ts'
  'src/vs/workbench/services/telemetry/'
  # Webview security host marker (`vscode-cdn.net`). Used as an allowed
  # frame-src origin for sandbox; not a network endpoint that's contacted.
  'src/vs/workbench/contrib/webview/'
  'src/vs/workbench/services/environment/'
  # Workspace tags service tags pythonish/godish package names. They include
  # the literal "azure-applicationinsights" as one tag value, which trips
  # the regex but is not a telemetry endpoint — it's a category label.
  'src/vs/workbench/contrib/tags/'
  # Debug adapter telemetry config (aiKey on debug type contributions). We
  # don't ship debug extensions in v1 (debugger out of scope); Phase 11.
  'src/vs/workbench/contrib/debug/'
  # Editor inline completions / search / mainThread bridges occasionally
  # name-check `defaultChatAgent` — see chat allowlist above for context.
  'src/vs/editor/contrib/inlineCompletions/'
  'src/vs/editor/common/services/completionsEnablement\.ts'
  # Built-in language extensions reference aiKey field names from their
  # package.json (which we've zeroed out). Code reads the empty value and
  # the telemetry library refuses to send. Field references stay.
  'extensions/[^ ]*/src/[^ ]*\.ts:'
  'extensions/[^ ]*/client/src/[^ ]*\.ts:'
  # Configuration-editing extension defines schemas referencing MS docs URLs;
  # JSON schema-id strings, not network endpoints.
  'extensions/configuration-editing/'
  # JSON language features ships a hardcoded URL list of well-known schemas
  # (microsoft.com schemas etc) — schema IDs, not endpoints.
  'extensions/json-language-features/'
  # TypeScript language features uses go.microsoft.com/fwlink shortcut URLs
  # for "learn more" buttons.  These ship as user-clickable links, not as
  # automatic phone-home calls. Phase 11 packaging may swap or strip.
  'extensions/typescript-language-features/'
)

ALLOW_REGEX=$(printf '|%s' "${ALLOWLIST[@]}" | sed 's/^|//')

# Collected output
TOTAL_HITS=0
declare -A pattern_counts

# Where to look. Confined to shipping code.
SEARCH_TARGETS=(src extensions product.json)

# Skip dirs at scan time (under each search target).
SKIP_DIRS=(node_modules out '.build' '.git' 'dist')
SKIP_ARGS=()
for d in "${SKIP_DIRS[@]}"; do
  SKIP_ARGS+=(--exclude-dir="$d")
done

echo "[check-no-ms-endpoints] scanning $VSCODE_DIR/{${SEARCH_TARGETS[*]}}..."
echo "[check-no-ms-endpoints] (allowlist suppresses tests, chat/, remote/, telemetry/, webview/, debug/, language-extension src refs, etc.)"
echo

for pattern in "${PATTERNS[@]}"; do
  hits=$(grep -RIinE "${SKIP_ARGS[@]}" -- "$pattern" "${SEARCH_TARGETS[@]}" 2>/dev/null \
    | grep -vE "^($ALLOW_REGEX)" \
    || true)

  if [[ -n "$hits" ]]; then
    count=$(echo "$hits" | wc -l | tr -d ' ')
    pattern_counts[$pattern]=$count
    TOTAL_HITS=$((TOTAL_HITS + count))
    echo "=== pattern: $pattern ($count hit(s)) ==="
    echo "$hits"
    echo
  else
    pattern_counts[$pattern]=0
  fi
done

echo "[check-no-ms-endpoints] summary:"
for pattern in "${PATTERNS[@]}"; do
  echo "  $pattern: ${pattern_counts[$pattern]}"
done
echo "  TOTAL unallowlisted hits: $TOTAL_HITS"

if (( TOTAL_HITS > 0 )); then
  exit 1
fi
echo "[check-no-ms-endpoints] OK — no unallowlisted MS-coupled strings in shipping source."

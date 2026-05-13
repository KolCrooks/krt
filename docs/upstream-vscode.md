# Upstream `vscode/` source

KRT is a fork of `microsoft/vscode`. The source lives at `./vscode/` and is
**vendored** — committed directly into the KRT repo, no submodule, no
clone-on-build, no patch series.

## Fork base

| Field | Value |
| --- | --- |
| Forked from | `microsoft/vscode` tag `1.118.1` |
| Released | 2026-04-30 |
| Forked on | 2026-05-04 (Phase 0) |
| Vendored on | 2026-05-13 (this rewrite) |
| Node required | 22.22.1 (per `vscode/.nvmrc`) |
| Package manager | npm |

If you use jj, raise the snapshot file-size limit once after cloning —
two upstream perf-test fixtures (`vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-checker.ts`
and `vscode/src/vs/base/test/node/uri.perf.data.txt`) exceed jj's 5 MB
default:

```sh
jj config set --repo snapshot.max-new-file-size 16777216
```

Earlier KRT (Phase 0 through Phase 11) maintained `vscode/` as a runtime
clone of upstream with a 107-patch series applied via `git am` on every
build. That setup was replaced on 2026-05-13: the patch series was
collapsed into the committed source, the nested `.git` was dropped, and
`vscode/` became plain files inside the KRT repo. See git/jj history for
the conversion commit.

## Bumping upstream

Roughly weekly during active development; less often once we ship.

Bumping is now a manual three-way merge against a side clone of upstream.
There is no `prepare_vscode.sh` doing this automatically.

1. Clone upstream into a sibling directory the first time:
   ```sh
   git clone --filter=blob:none https://github.com/microsoft/vscode.git ~/src/vscode-upstream
   ```
2. Find the diff between the current fork base and the candidate upstream
   tag:
   ```sh
   cd ~/src/vscode-upstream
   git fetch origin 'refs/tags/*:refs/tags/*'
   git diff 1.118.1 1.119.0 -- . ':!extensions/copilot' ':!extensions/microsoft-authentication' ':!extensions/mermaid-chat-features' > /tmp/upstream.diff
   ```
   (Exclude the extensions we deleted so they don't show as conflicts.)
3. Read the changelog. Pay attention to breaking changes in:
   - The workbench shell (we replace the title bar, activity bar, tabs).
   - `EditorInput` / `EditorPane` (PR / Review modes are custom inputs).
   - The extension host API (we depend on this staying compatible).
   - Build tooling (npm scripts, gulp tasks, electron version).
4. Apply the diff to `vscode/` via `git apply --3way` (run from the KRT
   repo root). Resolve conflicts in-place.
5. Update the table above with the new tag + date.
6. Full clean build: `bash build/clean.sh && bash build/build.sh`. Launch
   and exercise the demo gate for whichever phase you're in.
7. Single jj revision per upstream bump; describe with the upstream tag
   range, e.g. `Bump vscode 1.118.1 → 1.119.0`.

## Why pin to a release tag instead of `main`

PLAN.md §6 calls upstream churn the top risk for this fork. `main` lands
~150 commits/week; merging against a moving target while we're still
building basic infrastructure would burn time we don't have. A release
tag is stable for ~30 days (until the next release), which gives us a
predictable rebase cadence.

## What we depend on staying stable upstream

- Monaco editor (`vs/editor/`) — Diff view, Editor view rely on it.
- `EditorInput` / `IEditorService` / `IEditorPane` — PR and Review modes
  are custom editor inputs.
- `IStatusbarService`, `IThemeService`, `IStorageService`,
  `IPreferencesService` — used across KRT contributions.
- The extension host (`extensions/extensionHost.ts` and adjacent) — must
  keep working for language servers from open-vsx.
- Built-in language extensions in `vscode/extensions/` — TS, JSON, HTML,
  CSS, Markdown, Git. These ship with the binary.

## What we deliberately rip out

Tracked in PLAN.md §4 Phase 1. Briefly:

- All telemetry (`applicationinsights`, telemetry endpoints, crash report
  uploads).
- The Microsoft Marketplace gallery URL — replaced with open-vsx.
- MS sign-in, Walkthrough / "Get Started" page, Live Share.
- Multi-window code paths (`File → New Window`, `workbench.action.newWindow`).
- Built-in extensions: `extensions/copilot`, `extensions/microsoft-authentication`,
  `extensions/mermaid-chat-features` — physically deleted from the tree.

Because the source is vendored, these are just changes in the committed
working tree; `check-no-ms-endpoints.sh` keeps regressions out.

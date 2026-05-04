# Upstream `vscode/` clone

KRT works against a local clone of `microsoft/vscode` at `./vscode/`. The
clone is **gitignored** — it's not vendored, not a submodule. The single
source of truth for the version we target is `build/upstream-pin`;
`build/prepare_vscode.sh` clones (if missing), resets to that tag, and
applies the patches in `build/patches/krt/`.

This deviates from PLAN.md §2 which calls for a git submodule. Reasons for
the change, made during Phase 0:

- `jj` 0.40 (the VCS we use per the user's global preference) does not
  capture submodule pointers in commits — verified empirically.
- VSCodium itself, which PLAN.md cites as the build-pipeline reference,
  uses a clone-via-script approach, not a submodule.
- A gitignored clone keeps the KRT repo small for new contributors and
  avoids cross-tool impedance.

## Current pin

| Field | Value |
| --- | --- |
| Tag | `1.118.1` |
| Released | 2026-04-30 |
| Pinned on | 2026-05-04 (Phase 0) |
| Node required | 22.22.1 (per upstream `.nvmrc`) |
| Package manager | npm |
| KRT phase that pinned | [Phase 0](./phases/phase-00-scaffold.md) |

## Why pin to a release tag instead of `main`

PLAN.md §6 calls upstream churn the top risk for this fork. `main` lands
~150 commits/week; rebasing our patches against a moving target while we're
still building basic infrastructure would burn time we don't have. A
release tag is stable for ~30 days (until the next release), which gives us
a predictable rebase cadence.

## Bumping the pin

Roughly weekly during active development; less often once we ship.

1. Read the upstream changelog between the current pin and the candidate
   tag — look for breaking changes in:
   - The workbench shell (we replace the title bar, activity bar, tabs)
   - `EditorInput` / `EditorPane` (PR / Review modes are custom inputs)
   - The extension host API (we depend on this staying compatible)
   - Build tooling (npm scripts, gulp tasks, electron version)
2. Edit `build/upstream-pin` to the new tag.
3. Run `bash build/prepare_vscode.sh` — it fetches the new tag, resets
   `vscode/`, and re-applies the patch set in `build/patches/krt/`. If a
   hunk fails, fix the patch (regenerate from inside `vscode/` after
   manually rebasing the underlying change).
4. Full clean build: `bash build/clean.sh && bash build/build.sh`. Launch
   and exercise the demo gate for whichever phase you're in.
5. Commit:
   - `build/upstream-pin` change
   - Any patch regenerations under `build/patches/krt/`
   - Update the table at the top of this file
6. Single jj revision per upstream bump; describe with the upstream tag
   range, e.g. `Bump vscode 1.118.1 → 1.119.0`.

## What we depend on staying stable upstream

- Monaco editor (`vs/editor/`) — Diff view, Editor view rely on it.
- `EditorInput` / `IEditorService` / `IEditorPane` — PR and Review modes are
  custom editor inputs.
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

These removals all live as patches in `build/patches/krt/` so they can be
re-derived against any upstream tag.

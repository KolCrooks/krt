# Phase 0 — Scaffold the fork

Goal: a stock VSCodium-equivalent build that launches with one trivial KRT
contribution visible (status-bar item that reads "KRT"). No branding, no
shell replacement, no PR features yet — just prove the build pipeline and
that we can land code in `src/vs/workbench/contrib/krt/`.

Reference: PLAN.md §4 Phase 0. PLAN.md is the source of truth; this file
is the working checklist.

## Tasks

### Pre-work (local repo scaffolding) — done before Phase 0 proper

- [x] Initialize jj repo (`jj git init --colocate`)
- [x] Move design bundle into `design/kol-s-review-tool/`
- [x] Add `.gitignore` and `.gitattributes`
- [x] Create this checklist file
- [x] Stand up `build/` directory skeleton (`product.json`, `prepare_vscode.sh` stub, `patches/krt/`)
- [x] Add minimal repo `README.md`
- [ ] First commit on jj
- [ ] GitHub remote configured + initial push

### Phase 0 proper

#### Submodule the upstream

- [ ] Pick a known-good upstream tag. Open question — see below.
- [ ] `git submodule add https://github.com/microsoft/vscode.git vscode`
- [ ] Pin to the chosen tag (`cd vscode && git checkout <tag>`)
- [ ] Verify `vscode/.gitignore` is sensible (it is — upstream's own)
- [ ] Document the upstream tag and the date pinned in `docs/upstream-vscode.md`

#### Build scripts in build/

- [ ] Flesh out `build/prepare_vscode.sh`:
  - [ ] Copy/symlink `build/product.json` over `vscode/product.json`
  - [ ] Apply patches from `build/patches/krt/` in lexical order
  - [ ] Reproducible (running twice yields the same tree)
- [ ] Add `build/build.sh` wrapper that calls `prepare_vscode.sh` then `yarn`
  in `vscode/` (or `npm` — whichever the pinned upstream tag uses)
- [ ] Add `build/clean.sh` that resets `vscode/` to the pinned tag and removes
  generated files
- [ ] Verify `bash build/build.sh` produces a launchable Electron app

#### Trivial KRT contribution

- [ ] Create `vscode/src/vs/workbench/contrib/krt/` (added by patch, not
  directly committed in `vscode/`):
  - [ ] `browser/krt.contribution.ts` — registers a status-bar item via
    `IStatusbarService` reading "KRT"
  - [ ] `browser/krtStatusBar.ts` — the contribution class
  - [ ] Wire it into `vscode/src/vs/workbench/workbench.common.main.ts`
- [ ] Generate a patch from the change and store under `build/patches/krt/0001-status-bar.patch`
- [ ] Re-run `build/build.sh` from a clean state and confirm patch applies
  cleanly

#### Demo gate

- [ ] Launch the build (`./vscode/scripts/code.sh` or equivalent on macOS)
- [ ] Confirm: a stock-looking VSCode window opens, status bar shows "KRT"
- [ ] Screenshot or short clip captured for the working log
- [ ] Tag the commit `phase-00-complete`

## Open questions

- **Which upstream tag?** Need to pick one with a stable Electron and node
  bundling story. Likely a recent `1.NN.0` release tag (not a Recovery /
  Insiders tag). Decide by reading `microsoft/vscode/CHANGELOG.md` and the
  VSCodium build matrix. **Don't pick `main` HEAD** — too churn-y for a
  scaffold phase.
- **yarn vs npm?** Upstream switched build tooling at some point. Use
  whatever the pinned tag's `README.md` / `CONTRIBUTING.md` says.
- **Submodule vs subtree?** PLAN.md §2 says submodule. Sticking with that
  unless rebasing weekly proves too painful, in which case revisit in Phase 2
  notes.
- **Patch storage format?** Standard `git format-patch` output (`*.patch`)
  vs. a single combined diff. Going with `git format-patch` style — VSCodium
  uses this and it survives upstream rebases better.

## Decisions made during execution

(Filled in as we go.)

## Follow-ups deferred to later phases

- **Branding** — Phase 1. We deliberately don't change `product.json`'s
  `nameShort` etc. in Phase 0; the build should still say "Code - OSS" so
  we know we haven't broken the upstream pipeline.
- **Telemetry strip** — Phase 1. The CI grep that fails on `applicationinsights`
  / Microsoft endpoints lands with the branding work, not here.
- **Single-window lock** — Phase 1.
- **Open-VSX gallery URL** — Phase 1.
- **Icon replacement** — Phase 1.

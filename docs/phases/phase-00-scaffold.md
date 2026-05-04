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
- [x] First commit on jj
- [x] GitHub remote configured + initial push (`KolCrooks/krt`, private)

### Phase 0 proper

#### Pin the upstream (gitignored clone, not a submodule — see decisions)

- [x] Pick a known-good upstream tag → `1.118.1`
- [x] Record the pin in `build/upstream-pin`
- [x] Add `vscode/` to `.gitignore`
- [x] Have `build/prepare_vscode.sh` clone-and-pin idempotently
- [x] Document upstream tag, date pinned, bump workflow in `docs/upstream-vscode.md`

#### Build scripts in build/

- [x] Flesh out `build/prepare_vscode.sh`:
  - [ ] Copy/symlink `build/product.json` over `vscode/product.json`
        (deferred to Phase 1 with the rest of the branding work)
  - [x] Apply patches from `build/patches/krt/` in lexical order
  - [x] Reproducible (running twice yields the same tree)
  - [x] Aborts an in-progress `git am` from a previous failed run
- [x] Add `build/build.sh` wrapper that calls `prepare_vscode.sh` then `npm`
  in `vscode/`
- [x] Add `build/clean.sh` that resets `vscode/` to the pinned tag and
  runs `git clean -xdf` inside the clone
- [x] Verify `npm install` succeeds against the pinned tag
- [x] Verify `npm run compile-check-ts-native` passes against the patched
  source (ran type-check; full compile + Electron launch deferred to
  the demo gate)

#### Trivial KRT contribution

- [x] Create `vscode/src/vs/workbench/contrib/krt/browser/krt.contribution.ts`
  — single file with the contribution class and registration. Combined
  with `krtStatusBar.ts` from the original plan since the contribution is
  trivial.
- [x] Wire it into `vscode/src/vs/workbench/workbench.common.main.ts`
  (side-effect import)
- [x] Register `vs/workbench/contrib/krt` in `build/lib/i18n.resources.json`
  (silences the i18n-extraction hygiene reminder)
- [x] Use the upstream Microsoft copyright header verbatim — required by
  `build/hygiene.ts` and the eslint `header/header` rule. Phase 11 of
  PLAN.md handles public-release licensing/branding.
- [x] Generate the patch: `build/patches/krt/0001-Add-KRT-status-bar-contribution.patch`
- [x] Confirm `prepare_vscode.sh` applies the patch cleanly from a fresh
  reset to the pinned tag

#### Demo gate

- [ ] Launch the build (`./vscode/scripts/code.sh` or equivalent on macOS)
- [ ] Confirm: a stock-looking VSCode window opens, status bar shows "KRT"
- [ ] Screenshot or short clip captured for the working log
- [ ] Tag the commit `phase-00-complete`

The full compile (gulp + Electron) is heavy (~5–15 min on a fresh checkout)
and ends in launching a GUI window. Best run interactively. After
`bash build/build.sh && ./vscode/scripts/code.sh`, the status bar should
read "KRT" on the left.

## Open questions

(none open at the moment — see Decisions below)

## Decisions made during execution

- **Upstream tag = `1.118.1`** (latest stable, released 2026-04-30).
  Picked over `main` HEAD because PLAN.md §6 calls upstream churn the top
  risk and a scaffolding phase shouldn't fight that.
- **npm, not yarn.** Upstream's `package.json` at `1.118.1` uses
  `npm-run-all2` and `node build/npm/preinstall.ts`. Yarn isn't referenced
  in the build scripts at this tag.
- **Node 22.22.1 required, not just 22.x.** Started Phase 0 on Node 22.17.1;
  `preinstall.ts` failed because it's a `.ts` file and 22.17 doesn't have
  built-in TypeScript stripping (added in 22.18+). `nvm install 22.22.1`
  fixed it. **Build scripts assume `npm` and `node` resolve to ≥22.22.1
  in PATH** — they don't shell-load nvm themselves.
- **Patch storage format = `git format-patch`** output (`*.patch`).
  VSCodium uses this and it survives upstream rebases better than a single
  combined diff.
- **Deviation from PLAN.md §2: clone, not submodule.** vscode/ is a
  gitignored clone, set up by `build/prepare_vscode.sh`. Two reasons:
  (1) `jj` 0.40 doesn't capture submodule gitlink entries in commits —
  empirically verified during this phase. (2) VSCodium itself, the build
  reference PLAN.md cites, uses clone-via-script. The functional goal of
  PLAN.md §2 (a kept-rebasable upstream) is preserved.

## Follow-ups deferred to later phases

- **Branding** — Phase 1. We deliberately don't change `product.json`'s
  `nameShort` etc. in Phase 0; the build should still say "Code - OSS" so
  we know we haven't broken the upstream pipeline.
- **Telemetry strip** — Phase 1. The CI grep that fails on `applicationinsights`
  / Microsoft endpoints lands with the branding work, not here.
- **Single-window lock** — Phase 1.
- **Open-VSX gallery URL** — Phase 1.
- **Icon replacement** — Phase 1.

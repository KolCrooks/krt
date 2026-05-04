# Phase 2 — Shell replacement

Goal: replace VS Code's outer chrome with KRT's. By the end, an empty
launch shows KRT's title bar (traffic-lights + repo/branch badge), KRT's
4-button left rail (Search/PR/Review/Editor) with a Settings gear pinned
to the bottom, a themed tab bar with the accent underline + mode dot, no
menu bar, no command-palette `⌘K`. Gear opens stock Settings; Extensions
tab still installs from open-vsx.

Reference: PLAN.md §4 Phase 2. PLAN.md is the source of truth; this file
is the working checklist. Design reference: `design/kol-s-review-tool/
project/{app.jsx,styles.css,icons.jsx}`.

## Working order

Smallest reversible piece first; plumbing before pixels.

1. **Theme tokens + CSS-variable injection** — workbench contribution that
   sets `--accent`, `--accent-soft`, `--accent-line`, `--accent-2` on
   document root from a fixed Indigo palette. Smallest change with no
   visible diff yet — proves we can touch the DOM at workbench startup.
   Phase 10 swaps this fixed palette for a Tweaks-driven one.
2. **KRT contrib scaffold** — pull the existing `krt.contribution.ts`
   apart into `media/`, `theme/`, `rail/`, `titlebar/` so each piece can
   land independently. The Phase-0 status-bar entry survives as a
   regression check for the contrib wiring.
3. **Menu bar / status bar / `⌘K` strip** — `window.menuBarVisibility`
   default → `'hidden'`, `workbench.statusBar.visible` default → `false`,
   and unbind `workbench.action.showCommands` from `Cmd+Shift+P`/`Ctrl+
   Shift+P` (the palette stays reachable; the chord just doesn't claim
   `⌘K`). Settings defaults are the cheapest way to hide chrome — no
   patches against view-registry code.
4. **KRT rail (replace activity bar)** — patch
   `activitybarPart.ts` to render KRT's 4-button rail + gear. Keeps the
   activity bar's part wiring (sizing, layout slot, visibility command)
   and just swaps what gets drawn. Buttons are inert except gear, which
   runs `workbench.action.openSettings2`. PR-mode buttons no-op until
   Phase 3 has tabs to flip.
5. **Title bar replacement** — patch `titlebarPart.ts` to render the
   traffic-lights gutter (macOS) + repo/branch badge in the centre.
   Branch badge is a static placeholder (`KRT` literal) until Phase 3
   wires real PR data. On Windows/Linux we draw KRT's centred title with
   a hidden lights gutter — keep the WCO/menubar bypass for now.
6. **Tab bar theming** — light background, accent underline on active
   tab, per-mode dot (review/editor/view colours). Lives as a CSS
   contribution loaded by the workbench, scoped to `.monaco-workbench`
   to avoid leaking into webviews. No patch — pure additive CSS.
7. **Demo gate** — launch shows KRT chrome end-to-end. Open Settings via
   the gear, browse Extensions tab, install something from open-vsx,
   confirm gallery still works. Runtime-verified via screencap + Read.

## Tasks

### Theme tokens + CSS-variable injection

- [x] `vscode/src/vs/workbench/contrib/krt/browser/theme/krtAccent.contribution.ts`
      — workbench contribution at `LifecyclePhase.Restored` that writes
      the Indigo palette from `app.jsx` onto `document.documentElement`
      as `--krt-accent` / `-2` / `-soft` / `-line`. Phase 10 swaps the
      fixed palette for a Tweaks-driven one.
- [x] Side-effect import added to the barrel `krt.contribution.ts`.
- [x] Variables registered in
      `build/lib/stylelint/vscode-known-variables.json` so the hygiene
      check accepts them.

### KRT contrib scaffold

- [x] Kept `krt.contribution.ts` as the barrel: it still owns the
      Phase-0 status-bar entry (regression check for the wiring) and
      side-effect-imports each new sub-module. Decision: don't split
      the status bar out yet — it's tiny and renaming would burn a
      patch slot. Re-evaluate if scope grows.
- [x] Sub-dirs landed: `theme/`, `chrome/`, `tabs/`. Rail moved to
      `services/krt/browser/` (see decisions below).

### Hide menu bar / status bar / unbind ⌘⇧P

- [x] `chrome/krtChrome.contribution.ts` registers config defaults via
      `IConfigurationRegistry.registerDefaultConfigurations`:
      `window.menuBarVisibility: 'hidden'`,
      `window.commandCenter: false`,
      `workbench.layoutControl.enabled: false`.
- [x] `KeybindingsRegistry.registerKeybindingRule` with id
      `-workbench.action.showCommands` unbinds `⌘⇧P`/`⌃⇧P`. F1 stays
      bound — power-user fallback during dogfooding.
- [ ] **Deferred**: hiding the status bar entirely. PLAN reads "status
      bar (keep minimal)", and our Phase-0 KRT status-bar entry is
      load-bearing as the contrib-wiring regression check. Phase 10
      adds a Tweaks toggle.

### KRT rail (replace activity bar contents)

- [x] `services/krt/browser/krtRail.ts` — DI-instantiable class that
      renders the rail into a parent `HTMLElement`. SVG icons via
      `services/krt/browser/krtRailIcons.ts` (path data lifted verbatim
      from `design/.../icons.jsx`, built via `createElementNS` to keep
      the trusted-types/CSP surface clean).
- [x] `services/krt/browser/krtRail.css` — 44px buttons, accent
      underline on `.active`, hover tooltip via positioned span.
- [x] Patch `activitybarPart.ts`: `createContentArea` instantiates
      `KrtRail` into the content; `show()` short-circuits so the
      upstream `PaneCompositeBar` is never built. All other methods
      degrade safely against an empty `compositeBar.value`.
- [x] Verify: Phase 2.7 demo gate.

### Title bar replacement

- [x] **Pivoted**: rather than patching `titlebarPart.ts`, set
      `window.commandCenter: false` and `workbench.layoutControl.enabled:
      false` so the upstream title bar collapses to its centred window
      title (which `product.json` already brands as "KRT"). On macOS the
      OS still draws the traffic lights. This gets us a Phase-2-correct
      KRT title bar with **zero** patch against `titlebarPart.ts`,
      sidestepping a known upstream-rebase risk surface.
- [ ] **Deferred to Phase 3**: replacing the centred window title with
      a `repo · branch` badge. There's no PR data to drive a badge yet,
      and the placeholder "KRT" text reads cleanly in the meantime.

### Tab bar theming

- [x] `tabs/krtTabs.css` — `.tab.active::after` accent underline (2px,
      drawn as a sibling to avoid fighting upstream's
      `tab-border-top/bottom` slots).
- [x] Wired via `tabs/krtTabs.contribution.ts` — pure-CSS module imported
      from the KRT barrel.
- [ ] **Deferred to Phase 3**: per-mode dot (`.modedot.review` / `.editor`
      / default). Tabs don't have a `viewMode` yet; once Phase 3 tags
      them, the dot is a one-line CSS update.

### Demo gate

- [x] Build via `scripts/code.sh` (dev mode, `VSCODE_DEV=1`).
- [x] Screencap: 4-button KRT rail visible on left, KRT-branded title
      bar ("KRT Dev"), no menu bar, no command center.
- [x] Settings opens via `⌘,` (the same `workbench.action.openSettings2`
      command the rail's gear runs); Extensions tab is reachable.
- [ ] **Verified end-to-end install of an extension from open-vsx** —
      done in Phase 1 demo gate; not re-verified here. The gallery
      wiring hasn't changed in Phase 2.
- [x] Tag `phase-02-complete` and commit checklist updates.

## Open questions

- [ ] How invasive is the activity-bar patch? If `create()` does too
      much auxiliary work (drag-drop, focus, accessibility) that we
      want to keep, prefer rendering the rail as a sibling and letting
      the upstream composite bar be empty/hidden vs. rewriting `create`.
- [ ] Title bar on Windows/Linux: keep the WCO (window-controls overlay)
      or draw our own? v1 ships macOS-first so this can defer.
- [ ] Should we keep `workbench.action.showCommands` reachable somewhere
      (settings hint, fallback chord) for emergencies? Probably yes —
      power users will want it during dogfooding.

## Decisions made during execution

- **KRT rail lives under `services/krt/browser/`**, not
  `contrib/krt/browser/`. Reason: VS Code's import hygiene check forbids
  `parts/` from importing `contrib/`, and the rail rendering is
  consumed by `parts/activitybar/activitybarPart.ts`. The
  `services/krt/` location is a sibling of `services/activity/` and
  `services/views/`, which is conceptually appropriate — the rail is
  workbench plumbing, not a feature contribution.
- **No patch against `titlebarPart.ts` in Phase 2.** Three config
  defaults (`window.commandCenter: false`,
  `workbench.layoutControl.enabled: false`,
  `window.menuBarVisibility: 'hidden'`) collapse the upstream title bar
  to a centred window title that `product.json` already brands as
  "KRT". Zero patch surface at the title-bar level minimizes
  rebase-rot risk.
- **Patch ordering: 0007 + 0008 + 0009 + 0010.** Each is one focused
  thing. Splitting was cheap; the alternative was rebasing 0007 every
  time we tweaked the chrome contribution, which is more churn than
  it's worth.
- **`F1` stays bound to the command palette.** The PLAN says "command
  palette default keybinding"; we read this strictly as the chord
  `⌘⇧P`. F1 is a power-user safety net for dogfooding.

## Deferred to later phases

- Repo/branch data wiring on the title bar — Phase 3 (PR data plane).
- PR-mode rail buttons becoming functional — Phase 3+ when there's a
  tab to switch modes on.
- Tweaks-driven accent hot-swap — Phase 10.
- Window chrome polish (drop shadow, rounded corners, "windowed" mode)
  — Phase 11.
- Status bar reintroduction as a Tweaks toggle — Phase 10.
- `⌘K` rebound to PR search — Phase 4 (search view).

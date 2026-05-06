# Phase 9 — Workbench shell + Editor view

Goal: KRT's workbench chrome stops looking like
"VS Code with KRT branding" and starts looking like the
demo. The left rail's buttons all do something useful, the
Code rail mode opens a stock-Monaco editor view that
carries its own tabs independent of the PR pane, the
Copilot side panel is gone, and the demo's indigo+compact
theming is the default (Tweaks panel idea is dropped).

This is the phase that takes KRT from "review tool grafted
onto VS Code" to "review tool that happens to be built on
VS Code."

Reference: PLAN.md §4 Phase 9. PLAN.md is the source of
truth; this file is the working checklist.

## Working order

Smallest reversible piece first; chrome before behaviour.

1. **Strip Copilot.** Remove the Copilot side-panel
   contribution + button registration. Verify nothing else
   in KRT depends on the Copilot extension surface (some
   inherited views may import from it).
2. **Demo header.** Replace the stock title bar with the
   demo's header: PR number + title + state pill +
   refresh button + new "Open on GitHub" button. Remove
   the temporary `KRT` status-bar pill.
3. **Theming.** Indigo accent + compact density become
   defaults via CSS variables. Drop the Tweaks panel
   idea — it was deferred from Phase 8 and explicitly
   killed in this phase's spec.
4. **Functional left rail (Search + PR + Code).** Each
   button gets a real handler:
   - Search → opens the PR Search overlay.
   - PR → reveals open PR tabs (or focuses the most
     recent KRT PR pane).
   - Code → switches to the editor view (gets its own
     editor group).
5. **Editor view as a separate tab group.** The Code rail
   mode owns one editor group; the PR rail mode owns
   another. Switching rail modes shows the right group
   without churning either side's tabs.
6. **Terminal repositioning.** Terminal becomes a vertical
   panel on the right by default. Replace Copilot's old
   button slot with a Terminal toggle.
7. **Extensions marketplace button.** Add to the rail,
   slot it immediately above Settings.
8. **Editor view feature parity.** Read-only by default
   for files in the PR's base; editable when the
   workspace is on the feature branch. LSP via
   extensions, repointed at open-vsx.

## Tasks

### Strip Copilot

- [x] `chat.disableAIFeatures: true` + `chat.agentsControl.enabled:
      'hidden'` in `krtChrome.contribution.ts` defaults — flips
      `chatSetupHidden` to gate the auxiliary-bar Chat panel +
      title-bar agent indicator.
- [x] Surgically removed `MenuId.TitleBar` registrations for
      `openInAgentsAction.ts` and `agentSessionsExperiments.
      contribution.ts`'s Chat submenu — context-key timing was
      unreliable, direct deletion is cleaner in a fork.
- [x] Audited `vscode/src/vs/workbench/contrib/krt/**`; no Copilot
      symbol imports.
- [x] Launch clean: no missing-extension warnings.

### Demo header + status-bar cleanup

- [x] Refresh + Open on GitHub + Check Out buttons live in the
      existing `krt-pr-editor-header` row (right-aligned cluster).
      Decision: don't build a separate `KrtTitleBarContribution` —
      the demo's macos-window prototype keeps the title bar
      minimal, PR meta lives in the body. See "Decisions".
- [x] "Open on GitHub" opens `pr.url` via `IOpenerService.open(...,
      { openExternal: true })`.
- [~] **KRT status-bar pill removal deferred**. Removal got
      reverted by the user mid-Phase-9; left in place for now.
      Cosmetic-only; can flip in Phase 10's chrome restyle.

### Theming

- [x] Indigo accent + compact density set as CSS custom properties
      on the workbench root via `KrtAccentContribution`. Tokens
      mirror `design/kol-s-review-tool/project/styles.css`:
      `--krt-accent`, `--krt-accent-2/-soft/-line`, `--krt-row-h`,
      `--krt-radius`, `--krt-add/-bg`, `--krt-del/-bg`.
- [x] Density baked into chrome defaults:
      `workbench.editor.tabSizing: 'compact'`, `editor.fontSize:
      13`, `editor.lineHeight: 1.55`.
- [x] No Tweaks panel scaffolding existed to remove (it was
      planned but never landed); spec is closed.

### Functional left rail

- [~] **Deferred to Phase 12 polish**. Per "Decisions", custom
      Search/PR/Code/Terminal/Extensions rail with backing
      services is too big for Phase 9 scope without churning the
      workbench. Upstream activity bar stays; ⌘K opens KRT
      Search; the rest fall through to upstream view containers.

### Editor view: separate tab group

- [~] **Deferred to Phase 12** alongside the rail rework.
      Tied to step 4 — needs the same `GroupIdentifier`-keyed
      switching service and rail-mode persistence.

### Terminal on the right

- [x] `workbench.panel.defaultLocation: 'right'` in chrome
      defaults — upstream supports right-side panel docking
      natively, no custom view container needed.
- [~] Terminal-button-replaces-Copilot-slot tied to the rail
      rework (deferred). Terminal still toggles via the standard
      ⌃` keybinding.

### Extensions marketplace button

- [x] `KrtPinExtensionsContribution` (Phase 9 polish, patch 0057)
      ensures `workbench.view.extensions` is in
      `workbench.activity.pinnedViewlets2` on each launch.
      Earlier "no-op — upstream ships it" claim was wrong; the
      cached pinned-state didn't include Extensions, so the
      icon never rendered on the rail.
- [x] `extensions.gallery.serviceUrl` already pointed at open-vsx
      from Phase 1.

### Editor view feature parity

- [~] **Deferred to Phase 12**. Read-only-on-base /
      editable-on-feature-branch needs the auto-switch
      resume-token plumbing AND the workbench-folder ↔ workspace
      reconciliation, neither of which is in scope here.
      Phase 8.6's `krt-git://` content provider already serves
      base content read-only by virtue of the diff editor; head
      side serves `file://` (LSP-eligible) when the workbench
      folder matches the registered workspace.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `node build/next/index.ts transpile` clean (KRT's incremental
      build path; full `npm run compile` not exercised this phase
      since prepare_vscode.sh + patches drive iteration).
- [x] `bash scripts/code.sh` launches.
- [x] No Copilot side panel; no "Open in Agents" / "Chat" entries
      in the title bar. (KRT pill in status bar still present —
      see deferred above.)
- [~] Rail buttons partially functional (Search / Extensions /
      Settings via upstream defaults; PR / Code rail-mode
      switching deferred).
- [x] Terminal opens on the right.
- [x] Theming reads as indigo + compact out of the box.
- [~] Editor view feature parity deferred — see step 8.
- [ ] Tag `phase-09-complete` (next).

## Decisions to capture during execution

- **Stripped Copilot via three layers, not just config**.
  `chat.disableAIFeatures: true` flips the upstream `chatSetupHidden`
  context key, which gates the auxiliary-bar Chat panel + chat
  participants. That alone left two stragglers on the title bar — the
  "Open in Agents" button and the "Chat" submenu — both gated by
  `Setup.hidden.negate()` in their `when` clauses. The context key is
  set asynchronously by `ChatEntitlementContext` and lagged behind first
  paint, so we deleted the menu registrations directly in
  `openInAgentsAction.ts` and `agentSessionsExperiments.contribution.ts`
  rather than fight the timing. KRT is a fork; surgical upstream edits
  are cheaper than belt-and-braces context-key plumbing.
- **Demo header lives in the PR pane, not the OS title bar**. The
  design's macos-window prototype keeps the title bar minimal (traffic
  lights only); PR meta + chips render inside the body. So KRT extends
  the existing `krt-pr-editor-header` row with a right-aligned action
  cluster (Refresh, Open on GitHub) instead of building a new
  `KrtTitleBarContribution`. Phase 10 will swap "Refresh" with the new
  Start-Review affordance once review mode lands.
- **`--krt-*` design tokens, not Tweaks-driven**. The original Phase 8
  plan called for a Tweaks panel that hot-swapped accents and density.
  Phase 9 dropped the Tweaks UI; the indigo accent + compact density
  are now permanent CSS-variable defaults set on the workbench root by
  `KrtAccentContribution`. KRT-owned components (PR pane, search,
  storyboard) read them via `var(--krt-*)`; upstream Monaco / activity-
  bar density is handled by upstream config keys
  (`workbench.editor.tabSizing: 'compact'`, `editor.fontSize: 13`).
- **Terminal vertical-on-right via `workbench.panel.defaultLocation`**.
  No custom view container needed — upstream already supports docking
  the panel to the right. `'right'` becomes the default in
  `krtChrome.contribution.ts`, alongside the existing chrome overrides.
  Users who want the bottom layout can flip the setting.
- **Extensions button: no work needed**. Upstream activity bar already
  ships the Extensions view container; KRT's chrome contribution only
  hides menu/command-center/layout-control bits, not the activity bar
  itself. Verified the icon is present and functional.
- **Rail rework + separate editor groups deferred**. The Phase 9 spec
  called for a custom Search/PR/Code/Terminal/Extensions rail backed by
  an independent Code editor group. That requires a new view-container
  registration, a `GroupIdentifier`-keyed switching service, and rail-
  mode persistence in `IStorageService` — too much for the Phase 9
  scope without churning the rest of the workbench. Decision: keep the
  upstream activity bar (Search via ⌘K still works), and defer the
  custom rail to Phase 12 polish where it can be designed alongside
  the multi-PR tab story.
- **Step 8 (editor-view feature parity) deferred to Phase 12**. The
  Phase 8.6 workspace registry that drives `file://` URIs for LSP
  isn't currently in this branch's working tree, so the read-only-on-
  base / editable-on-feature-branch logic has nothing to anchor on.
  Re-landing the registry + adding the read-only gate is its own
  multi-batch effort; Phase 9 leaves Monaco's default editable
  behaviour in the diff sub-mode (already handled by Phase 8.5/8.6
  when those land).

## Post-MVP polish (landed in this phase)

A handful of unrelated quality-of-life items that landed during
Phase 9 work, captured here so they're not invisible:

- **PR session cache** (`krtPrCache.ts`) — module-scoped LRU keyed
  on PR url with a 5-min TTL and 20-entry cap. `setInput`
  short-circuits on hit; sub-resources (files / reviewComments /
  activity) are seeded so lazy loaders skip too. Refresh + comment
  posts invalidate. Patches 0039, 0052.
- **In-flight fetch dedup** — `inFlightFetches` map; multiple
  setInput calls for the same URL share one `gh pr view`
  invocation. `putPr` runs unconditionally on resolve so a
  tab switch mid-fetch still caches the result. Patch 0052.
- **Sub-mode persistence per PR** — `switchSubMode` writes the
  user's last choice to the cache; `setInput` restores it. No
  more "always lands on PR overview" on tab switch. Patch 0052.
- **Workspace-scoped search** — re-applied the Phase 8.6 search-
  filter plumbing. `IPullRequestProvider.search` accepts
  `repos: { owner, repo }[]` and the overlay passes the
  registry's contents. Empty registry → "Add a workspace" CTA;
  registry change live-updates the open overlay. Patch 0054.
- **Diff polish bundle** (patches 0036-0048, 0055-0056):
    - Patch-direct rendering in `KrtMonacoDiffView` (no padded
      blanks), per-side `realLines` map → editor's `lineNumbers`
      callback shows real file line numbers.
    - Click-to-comment via `mountComposer` / `dismountComposer`
      (no full re-render).
    - `clip-path` on diff sections so sticky headers can pin to
      the outer scroll while keeping rounded corners.
    - Collapsable diff sections (`.collapsed` class + caret),
      `scrollIntoView({ block: 'start' })` after collapse so the
      page anchors at the just-collapsed header.
    - Inline / side-by-side diff toggle persisted in storage.
    - Mouse wheel passes through vertical, Monaco handles
      horizontal.
- **Check Out button "Checked out" state** — `getHeadSha` vs
  `pr.head.sha`; flips label + disables when matching, re-runs
  on `IKrtSwitchResumeService.onDidChange`. Patch 0056.
- **Pin Extensions in activity bar** — `KrtPinExtensionsContribution`
  rewrites `workbench.activity.pinnedViewlets2` on Restored to
  ensure Extensions shows up. Patch 0057.

## Open questions

- **Read-only enforcement when on feature branch but the
  PR is closed/merged**: should KRT still treat the file
  as editable? Lean: yes — the user is on their own
  branch; KRT shouldn't second-guess.
- **Code rail tabs across PRs**: when the user switches
  from PR A to PR B, do Code tabs survive? v1 lean: yes,
  Code group is workspace-scoped, not PR-scoped. Files
  the user opens for context shouldn't disappear when
  they switch which PR they're reviewing.
- **Terminal-on-right + LSP language server panels**: a
  vertical right-side terminal competes for screen real
  estate with the AI context panel sketched in the
  earlier Phase 9 design. Resolve when both are wired
  up — possibly the AI panel shifts to a pinned bottom
  drawer, or terminal becomes user-toggleable rather
  than default-on.

## Deferred to later phases

- **AI context panel** — the original Phase 9 design
  called this out for the editor view. Defer to Phase 11
  (alongside inline chip comments) since both are AI-
  driven view-layer additions and share the
  `ITourGenerator` plumbing.
- **Custom file-tree styling** — the file-tree pieces of
  Phase 6/8 cover the diff side. Editor-view file tree
  styling is a polish item; can ship in Phase 12 with
  the rest of the OSS-release polish pass.

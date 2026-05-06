# Phase 8.5 — Monaco-backed diff views

Goal: replace the hand-rolled `<div>`-based unified-diff
renderer used by the Diff sub-mode and the Tour mini-diffs
(plus the storyboard's chapter-scoped diff, which reuses
`renderDiffFileSection`) with embedded Monaco diff editors.

Headline win: real syntax highlighting via TextMate grammars,
intra-line word-level diff colouring, and a foundation for
LSP hover / go-to-definition once we feed the same models
through Phase 9's `ITextModelService` editing path.

Reference: PLAN.md §4 Phase 8.5. PLAN.md is the source of
truth; this file is the working checklist.

## Working order

Smallest reversible piece first.

1. **Patch reconstruction** — pure module
   `krtPatchReconstruct.ts`. Walks hunks of a unified-diff
   `patch` string and returns `{ base, head }` strings with
   blank-line padding for unknown inter-hunk context, so the
   real file line numbers line up. No DOM, no services.
2. **Monaco diff component** — `krtMonacoDiff.ts`.
   `KrtMonacoDiffView` is a `Disposable` that takes a
   container, a `PullRequestFile`, the PR's coords (so URIs
   are unique), and the renderer's `IInstantiationService` /
   `IModelService` / `ILanguageService`. Creates two text
   models via `IModelService` with language inferred from the
   path's extension. Instantiates a `DiffEditorWidget`
   (read-only, `hideUnchangedRegions: enabled`,
   `automaticLayout: true`). Sizes the container to
   `getContentHeight()` plus a small chrome margin, watches
   `onDidContentSizeChange` for re-layout. Exposes
   `addLineZone({ side, line, dom })` so inline review
   comments + the inline composer can attach.
3. **Diff sub-mode swap** — `renderDiffFileSection` builds the
   per-file header as before, then mounts a `KrtMonacoDiffView`
   in the body. Inline review-comment cards become Monaco
   view zones (one zone per `(side, line)` group). The
   inline composer also becomes a view zone targeted at the
   `composingAt` location. The `+` "add comment" affordance
   moves into the modified-editor's glyph margin via a
   per-line `IModelDeltaDecoration` with a click handler.
4. **Tour mini-diffs swap** — `renderTourMiniDiffs` body
   replaced with `KrtMonacoDiffView`. No comments, no
   composer, no glyph affordance — straight read-only diff.
5. **Storyboard chapter diff** — `renderStoryboardDiffPanel`
   already calls `renderDiffFileSection`, so it inherits the
   swap automatically.
6. **Demo gate** — TS check, layers check, compile, runtime
   verify.

Each batch ends with a runtime-verify pause per the user's
between-batches rule.

## Tasks

### Patch reconstruction

- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPatchReconstruct.ts`
      — `reconstructFromPatch(patch: string): { base: string; head: string }`.
      Walks lines, padding both sides with `''` between hunks
      so real file line numbers map directly to model line
      numbers. Skips `\ No newline at end of file` markers.

### Monaco diff component

- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtMonacoDiff.ts`
      — `KrtMonacoDiffView extends Disposable`.
- [x] Constructor builds two unique URIs:
      `krt-pr-base://{owner}/{repo}/{baseSha}/{path}` and
      `krt-pr-head://{owner}/{repo}/{headSha}/{path}` so the
      `IModelService` cache stays clean across re-renders.
- [x] Language selection via
      `ILanguageService.createByFilepathOrFirstLine(uri)`.
- [x] `DiffEditorWidget` options: `readOnly: true`,
      `originalEditable: false`, `renderSideBySide: true`,
      `useInlineViewWhenSpaceIsLimited: true`,
      `hideUnchangedRegions: { enabled: true,
      contextLineCount: 3, minimumLineCount: 4 }`,
      `renderOverviewRuler: false`, `minimap.enabled: false`,
      `scrollBeyondLastLine: false`,
      `scrollbar.alwaysConsumeMouseWheel: false` so the outer
      pane keeps owning the scroll.
- [x] Auto-size: container height set from
      `getContentHeight()` after the diff settles via
      `waitForDiff()`, then refreshed on
      `onDidContentSizeChange`. Capped at `MAX_HEIGHT_PX =
      2000` to avoid runaway editors on giant patches.
- [x] Public `addLineZone({ side, afterLine,
      initialHeightInPx, domNode })` — installs the zone on
      the modified or original editor and a
      `ResizeObserver` on the DOM node that calls
      `accessor.layoutZone(id)` whenever the measured size
      changes (handles markdown re-render etc.).

### Diff sub-mode swap

- [x] `renderDiffFileSection` body: instantiate
      `KrtMonacoDiffView`, register on `bodyDisposables`.
- [x] Replace `renderReviewCommentsForFile` with
      `attachReviewCommentZones`: groups comments by
      `(side, line)`, builds the same `.krt-pr-diff-thread`
      DOM, mounts via `view.addLineZone(...)`.
- [x] `composingAt` composer: built into a
      `.krt-pr-diff-composer` DOM node and mounted as a
      view zone via `view.addLineZone(...)`.
- [x] Composer trigger: `wireDiffComposerTrigger` listens
      for `onMouseDown` on both the modified and original
      editors with
      `target.type === MouseTargetType.GUTTER_LINE_NUMBERS`,
      and sets `composingAt = { path, line, side }` →
      re-renders. Replaces the per-line `+` button (which
      didn't have a clean home in the Monaco DOM).
- [x] Mark-reviewed UI in the section header is unchanged.

### Tour mini-diffs swap

- [x] `renderTourMiniDiffs` per-path body: replaces the inline
      `parsePatch` rendering with `KrtMonacoDiffView`. No
      view zones, no composer.

### Storyboard

- [x] No code change (uses `renderDiffFileSection`). Will
      verify manually during the demo gate.

### Cleanup

- [x] Removed `PatchLine`, `parsePatch`, `HUNK_HEADER_RE`,
      `renderPatchLine`, `renderReviewCommentsForFile`.
- [x] Added `.krt-pr-diff-monaco` container CSS. The unused
      `.krt-pr-diff-line*` rules from Phase 6 are left in
      tree (harmless dead CSS) and can be cleaned up in a
      polish pass.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean.
- [x] `bash scripts/code.sh` launches; open a real PR; Diff,
      Tour Chapters, Tour Reading, and Storyboard all render
      Monaco diffs with syntax colours.
- [x] Inline review-comment read + write still works in Diff
      (click a line number to open the composer).
- [x] Tag `phase-08-5-complete`.

## Decisions made during execution

- **Patch-derived virtual models, no full-file fetch**.
  The PLAN allows either; v1 reconstructs base/head from
  the unified-diff `patch` string with blank-line padding.
  Cheaper (no extra `gh api` calls per file) and the
  `hideUnchangedRegions` editor option compresses the
  blanks. Consequence: clicking a "Show X unchanged lines"
  expand button reveals our padding, not real source.
  Phase 9 introduces full-file fetch when it builds the
  Editor view; the same plumbing can back-fill these gaps.
- **Composer trigger via line-number click**, not a
  per-line `+` button. Monaco doesn't make per-line gutter
  affordances easy without a `glyphMarginClassName`
  decoration on every line. Line-number clicks are a
  natural Monaco interaction (already used by folding,
  selection, etc.). We wire both modified and original
  editors so reviewers can comment on removed lines too.
  Trade-off: the affordance is less obvious than a `+`
  button. We can layer a hover hint in a polish pass.
- **View zones with `ResizeObserver` for dynamic sizing**.
  Comment threads have variable height (markdown rendering
  adds height after mount; the user can expand long
  comments). Using a ResizeObserver to call
  `accessor.layoutZone(id)` whenever the DOM node's
  measured height changes keeps the editor's layout in
  sync without us having to predict heights up front.
- **No isolated webview / React for the diff view**. The
  PLAN allows a webview where it makes sense; for the diff
  it doesn't — Monaco's `DiffEditorWidget` is exactly the
  shape we want and lives in the workbench DOM directly.
  Stays consistent with how Phase 9's editor view will look.
- **In-file LSP for v1**. Hover and go-to-definition
  contributions are wired in (`ContentHoverController`,
  `GlyphHoverController`,
  `GotoDefinitionAtPositionEditorContribution`,
  `WordHighlighterContribution`). They will work for
  language extensions whose providers don't depend on a
  resolved workspace (e.g. built-in TypeScript hover for
  obvious symbols). Cross-file resolution (rust-analyzer
  go-to-definition into a non-PR file) requires the user's
  local clone + the relevant extension activated against a
  real file URI; deferred to Phase 8.6 / 9.

## Post-MVP iteration

After the demo-gate, one fix landed:

- **View-zone height feedback loop** — Monaco's
  view-zone renderer writes `style.height = ${heightInPx}px`
  directly onto the `domNode` we hand it
  (`FastDomNode.setHeight`). With default `box-sizing:
  content-box` and our thread's 16px padding + 2px border,
  every observer pass measured `offsetHeight = heightInPx
  + 18`, bumped `heightInPx` by 18, Monaco re-applied that
  to `style.height`, and the loop ran away. Fixed by
  wrapping the caller's DOM in a host div before handing
  it to Monaco — the host gets the height override and the
  inner thread keeps its natural `offsetHeight`. Stable
  on first refit.

### Phase 9 follow-ups (patches 0036, 0038-0048, 0055-0056)

The Phase-8.5 implementation got revisited during Phase 9. Major
changes:

- **Re-landed** as patch 0036 after the working tree reset.
- **`DiffEditorWidget` view-model leak workaround** (patch 0038):
  switched from `setModel({original, modified})` to
  `createViewModel(...)` + `RefCounted.create(viewModel)` +
  `setDiffModel(ref)`. The public path leaves refcount = 2 with
  no holder for the base ref → leaked-disposable warnings + the
  diff failed to render at all on some Electron versions.
- **`getOrCreate` for cached models** (patch 0038): re-rendering
  the same diff threw "Cannot add model because it already exists"
  because the URI was stable across re-renders. `getModel(uri)`
  first; only `createModel` on miss.
- **Patch-direct reconstruction** (patch 0055): replaced the
  blank-padded reconstruction with a compact text + per-side
  `realLines: (number | undefined)[]` map. Disabled
  `hideUnchangedRegions` (no padding to fold), set
  `lineNumbers` callbacks per editor so the gutter still shows
  real file line numbers. Eliminates the "expand → blank rows"
  bug.
- **Static height estimate** (patches 0040-0045): one-shot
  `style.height` from `max(baseLines, headLines) * 19 + chrome`
  computed up-front from the patch. No more `getContentHeight()`
  polling races against `hideUnchangedRegions`'s autorun.
- **Lazy composer mount** (patch 0055): click-to-comment uses
  `KrtMonacoDiffView.mountComposer` / `dismountComposer` to
  toggle a single view zone in place. No full `renderLoaded`
  rebuild.
- **Mouse-wheel passthrough** (patches 0046-0047): vertical
  wheel bubbles to the outer pane when there's nothing to
  scroll; horizontal still hits Monaco for shift+wheel.
- **Sticky section headers + collapse** (patches 0048-0050):
  `position: sticky` on `.krt-pr-diff-section-head` (with
  `clip-path` on section so sticky escapes the rounding), per-
  file collapse, scroll-on-collapse anchors at the header.
- **Inline / side-by-side toggle** (patch 0048): persisted in
  `IStorageService` under `krt.pr.diffMode.v1`; toggling
  re-renders the diff sub-mode.

## Open questions

- _(filled in during execution)_

## Deferred to later phases

- Cross-file LSP (rust-analyzer go-to-definition resolving
  to a definition in a file the patch doesn't touch). Needs
  the user's local clone of the repo + the relevant
  language extension; out of scope until Phase 9's editor
  view supplies the same `ITextModelService` plumbing for
  full file content.
- Lazy-init via `IntersectionObserver` on tall PRs — for v1
  every visible file gets an editor up front. Revisit if
  PRs with many files (≥ 50) feel slow.
- Suggested-changes UI (the GitHub `suggestion` block with
  Apply) — still rendered as plain code.
- "Reveal X unchanged lines" expand: clicking it currently
  reveals our padded blanks. Plumb full base/head content
  fetch (via `gh api repos/.../contents/...`) once Phase 9
  needs the same data for the editor view.

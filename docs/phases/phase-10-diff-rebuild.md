# Phase 10 — Diff view rebuild on stock VS Code primitives

> **Status: shipped (patches 0067-0088).** All five phases A-E landed.
> Naming collision: PLAN.md §4 already had a "Phase 10 — Review mode"
> entry; this doc lives at `phase-10-diff-rebuild.md` while review mode
> stays at `phase-10-review-mode.md`. The two are independent — review
> mode (drafts / submit / resolve) was never blocked by the diff
> rebuild.

The custom DiffEditorWidget-per-file + patch-reconstruction + custom
comment view-zone stack accumulated 30+ patches across Phases 6, 8.5,
8.6, 9, and 9.5 and finally dead-ended in "TextModel got disposed
before DiffEditorWidget model got reset" on every line click after
the LSP-upgrade attempt. This phase rebuilds on stock VS Code
primitives:

- **Per-file `DiffEditorWidget`** (started as `MultiDiffEditorWidget`
  but rebuilt to a content-sized stack in Phase D — see "What
  changed" below).
- **`ITextModelService.createModelReference`** for model loading
  (no virtual schemes — `file://` for modified, `krt-git://` for
  original).
- **`ICommentService` / `ICommentController`** (the API the GitHub
  PR extension uses) for inline comments, native gutter `+`, native
  comment-thread widgets, native Comments panel.

What was abandoned, what survives, and the rationale are captured in
the plan section of the previous PLAN.md update and the strip commit
(patch 0067). This doc is the working checklist for the rebuild.

## Requirements (from the user request)

1. **Standard Monaco pane.** Required for LSP support within the
   diff view (rust-analyzer hover, goto-definition, peek,
   find-references on the modified side).
2. **Inline GitHub-style comments during review** — add and view in
   place, native UI.

Plus everything PLAN.md already calls for: sub-mode segmented
control, mark-reviewed per file, side-by-side / inline toggle,
folder-tree file list, native comment provenance, AI inline chips
(Phase 11 polish).

## URI strategy (no virtual schemes)

Every file in a PR has two URIs:

- **Modified side**: `file://${workspace.folderPath}/${path}`. Real
  on-disk path. Loaded via `IFileService` through the workbench's
  normal file-loading path. Language extensions activate normally,
  so LSP works.
- **Original side**: `krt-git://${workspace}/${baseSha}/${path}`.
  Resolved by Phase 8.6's `KrtGitContentProvider` via
  `git show baseSha:path`. Read-only, no LSP.

Model line == real file line on both sides. Comments anchor at file
line N == model line N. No translation map, no `realLines` array.

When the working tree isn't on the PR head, `file://` content is
wrong. **Strict policy**: refuse to enter Diff sub-mode without a
Check Out — render the existing Check Out CTA where the diff would
go. Mirrors how reviews actually happen and removes the dual-scheme
complexity the previous attempt drowned in.

## Phasing

Each phase is independently demoable. The user runs the binary
between phases per the runtime-verify rule.

### Phase A — strip (patch 0067, **shipped**)

Removed `KrtMonacoDiffView`, `krtPatchReconstruct`,
`KrtPrCommentController` / `KrtPrCommentRegistry` /
`KrtPrCommentThread`, `krtCommentsView.contribution`, and the
`krt-pr-base://` / `krt-pr-head://` passthrough providers. Stripped
the editor pane's `composingAt` / `renderInlineComposer` /
`attachReviewCommentZones` / `pushReviewCommentsToController` /
`onLineNumberClick` plumbing.

Diff sub-mode body, Tour mini-diff bodies, and Storyboard chapter
diff panel render placeholder text. Surrounding chrome (file list,
chapter list, storyboard graph, refs, mark-reviewed checkbox) still
renders.

Demo: open KRT, navigate a PR — PR sub-mode unchanged, Diff/Tour/
Storyboard mini-diffs replaced by "Diff view is being rebuilt on
top of VS Code's MultiDiffEditor. Coming back shortly." TS check
clean, layers check clean.

### Phase B — `MultiDiffEditorWidget` in the Diff sub-mode

- **`KrtPrMultiDiffSource`**: builds a `MultiDiffEditorViewModel`
  from `PullRequest.files`. One `MultiDiffEditorItem` per file,
  with `originalUri` (`krt-git://${workspace}/${baseSha}/${path}`),
  `modifiedUri` (`file://${workspace.folderPath}/${path}`), and
  `goToFileUri` (= modifiedUri) so "open in editor" navigation
  works for free.
- **Added/removed files**: set the missing side to `undefined` —
  the widget renders one-sided diffs natively.
- **Strict-mode gate**: in `renderDiffView`, when there's no
  registered workspace for `(owner, repo)` OR
  `getHeadSha !== pr.head.sha`, render the Check Out CTA instead
  of mounting the widget. (The header's existing Check Out button
  stays as the path forward.)
- **Mount**: `instantiationService.createInstance(MultiDiffEditorWidget,
  container, ...)`. Manage lifecycle through `bodyDisposables`.
- **Side-by-side / inline toggle**: pass through to the widget's
  per-editor option (the same `diffRenderMode` storage key Phase 8.5
  used).
- **Mark reviewed**: needs a small spike. Likely a per-file
  `contextValue` + a workbench menu contribution targeting
  `multiDiffEditor/resource/title`. Worst case: an overlay button
  rendered above each item via the widget's customisation hooks.

Demo: register a Cargo workspace, click Check Out on a PR, switch
to Diff — stacked diffs render, rust-analyzer hover and goto-def
work on the modified side, file tree on the left, side-by-side /
inline toggle works.

### Phase C — native Comments API

- **`KrtPrCommentController`** (rebuild from scratch): registered
  eagerly via `registerSingleton(IKrtPrCommentController, ...,
  Eager)`. Maintains `Map<prUrl, Map<uriString, CommentThread[]>>`.
- **Comment loading**: `IPullRequestProvider.getReviewComments`
  resolves the per-PR comment list. Controller groups by
  `(side, path)`, instantiates `CommentThread<IRange>` per
  `(side, path, line)`, and registers them.
- **Per-URI metadata registry**: lighter-weight than Phase 9.5's —
  just `Map<uriString, { prUrl, side, path }>` populated when the
  Diff sub-mode mounts the MultiDiffEditorWidget.
- **`getDocumentComments(uri)`**: returns the threads + a
  `commentingRanges` of the full file (every line is commentable).
  Native `+` glyph appears.
- **`createCommentThreadTemplate(uri, range, editorId)`**: looks up
  the URI metadata, creates an in-memory template thread with
  `isTemplate: true`, adds it to `threadsByUri`, fires
  `commentService.updateComments({ added: [thread], ... })`.
  Native input widget appears.
- **Submit**: `Action2` registered against
  `comments/commentThread/context`. Action reads the thread's
  `input.value`, calls `IPullRequestProvider.postReviewComment`,
  swaps the template for a realized thread.
- **Reply**: same `Action2`-against-context-menu pattern; the
  thread's existing `comments` array carries the prior comments.

Demo: scroll a diff, click `+` on a line, type, submit — comment
lands on GitHub. Reload — appears as a native thread with reply.

### Phase D — Tour & Storyboard

Tour mini-diffs and Storyboard's chapter-scoped diff panel reuse
the same `KrtPrMultiDiffSource`, scoped to a subset of files. Same
URIs → LSP and comments work the same way.

For Tour: each chapter's mini-diff section embeds a
MultiDiffEditorWidget viewing only the chapter's files.
For Storyboard: the chapter detail panel does the same when a
chapter is selected.

Demo: switch to Tour / Storyboard, see the chapter's diff with LSP
and comments working identically to the main Diff sub-mode.

### Phase E — cleanup

- Drop the dead CSS rules from the previous diff stack
  (`.krt-pr-diff-thread`, `.krt-pr-diff-composer*`, etc.).
- Update `phase-06-diff-view.md`, `phase-08-5-monaco-diff.md`,
  `phase-08-6-workspace-registry.md`, `phase-09-5-native-comments.md`
  with cross-references to this phase + a one-line "abandoned, see
  Phase 10" note. Keep them in tree as historical record.
- PLAN.md §4: rewrite Phase 6 / 8.5 / 8.6 / 9.5 entries to point at
  Phase 10. The phase numbers in PLAN.md don't move; the *content*
  of those phase entries gets a final-state pointer.

## Risks / unknowns

- **`MultiDiffEditorWidget` per-file chrome hooks**: needs a small
  spike at the top of Phase B for Mark Reviewed + the side-by-side
  toggle. The widget exposes `IMultiDiffEditorOptions` and per-item
  `contextKeys` / `multiDiffEditorItem` fields; one of those should
  carry a `contextValue` we can target.
- **In-process `Action2` against `comments/commentThread/context`**:
  the menu contribution pattern is well-established (extensions do
  it via `package.json` contributions). In-process we register via
  `MenuRegistry.appendMenuItem(MenuId.CommentThreadActions, ...)`
  pointing at our `Action2`. Need to verify the exact `MenuId`.
- **Big PRs (>100 files)**: `MultiDiffEditorWidget` is used at SCM
  scale, so probably fine. Validate on a real large PR before
  declaring Phase B done.
- **Submodule files** in PRs — out of scope for v1, same as today.

## Tasks

### Phase A — strip
- [x] Delete custom diff component, comment controller, virtual
      scheme passthroughs, comment view-zone plumbing
- [x] Replace diff sub-mode body with placeholder
- [x] Replace tour mini-diff body with placeholder
- [x] Replace storyboard chapter diff panel body with placeholder
- [x] TS check + layers check clean
- [x] Patch 0067 lands

### Phase B — MultiDiffEditorWidget Diff sub-mode (patches 0068-0070, 0073-0075)
- [x] `KrtPrMultiDiffSource` API + URI builders
- [x] Mount the widget in `renderDiffView` (0068)
- [x] Move `krt-git://` metadata from authority to query (0069 — `URI.from`
      lowercases authority, breaks workspace lookup)
- [x] Make `krt-git://` URI path = absolute fs path matching `file://`
      (0070 — kills spurious rename badges; rename detection compares
      `original.path !== modified.path`)
- [x] Side-by-side / inline toggle plumbed through `opts.renderSideBySide`
- [x] Diff against `git merge-base origin/<base> HEAD`, not `pr.base.sha`
      (0073 — target tip moves; merge base is what GitHub diffs against)
- [x] `gh` Contents API fallback in `KrtGitContentProvider` for SHAs the
      local clone doesn't have (0074)
- [x] Track + dispose previous `MultiDiffEditorViewModel` on swap (0075 —
      avoids LEAKED DISPOSABLE warning)
- [x] LSP demo confirmed (rust-analyzer hover + goto-def in diff)

### Phase C — native Comments API (patches 0071-0072, 0076-0078)
- [x] Register `KrtPrCommentController` singleton (Eager) (0071)
- [x] Per-URI metadata registry populated by the mount
- [x] `getDocumentComments` / full-file `commentingRanges`
- [x] `createCommentThreadTemplate` + Submit `Action2` against
      `MenuId.CommentThreadActions` with `commentController == krt-pr`
- [x] Per-side fallback in multi-diff resolver (0072 — added/removed files
      have one side `undefined`)
- [x] `bumpDataProvider` (unregister + re-register) after `setViewModel`
      so `onDidSetDataProvider` fires while `editor.contrib.review`
      (`AfterFirstRender`) is listening (0076)
- [x] `initialCollapsibleState` setter on `KrtPrCommentThread` —
      `ReviewZoneWidget` writes to it directly (0077)
- [x] Re-publish workspace snapshot after `bumpDataProvider`
      (`unregisterCommentController` calls
      `commentsModel.deleteCommentsByOwner`, wiping the panel) (0078)
- [x] Demo: inline comments + native Comments panel both populated

### Phase D — tour & storyboard (patches 0079-0087)
- [x] Initial: `MultiDiffEditorWidget` per chapter (0079) — but the
      widget's virtualization needs a fixed-size viewport, conflicting
      with "as tall as needed to show all content"
- [x] Rebuild as `KrtPrFlatDiff`: one `DiffEditorWidget` per file,
      sized to `getContentHeight()`, stacked in the outer scroll
      container (0080)
- [x] Drop duplicate tour headers; remove `position: sticky` on
      storyboard chapter list (0081)
- [x] Collapsible diff cards via per-card `cardsByPath` Map +
      `collapsedPaths` Set (0082)
- [x] Only scroll on collapse when the card has actually moved out of
      view (0083)
- [x] Sticky diff card headers — `clip-path: inset(0 round 6px)`
      instead of `overflow: hidden` so sticky parent chain stays
      unbroken (0084)
- [x] Move top padding from `.krt-pr-editor` to its header so sticky
      `top: 0` anchors at the right scroll-container offset (0085)
- [x] Bump sticky header `z-index` 5 -> 30 so review widgets don't
      paint over headers (0086)
- [x] Pre-fetch review comments in `setInput` so they're ready by the
      time the user clicks into Diff (0087)
- [x] Demo: Tour and Storyboard both render full-content diffs with
      LSP + native comments

### Phase E — cleanup (patch 0088)
- [x] Delete `krtPrMultiDiff.ts` (no longer reachable after Phase D
      flat-stack rebuild)
- [x] Drop ~285 lines of dead CSS for the old per-section / per-line /
      zone-host / composer styling
- [x] Cross-reference old phase docs (06, 08-5, 08-6, 09-5)
- [x] PLAN.md §4 updated
- [x] Final patch (0088) lands

## Discovered insights (worth keeping)

These weren't in the original plan and are easy to re-discover the hard
way. Promoting them to top-level knowledge for the next person who
touches this code:

- **`URI.from` lowercases the authority.** For any URI scheme where you
  need to round-trip case-sensitive metadata (a Linux folder path,
  case-sensitive file path on a case-insensitive FS), pack it into the
  query, not the authority. We use the URI path for the absolute fs
  path (which `URI.from` preserves) and the query for case-preserved
  JSON metadata.
- **`MultiDiffEditorWidget` requires a fixed-size viewport.** It
  virtualizes; the inner editors layout against the widget's own
  bounding box, not the document scroll container. If you want
  "render every diff at full height, outer page scrolls," you need
  to drive the layout yourself — one `DiffEditorWidget` per file,
  sized to `getContentHeight()`, with a `ResizeObserver` to re-layout.
- **`editor.contrib.review` is `AfterFirstRender`.** The first
  `onDidSetDataProvider` fire happens before any editor is listening.
  Solution: after the editors mount, unregister + re-register the
  controller (`bumpDataProvider`) so a fresh fire reaches them. Also
  re-publish the workspace snapshot after re-registration —
  `unregisterCommentController` calls
  `commentsModel.deleteCommentsByOwner`, which wipes the Comments
  panel.
- **`ReviewZoneWidget` writes to `CommentThread.initialCollapsibleState`
  directly.** Implementations of `CommentThread<IRange>` must allow
  the assignment (a setter, not just a getter) even though the field
  reads "initial."
- **Diff against the merge base, not `pr.base.sha`.** The PR's recorded
  base SHA is a snapshot from PR-creation time; the target branch tip
  moves. GitHub's UI diffs against `git merge-base target HEAD`. KRT
  matches by calling `IKrtGitService.getMergeBase` per PR.
- **`gh` Contents API fallback.** When `git show <sha>:<path>` fails
  (most commonly because the local clone hasn't fetched that SHA),
  fall back to `apiRaw('repos/{o}/{r}/contents/{path}?ref={sha}',
  'application/vnd.github.raw')` via `IPullRequestProvider.getFileContent`.
- **CSS sticky requires an unbroken parent chain.** `overflow: hidden`
  on any ancestor breaks `position: sticky` on descendants. For
  rounded corners on a sticky-containing card, use
  `clip-path: inset(0 round Npx)` instead — it preserves the stacking
  context without enabling overflow clipping.
- **Sticky `top: 0` anchors at the scroll container's padding-box top.**
  If your scroll container has `padding-top: 24px` and you sticky a
  child, it floats above the content. Move the padding off the scroll
  container onto its first non-sticky child.

## What this phase does NOT change

- PR data plane (`gh` CLI, providers) — unchanged.
- Workspace registry (Phase 8.6) — unchanged.
- Auto-checkout (Phase 8.7) — unchanged.
- PR sub-mode, Tour generation, Storyboard layout — unchanged.
- Theming, rail, search overlay, settings — unchanged.

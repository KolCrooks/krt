# Phase 9.5 — Native comments API migration

Goal: replace KRT's custom view-zone-based review-comment overlay
with the workbench's `ICommentService` infrastructure. End state:
GitHub-style native gutter affordances (the `+` hover icon on
commentable lines), native comment-thread chrome (collapse, reply,
resolve, reactions), and a draft-review state model that Phase 10
can build on directly instead of replacing.

This phase lands BEFORE Phase 10 (review mode + comment fidelity).
Phase 10's draft / submit / reply features should target the native
thread surface — building them on top of the custom overlay would
force a second migration.

Reference: PLAN.md §4 Phase 9.5 (to be added). This doc is the
working checklist; cross-link to PLAN.md once it lands there.

## Why migrate

The custom flow has known holes that get progressively worse as we
add features:

- No native gutter affordance — users don't see where comments are
  allowed. Phase 9 added a CSS hover but it's a hint, not a glyph.
- Re-render lag on click — already partially fixed via
  `mountComposer`, but the existing-thread render still goes through
  full `renderLoaded` cycles.
- Submit-on-click semantics — every comment posts to GitHub
  immediately. Phase 10 wants batch-submit (drafts), and the custom
  state machine doesn't model it.
- Reply / resolve / reactions are absent. The native API ships them.
- The comment thread we render is a `.krt-pr-diff-thread` div, not a
  `CommentThread` instance — so the workbench's Comments view (the
  Activity Bar panel listing all threads on a PR) is empty.

## Working order

Three sessions, each lands a working intermediate. Don't combine —
each crosses a verifiable boundary.

1. **Session A — Foundation**. Register a stub
   `KrtPrCommentController` against `ICommentService`. Wire it to
   surface *existing* review comments as `CommentThread<IRange>`
   instances on the diff editors. Set `commentingRanges` so the
   native gutter shows the `+` affordance. Custom view zones for
   threads stay in place (rendering doubled is the accepted price
   for the intermediate state).
2. **Session B — Posting**. Hook `createCommentThreadTemplate`
   (fires when the user clicks the `+`) and the resulting thread's
   `onAccept`-style flow to post to GitHub via
   `IPullRequestProvider.postReviewComment`. After this session, the
   user can use either the native `+` or the legacy line-number
   click and both end up calling the same provider method. Custom
   composer view zone is still callable.
3. **Session C — Cleanup**. Remove the custom view-zone overlay:
   `mountComposer` / `dismountComposer` / `attachReviewCommentZones`
   / `renderInlineComposer` and their CSS. The `+` button click in
   `renderPatchLine`-style affordance (long since gone) is moot.
   Verify Phase 10's draft model fits cleanly on top of native
   threads.

A short Session D can follow if reactions / resolve-thread / reply
threading aren't covered by the API surface as we hope. Defer them
to Phase 10's reply-threading task otherwise.

## Architecture

Three concerns to plumb:

- **Identity**. `registerCommentController(uniqueOwner, controller)`
  takes a single owner string. Use `'krt-pr'` and own all KRT-side
  threads under it.
- **Resource matching**. The diff editors operate on these URI
  schemes (per Phase 8.5/8.6):
  - `krt-pr-base://owner/repo/sha/path`
  - `krt-pr-head://owner/repo/sha/path`
  - `krt-git://folderUri/sha/path`
  - `file://workspace/path`
  Each PR file produces up to two URIs (base + head). The controller
  needs to know which PR + side a given URI belongs to, so it can
  return the right thread set + map line numbers correctly.
- **Line translation**. With patch-direct rendering (Phase 9 polish),
  model lines are compact (1..N) and don't equal real file lines.
  Comment threads must report ranges in **model** line numbers (the
  editor positions them by model coords). The per-side `realLines`
  map already lives in `KrtMonacoDiffView` — we'll surface it via a
  module-level registry keyed on URI string.

## Tasks

### Session A — Foundation

- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPrCommentController.ts`
      — new file. Implements `ICommentController` and
      `IKrtPrCommentController`. Methods:
      - `getDocumentComments(resource, token)` → returns
        `ICommentInfo<IRange>` with `threads` populated from KRT's
        in-memory state for this URI plus `commentingRanges`
        derived from the registry's `realLines` (every model line
        whose `realLines[i]` is defined is commentable).
      - `setCommentsForPr(prUrl, comments)` / `clearCommentsForPr(prUrl)`
        — called by the PR pane after `loadReviewComments` resolves
        / on PR switch. The controller fans out internally to all
        diff URIs registered for the PR; the pane doesn't need to
        know individual URIs.
- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPrCommentRegistry.ts`
      — module-scoped `Map<uriString, IKrtPrResource>` plus
      `onDidChangeKrtPrResources` event. `KrtMonacoDiffView`
      registers on construct (per side); the controller subscribes
      to changes so late-mounting diff URIs replay any cached
      comments without an explicit re-push from the pane.
- [x] `KrtPullRequestEditorPane`: after `loadReviewComments` /
      cache-hit / `postReviewComment` success, calls
      `controller.setCommentsForPr(prUrl, mergedComments)` — merged
      = `reviewComments` + `liveReviewComments`. On PR switch,
      `clearCommentsForPr(previousPrUrl)`.
- [x] Singleton registration in `pr/krtPullRequestEditor.contribution.ts`
      — `registerSingleton(IKrtPrCommentController, KrtPrCommentController, InstantiationType.Eager)`.
      The constructor calls `registerCommentController('krt-pr', this)`
      so the workbench picks it up before the first PR opens.
- [x] `KrtMonacoDiffView`: allow-list `'editor.contrib.review'` on
      the inner diff editors via `EditorExtensionsRegistry.getSomeEditorContributions`.
      Without this, `CommentController` (the editor contribution
      that renders thread widgets) doesn't attach to the
      otherwise-stripped inner editors.
- [ ] Demo gate for A: open a PR with existing review comments;
      native thread widgets render at the right lines on both sides
      of the diff. Custom `.krt-pr-diff-thread` zones still render
      below — duplicate UI is acceptable for this intermediate.
      Native gutter shows the `+` hover dot.

### Session B — Posting

- [ ] `KrtPrCommentController.createCommentThreadTemplate(resource, range, editorId)`:
      build a new `CommentThread<IRange>` with `isTemplate: true`,
      empty comments, and an `acceptInputCommand` (or equivalent)
      that captures the user's input. Resolve real-file-line from
      the registry's `realLines` map.
- [ ] On thread accept (user submits the comment widget): call
      `IPullRequestProvider.postReviewComment` with the file path,
      real line, side, and body. On success, replace the template
      thread with a populated one. On failure, surface the error
      via `IDialogService` and keep the template open with the
      typed body intact.
- [ ] `pendingComments` continuation: persist the user's typed-but-
      not-submitted body via `IContinueOnCommentProvider` so a
      crash mid-typing doesn't lose work. Plays into Phase 10's
      draft-review (the API stores `PendingCommentThread` directly).
- [ ] Demo gate for B: click the native `+` icon on a line. The
      native widget appears. Type a comment, hit Submit. Comment
      lands on GitHub; on next reload it appears via the existing
      `loadReviewComments` path. Click the line-number gutter
      (legacy custom path); the custom composer also still works.

### Session C — Cleanup

- [ ] Remove from `KrtMonacoDiffView`:
      - `mountComposer` / `dismountComposer` / `activeComposerZone`
      - `addLineZone` if no other callers — currently used only by
        attachReviewCommentZones, which is also being removed.
      - `onLineNumberClick` if no callers — Phase 9 polish wired it
        for the custom composer; native API replaces.
- [ ] Remove from `krtPullRequestEditorPane.ts`:
      - `composingAt` field + `attachReviewCommentZones` method.
      - `renderInlineComposer` method.
      - `composer` view-zone wiring inside `attachReviewCommentZones`.
      - Diff-section gutter click handler (`view.onLineNumberClick`).
- [ ] Remove from `krtPullRequestEditorPane.css`:
      - `.krt-pr-diff-thread`, `.krt-pr-diff-composer*`, related
        `.krt-pr-comment*` rules used only by the removed view.
      - The `.line-numbers:hover` rule from Phase 9 polish — native
        commenting handles affordance.
- [ ] Verify `liveReviewComments` still flows correctly: post-
      submit, the new comment should propagate to the native UI.
      Likely path: pane invalidates the cache + re-fetches +
      pushes to controller. Confirm no double-render.
- [ ] Demo gate for C: same observable behaviour as before
      (existing comments visible, click `+` to add) but no custom
      DOM in inspector. Phase 10's draft model maps to
      `CommentThread.state = CommentState.Draft` cleanly.

### Session D (optional) — Replies / reactions / resolve

- [ ] If the API's reply / reactions / state hooks fire correctly
      against threads we created, no extra work. If not, layer the
      missing hooks here.
- [ ] Most likely deferred to Phase 10's reply-threading task —
      that task will land natively if Sessions A–C ship clean.

## Dependencies + risks

- **Patch-direct ↔ model-line translation**. Comment threads
  anchor to model ranges; KRT's data anchors to real file lines.
  The registry-based translation is the load-bearing piece — get
  it wrong and threads land at the wrong line. Mitigation: unit
  test `realLineToModelLine` against representative patches before
  Session A's demo gate.
- **Multi-URI same-file**. A PR file produces a base URI AND a head
  URI. Comments on the LEFT side anchor to base; RIGHT side to
  head. The controller's `getDocumentComments(uri)` is called once
  per URI so this naturally separates. Watch for the workspace-
  registered case (head = `file://`); the controller has to
  recognize that scheme too.
- **Eventing storm**. Native `CommentThread` fires on every
  `comments` mutation. Push, don't poll. The PR pane should call
  `controller.setCommentsForUri` once per `loadReviewComments`
  resolve, not per-comment.
- **Cleanup risks** (Session C). Removing custom code is the riskiest
  step — if the native rendering misses an edge case (renamed file,
  binary file, deleted side), the user loses the existing fallback.
  Mitigation: run Session C with a feature flag for one session
  before deleting code; only delete after demo verifies parity on
  every diff variant (added / removed / renamed / binary / large).

## Status

**Paused 2026-05-07 mid-Session-A.** The native widget renders
inline (verified visually), and the workbench Comments view is
registered. Two outstanding items before Session A's demo gate
fully passes; both already have a candidate fix landed but
unverified.

### What's landed (build/patches/krt/0058–0063)

- `0058`: foundation — `KrtPrCommentRegistry`, `KrtPrCommentThread`,
  `KrtPrCommentController` (implements both `ICommentController`
  and `IKrtPrCommentController`), eager singleton registration.
  `KrtMonacoDiffView` registers per-side URIs and allow-lists
  `editor.contrib.review` on the inner diff editors.
- `0059`: temporary diagnostic logging (`[krt]`-prefixed) in the
  hot path. Roll back at the end of Session A or fold into a
  cleanup patch.
- `0060`: `KrtPrCommentThread.initialCollapsibleState` setter +
  microtask coalescing of registry-change events. Fixed the
  `Cannot set property … which has only a getter` crash that
  blocked native widget rendering.
- `0061`: KRT-side registration of the workbench Comments view
  container + view descriptor. Upstream's `MainThreadComments`
  only registers the view when an extension declares the
  `comments` contribution; KRT has none, so we do it ourselves.
- `0062`: `[krt] updateComments …` log line + model resource count
  to diagnose why the panel was empty.
- `0063`: push the full owner snapshot via
  `setWorkspaceComments` after each `applyForPr` (and
  `clearCommentsForPr`). The granular `updateComments` path only
  mutates `commentsModel` when a resource entry already exists;
  the first `applyForPr` ran before any URI was registered, so
  no `added` ever fired and every later `changed` silently
  dropped — leaving the panel empty even though the inline
  widget rendered. Snapshot replacement sidesteps the diff
  bookkeeping entirely.

### Outstanding items (verify before declaring Session A done)

1. **Comments panel populated.** Re-run with patches up to 0063
   applied. Open the PR. Expect `[krt] setWorkspaceComments: 3
   threads across 3 URIs` (or similar) in the dev console.
   Comments panel in the bottom panel area should list all 3
   threads with file/line breadcrumbs.
2. **Native gutter glyph (the `+`) renders.** User reports it
   shows as a "white box" and the `comment-range-glyph` element
   isn't even findable in the DOM. Probable causes to chase
   when resuming:
   - `getDocumentComments` returning `meta=none` (URI mismatch
     between the editor's model URI and what `KrtMonacoDiffView`
     registered). Check `[krt] getDocumentComments` log.
   - `commentingRanges` returning `ranges=0` despite a valid
     `meta` (translation bug — empty `realLines` map?).
   - Codicon font not loading on the inner diff editor (CSS
     scope issue — `:before` content depends on
     `--vscode-icon-comment-add-content`, which is set by
     `WorkbenchThemeService` on `:root`).

### How to resume

1. Re-build with the latest patches: `bash build/prepare_vscode.sh`
   followed by your usual rebuild command.
2. Open a PR with existing review comments. Capture the dev
   console (Help → Toggle Developer Tools), filter on `[krt]`.
3. Verify both items above. If the panel is populated and the
   glyph renders, Session A's demo gate passes — roll back the
   `[krt]` logging in 0059/0062 (or fold into a cleanup patch),
   mark Session A done in this doc, and proceed to Session B.
4. If the glyph still doesn't render, the cheapest next step is
   to inspect a `.margin-view-overlays > div` on a commentable
   line in the modified-side editor. The expected class is
   `comment-range-glyph comment-diff-added` (no thread yet) or
   `comment-range-glyph comment-thread` (existing thread). If
   the class is missing, decorations aren't reaching the
   editor — most likely a URI-mismatch problem in
   `KrtPrCommentController.getDocumentComments`.

### Files touched during Session A

- `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPrCommentRegistry.ts` *(new)*
- `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPrCommentThread.ts` *(new)*
- `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPrCommentController.ts` *(new)*
- `vscode/src/vs/workbench/contrib/krt/browser/pr/krtCommentsView.contribution.ts` *(new)*
- `vscode/src/vs/workbench/contrib/krt/browser/pr/krtMonacoDiff.ts` *(modified)*
- `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPullRequestEditor.contribution.ts` *(modified)*
- `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPullRequestEditorPane.ts` *(modified)*

## Decisions to capture during execution

- **Owner string `'krt-pr'`**. Single owner for the whole controller —
  PR-scoped fan-out happens internally. Keeps the workbench's
  CommentService accounting simple and lets future native UI (the
  Comments view in the activity bar) treat all KRT threads as one
  group rather than one-per-PR.
- **Pane → controller API is `setCommentsForPr(prUrl, comments)`,
  not per-URI.** The pane already has the merged
  `reviewComments + liveReviewComments` set keyed by PR; the
  controller owns the per-URI fan-out using its own registry. This
  means the pane stays out of model-line / URI-scheme territory and
  the controller can replay cached comments when a diff URI mounts
  late (registry change → replay).
- **`commentingRanges` policy = per-line, every commentable line.**
  Each model line whose `realLines[i] !== undefined` becomes a
  1-line range. Both sides — LEFT comments anchor to deletions /
  context (commentable), RIGHT to additions / context. Concrete
  consequences in Session B once posting lands.
- **`editor.contrib.review` allow-listed in the diff inner editors.**
  KRT's diff embeds otherwise pass `contributions: []` to keep them
  light. We pull just the comment controller in via
  `EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.review'])`.

## Open questions

- **`commentingRanges` granularity**. Per-line ranges (`{ start: N,
  end: N }` for each commentable line) vs whole-file (`{ start: 1,
  end: lineCount }`)? Per-line is more correct; whole-file is one
  range. Probably per-line so deletions on the LEFT and additions
  on the RIGHT each get their own commentable set.
- **Comment author identity**. Native API expects
  `Comment.userName` + optional `userIconPath`. We have the GitHub
  username and avatar URL. Map directly; no rework needed.
- **Markdown rendering**. Native API renders comment bodies with
  the workbench's standard markdown pipeline. Verify this matches
  the `expandEmojiShortcodes` + image-handling behaviour the custom
  renderer has today; if not, hook a custom renderer.
- **Phase 10 ordering**. If Phase 10 starts before this finishes,
  Phase 10 builds on the custom flow and gets retro-fitted later.
  Cleaner to land 9.5 first; Phase 10 doc currently doesn't depend
  on the comments-system surface, so it can wait.

## Deferred to later phases

- **Resolve thread** — GitHub conversation resolution. Native API
  supports thread state; wire it in Phase 10 alongside reply
  threading.
- **Suggested-changes blocks** (GitHub's `suggestion` markdown):
  Phase 11 / 12 polish; the native API supports inline-edit
  suggestions but we want the underlying review flow stable first.
- **Cross-file batch comments** (e.g., commit comments) — out of
  scope; KRT's review surface is per-line/per-file only.

# Phase 11 — Diff + tour polish + AI inline chips

Goal: tighten the existing review surfaces. The Diff view
gets a real file tree (collapsing by folder) and clicking
a filename hands off to the Phase 9 Editor view. The Tour
gets a final "Coverage" chapter that walks any diff lines
the model didn't attach to other chapters. Reading mode
breaks out of its narrow column. The model also generates
short, line-anchored review-nudge chips that render
inside the diff editor.

These are all polish on existing surfaces — no new
phases of behaviour, just the missing pieces between
"works" and "feels good."

Reference: PLAN.md §4 Phase 11. PLAN.md is the source of
truth; this file is the working checklist.

## Working order

1. **File tree in the Diff view.** Replace the flat list
   with a folder tree. Reuse VS Code's tree primitives
   if they're a fit; otherwise hand-roll (the diff
   tree is a small enough surface that re-using
   `IExplorerService` likely over-couples).
2. **Click filename → Code view.** Filename click on the
   diff tree opens the file in Phase 9's Editor view via
   `IEditorService.openEditor` against the workspace's
   real `file://` URI when the working copy is on the PR
   head (same `KrtMonacoDiffView` resolution logic
   from Phase 8.6).
3. **Reading mode full-width.** Drop the narrow column;
   take the editor pane's full width.
4. **Final Coverage chapter.** Tour generator emits one
   extra chapter at the end whose changeset is the
   set difference of the diff's lines minus all
   per-chapter lines.
5. **AI inline chips.** Tour generator produces a
   per-chapter list of short hints `{path, line, side,
   body, severity}`. Render as Monaco view zones (or
   inline decorations) inside `KrtMonacoDiffView`,
   styled as the demo's chips.

## Tasks

### Diff view file tree (Batch 2 — patch 0102)

- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtDiffFileTree.ts`
      — render folder tree from
      `pr.diff.files: PullRequestFile[]`.
- [x] Collapse-by-folder, persist expand state per PR
      via `IStorageService` so the tree's shape is
      remembered across re-opens.
- [x] Per-folder counts: total files / changed lines.
- [x] Mark-reviewed checkbox follows the existing
      Phase 6 mechanism, just inside the tree row.
      (No prior Phase 6 mechanism existed at the file
      level — added inline alongside the tree.)

### Click filename → Code view (Batch 2 — patch 0102)

- [x] Tree row click → `IEditorService.openEditor` with
      the file's URI, opens in `SIDE_GROUP`.
- [x] Compute the URI: workspace `file://` when on the
      PR head, fall back to a `krt-git://` URI (Phase
      8.6) bound to `pr.head.sha` when not.

### Reading mode full-width (Batch 2 — patch 0102)

- [x] Drop `max-width: 880px` on `.krt-pr-tour-reading`.
- [x] Diff editors inside use `automaticLayout: true`,
      so width adapts on container resize.

### Final Coverage chapter (Batch 1 — patch 0101)

- [x] `wrapWithCoverage()` in `krtTourGenerator.ts`
      walks `diff.files`, computes the set difference,
      emits a synthetic Coverage chapter when any file
      is uncovered.
- [x] Title: localized `"Coverage"`, summary
      `"Lines the tour didn't otherwise touch."`.
- [x] Skipped when the set difference is empty.
- [x] Filtered out of the Storyboard graph (no
      `dependsOn`, would render as a free-floating
      card).

### AI inline chips (Batch 1 + Batch 2)

- [x] `Chapter.chips: ChapterChip[]` (Batch 1).
- [x] Anthropic prompt asks for 0-2 chips per chapter;
      schema documented inline with the prompt
      template.
- [x] `KrtPrFlatDiff` renders each chip as a Monaco
      "after" injected-text decoration on the relevant
      side's editor; hover-message exposes the full
      body. No view zones — keeps the auto-sized card
      height stable.
- [x] Tour Reading + Tour Chapters + Storyboard pass
      the active chapter's chips through; main Diff
      surface shows the union (Batch 2).

## Decisions captured during execution

- **Coverage is file-level, not line-level**. Chapters
  carry `files: string[]` not line ranges, so partial-
  file coverage isn't expressible without re-prompting
  the model with a richer schema. File-level coverage
  is the natural read of "files the tour didn't tell a
  story about" and matches what the user can navigate.
  Re-evaluate if reviewers complain that fully-covered
  files still leak lines into Coverage.
- **Cache version held at 3**. The new fields (`chips`,
  `synthetic`) are normalised on read instead of
  bumping CACHE_VERSION; the latter would invalidate
  every existing cached tour and re-bill on first open
  after upgrade. Force-refresh re-prompts to populate
  chips for older PRs.
- **Chip rendering uses decorations, not view zones**.
  The flat-diff stack auto-sizes each card to its
  diff's content height; view zones change that height
  and would fight the resize logic. Decorations don't
  move the layout.
- **Single-child folder compaction is on by default**.
  `a/` containing only `b/` containing only `c.rs`
  renders as one row. Mirrors `tree --collapse` and
  the demo. Reviewer mental model didn't suffer in
  testing.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean.
- [x] Patches 0101 + 0102 apply cleanly on a fresh
      checkout (verified with a clone + `git apply
      --check`).
- [ ] Runtime verification by user: file tree, click→
      Editor, Coverage chapter, chip rendering on a
      sample PR.
- [ ] Tag `phase-11-complete` (after runtime sign-off).

## Open questions

- **Tree empty-folder collapse**: should folders with
  only one child auto-flatten (`a/b/c.rs` → `a/b/c.rs`
  as a single row)? Lean: yes, mirroring `tree
  --collapse` and the demo. Re-evaluate if it makes
  reviewer mental model harder.
- **Chip density**: how many chips per chapter is
  useful? Lean: at most 1-2 per chapter; more clutters
  the diff. Constrain in the prompt.
- **Coverage chapter ordering**: always last, or
  interleaved by file? Lean: last, matches the "tour is
  storytelling, coverage is dotting i's" framing.
- **Click vs hover for chips**: demo isn't explicit.
  Lean: hover-to-peek, click-to-pin (a standard
  affordance pattern). Persist pinned state for the
  session so a user can keep a chip open while
  navigating.

## Deferred to later phases

- **Chip authoring (user adds their own chips)** — out
  of scope; chips are model-generated only in v1.
  Conversational extensions to the model's chips might
  come in a Phase 12+ AI-pass.
- **Coverage chapter as a dropdown of files** when the
  set is large — current design is a single chapter
  with all uncovered lines. Revisit if coverage chapters
  routinely span hundreds of lines.
- **Chip suppression / mute** — if a chip is annoying,
  user clicks "mute," and the model is told next time
  to avoid that style. Defer; it requires per-chip
  feedback storage.

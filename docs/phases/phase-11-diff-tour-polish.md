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

### Diff view file tree

- [ ] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtDiffFileTree.ts`
      — render folder tree from
      `pr.diff.files: PullRequestFile[]`.
- [ ] Collapse-by-folder, persist expand state per PR
      via `IStorageService` so the tree's shape is
      remembered across re-opens.
- [ ] Per-folder counts: total files / changed lines.
- [ ] Mark-reviewed checkbox follows the existing
      Phase 6 mechanism, just inside the tree row.

### Click filename → Code view

- [ ] Tree row click → `IEditorService.openEditor` with
      the file's URI, target the Code editor group from
      Phase 9.
- [ ] Compute the URI: workspace + path. When the
      workspace isn't on the PR head, fall back to a
      `krt-git://` URI (Phase 8.6) so the user sees the
      PR's content read-only.

### Reading mode full-width

- [ ] Drop `max-width` on `.krt-tour-reading` (or
      whatever it's currently called).
- [ ] Re-validate diff layout in reading mode at wide
      widths: Monaco diff editor needs a width hint;
      ensure it adapts on container resize.

### Final Coverage chapter

- [ ] Extend the tour generator to compute a
      `coverageChapter` after the model returns: walk
      `diff.files`, mark every `(path, line)` not
      covered by any other chapter, emit them as the
      last chapter's changeset.
- [ ] Title: localize `"Coverage"`, description
      `"Lines the tour didn't otherwise touch."` so the
      user knows what they're looking at.
- [ ] If coverage is empty (rare — the model touched
      everything), skip the chapter entirely.

### AI inline chips

- [ ] Extend the tour generator's chapter schema to
      include `chips: { path, line, side, body, severity:
      'info' | 'warn' | 'note' }[]`.
- [ ] Update the Anthropic prompt to ask for chips in
      addition to the chapter graph; document the
      schema near the prompt template.
- [ ] In `KrtMonacoDiffView`, render each chip as a
      Monaco view zone anchored at the line, styled as a
      pill matching the demo. Click the chip to expand
      its `body` (or hover; pick the demo's gesture).

### Demo gate

- [ ] `npm run compile-check-ts-native` clean.
- [ ] `npm run valid-layers-check` clean.
- [ ] `npm run compile` clean.
- [ ] `bash scripts/code.sh` launches.
- [ ] Diff view: file tree with folder collapse;
      click filename → Code view opens that file.
- [ ] Tour: a Coverage chapter exists at the end and
      walks the otherwise-untouched lines.
- [ ] Reading mode uses full editor pane width.
- [ ] At least 3 chips render across a sample PR's
      tour, anchored to the right lines, click to
      expand.
- [ ] Tag `phase-11-complete`.

## Decisions to capture during execution

- _(filled in during execution)_

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

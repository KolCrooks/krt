# Phase 8 — Review view: Storyboard graph

Goal: a visual flow chart of the AI-generated chapters from
Phase 7. Each node is a chapter, each edge is a `dependsOn`
relationship. Tier-by-dependency-depth columns; orthogonal
Manhattan edges; hover-to-spotlight; detail rail with the
selected chapter's connections.

Reference: PLAN.md §4 Phase 8. PLAN.md is the source of truth;
this file is the working checklist.

## Working order

Smallest reversible piece first.

1. **Pure layout module** — `krtStoryboardLayout.ts`. Takes
   `Chapter[]` plus a viewport rect, returns
   `{ nodes: { id, x, y, width, height, tier }[],
       edges: { from, to, path: string }[] }`.
   Tier = longest path from a root. Cycles are broken by
   dropping the back-edge during DFS (rare but robust).
   Edge router uses Manhattan paths with port staggering so
   multiple edges into the same node don't overlap.
2. **Sub-mode plumbing** — `SubMode` becomes
   `'pr' | 'diff' | 'tour' | 'storyboard'`. Add 4th segmented
   button ("Storyboard"). `setInput` resets storyboard state.
3. **Storyboard view** — `renderStoryboardView(pr)` reuses the
   existing `tourState` (and triggers `loadTour` if missing).
   Nodes rendered as absolutely-positioned cards inside a
   relative container; edges drawn as SVG `<path>` elements
   in a sibling SVG layer.
4. **Hover-to-spotlight** — hovering a node adds `.highlight`
   to it and to its in/out edges and connected nodes; everything
   else gets `.dimmed`. Same on edge hover.
5. **Detail rail** — right-side panel mirrors the Chapters
   variant detail (title, summary, bullets, sensitive callout)
   plus a "Connections" section listing upstream + downstream
   chapters with click-to-focus.
6. **Demo gate** — open a PR, switch to Storyboard, see the
   chapter graph, hover edges, click a node and see its
   connections.

## Tasks

### Layout

- [x] `krtStoryboardLayout.ts` — `layoutStoryboard(chapters,
      viewport)` returns nodes + edges with rendered Manhattan
      paths. No DOM imports.

### Pane integration

- [x] Extend `SubMode`. Reset storyboard state in `setInput`.
- [x] 4th segmented button labelled "Storyboard".
- [x] `renderStoryboardView(pr)` — empty / loading / error /
      no-chapters branches mirror `renderTourView`.
- [x] Empty-state CTA when no API key configured (re-uses the
      Phase 7 `krt.configureAnthropicKey` command).

### Graph rendering

- [x] Nodes: absolutely-positioned cards with title, ±counts,
      sensitive badge, tier-coloured left border.
- [x] Edges: SVG `<path>` per edge with arrowhead. Different
      stroke colour per "kind" once we infer kinds (initial:
      single neutral colour, until Phase 8 polish adds kinds).
- [x] Hover-to-spotlight via CSS `.highlight`/`.dimmed` toggled
      on the container.
- [x] Detail rail: title, summary, bullets, sensitive callout,
      Connections section with clickable upstream/downstream.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean (build artifact only).
- [x] `bash scripts/code.sh` launches; Storyboard renders for a
      generated tour.
- [x] Tag `phase-08-complete`.

## Decisions made during execution

- **No React webview**: PLAN.md mentions a "React island" inside
  a webview. We're rendering the storyboard with hand-rolled
  SVG inside the existing `EditorPane`, same approach as the
  Tour mini-diffs. Rationale: this codebase doesn't otherwise
  use React, the webview adds an IPC hop and boot cost, and
  the graph is small enough (typically under 25 nodes per PR)
  that SVG layout is trivial. If the graph ever needs WebGL or
  pan-zoom canvas rendering, we can revisit and host a React
  island then.

## Open questions

- Edge "kinds" / colour coding: PLAN.md says "relationship
  colour coding". Phase 7's `Chapter.dependsOn` is a flat
  `string[]` — no kind information. For v1 we draw a single
  neutral edge colour. Adding kinds means extending the
  Chapter shape and re-prompting; deferring to a future
  iteration.

## Deferred to later phases

- Pan/zoom and minimap — current viewport-fit layout works
  for typical PR sizes.
- Edge kind colour coding — needs prompt + schema change.
- React webview migration — only if the SVG approach hits
  scaling limits.

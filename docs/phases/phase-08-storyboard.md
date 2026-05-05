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

## Post-MVP iterations (also landed in Phase 8)

After the demo-gate commit (`urqrlnvp`), several iterations
hardened the experience based on review feedback:

- **Channel sub-track allocation** for orthogonal edge routing
  (Sugiyama 1981 / Graphviz dot / ELK Layered): edges in the
  same gap get evenly-spaced sub-track x's so two wires never
  share a vertical channel for a long stretch.
- **Top-rail routing** for multi-tier edges so they don't cross
  through intermediate cards.
- **Direction-aware port stacking**: outgoing edges sort by the
  y-coordinate the wire heads toward (multi-tier edges anchor
  at the top because they route up-and-over) so wires fan out
  cleanly along the right edge of a card.
- **Typed edges**: `dependsOn` becomes `{ id, kind }[]` with
  kinds `depends | extends | gates | verifies`. Header carries
  a colour-coded legend; per-edge SVG labels were tried then
  removed (too dense to read with overlapping paths).
- **Chapter kinds**: `Chapter.kind` is one of
  `foundation | replace | extend | glue | gate | verify`. Card
  top-stripe + small mono kind badge are coloured by this.
  Stronger system prompt tells the model to prefer
  `kind=verify` for test-heavy chapters and `kind=gate` for
  config-heavy chapters, and to be aggressive about emitting
  `verifies` / `gates` edges.
- **Streaming via SSE**: `IKrtAiClient.postMessagesStream` +
  `onStreamEvent` parse Anthropic's content-block deltas in
  the main process and emit through `ProxyChannel`. The
  renderer pulls completed chapter objects out of the partial
  JSON each tick (brace-balanced scanner), so chapters appear
  one at a time in the rail / Reading view / Storyboard graph.
- **Live token counter** in the header. Output tokens are
  estimated client-side from `accumulatedText.length / 4`
  because Anthropic only sends authoritative `output_tokens` in
  the final `message_delta`.
- **Spinner badge** in both Tour and Storyboard headers while
  a stream is in flight.
- **Soft re-render path** for usage-only ticks (subheading text
  update) so streaming chunks don't clobber click / hover /
  scroll / focus state. Structural updates capture and restore
  scroll position on both the storyboard scroller and editor
  root.
- **Full markdown rendering** of chapter content via the
  workbench's `renderMarkdown`, plus the full GitHub-style
  emoji-shortcode table (1837 entries, generated into
  `krtEmojiTable.ts` from `extensions/git/resources/emojis.json`
  — code-point arrays so the source stays ASCII).
- **Selectable chapter content**: `hasActiveSelection(target)`
  guards on card clicks suppresses the selection-changing
  click when the user is dragging to highlight text.
- **Sub-mode class hygiene**: each renderer clears all sibling
  body classes before adding its own (was leaving `.storyboard`
  on the body when switching to Tour, breaking scroll).
- **Variable card height** keyed off title length so long
  titles aren't clipped.
- **Centre-on-click** for connection-rail clicks: smooth-scroll
  the canvas horizontally and the editor root vertically so
  the target card lands in the middle of the viewport.
- **Storyboard as a header section** with the full Diff
  sub-mode layout below: file tree on the left + stacked
  unified diffs on the right, scoped to the selected chapter.
  Whole sub-mode shares one scroll surface (the editor root);
  graph header and detail rail use `position: sticky`.

## Deferred to later phases

- **Phase 8.5 (new) — Monaco-backed diff views**. Replace the
  hand-rolled `<div>`-based unified-diff renderer used in the
  Diff sub-mode AND the storyboard's chapter diff with
  embedded Monaco diff editors so reviewers get syntax
  highlighting + LSP hover / go-to-definition / find-
  references inside the diff. Scoped before Phase 9 (Editor
  view) because both phases need the same `ITextModelService`
  + language-server plumbing.
- Pan/zoom and minimap — current scroll model works for the
  PR sizes we've tested. Revisit if a 30+ chapter graph hits
  the wall.
- React webview migration — only if the hand-rolled SVG
  approach hits scaling limits we can't paper over.

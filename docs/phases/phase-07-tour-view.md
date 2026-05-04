# Phase 7 — Review view: Tour (Chapters + Reading)

Goal: AI-generated narrative tour of a PR. BYOK Anthropic key
stored in OS keychain via `IEncryptionService`. Tour view sits as
a third sub-mode beside PR / Diff. Two presentation variants:
**Chapters** (rail of cards + focused diff per chapter) and
**Reading** (prose layout with mini-diffs). Generated chapters
cache by `{prId, headSha}` so reopening doesn't re-bill.

Reference: PLAN.md §4 Phase 7. PLAN.md is the source of truth;
this file is the working checklist.

## Working order

Smallest reversible piece first.

1. **Settings/AI module** — encrypted API key, model, prompt-cache
   toggle persisted via `IEncryptionService` + `IStorageService`.
   Configure command (`KRT: Configure Anthropic API Key…`) +
   model picker command. Phase 10 will host these in the proper
   Tweaks panel; for v1 a Command Palette command is sufficient
   because the Tour empty state runs it via a CTA button.
2. **Chapter type + cache** — `Chapter` shape per PLAN.md; cache
   in `IStorageService` keyed by `krt.tour.{owner}/{repo}#{number}.{headSha}`.
3. **TourGenerator service** — calls `api.anthropic.com/v1/messages`
   from renderer with the user's BYOK. Builds a structured prompt
   from `PullRequest` + `PullRequestFile[]`. Parses a JSON
   response into `Chapter[]`. Stub canned data when no key.
4. **Reviewed-chapter persistence** — per-chapter checkmarks
   keyed similarly to Phase 6's `krtPrReviewed`.
5. **Tour sub-mode** — extend `SubMode = 'pr' | 'diff' | 'tour'`.
   New segmented button. Empty state CTA when no key configured.
6. **Chapters variant** — left rail of chapter cards (title,
   summary, ±counts, sensitive badge, mark-reviewed checkmark),
   right pane shows the focused chapter's mini-diff.
7. **Reading variant** — single-column prose: each chapter
   renders title + summary + bullets + inline mini-diff for each
   `files[]`.
8. **Variant toggle** — small inline toggle in the Tour header.
   Phase 10 (Tweaks panel) will own this properly.
9. **Demo gate** — paste API key via the Configure command, open
   real PR, switch to Tour, see live AI chapters, mark a few
   reviewed (persists across reload).

## Tasks

### AI settings + secret storage

- [x] `vscode/src/vs/workbench/contrib/krt/browser/ai/krtAiSettings.ts`
      — `readAnthropicKey`, `writeAnthropicKey` (encrypts via
      `IEncryptionService`), `readModel`/`writeModel`,
      `readPromptCaching`/`writePromptCaching`. Defaults: model
      `claude-sonnet-4-6`, prompt-cache on.
- [x] `vscode/src/vs/workbench/contrib/krt/browser/ai/krtAi.contribution.ts`
      — register `krt.configureAnthropicKey` and
      `krt.selectAnthropicModel` actions. `f1: true` so they're
      reachable from the Command Palette. Wire-up imported from
      `krt.contribution.ts`.

### Chapter shape + cache

- [x] `krtTourTypes.ts` — `Chapter` interface matching PLAN.md.
- [x] `krtTourCache.ts` — `readCachedChapters(storage, owner, repo,
      number, headSha)` + `writeCachedChapters(...)`. JSON
      serialization with version tag for forward-compat.

### Tour generator

- [x] `krtTourGenerator.ts` — `ITourGenerator` decorator;
      `generateChapters(pr, files): Promise<Chapter[]>`. Calls
      `api.anthropic.com/v1/messages` with `Authorization: Bearer
      <key>` (Anthropic uses `x-api-key`; double-check). Parses
      JSON content blocks to a `Chapter[]`. Stub canned data
      ("no API key configured" path returns `[]`).

### Reviewed-chapter persistence

- [x] `krtTourReviewed.ts` — `string[]` of reviewed chapter ids,
      keyed by `krt.tour.reviewed.{owner}/{repo}#{number}`.

### Pane integration

- [x] Extend `SubMode` to `'pr' | 'diff' | 'tour'`. Add Tour
      button to segmented control. Reset variant on `setInput`.
- [x] `renderTourView(pr)` dispatcher: empty state when no key,
      loading state, error state, `Chapters`/`Reading` variant.
- [x] `renderTourChapters(pr, chapters)`: left rail + right
      detail. Click a chapter card to focus its mini-diff.
- [x] `renderTourReading(pr, chapters)`: single column prose.
- [x] Mini-diff renderer: re-uses `parsePatch` + `renderPatchLine`
      logic, scoped to a chapter's `files[]`.

### Variant toggle

- [x] Inline toggle in Tour header switches between Chapters and
      Reading. Persists via `IStorageService` keyed `krt.tour.variant`.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean.
- [x] `bash scripts/code.sh` launches.
- [x] Configure API key via command palette.
- [x] Open a real PR, switch to Tour, see chapters render, mark
      a few reviewed (persists across reload).
- [x] Tag `phase-07-complete`.

## Decisions made during execution

- **Settings UX**: shipped Command Palette commands
  (`KRT: Configure Anthropic API Key…`, `KRT: Select Anthropic
  Model…`, `KRT: Toggle Anthropic Prompt Caching`) instead of a
  full Settings → KRT → AI panel. The Tour empty state runs the
  Configure command directly via `ICommandService` so the demo
  flow is identical from the user's POV. Phase 10 (Tweaks panel)
  will host these inline.
- **API call origin**: renderer-side `fetch()` to
  `api.anthropic.com/v1/messages` with the
  `anthropic-dangerous-direct-browser-access: true` header.
  Anthropic blocks browser-origin traffic by default; without
  the header the request is rejected. Calling from main was
  considered but adds an IPC hop without a clear benefit (the
  decrypted key already lives in renderer memory the moment we
  use it, and `IEncryptionService` works in renderer).
- **Prompt shape**: a single user message containing PR
  metadata, description, and per-file `### path` headers with
  fenced `diff` blocks of the unified patch text. Patch text is
  truncated per-file at 8 KB and the whole prompt at 180 KB to
  stay well inside model context for typical PRs.
- **Output format**: model produces a fenced JSON block
  matching a tight schema. `parseChaptersJson` validates types,
  drops chapters whose `files` aren't in the actual PR, and
  uniquifies ids. We do not retry on parse failure in v1 — the
  user can hit "Try again" and we'll re-issue.
- **Cache key**: `{owner, repo, number, headSha}`. Force-push
  produces a new `headSha` and naturally invalidates the cache
  without us tracking it explicitly. Envelope carries a `v`
  field so we can re-shape `Chapter` later without false hits.
- **Variant toggle**: lives in the Tour header bar rather than
  the Tweaks panel (Phase 10). Phase 10 will likely subsume it.
- **Mini-diff renderer**: re-uses `parsePatch` and the same line
  classes as Phase 6's diff. The chapter detail focuses on the
  chapter's `diffFile` first, then renders the rest of `files[]`
  in order. We deliberately don't load distinct file content
  for the mini-diffs — patches cover the diff, which is what
  the reviewer needs to look at.

## Open questions

_(none)_

## Deferred to later phases

- Settings panel UI proper — Phase 10 (Tweaks panel) will host
  the AI config inline rather than via Command Palette only.
- Storyboard graph from `dependsOn[]` — Phase 8 builds the visual
  graph; we capture `dependsOn` in the chapter shape now so
  Phase 8 has data to draw.
- Streaming responses from Anthropic — v1 awaits the full
  response. Streaming is a UX nicety we can layer later.
- Multi-turn refinement / "regenerate this chapter" — the v1
  flow is one-shot generate; user can wipe the cache to redo.

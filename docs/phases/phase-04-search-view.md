# Phase 4 — Search view

Goal: take Phase 3's data plane and put a UI on top of it. By the end,
Cmd+K opens a Search overlay; typing streams results from the gh CLI;
Enter opens the selected PR as a tab in the editor area. The PR tab
shows a placeholder body — Phases 5/6 fill in description, comments,
review surfaces.

Reference: PLAN.md §4 Phase 4, §3 (Architecture). PLAN.md is the
source of truth; this file is the working checklist.

## Working order

Smallest reversible piece first. Provider surface → PR EditorInput
(so "open a PR as a tab" is callable end-to-end before any UI) →
overlay UI → keybinding → onboarding screen.

1. **Provider surface** — extend `IPullRequestProvider` in
   `vs/platform/krt/common/krt.ts` with
   `search(query, scope): Promise<readonly PullRequestSummary[]>`.
   Add `SearchScope` (`'all-open' | 'reviewed' | 'awaiting-review'`)
   and `PullRequestSummary` (lighter than `PullRequest`: url, owner,
   repo, number, title, state, author, updatedAt). Implementation in
   the main process uses `gh api search/issues?q=...` (REST) — the
   PR-specific search endpoint requires GraphQL we're saving for
   Phase 5.
2. **PR `EditorInput` + `EditorPane`** — custom editor input whose
   resource is the PR URL. The pane renders a placeholder body now
   (title, owner/repo#number, state pill, "Phase 5 will land the
   description here"). All future PR surfaces (PR view, Review,
   Editor) become alternative panes for the same input. Open via
   `IEditorService.openEditor(input)` from the Search overlay and
   `KRT: Open PR`.
3. **Search overlay UI** — full-width modal anchored under the
   titlebar. Input on top, scope tabs (All open / You've reviewed /
   Awaiting your review), streamed result list, recent-repos grid
   below. ⌘K toggles open; Esc closes; Enter opens the selected PR
   as a tab; ↑/↓ moves selection. Visual style: matches
   `design/kol-s-review-tool/src/search-view.jsx` + `styles.css`.
4. **Keybinding** — bind ⌘K to `krt.search`. Phase 2 unbound the
   default command-palette binding for exactly this purpose.
5. **`gh-missing` onboarding** — when `IGhClient.detect()` rejects
   with `gh-missing` / `gh-auth-expired`, the overlay's empty state
   becomes the onboarding card with copy-pasteable install +
   `gh auth login` commands. Same pixels for both states (deferred
   from Phase 3 for this reason).
6. **Demo gate** — launch via `scripts/code.sh`, ⌘K, type
   `is:open repo:cli/cli`, see results stream, Enter on the first
   result opens a tab whose body shows the placeholder. Re-bind
   `KRT: Open PR` recents flow to also use `IEditorService` so the
   command and the overlay converge on one open path.

## Tasks

### Provider surface

- [x] `vscode/src/vs/platform/krt/common/krt.ts` — add `SearchScope`,
      `PullRequestSummary`, extend `IPullRequestProvider` with
      `search(query, scope)`. Keep summary thin — UI only needs
      enough to render a row.
- [x] `vscode/src/vs/platform/krt/electron-main/pullRequestProviderMainService.ts`
      — implement `search`. Build a query string per scope:
      - `all-open`: append `is:open is:pr archived:false`
      - `reviewed`: append `is:pr reviewed-by:@me`
      - `awaiting-review`: append `is:pr review-requested:@me`
      Call `gh api search/issues?q=...&per_page=25`, map
      `items[*]` → `PullRequestSummary`. The endpoint returns issues
      and PRs — `is:pr` filters server-side; double-check
      `pull_request !== undefined` defensively.

### PR `EditorInput` + `EditorPane`

- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPullRequestEditorInput.ts`
      — `class KrtPullRequestEditorInput extends EditorInput`. Resource:
      `URI.parse(prUrl)`. `typeId`: `krt.pullRequestEditorInput`.
      `getName()` returns `owner/repo#number`. `matches()` compares
      resource string.
- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPullRequestEditorPane.ts`
      — `class KrtPullRequestEditorPane extends EditorPane`.
      `setInput()` calls `provider.getPullRequest(url)`, swaps the
      placeholder DOM in. Layout-aware (`layout(dim)` sets the
      content size).
- [x] Register the pair in `krtPullRequestEditor.contribution.ts`:
      `Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
      .registerEditorPane(...)` plus `EditorExtensions.EditorFactory`
      for input serialization (so closed PR tabs persist across
      reload — desirable for Phase 4+).
- [x] Update `krtOpenPullRequest.contribution.ts` to call
      `IEditorService.openEditor(input)` instead of `console.log`.

### Search overlay UI

- [x] `vscode/src/vs/workbench/contrib/krt/browser/search/krtSearchOverlay.ts`
      — DOM-built overlay using base `Modal`-style helpers (look at
      `quickInputController` for the established pattern). Uses
      `WorkbenchList` for the result list — built-in keyboard nav,
      virtualization, accessibility for free.
- [x] `vscode/src/vs/workbench/contrib/krt/browser/search/krtSearchOverlay.css`
      — pull from `design/kol-s-review-tool/src/styles.css` for the
      surface; reuse the `--accent` etc. variables already injected
      in Phase 2.
- [x] `vscode/src/vs/workbench/contrib/krt/browser/search/krtSearchService.ts`
      — `IKrtSearchService` (decorator). `open()` shows the overlay,
      `close()` hides. Tracks recents via `IStorageService`
      `krt.recentRepos` (separate key from `krt.recentPRs`).
- [x] Debounce input → provider.search calls (250ms). Cancel
      in-flight requests on input change (CancellationToken).

### Keybinding

- [x] `krt.search` action with `keybinding: KeyMod.CtrlCmd | KeyCode.KeyK`,
      weight `KeybindingWeight.WorkbenchContrib`, `when` clause that
      excludes `inEditor` so ⌘K still works in editor's
      remove-trailing-whitespace etc. (Actually, `quickOpen` is the
      precedent — it overrides editor too; revisit if the binding
      conflicts in practice.)

### `gh-missing` onboarding

- [x] In `KrtSearchOverlay.show()`: call `IGhClient.detect()` once
      per open. On `gh-missing` / `gh-auth-expired`, swap the result
      list for an onboarding card: heading, install URL, two
      copy-pasteable code blocks (`brew install gh` /
      `gh auth login`), "Retry" button that re-runs detect.
- [x] Reuse the same DOM panel from the overlay's "no results yet /
      type something" empty state (slot in different content).

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean.
- [x] `bash scripts/code.sh` launches.
- [x] ⌘K opens the overlay.
- [x] Typing `repo:cli/cli is:open` streams results within ~500ms.
- [x] Enter on the top result opens a PR tab whose pane shows the
      placeholder body (title + state pill).
- [x] `KRT: Open PR` command also opens via the same editor input.
- [x] Tag `phase-04-complete`.

## Decisions made during execution

- **Custom URI scheme `krt-pr://owner/repo/number`** for the PR
  EditorInput resource. The `https:` URL is preserved in `input.url`
  and round-trips through `parsePullRequestUrl` for serialization.
  Reason: editor inputs are commonly addressed by resource, but
  `https:` resources collide with other webview/markdown openers in
  the editor service routing.
- **Single shared `EditorPane` per PR tab.** Phases 5/6/7/8 will
  render different sub-modes (PR view / Diff / Tour / Storyboard) by
  swapping the body DOM inside this same pane, not by registering
  parallel panes. Keeps tab/group lifecycle uniform across modes.
- **Pane handles recents persistence**, not the open-PR action. The
  pane is the only place that observes a successful
  `getPullRequest(url)`; recording recents at that join point means
  both the Search overlay and `KRT: Open PR` converge on one path
  with no duplicate fetch.
- **Shared `parsePullRequestUrl` helper in `common/krt.ts`.** Pulled
  out of `pullRequestProviderMainService.ts` so the renderer can
  parse without IPC-ing to main. Action constructs the editor input
  immediately on click; the pane fetches the body lazily via
  `IPullRequestProvider.getPullRequest`.
- **Cmd+K weight bumped to `ExternalExtension + 1000`** to beat the
  ~30 upstream `KeyChord(cmd+K, …)` bindings in the keybinding
  resolver. Without the bump the dispatcher entered chord-prefix
  mode on press and waited for a second key. The resolver picks the
  last matching candidate in `_findCommand`; higher weight = later
  in list = wins. PLAN.md Phase 2 listed "rebind ⌘K" as deferred
  work — this is the actual fix.
- **Onboarding screen lives inside the Search overlay's results
  area**, not as a separate editor input. The overlay owns the
  pixels for both the empty state and the gh-missing/auth-expired
  state — same `.krt-search-results` container, different content.
  This is what PLAN.md anticipated when it deferred the onboarding
  screen from Phase 3 ("shares pixels with the Search empty state").
- **One patch (0012) for all of Phase 4.** Like Phase 3 — the search
  surface, the editor input, and the PR pane are meaningless apart.

## Open questions

- [x] Scope tab "You've reviewed" — does GitHub's
      `reviewed-by:@me` qualifier match the design's intent (PRs
      where the user submitted at least one review) or do we need
      `commenter:@me` etc.? Defaulting to `reviewed-by:@me`; iterate
      if it feels wrong on a real account.
- [x] PR EditorInput resource — `URI.parse(prUrl)` works but
      `https:` resources are unusual for editor inputs. Consider a
      custom scheme `krt-pr://owner/repo/number` for clarity. Pick
      whichever round-trips through `EditorInputFactory` cleanly.
- [x] Should the PR pane fetch the PR object eagerly on `setInput`
      or only when the body becomes visible? Phase 5 will load real
      content; Phase 4's placeholder is fine eager.
- [x] Recent repos grid — derive from `krt.recentPRs` (Phase 3
      storage key) by uniquing `owner/repo`, or maintain a separate
      `krt.recentRepos`? Probably derive — single source of truth.

## Deferred to later phases

- Real PR description / comments / reviewers / checks rendering →
  Phase 5.
- GraphQL search (richer filters, batch reviewer state) → Phase 5.
- Diff / Tour / Storyboard / Editor sub-modes for the PR tab →
  Phases 6-9.
- Pagination beyond the first 25 results — Phase 4's overlay is
  type-ahead, not browse; punt until a user complains.

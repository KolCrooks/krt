# Phase 5 — PR view

Goal: take Phase 4's placeholder PR tab and turn it into a real PR
view. By the end, opening a PR shows the description (markdown),
reviewers / checks / labels / stats sidebar cards, and an Activity
section with Discussion / Automation tabs. The reply box at the bottom
posts a comment via the provider.

Reference: PLAN.md §4 Phase 5, §3 (Architecture). PLAN.md is the
source of truth; this file is the working checklist.

## Working order

Smallest reversible piece first. Provider surface (parallel REST
fan-out for reviewers/checks/comments + `getActivity` + `postComment`)
→ pane DOM rewrite (header + 2-column grid) → markdown description
via `renderMarkdown` → sidebar cards → activity tabs + timeline →
functional reply box.

1. **Provider surface** — extend `IGhClient` with `apiPostJson` so the
   provider can shell out to `gh api -X POST -f body=...`. Extend
   `IPullRequestProvider` with `getActivity(prUrl)` returning
   `AutomationEvent[]` and `postIssueComment(prUrl, body)` returning
   the new `Comment`. `getPullRequest` populates `reviewers`,
   `checks`, `comments` by parallel-fanning to:
   - `repos/{o}/{r}/issues/{n}/comments` → discussion comments
   - `repos/{o}/{r}/pulls/{n}/reviews` → reviewer states
   - `repos/{o}/{r}/commits/{headSha}/check-runs` → checks
2. **Pane DOM rewrite** — `KrtPullRequestEditorPane` keeps the same
   shell (root, header) but the body becomes a 2-column grid: main
   column (description, activity, reply box) + sidebar (Reviewers,
   Checks, Labels, Stats).
3. **Markdown description** — render via VS Code's base
   `renderMarkdown(IMarkdownString)`. Pane's body container hosts the
   rendered content. Empty description shows a muted "No description
   provided." line.
4. **Sidebar cards** — small DOM helpers for each card. Reviewer rows
   show login + state pill (approved/commented/pending). Check rows
   show name + status icon + (when failed/in-progress) link arrow
   that opens `details_url`. Labels render as inline chips. Stats are
   a key/value grid.
5. **Activity tabs** — Discussion / Automation. Discussion is a
   timeline of `Comment[]` (existing PR data); Automation is a
   timeline of `AutomationEvent[]` from `getActivity`. Active tab
   tracked locally on the pane; lazy-fetch automation events the
   first time the user clicks the tab.
6. **Reply box** — textarea + Comment button. On submit calls
   `provider.postIssueComment(url, body)`, appends the returned
   `Comment` to the discussion timeline, clears the textarea. Shows
   inline error on failure.
7. **Demo gate** — launch via `scripts/code.sh`, ⌘K → open a real PR,
   see description rendered, sidebar populated, click Automation tab
   to see CI events, type a comment in the reply box and post.

## Tasks

### Provider surface

- [x] `vscode/src/vs/platform/krt/common/krt.ts` — extend
      `IGhClient` with `apiPostJson<T>(path, body): Promise<T>`. Add
      `IPullRequestProvider.getActivity(url)` and
      `postIssueComment(url, body)`. `Comment` already exists; ensure
      the `issue` location kind round-trips.
- [x] `vscode/src/vs/platform/krt/electron-main/ghClientMainService.ts`
      — implement `apiPostJson`. `gh api <path> -X POST -f body=<…>`
      sends form-encoded; for arbitrary-length bodies use stdin via
      `--input -` and write the JSON. Pick `--input -` (POST + JSON
      body) since GitHub's comment endpoint expects JSON.
- [x] `vscode/src/vs/platform/krt/electron-main/pullRequestProviderMainService.ts`
      — `getPullRequest` now `Promise.all([prFetch, comments,
      reviews, checks])`. Map reviewers from latest review per user.
      `getActivity` calls `issues/{n}/timeline`
      (`Accept: application/vnd.github.mockingbird-preview` is the
      preview header; we may need to bypass the gh CLI default and
      use `--header`). Translate timeline events to
      `AutomationEvent`. `postIssueComment` POSTs to
      `repos/{o}/{r}/issues/{n}/comments` with `{ body }`.

### Pane DOM rewrite + markdown description

- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtPullRequestEditorPane.ts`
      — replace placeholder body with two-column grid. Main column
      hosts description (rendered via `renderMarkdown`), activity,
      reply box. Sidebar hosts cards. Pane disposes the
      `IRenderedMarkdown` on `clearInput` / re-render.

### Sidebar cards

- [x] `Reviewers` card — one row per `Reviewer`. Empty state: muted
      "No reviewers requested.".
- [x] `Checks` card — one row per `CheckRun`. Status icon + name +
      external-link arrow when `details_url` is present (clicking
      opens via `IOpenerService`).
- [x] `Labels` card — chip per label; empty state muted line.
- [x] `Stats` card — Commits / Files / Lines added / Lines removed /
      Last updated (relative time via `fromNow` from
      `vs/base/common/date`).

### Activity tabs + reply box

- [x] Activity tab strip with `Discussion` (count = `pr.comments`) /
      `Automation` (count = lazy-loaded). Switching tabs swaps
      content area.
- [x] Discussion timeline — comment cards with author, when, body
      (markdown rendered).
- [x] Automation timeline — rows with kind icon + actor + summary +
      when.
- [x] Reply box — textarea + `Comment` button. Disabled while
      posting; clears on success; appends new comment to discussion
      list. Error state inline below the box.

### Compile + hygiene + demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean.
- [x] `bash scripts/code.sh` launches.
- [x] ⌘K → open `cli/cli#1`, see description rendered, sidebar
      populated, Discussion has comment cards, Automation tab has CI
      events, reply box posts a comment that appears in the timeline.
- [x] Tag `phase-05-complete`.

## Decisions made during execution

- _(filled in during execution)_

## Open questions

- _(filled in during execution)_

## Deferred to later phases

- GraphQL for batched timeline + reviewer + thread fetch — REST
  parallel fan-out is fine at Phase 5 scale; revisit if a real PR
  shows latency pain.
- Inline review comments anchored to lines → Phase 6 (Diff
  sub-mode).
- Reply threads + reactions on comments — issue comments are flat in
  GitHub's REST API and the design renders them flat at this level.
  Threaded replies live on review comments, which arrive in Phase 6.
- "Approve" / "Request changes" buttons in the reply box — design
  shows them as siblings of `Comment`. Defer to Phase 6 since they
  apply to a review, not a discussion comment, and we don't yet
  have a review object on the pane.

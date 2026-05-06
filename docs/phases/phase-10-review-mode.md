# Phase 10 — Review mode + comment fidelity

Goal: turn KRT from "PR viewer that can also check out
the head" into "review tool you actually finish a review
with." Replace the per-PR "Check Out" button with a
"Start Review" button that wraps check-out + draft-review
state. Inline comments accumulate into the draft and post
to GitHub in one batch on Submit. Multiple PRs can carry
concurrent drafts. Along the way, fix the comment-
rendering and automation-classification bugs the user
flagged.

Reference: PLAN.md §4 Phase 10. PLAN.md is the source of
truth; this file is the working checklist.

## Working order

The behavioural piece (review mode) lands first because
it changes the PR header's primary affordance; comment
fidelity layers in afterwards.

1. **Draft-review storage**. Add
   `IKrtReviewDraftService`: per-PR draft with comments
   `[{path, line, side, body}]`. Persist to
   `IStorageService` so a crash mid-review doesn't lose
   work. Multiple drafts at once (one per PR).
2. **Start Review button replaces Check Out.** PR header
   shows Start Review when no draft exists for this PR;
   Continue Review when one exists. Click runs Phase
   8.7's check-out flow + activates draft-mode.
3. **Submit / Discard.** Submit posts every draft
   comment via `IGhClient.apiPostJson` to
   `/repos/{owner}/{repo}/pulls/{number}/reviews` in one
   request (GitHub's batch-review endpoint). Discard
   drops the draft + runs the existing Return flow.
4. **Mode-switching UI restyle.** PR / Diff / Tour /
   Storyboard segmented control matches the demo's
   visual; refresh button moves to the left of the PR
   title; "Open on GitHub" affordance lands.
5. **Reply-to-comment threading.** Existing review
   comments on the PR get a "Reply" affordance that
   adds a reply body to the active draft, threaded under
   the parent.
6. **Bot list.** Per-workspace local list of GitHub
   usernames whose comments route to Automation rather
   than Discussion. Add via `KRT: Add Bot User…` and
   `KRT: Remove Bot User…`.
7. **Markdown HTML support.** Update the markdown
   renderer to allow inline HTML — at minimum
   `<details>` / `<summary>` — in comments and PR body.
8. **Avatar pops in Discussion.** Each comment shows
   the author's avatar next to the name (today only the
   login is rendered).
9. **Checks tab dedupe + restyle.** Group reruns by
   workflow, show the latest run per check, restyle to
   the demo.

## Tasks

### Draft-review storage

- [ ] `vscode/src/vs/workbench/contrib/krt/browser/review/krtReviewDraftService.ts`
      — `IKrtReviewDraftService` decorator + service.
      Methods: `getDraft(prUrl)`, `addComment(prUrl,
      comment)`, `updateComment(prUrl, id, body)`,
      `removeComment(prUrl, id)`, `discard(prUrl)`,
      `submit(prUrl)`, `onDidChange(prUrl?)`.
- [ ] Persist under `krt.reviewDrafts.v1` envelope. App
      scope. Concurrent drafts keyed by `prUrl`.

### Start Review / Continue Review button

- [ ] PR header replaces the existing Check Out button.
      Three states: Start Review (no draft) / Continue
      Review (draft exists) / Submit / Discard (when in
      review mode).
- [ ] Start Review runs the existing
      `checkOutPullRequest` flow then opens a fresh
      draft for that PR.
- [ ] Continue Review runs the same check-out flow if
      not already on this PR, then re-enters review mode
      against the existing draft.

### Submit + Discard

- [ ] `submit(prUrl)` POSTs to
      `/repos/{owner}/{repo}/pulls/{number}/reviews`
      with `{event: 'COMMENT', comments: [...]}` (use
      `'APPROVE'` / `'REQUEST_CHANGES'` when the user
      picks one of those buttons in the submit
      sheet). Drop the local draft on success.
- [ ] `discard(prUrl)` clears the draft + invokes the
      Phase 8.7 Return flow on the active resume token.

### Mode-switching UI

- [ ] Restyle the existing sub-mode bar in
      `krtPullRequestEditorPane.css` to match the demo's
      segmented control.
- [ ] Move the refresh button DOM element to the left
      side of the title in `createEditor()`.
- [ ] Add an "Open on GitHub" link button to the header
      (see Phase 9 for the icon set).

### Reply-to-comment threading

- [ ] Extend `Comment` (or wrap with a new draft-side
      type) to carry `inReplyTo: number?`.
- [ ] Discussion + Diff comment renderers grow a Reply
      button. Click adds a draft comment under the
      parent.
- [ ] Submit posts replies via `POST
      /repos/{o}/{r}/pulls/{n}/comments` with
      `in_reply_to`.

### Bot list

- [ ] `IKrtBotListService` with
      `getBots(workspaceId)`, `addBot(workspaceId,
      login)`, `removeBot(workspaceId, login)`,
      `isBot(workspaceId, login)`. Persist under
      `krt.botList.v1`.
- [ ] Activity classifier in
      `krtPullRequestEditorPane.ts` consults the bot
      list when bucketing comments into Discussion vs
      Automation.
- [ ] Commands: `KRT: Add Bot User…`, `KRT: Remove Bot
      User…`. Add Bot picks from the PR's existing
      commenters via QuickPick so the user doesn't have
      to type GitHub logins from memory.

### Markdown HTML support

- [ ] Update the markdown renderer (likely
      `renderMarkdown`'s sanitizer config) to allow
      `<details>`, `<summary>`, `<sub>`, `<sup>`, `<kbd>`,
      `<br>`. Audit GitHub's markdown to make sure we're
      not under-sanitizing.
- [ ] Test against a PR description containing a
      collapsed `<details>` block; verify it expands on
      click.

### Avatar pops in Discussion

- [ ] PR data now carries `avatarUrl` (already on
      `PullRequestUser`). Render `<img>` next to the
      author name in the comment headers.
- [ ] Fall back to a generated initial-avatar when
      `avatarUrl` is absent.

### Checks tab dedupe + restyle

- [ ] Group `CheckRun` entries by `name`; keep the
      newest by `completedAt` (or `startedAt` if
      missing). Currently we render all entries
      verbatim, hence duplicates after re-runs.
- [ ] Some checks reportedly fail to render at all —
      audit the GraphQL query to ensure we're paginating
      / requesting the right `checkSuites` / handling
      the `CheckSuite.app.slug` for non-Actions checks.
- [ ] Restyle to the demo (status pill colours,
      timestamp on the right, expandable details).

### Demo gate

- [ ] `npm run compile-check-ts-native` clean.
- [ ] `npm run valid-layers-check` clean.
- [ ] `npm run compile` clean.
- [ ] `bash scripts/code.sh` launches.
- [ ] **Review happy path**: Start Review on PR A → leave
      3 inline comments + 1 reply via the Diff view →
      Submit → all 4 land on GitHub as a single review.
- [ ] **Multi-PR drafts**: Start Review on PR A, leave a
      comment, navigate to PR B, Start Review there,
      leave a different comment, return to PR A —
      Continue Review picks up where you left off.
- [ ] **Discard**: leave a comment, Discard, working
      copy returns via the Phase 8.7 resume flow, draft
      is gone.
- [ ] **Bot list**: add a known automation user; their
      previously-Discussion comments shift to
      Automation. Reload the PR; classification sticks.
- [ ] **Markdown**: PR with a `<details>` block in the
      description renders collapsed; clicking the
      summary expands it.
- [ ] **Avatars**: every commenter row shows the right
      avatar; fallback initial avatar appears for users
      with no `avatarUrl`.
- [ ] **Checks**: re-run a check on a test PR; the row
      updates rather than duplicating; layout matches
      demo.
- [ ] Tag `phase-10-complete`.

## Decisions to capture during execution

- _(filled in during execution)_

## Open questions

- **Submit-as-Approve / Request-Changes**: the GitHub
  review-batch endpoint takes `event: 'COMMENT' |
  'APPROVE' | 'REQUEST_CHANGES'`. UX-wise: a single
  Submit button with a small dropdown for the event, or
  three explicit buttons? Lean: dropdown — Approve /
  Request changes are the rare path.
- **Reply threading depth**: GitHub allows arbitrary
  reply depth; the demo shows flat-after-first-reply.
  Lean: render flat (parent + replies in one thread, no
  nested indentation past depth 1) since deeper trees
  are rare and ugly in narrow comment columns.
- **Bot list scope**: per-workspace (one list per repo)
  or global across all KRT? Lean: per-workspace,
  matching the workspace registry's scoping. A user's
  internal bots are repo-specific.
- **Discard while changes in working tree**: if the user
  made commits on the PR head while reviewing, Discard
  runs `jj op restore` (Phase 8.7) which discards those
  too. Should Discard warn? Lean: yes, warn if working
  tree is dirty or has commits past the switch op.

## Deferred to later phases

- **Code-suggestion comments** (GitHub's
  `suggestion`-block markdown): a v2 of inline review
  comments. Phase 11 / 12 polish.
- **Cross-PR comment search** — handy but not core
  reviewing UX. Defer.
- **Resolve threads from KRT** — GitHub's "resolve
  conversation" gesture. Add later, probably alongside
  reply threading polish.

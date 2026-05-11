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

- [x] `vscode/src/vs/workbench/contrib/krt/browser/pr/krtReviewDraftService.ts`
      — `IKrtReviewDraftService` decorator + service.
      Methods: `getDraft`, `hasDraft`, `startReview`,
      `discard`, `addComment`, `removeComment`, `submit`,
      `onDidChange(prUrl)`. (Lives under `pr/` rather
      than `review/` since everything else lifecycle-
      coupled to it is already there.)
- [x] Persist under `krt.reviewDrafts.v1` envelope. App
      scope. Concurrent drafts keyed by `prUrl`.

### Start Review / Continue Review button

- [x] PR header replaces the existing Check Out button.
      Three primary-button states: Start Review (no
      draft) / Continue Review (draft, not on head) /
      Submit Review (draft, on head). A Discard button
      surfaces alongside once a draft exists.
- [x] Start Review runs the existing checkout flow
      (`switchTo` from Phase 8.7) then opens a fresh
      draft for that PR. Already-on-head case skips the
      switch dance and goes straight to draft creation.
- [x] Continue Review runs the same check-out flow if
      not already on this PR, then re-enters review mode
      against the existing draft.

### Submit + Discard

- [x] `submit({prUrl, event, body})` POSTs to
      `/repos/{owner}/{repo}/pulls/{number}/reviews` via
      a new `IPullRequestProvider.submitReview(url,
      submission)` with `{event, body, commitId,
      comments, replies}`. Drops the local draft on
      success and re-fetches review comments so the
      pending threads flip to native server-side ones.
- [x] Approve / Comment / Request Changes verdicts.
      Submit is now a two-step dialog: a three-button
      prompt picks the `ReviewSubmissionEvent`, then an
      input dialog collects the optional summary body.
      Notification + body-dialog copy adapt to the
      verdict ("Approved PR #N" / "Requested changes" /
      "Review posted"). Patch 0100.
- [x] `discard(prUrl)` clears the draft + invokes the
      existing `returnFrom` flow on the active resume
      token (only when KRT owns the switch — manual
      check-outs aren't reverted).

### Mode-switching UI

- [x] Restyle the existing sub-mode bar in
      `krtPullRequestEditorPane.css` to match the demo's
      pill-wrapped subtab style (outer track + accent-soft
      active state, no per-button dividers). Patch 0092.
- [ ] Move the refresh button DOM element to the left
      side of the title — descoped on user request; the
      existing right-side placement stays.
- [x] "Open on GitHub" link button: already shipped in
      Phase 9, kept as-is.

### Reply-to-comment threading

- [x] Extend `KrtReviewDraftComment` + `IAddDraftCommentArgs`
      with `inReplyTo?: number`. (Modelled on the draft
      side rather than mutating `Comment`, since GitHub
      threads its replies via parent id, not via the
      comment payload.)
- [x] `KrtPrCommentController.refreshUri` flips
      `canReply: true` on real threads while a draft is
      active. Native widget shows the Reply input
      automatically.
- [x] `submitNewComment` detects reply mode (non-template
      thread + at least one server-side comment on the
      line) and calls `findReplyParentId` to look up the
      earliest GitHub comment id as the reply target.
- [x] Submit splits the draft into top-level comments
      (POST `/reviews`, batched) and replies (POST
      `/comments` with `in_reply_to`, one request per
      reply). Patch 0093.

### Bot list

- [x] `IKrtBotListService` with the methods listed,
      persisted under `krt.botList.v1`. Keyed by workspace
      folder URI — matches the workspace registry's
      scope. Patch 0094.
- [x] `partitionCommentsByBot` filters `liveComments` per
      PR via `botListService.isBot(workspace.folderUri, ...)`.
      Bot comments merge into the Automation timeline by
      timestamp so chronology stays clean.
- [x] In-context kebab menu on every comment header (no
      command palette entries). Click the kebab → context
      menu with one item: "Mark as Automation" (or "Mark
      as Discussion" if already a bot). Visible by default
      at 0.6 opacity, brightens on hover. The kebab is
      shaped to host more per-comment actions later
      (resolve, copy permalink, …) without re-plumbing the
      chrome. Patches 0097-0099. Initial command-palette
      shape (patch 0094) was rolled back per user
      direction — see `feedback_avoid_command_palette`.

### Markdown HTML support

- [x] Flipped `supportHtml: true` on PR description and
      comment body. The base `renderMarkdown` sanitizer's
      default allowlist already covers every tag PLAN.md
      called out (`<details>`, `<summary>`, `<kbd>`,
      `<sub>`, `<sup>`, `<br>`) plus the `s` / `strike` /
      `del` family — no custom sanitizer config needed.
      Patch 0095.
- [x] Verified against a real PR with a collapsed
      `<details>` block in the description.

### Avatar pops in Discussion

- [x] `<img class="krt-pr-comment-avatar">` rendered next
      to each comment author in the timeline. Source URL
      is GitHub's `avatarUrl` with `?s=40` appended
      (idempotent). Patch 0095.
- [x] Initial-letter fallback chip with a stable colour
      hashed from the login when `avatarUrl` is absent.

### Checks tab dedupe + restyle

- [x] `dedupeChecksByName` collapses re-runs to the
      latest entry by `completedAt` (falling back to
      `startedAt`) and sorts alphabetically for stable
      ordering. Patch 0096.
- [x] Each row grows a right-aligned meta cell:
      relative time of the latest run, or "running…" in
      the warn colour for in-flight checks. The arrow
      glyph fades in on hover instead of always
      showing.
- [ ] Deeper "missing checks" audit (statuses API for
      non-Actions sources, paging past 100) deferred —
      none of the test PRs surfaced missing entries
      during the dedupe work, but the `commits/{sha}/check-runs`
      endpoint specifically can miss third-party
      statuses. Tracked as a follow-up.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] **Review happy path** (verified): Start Review →
      inline comment with the kebab/template flow →
      Submit Review → comment lands on GitHub.
- [x] **Bot list**: kebab → "Mark as Automation" shifts
      the author's comments to the Automation tab. Reload
      to confirm it sticks. Verified.
- [x] **Approve / Request Changes verdicts**: Submit
      Review prompt offers three buttons; verdict flows
      through provider to GitHub.
- Tagging deferred — patch 0067 onward isn't squashed yet.
  Pick a tag point when the parent KRT repo's jj change is
  described.

## Decisions to capture during execution

- **Submit-as-Approve / Request-Changes deferred.** The provider +
  draft service already accept `'APPROVE'` / `'REQUEST_CHANGES'`
  (`ReviewSubmissionEvent`), so adding the dropdown later is a UI
  change in `handleSubmitReview`'s dialog. Not blocking review-mode
  ergonomics, so it's not in Phase 10.
- **Refresh button stays on the right.** PLAN.md called for moving it
  left of the title; user descoped during execution because the right
  cluster (Refresh / Open on GitHub / Discard / Submit Review)
  reads cleanly together.
- **Replies need a real parent.** `submitNewComment` only routes a
  comment as a reply when the line already has a server-side comment
  it can `in_reply_to`. Follow-ups on a draft-only line fall through
  to "another new top-level on the same line" — GitHub will collapse
  those into one thread anyway via line position.
- **Inline `Comment` button was hidden in Phase C.** `KrtPrCommentController`
  never set `contextValue`, so the menu's
  `commentController == 'krt-pr'` `when` clause never matched and the
  inline submit button was invisible. Patch 0090 binds
  `contextValue = KRT_PR_COMMENT_OWNER` (matching upstream
  `MainThreadCommentController`'s `contextValue = id`). The keyboard
  shortcut had been masking the regression.
- **`setDocumentComments` was double-mounting widgets.** Both
  `refreshUri` and `createCommentThreadTemplate` fired the
  `updateComments` delta AND the `setDocumentComments` snapshot. The
  workbench treats the snapshot as a wipe-and-re-add, so the snapshot
  re-mounted the widgets the delta just created and left stacked
  `ReviewZoneWidget` viewzones on the same line. Patch 0091 drops the
  snapshot calls — the delta alone is sufficient after the initial
  provider attach.
- **Template threads need explicit cleanup.** After the user submits
  a comment (real or draft), the empty template thread previously
  lingered in `threadsByUri` (carry-over preserved it). `disposeTemplateForLine`
  (patch 0090) removes it explicitly so the line shows only the
  consumed thread. `deleteCommentThreadMain` is no longer a stub —
  the workbench's hide-empty-template path now actually drops the
  thread from our state.
- **Bot list scope: per-workspace.** Matches the workspace registry's
  scoping. The `IKrtBotListService` is keyed by `workspace.folderUri`
  rather than `(owner, repo)` so a user with multiple clones of the
  same repo can keep their bot lists independent.
- **Bot comments merge into Automation by timestamp.** Rather than
  bucketing bot comments into a separate "Bots" sub-section, they
  interleave with `AutomationEvent` rows by `at` / `createdAt`. Keeps
  the timeline coherent — a bot comment about a CI failure renders
  next to the CI status row instead of below all of them.

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

# Phase 8.7 — Auto-switch on review (jj + git)

Goal: when the user opens a PR whose repo matches a
registered workspace, prompt to switch the workspace's
working copy to the PR's head commit. After confirmation,
KRT runs `jj new ${headSha}` (jj-colocated repos) or
`gh pr checkout ${number}` with a stash if needed (plain
git), so the rest of the review surface reflects the PR
that's being looked at — files in the Editor view are the
PR's version, language servers index the PR's source, etc.

The user's prior working-copy state is **always
recoverable**:
- jj path: prior change is preserved in the op log;
  `jj op undo` (or KRT's "Return to previous state"
  command) flips back.
- git path with a clean tree: prior branch is recorded;
  KRT's command checks the prior branch back out.
- git path with a dirty tree: KRT runs `git stash push -m
  "krt: PR #N"` first, behind a strong confirmation
  dialog. Restore is `git stash pop` (manual, intentionally
  — auto-popping is too surprising).

Reference: PLAN.md §4 Phase 8.7. PLAN.md is the source of
truth; this file is the working checklist.

## Working order

Smallest reversible piece first.

1. **VCS detection** — `krtVcs.ts`. Detect per-workspace
   whether `.jj` exists (jj-managed, possibly colocated
   with git) vs `.git` only (plain git). Cache the result
   on the workspace record.
2. **Pre-flight status** — for both VCS, run a status
   query so the dialog can describe what'll happen
   (jj: show the current change ID; git: show
   uncommitted-file count).
3. **Confirmation dialog** — `IDialogService.confirm` with
   three messages keyed off VCS + dirty state.
4. **Resume token persistence** — before the switch,
   record the workspace's current `{ vcs, jjChangeId? ,
   gitBranch?, gitStashRef? }` in `IStorageService` keyed
   by `(workspaceId, prUrl)` so we can recover even if
   KRT crashes.
5. **Switch op**:
   - jj: `jj new ${headSha}` (or `jj edit` if a change at
     the SHA already exists locally).
   - git clean: `git fetch origin pull/${n}/head` →
     `git checkout FETCH_HEAD` (detached) or
     `gh pr checkout ${n}` for a named branch.
   - git dirty: `git stash push -m "krt: PR #${n}"` then
     same as clean.
6. **Workbench refresh** — once the working tree changes,
   the file tree, status bar, and any open editors need
   to re-read. Send the appropriate file-system change
   events; reload language extensions watching the
   workspace if necessary.
7. **Close-PR cleanup prompt** — when the user closes the
   PR tab, surface a notification or modal: "Return to
   ${prevBranchOrChange}?" → flips back via the resume
   token.
8. **Failure modes** — every branch needs a clean rollback
   path. If a step fails mid-switch, surface the error and
   leave the workspace exactly where it was.

## Tasks

### VCS detection

- [x] `vscode/src/vs/platform/krt/common/krtGit.ts` —
      `IKrtGitService.detectVcs(folderPath)`. Looks for
      `.jj/` (wins over `.git/` because jj-colocated
      repos have both and jj is the layer the user
      drives), then `.git/`. Renderer-side `krtVcs.ts`
      wraps it with `getWorkspacePreFlight(...)` that
      returns a discriminated union on `vcs`.
- [x] Pre-flight status:
      `IKrtGitService.getJjStatus(folderPath)` →
      `{ changeId, description }` via
      `jj log -r @ --no-graph -T 'change_id ++ "\n" ++ description.first_line()'`.
      `IKrtGitService.getGitStatus(folderPath)` →
      `{ branch, dirtyFileCount }` via `git status
      --porcelain` + `git rev-parse --abbrev-ref HEAD`.

### Confirmation dialog

- [x] `krtSwitchDialog.ts` — three message variants:
  - **jj**: starts at PR head; prior change preserved via
    "Return to Previous State" command. Severity info.
  - **git clean**: simple branch swap; current branch
    surfaced + auto-return on PR close. Severity info.
  - **git dirty**: warning chrome, stash plan, manual
    `git stash pop` reminder. Severity warning.
- [x] Two buttons: "Switch" (primary) / "Cancel".

### Resume token

- [x] `krtSwitchResume.ts` — `IKrtSwitchResumeService`
      decorator + service. Persists a single `ResumeToken`
      to `IStorageService` (application scope, key
      `krt.switchResume.v1`). Discriminated union on
      `vcs`: jj branch carries `previousChangeId` +
      `previousDescription` + `preSwitchOpId`; git branch
      carries `previousBranch` + `previousSha` + optional
      `stashRef` / `stashMessage`. v1 enforces single-
      active-switch — second-PR-switch is refused.

### Switch ops

- [x] `krtSwitchOps.ts` — `switchTo(deps, workspace, pr,
      preFlight): Promise<ResumeToken>`.
- [x] jj path: capture `preSwitchOpId` via
      `getJjOpHead`, then `git fetch origin
      +refs/pull/N/head:refs/remotes/origin/krt-pr/N`,
      then `jj git import`, then `jj new <prHead>`. Token
      records the captured op id.
- [x] git path: `gh pr checkout <n>` in the workspace
      folder (handles forks); if `dirtyFileCount > 0`,
      `git stash push --include-untracked -m "krt: PR
      #<n> @ <iso>"` first and capture the stash ref.
- [x] All shell calls run via the main process —
      `IKrtGitService` extended with `jjNew`, `jjEdit`,
      `jjOpRestore`, `jjGitImport`, `getJjOpHead`,
      `gitStashPush`, `gitCheckout`,
      `gitFetchPullRequest`. `IGhClient.prCheckout` for
      gh side. Renderer never imports `child_process`.

### Workbench refresh

- [x] After switch and after return, call
      `IFileService.resolve(workspaceUri)` to nudge the
      explorer + decoration refresh ahead of the OS
      watcher's debounce. Watcher still picks up
      everything else.
- [x] `KrtSwitchStatusPillContribution` — left-aligned
      `$(git-pull-request) PR #<n>` entry, click runs
      `KRT: Return to Previous State`. Listens on
      `IKrtSwitchResumeService.onDidChange` and shows
      iff `getActive()` is non-null.

### Close-PR cleanup

- [x] `KrtSwitchCleanupContribution` — listens on
      `IEditorService.onDidCloseEditor`, filters to
      `EditorCloseContext.UNKNOWN` so REPLACE / MOVE /
      UNPIN don't trigger. When the closed input is a
      `KrtPullRequestEditorInput` matching the active
      resume token, prompts via `IDialogService.confirm`
      with "Return" / "Stay on PR Head" buttons and a
      VCS-aware detail line.
- [x] Return path: `jj op restore <preSwitchOpId>` for
      jj, `git checkout <previousBranch>` for git. If a
      stash was captured, follow-up notification points
      the user at the stash ref + reminds them to
      `git stash pop` (auto-pop deliberately deferred —
      see "Decisions" below).

### Failure modes + rollback

- [x] Every shell call wraps a try/catch via `KrtError`.
      On failure mid-switch:
      - Stash (if created) is left in place; warning log
        names the ref + the manual `git stash pop`
        recovery path. Auto-pop on failure was rejected
        because it would mask the underlying error.
      - `IDialogService` error notification with
        `KrtError.message` + `KrtError.hint`.
      - Resume token NOT written, PR tab stays where it
        was.
- [x] `gh pr checkout` unauthenticated → bubbles up as
      `gh-auth-expired` `KrtError`, surfaced via the
      Phase 3 onboarding hint.
- [x] `KRT: Forget Active PR Switch` escape hatch —
      clears the resume token without flipping the
      working copy. Used to recover from stuck legacy-
      shape tokens or operations the new code can't
      reverse cleanly.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean.
- [x] `bash scripts/code.sh` launches.
- [x] **jj happy path**: switch dialog → confirm →
      `jj new` runs after `git fetch` + `jj git import`
      brings PR head into jj's view. Status pill renders
      `PR #<n>`. Pane reflects PR head content; LSP
      activates. Click pill → `jj op restore` rewinds to
      pre-switch op id; pill disappears.
- [ ] **git clean happy path** — not exercised
      end-to-end yet (the verification workspace is
      jj-managed). Code path covered by type checks +
      `gh pr checkout` reuse from existing PR-fetch flow.
- [ ] **git dirty path** — same as above.
- [x] **Cancel paths**: Cancel in the confirmation
      dialog leaves working tree untouched (no shell
      calls run; no token written). Verified mid-batch.
- [x] **Failure path**: hit empirically — first
      `jj new <sha>` failed with "Revision doesn't exist"
      because the SHA wasn't fetched; error surfaced as
      `KrtError(jj-invocation)` notification, working
      tree unchanged, no token written.
- [x] Tag `phase-08-7-complete`.

## Decisions to capture during execution

- **Capture `preSwitchOpId` before `jj new`, restore via
  `jj op restore`.** Initial design captured the
  *post*-switch op id and used `jj op undo` (which
  inverts a single op without losing later work).
  jj 0.40 doesn't ship `op undo`; the closest equivalent
  is `jj op restore <op>`, which rewinds the entire
  state to that op. Restore needs the *target* op id —
  the one before our switch — so we capture op head
  first, then run `jj new`. Tradeoff: any post-switch
  ops (commits the user made while reviewing) are lost
  on return. v1's contract is "review and return without
  modifying," so this is acceptable for now.
- **PR head fetch needs a persistent ref.** A bare
  `git fetch origin pull/N/head` only updates
  `FETCH_HEAD`; jj's index ignores `FETCH_HEAD` and
  `jj git import` finds nothing new, so `jj new <sha>`
  fails with "Revision doesn't exist" even when the
  commit is in the git object store. Fix: refspec form
  `+refs/pull/N/head:refs/remotes/origin/krt-pr/N`,
  which jj's import does sync. The leading `+` allows
  re-fetching a force-pushed PR over an existing ref.
  Namespace `krt-pr/<n>` keeps these refs out of the
  user's normal branch list.
- **Auto-abandonment is jj's killer subtlety.** When a
  user is on an empty + un-described change (the common
  default in jj's "always have a working change at @"
  model) and we run `jj new <prHead>`, the prior change
  gets abandoned automatically. `jj edit
  <previousChangeId>` then fails with "Revision doesn't
  exist." The op-id capture + restore approach above
  sidesteps this; the legacy `jj edit` path is kept
  only for already-persisted tokens.
- **Manual `git stash pop`, no auto-pop.** Deferred to
  user action because auto-popping after a failed
  checkout would mask the original error and at success
  time would surprise users mid-review with merge
  conflicts. The cleanup notification names the stash
  ref so users can find it; that's enough.
- **Single-active-switch v1.** `IKrtSwitchResumeService`
  stores at most one token. Switching to a second PR
  while a switch is active surfaces a typed message
  pointing at "Return to Previous State" rather than
  juggling multiple pre-states. Mirrors the existing
  refusal pattern Phase 8.6 used for cross-workspace
  PRs.
- **`EditorCloseContext.UNKNOWN` is the only trigger for
  the cleanup prompt.** REPLACE / MOVE / UNPIN fire on
  preview-editor swaps and group operations the user
  doesn't perceive as "closing the PR." Filtering keeps
  the prompt aligned with the click-X / Cmd+W gesture
  the user does mean as a close.
- **`refs/krt/pr/<n>` namespace for fetched PR heads.**
  Considered using `refs/remotes/origin/pr/<n>` (no
  prefix) but that overlaps with anything else under
  origin/pr; the `krt-pr/` prefix isolates KRT's view.
  The refs are remote-tracking, so `jj git import`
  treats them as branches on `origin` — fine.

## Post-MVP polish

- _(none captured during this pass — the immediate gaps
  are the deferred-to-later list below.)_

## Open questions

- **Stash naming resolved**: settled on `krt: PR #${n} @
  ${iso}` — the ISO timestamp disambiguates a series of
  stashed PRs cleanly without forcing the user to read
  the diff.
- **Multiple PR tabs resolved**: refusing with a clear
  message + pointer to "Return to Previous State."
- **Detached HEAD vs named branch** for git: `gh pr
  checkout` creates a named local branch; this clutters
  the user's branch list over time. Could detach-HEAD
  by default, with an option to make it a branch.
  Revisit if branch-list pollution becomes a complaint.
- **Workbench folder ≠ workspace** still leaves LSP
  inactive (Phase 8.6 limitation). Phase 8.7 didn't
  close this — auto-switching the workbench folder is
  Phase 9 territory. Switch + Return work but the user
  still has to launch KRT in the workspace folder for
  rust-analyzer / gopls / pyright to attach.

## Deferred to later phases

- **Auto-pop stash on PR close** — too surprising. v1
  leaves it manual.
- **Cross-workspace PRs** — if a user opens a PR for a
  repo they don't have a workspace for, fall back to the
  Phase 8.6 read-only diff (no switch offered).
- **Worktree-based switch** — instead of mutating the
  primary working tree, KRT could `git worktree add` a
  temporary worktree for each PR. Avoids the stash
  altogether but adds disk-space + cleanup complexity.
  Revisit if users hate the stash flow.

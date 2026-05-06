# Phase 8.6 — Workspace registry + LSP via real file URIs

Goal: KRT knows about a list of local repository workspaces.
PR search filters to those repos. When viewing a PR whose
repo matches one of the registered workspaces, base + head
text models are served from the local clone — head from the
real `file://${workspace}/${path}` URI (so language
extensions activate against it), base from a synthetic
`krt-git://` URI populated by `git show ${baseSha}:${path}`.

This unlocks the LSP demo from PLAN.md Phase 8.5 (rust-
analyzer / gopls / pyright hover + go-to-definition inside
the diff) without touching the user's working tree — Phase
8.7 layers in the destructive-but-warned auto-switch flow.

Reference: PLAN.md §4 Phase 8.6. PLAN.md is the source of
truth; this file is the working checklist.

## Working order

Smallest reversible piece first.

1. **Registry storage** — `krtWorkspaceRegistry.ts`. Read /
   write `Workspace[]` to `IStorageService` (application
   scope). Each `Workspace` is
   `{ folderUri, owner, repo, remoteUrl, addedAt }`.
   Emits `onDidChange` so search overlay + settings panel
   can live-update.
2. **Add / remove commands** — `KRT: Add Workspace…` opens
   an `IFileDialogService` folder picker, runs
   `git -C <path> remote get-url origin` (via main process
   for shell access), parses to `{ owner, repo }`, persists.
   `KRT: Remove Workspace…` lists registered workspaces in
   a quick pick.
3. **Search filter** — extend `IPullRequestProvider.search`
   to take `repos: { owner, repo }[]`. When non-empty, the
   GraphQL query gets `repo:o/n` filters joined with the
   user's text query. Search overlay reads the registry on
   open and passes the list down.
4. **Empty-state CTAs** — when the registry is empty, the
   Search overlay shows "No workspaces yet — add one to
   start finding PRs." with a button that runs the Add
   command.
5. **`krt-git://` URI scheme** — register an
   `ITextModelContentProvider` that resolves
   `krt-git://${workspaceId}/${baseSha}/${path}` by shelling
   out to `git -C ${workspace.folderUri} show ${baseSha}:${path}`.
   Caches results per `(workspaceId, baseSha, path)` in a
   small LRU so repeated lookups (e.g. switching sub-modes)
   are free.
6. **`KrtMonacoDiffView` URI strategy** — accept an
   optional `Workspace`. Branch:
   - **with workspace**: head URI =
     `URI.file(${workspace.folderUri}/${path})`; base URI =
     `krt-git://${workspaceId}/${baseSha}/${path}`. Models
     are *resolved* via `ITextModelService.createModelReference`
     (so language detection + extension activation runs the
     normal workbench path) rather than hand-built via
     `IModelService.createModel`.
   - **without workspace**: current behaviour
     (`krt-pr-base://` + `krt-pr-head://` virtual URIs from
     patch reconstruction).
7. **Workspace resolution** — `krtWorkspaceResolver.ts`:
   `resolveWorkspaceForPr(registry, pr): Workspace | undefined`.
   Match on `(owner, repo)`.
8. **Wire through Diff sub-mode + Tour mini-diffs +
   Storyboard** — pass the resolved workspace into
   `KrtMonacoDiffView`. When undefined, the Phase 8.5
   virtual-URI fallback is unchanged.
9. **Settings panel** — under Settings → KRT →
   Workspaces, list current entries with remove buttons +
   "Add Workspace…" button. Same commands underneath.
10. **Demo gate** — see below.

## Tasks

### Registry storage

- [ ] `vscode/src/vs/workbench/contrib/krt/browser/workspace/krtWorkspaceRegistry.ts`
      — `IKrtWorkspaceRegistry` decorator + `KrtWorkspaceRegistry`
      service. Methods: `getAll()`, `add(folderUri)`,
      `remove(folderUri)`, `findByOwnerRepo(owner, repo)`,
      `onDidChange`.
- [ ] Persist to `IStorageService` under
      `krt.workspaces.v1`. Versioned envelope so future
      shape changes don't false-hit cached entries.

### Add / remove commands

- [ ] `vscode/src/vs/workbench/contrib/krt/electron-browser/krtWorkspaceCommands.contribution.ts`
      — `krt.workspace.add`, `krt.workspace.remove`. Uses
      `IFileDialogService.showOpenDialog` for picking,
      shells out to `git remote get-url origin` via a new
      main-process IPC method on `IPullRequestProvider`
      (or a small parallel `IGitMainService`).
- [ ] Parse `git@github.com:o/n.git` and
      `https://github.com/o/n.git` URLs into `{ owner, repo }`.

### Search filter

- [ ] `vscode/src/vs/platform/krt/common/krt.ts` — add
      `repos?: readonly { owner: string; repo: string }[]`
      to the `search` arg type.
- [ ] `vscode/src/vs/platform/krt/electron-main/pullRequestProviderMainService.ts`
      — when `repos.length > 0`, prepend
      `repo:o/n OR repo:o/n …` to the GraphQL search query.
- [ ] `vscode/src/vs/workbench/contrib/krt/browser/search/krtSearchOverlay.ts`
      — read registry on open, pass `repos` into search
      calls. Live-update on `registry.onDidChange`.

### Empty state

- [ ] Search overlay: when registry is empty, render a
      "No workspaces yet" empty state with an "Add a
      workspace" button that invokes `krt.workspace.add`.

### `krt-git://` content provider

- [ ] `vscode/src/vs/workbench/contrib/krt/browser/workspace/krtGitContentProvider.ts`
      — registers under scheme `krt-git`. `provideTextContent`
      shells out to `git show` (via main process), returns
      a text model.
- [ ] LRU cache keyed by `${workspaceId}|${baseSha}|${path}`
      with a small bound (~256 entries) so a busy reviewer
      doesn't re-shell for every sub-mode switch.

### `KrtMonacoDiffView` URI strategy

- [ ] Accept optional `workspace: Workspace | undefined` in
      the constructor. Branch URI construction + model
      acquisition on it.
- [ ] When `workspace` is set, resolve via
      `ITextModelService.createModelReference` so the model
      goes through the normal workbench path (language
      detection, extension activation hooks).
- [ ] Manage the `IReference<IResolvedTextEditorModel>`
      lifetime: `_register(reference)` to release on
      dispose.

### Diff sub-mode integration

- [ ] `renderDiffFileSection` resolves the workspace from
      registry given the PR's `(owner, repo)` and threads
      it into the `KrtMonacoDiffView` constructor.
- [ ] `renderTourMiniDiffs` same.
- [ ] Storyboard's `renderStoryboardDiffPanel` same
      (inherits via `renderDiffFileSection`).

### Settings panel

- [~] Workspaces section under Settings → KRT —
      **deferred to a later phase**. Originally pointed at
      a Tweaks panel (old Phase 10), but Phase 10 has been
      retargeted to review mode + comment fidelity and the
      Tweaks panel idea was dropped (its accent + density
      bits became Phase 9 defaults). Discoverability today:
      Command Palette `KRT: Add Workspace…` / `KRT: Remove
      Workspace…`, plus the "Add a workspace" CTA in the
      empty PR Search overlay. A KRT settings UI lands
      with the polish pass in Phase 12 if not sooner.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean.
- [x] `bash scripts/code.sh` launches.
- [x] `KRT: Add Workspace…` adds a real Cargo repo.
- [x] Search shows PRs scoped to that repo only.
- [x] Open a PR whose head is currently in the workspace.
      Diff view shows Monaco with rust-analyzer hover +
      go-to-definition working on the head side.
- [x] When the PR's head SHA isn't in the local clone,
      see the workspace-mismatch info log and graceful
      fallback to `krt-git://` URIs (correct content; LSP
      activates only when the working tree is on the PR
      head SHA).
- [x] Tag `phase-08-6-complete`.

## Decisions made during execution

- **Per-side independent model resolution**. Initial
  implementation used `Promise.all([head, base])` and fell
  back to virtual URIs on any failure. In practice, base
  and head fetch independently — the working tree is
  often on PR head (file:// → LSP) while the base SHA
  isn't fetched (krt-git fails). Restructured to resolve
  each side separately with its own fallback chain
  (working-tree file:// → krt-git:// → virtual) so
  partial successes preserve LSP on the head side.
- **Skip resolution for added/removed files**. `git show
  ${baseSha}:${path}` for an added file (or `${headSha}`
  for a removed file) always fails — the file doesn't
  exist on that side. Detect via `file.status` and skip
  to the virtual fallback without a noisy warning.
- **Passthrough content provider for virtual schemes**.
  Downstream features (hover, peek, language services)
  call `ITextModelService.createModelReference` against
  whatever URI is in an editor. Without a content provider
  for `krt-pr-base://` / `krt-pr-head://`, the resolver
  errored out with "Unable to resolve resource". Added a
  trivial passthrough provider that returns
  `modelService.getModel(uri)` so the existing-model
  lookup satisfies the resolver contract.
- **`DiffEditorWidget` view-model leak workaround**. The
  public `setModel({original, modified})` path goes through
  `RefCounted.create(...)` and never decrements the base
  ref's initial "1", so the auto-created
  `DiffEditorViewModel` and its inner `autorunWithStore`
  never reach refcount 0 and trip the leaked-disposable
  GC tracker. Bypassed by creating the view model
  ourselves (`createViewModel(...)`) and feeding it through
  `setDiffModel(RefCounted.create(viewModel))` with the
  ref `_register`'d so our store's dispose decrements the
  last count synchronously.
- **Workbench folder still has to be the registered
  workspace** for LSP to activate. KRT doesn't auto-add
  the registered workspace to `IWorkspaceContextService`;
  rust-analyzer / gopls / etc. anchor on the workbench
  folder and won't service files outside it. v1 user
  flow: launch KRT in the same folder you registered as
  the workspace. Phase 8.7 will close this gap by
  switching the workbench's working tree to the PR head.
- **Settings panel deferred** — Command Palette commands
  cover the use cases for now (Phase 7 precedent).
  Originally targeted at an old Phase 10 Tweaks panel
  that's since been retargeted; will likely live with
  the Phase 12 polish pass.

## Phase 9 follow-ups (patches 0037, 0054)

- **Re-landed** as patch 0037 after the working tree reset.
  Workspace registry, krt-git:// content provider, workspace-
  aware Monaco diff URI strategy, KrtGitMainService extensions.
- **Workspace-scoped search re-applied** (patch 0054):
  `IPullRequestProvider.search` accepts
  `repos: { owner, repo }[]`; the overlay reads
  `IKrtWorkspaceRegistry.getAll()` on each search. Empty
  registry → "Add a workspace" CTA inline; registry change
  fires `runSearch` automatically while the overlay is open.

## Post-MVP polish

- **PR-fetch caching + refresh buttons**. Reopening a PR
  in the same session shouldn't re-shell `gh api`; added
  a session-scoped `Map<url, {pr, files?, reviewComments?,
  activity?, fetchedAt}>` with a 5-minute TTL and a
  20-entry cap to the editor pane. Lazy loaders
  (`loadDiffFiles`, `loadReviewComments`, `loadAutomation`)
  populate the cache as data arrives. Posting a comment
  invalidates the entry. Two refresh buttons: one in the
  PR editor header (drops the entry, re-runs the fetch
  flow), one in the Search overlay (re-runs the current
  query immediately).

## Open questions

- **`origin` only?** v1 consults only `origin`. Workspaces
  with non-`origin` GitHub remotes (e.g. an `upstream`
  pointing at the canonical repo) get the wrong mapping.
  Could prompt for a remote during Add when multiple exist.
- **Bare clones / sparse checkouts** — out of scope; flag
  as unsupported when detected.
- **Submodules** — KRT itself uses one. PRs that touch
  submodule pointers need special-casing later.

## Deferred to later phases

- **Auto-switch on review** — Phase 8.7. Phase 8.6 deliberately
  does NOT modify the user's working tree.
- **Editor view full read/write** — Phase 9.
- **PR-head-not-fetched hint with one-click fetch button**
  — could land in 8.6 as a polish item if the manual-fetch
  step proves annoying. Initial v1 just shows the hint.
- **Workspace health check** — detect when a workspace's
  remote URL changed or the folder was deleted on disk.
  Defer to a polish pass.

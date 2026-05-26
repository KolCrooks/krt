# Kol's Review Tool: Electron Architecture Plan

## Summary

Build a production Electron desktop app from the Claude Design prototype. The app is a high-performance PR review client focused on large PRs, huge monorepos, AI-assisted review tours, and local code intelligence.

Core decisions:

- Desktop shell: Electron, macOS-first.
- Frontend: React + TypeScript + Vite.
- Diff rendering: `@pierre/diffs`.
- Tree rendering: `@pierre/trees`.
- Data architecture: provider abstraction from day one.
- First provider: GitHub.
- Default PR mode: managed local git mirrors/worktrees.
- Secondary PR mode: light/API-only mode.
- AI Tour: real AI generation, not static mock data.
- Performance target: huge monorepos and large PRs.

## Product Goals

The real app should preserve the prototype's mental model:

- Search and open PRs quickly.
- Keep multiple PRs open as tabs.
- Switch each PR between Overview, Review, and Editor modes.
- Show human comments, bot reports, CI, labels, reviewers, and activity distinctly.
- Let reviewers inspect code by file, by AI-generated chapter, or by dependency storyboard.
- Support fast skim mode and deep local checkout mode.
- Keep UI responsive even on very large diffs and very large repos.

The app should not be a generic GitHub clone. Its differentiator is a review workspace that combines:

- Git provider data
- Local repo intelligence
- High-performance diff rendering
- Path-first tree navigation
- AI-generated review structure
- Editor/LSP context

## Stack

Use:

- Electron `42.x`
- Vite `8.x`
- React `19.x`
- TypeScript
- `@pierre/diffs@1.2.2`
- `@pierre/trees@1.0.0-beta.4`
- TanStack Query for async server/provider cache
- Zustand for UI/session state
- SQLite for local durable cache
- Zod for IPC/provider payload validation
- Playwright for UI and screenshot regression tests
- Vitest for unit/integration tests

Avoid:

- Renderer-side Node access
- Ad hoc diff rendering
- Ad hoc file-tree rendering
- Main-thread parsing/highlighting for large inputs
- Provider-specific data leaking into UI components

## Process Architecture

Use four execution layers.

### Electron Main Process

- Owns all trusted operations.
- Talks to GitHub and future providers.
- Manages credentials through macOS Keychain.
- Manages git mirrors and worktrees.
- Owns SQLite.
- Starts and stops LSP processes.
- Performs filesystem watching.
- Exposes typed IPC endpoints.

### Preload

- Exposes a narrow `window.krt` API.
- Validates request/response shapes.
- Provides no broad Node or Electron exposure.
- Groups APIs by domain: providers, repos, PRs, comments, review, worktrees, settings, and AI.

### Renderer

- Pure UI.
- Contains the React app shell, PR views, review workspace, editor, settings, and extensions.
- Uses TanStack Query for async reads.
- Uses Zustand for local UI state: active tabs, active modes, selected files, expanded nodes, panel state.

### Workers

- Diff parsing and normalization.
- Syntax highlighting through Diffs worker pool.
- Tree indexing/search preparation.
- AI chunk preparation.
- Local full-text/path search indexing.
- Expensive graph/storyboard derivation.

## App Layout

Match the prototype's design structure:

- macOS-style outer window and titlebar.
- Left rail:
  - Search
  - PR overview
  - Review
  - Editor
  - Extensions
  - Settings
- Top tab strip for open PRs.
- Per-PR mode state.
- Shared file tabs between Review and Editor.
- Compact, warm-neutral light theme by default.
- Theme tokens shared across app chrome, Diffs, and Trees.

Primary screens:

- Search
- PR Overview
- Review Diff
- AI Tour
- Storyboard
- Editor
- Settings
- Extensions/Logs

## Data Modes

Implement two PR data modes.

### Managed Worktree Mode

- Default for serious review.
- App maintains a bare mirror per repository.
- App fetches PR refs/head/base.
- App creates lightweight per-PR worktrees.
- Diffs are computed locally where possible.
- File contents are read from worktrees.
- Trees renders full workspace and changed-file trees.
- LSP can run against the checked-out PR.
- Enables offline review cache.

### Light/API Mode

- Fast preview without cloning.
- Uses provider API for PR metadata, changed files, patches, comments, checks, and file contents.
- Builds changed-file tree from provider paths.
- Renders diffs from provider patch data through Diffs.
- Disables LSP/refactors and marks editor as remote/API-backed.
- Lets user upgrade to managed checkout from a banner.

### Mode Selection

- Opening a PR starts in light/API mode if no local mirror exists.
- If a mirror exists and is fresh, open in managed mode.
- User can explicitly "Check out branch" to upgrade.
- If checkout/fetch fails, app remains usable in light/API mode.

## Provider Architecture

Define a provider abstraction used by all UI and app services.

Provider capabilities:

- `listPullRequests`
- `getPullRequest`
- `getPullRequestTimeline`
- `getReviewThreads`
- `getChecks`
- `getChangedFiles`
- `getPatch`
- `getFileContent`
- `postIssueComment`
- `replyToReviewThread`
- `resolveReviewThread`
- `reopenReviewThread`
- `submitReview`
- `getRepository`
- `getCloneInfo`
- `fetchUser`

Provider entities:

- `ProviderAccount`
- `RepositoryRef`
- `PullRequestSummary`
- `PullRequestDetail`
- `ReviewThread`
- `ReviewComment`
- `BotThread`
- `AutomationEvent`
- `CheckRun`
- `ChangedFile`
- `FilePatch`
- `ReviewSubmission`

GitHub implementation:

- Use GitHub REST/GraphQL as appropriate.
- Use GraphQL for review threads and timeline state.
- Use REST where simpler for changed files, checks, and comments.
- Normalize all GitHub entities before renderer use.
- Keep raw provider payloads in debug cache only, not UI state.

Future providers:

- GitLab and Bitbucket can implement the same interface.
- Provider-specific unsupported capabilities return typed capability errors.
- UI checks capabilities before showing actions.

## Local Git and Worktree Architecture

Storage:

- App data directory contains:
  - `repos/<provider>/<owner>/<repo>/mirror.git`
  - `worktrees/<provider>/<owner>/<repo>/<pr-id>-<head-sha>/`
  - `cache/db.sqlite`
  - `logs/`
  - `indexes/`

Repo service responsibilities:

- Clone bare mirrors.
- Fetch base/head refs.
- Create and remove worktrees.
- Detect stale mirrors.
- Compute merge-base.
- Generate changed file list.
- Generate patches.
- Read file contents at base/head.
- Watch worktree files.
- Surface checkout/fetch progress.

Git command execution:

- Runs only in main process.
- Uses non-interactive commands.
- Streams progress to renderer.
- Cancels cleanly if PR tab closes or user aborts.
- Never mutates user repositories; all managed repos live under app data.

Worktree lifecycle:

- Keep recently used PR worktrees.
- Garbage collect old worktrees by LRU and disk budget.
- Never delete active worktrees.
- Store mapping by repo + PR + head SHA.

## Diff Architecture with `@pierre/diffs`

Use Diffs as the only code/diff renderer.

Render paths:

- API mode:
  - Provider patch -> normalized patch -> `PatchDiff`.
- Managed mode:
  - Local git patch or base/head file contents -> Diffs file diff renderer.
- Editor mode:
  - Single file content -> Diffs file renderer.

Performance rules:

- Use Diffs worker pool for syntax highlighting.
- Keep file content and diff metadata object references stable.
- Do not inline large strings into React state.
- Store large diff payloads in cache/services and expose lightweight handles to UI.
- Render only visible files/chunks.
- Defer syntax highlighting until plain diff is visible.
- Use file-size and line-count thresholds to disable expensive features.

Diff features:

- Inline/split layout.
- File headers with status, path, line counts.
- Changed-file tree navigation.
- Diff comments and annotations.
- AI notes anchored to file/path/line.
- Collapsed unchanged sections.
- Large file fallback with explicit "load full file" affordance.

Theming:

- Build a Diffs theme from app CSS tokens.
- Match prototype colors:
  - warm neutral background
  - restrained indigo accent
  - green additions
  - red deletions
  - amber warnings
  - compact typography
- Ensure Diffs Shadow DOM styling receives token updates on theme changes.

## Tree Architecture with `@pierre/trees`

Use Trees for every file/tree surface.

Tree surfaces:

- Changed files in Review mode.
- Workspace file tree in Editor mode.
- Search result path lists if tree-like.
- Optional dependency/chapter file groups.

Identity:

- Canonical path strings are the public item IDs.
- Selection, focus, expansion, search, rename/move future actions all use canonical paths.

Tree model:

- `TreeNodePath`
- `TreeItemKind`
- `GitStatus`
- `ReviewStatus`
- `AnnotationCount`
- `DiagnosticCount`
- `IsChangedInPR`
- `IsOpenInEditor`

Performance:

- Incremental tree construction.
- Virtualized rendering.
- Search index built off-thread.
- Lazy children for huge workspaces.
- Fast changed-file tree from PR file list.
- Full workspace tree only after managed checkout.

Theming:

- Map app tokens into Trees theme variables.
- Keep row height aligned with prototype compact density.
- Use status badges/annotations without layout shift.

## AI Tour Architecture

The AI Tour is a first-class feature.

Inputs:

- PR title/body.
- Changed file list.
- Diff stats.
- File paths and language hints.
- Patch excerpts.
- Existing comments/review threads.
- Bot reports.
- CI/check failures.
- Local dependency/tree signals where available.
- Optional code symbols from LSP/indexing.

Outputs:

- `ReviewTour`
- `TourChapter[]`
- `TourGraph`
- `RiskSignal[]`
- `DiffAnchor[]`

Tour chapter shape:

- `id`
- `title`
- `summary`
- `files`
- `diffAnchors`
- `changeStats`
- `riskLevel`
- `riskReasons`
- `reviewChecklist`
- `dependencies`
- `generatedAt`
- `model`
- `headSha`

Generation flow:

- Build file clusters from path, language, imports, and diff metadata.
- Select bounded patch excerpts per cluster.
- Ask model to produce structured JSON.
- Validate with Zod.
- Repair or fall back to deterministic summaries if invalid.
- Persist by repo + PR + head SHA.
- Render immediately from cache when available.
- Regenerate when head SHA changes.

AI providers:

- Anthropic
- OpenAI
- Google
- Azure OpenAI
- AWS Bedrock
- Ollama/local

Credential handling:

- Store API keys in macOS Keychain.
- Store non-secret provider config in SQLite.
- Never expose secrets to renderer.
- Main process performs model requests.

Privacy:

- Settings must clearly show provider and data mode.
- Local/Ollama mode supported.
- Per-repo "AI disabled" setting.
- Redaction hooks before sending prompts.

## Storyboard Architecture

The Storyboard turns AI Tour chapters into a dependency graph.

Graph data:

- Nodes: tour chapters.
- Edges: dependency, extension, gating, verification, risk relationship.
- Node metadata: files, stats, risk, reviewed state.
- Edge metadata: relation label, confidence, source.

Rendering:

- Use custom React/SVG/canvas layout, not Diffs/Trees.
- Preserve prototype's horizontal dependency-flow design.
- Pan/scroll for large graphs.
- Keep selected node and hover preview behavior.
- Bottom diff panel uses Diffs for selected chapter anchors.

Performance:

- Graph layout runs in worker for large chapter counts.
- UI renders simplified graph for huge tours.
- Diff panel loads selected chapter diff lazily.

## Editor and LSP Architecture

Editor mode is a review-focused code viewer, not a full IDE initially.

Editor features:

- Workspace tree via Trees.
- File tabs shared with Review mode.
- Code rendering via Diffs file renderer.
- Breadcrumbs.
- PR context side panel.
- Status bar.
- Checkout/LSP state banner.
- Open-in-editor from diff/tour/storyboard.

LSP:

- Available only in managed worktree mode.
- Main process supervises language servers.
- Extensions define activation globs and command config.
- LSP features for v1:
  - diagnostics
  - hover
  - go-to-definition
  - document symbols
- Refactors/rename can appear in UI but should be disabled until write-safe editing exists.

Extension model:

- Built-in extension registry initially.
- Include rust-analyzer, TypeScript, gopls, ruff, and review tools as modeled prototype entries.
- Extension logs stream from main process.
- Extension marketplace is local/static in v1 unless a registry exists later.

## State Management

Separate state into durable domain state and ephemeral UI state.

Durable SQLite:

- Accounts
- Repositories
- PR metadata cache
- Changed files
- Review threads
- Check summaries
- AI tours
- Worktree mappings
- Settings
- Extension config
- Performance measurements

Query cache:

- Provider requests
- PR details
- Timelines
- Checks
- File contents
- Patches
- Tour status

UI state:

- Open tabs
- Active tab
- Per-tab mode
- Active file
- Open editor files
- Tree expansion
- Selected chapter
- Reviewed chapters
- Modal state
- Density/theme/accent

Large payload rule:

- Do not put full patches, huge files, or large trees directly in React component state.
- Store large payloads in service/cache and reference by IDs/keys.

## IPC Design

Expose a typed IPC API through preload.

API groups:

- `auth`
- `providers`
- `repos`
- `pullRequests`
- `reviews`
- `diffs`
- `trees`
- `ai`
- `lsp`
- `settings`
- `extensions`
- `perf`

IPC rules:

- Every method has typed input/output.
- Validate all renderer input.
- Return typed errors with user-facing messages and diagnostic codes.
- Long operations return operation IDs and stream progress events.
- Support cancellation for fetch, checkout, tour generation, and indexing.

Example operation categories:

- `pullRequests.open`
- `pullRequests.refresh`
- `repos.ensureMirror`
- `repos.checkoutPullRequest`
- `diffs.loadFilePatch`
- `trees.loadWorkspaceTree`
- `ai.generateTour`
- `reviews.submit`
- `comments.reply`
- `lsp.startForWorktree`

## Performance Strategy

Targets:

- Open PR overview quickly before all diff data loads.
- Handle 1k+ changed files.
- Handle 100k+ changed lines.
- Handle 250k+ workspace paths.
- Keep tab switching instant.
- Keep scroll smooth in Review and Editor modes.

Techniques:

- Progressive loading:
  - PR metadata first
  - changed-file summaries second
  - visible diffs on demand
  - full file contents only when opened
  - AI tour generated after enough metadata is ready
- Virtualization:
  - PR result lists
  - activity timelines
  - changed-file trees
  - workspace trees
  - diff files/chunks
  - extension logs
- Workers:
  - diff parse
  - tree index
  - search index
  - syntax highlighting
  - AI prompt chunking
- Caching:
  - provider responses by ETag/head SHA
  - patches by file/head SHA
  - parsed diff metadata
  - tree indexes
  - AI tour outputs
  - LSP initialization metadata where safe
- Backpressure:
  - limit concurrent provider requests
  - limit concurrent file loads
  - pause background work during scroll
  - prioritize active tab and visible viewport

Large-file policy:

- Mark files over threshold as large.
- Render summary first.
- Require explicit load for full diff.
- Disable syntax highlighting for extremely long lines or huge generated files.
- Allow "view raw" and "open external editor" later.

## UI Implementation Plan

Build production components corresponding to prototype modules:

- `AppShell`
- `TitleBar`
- `Rail`
- `TabStrip`
- `SearchView`
- `PullRequestOverview`
- `ActivitySection`
- `ReviewWorkspace`
- `DiffReviewMode`
- `TourMode`
- `StoryboardMode`
- `EditorWorkspace`
- `SettingsModal`
- `ExtensionsModal`
- `FinishReviewPopover`

Design system:

- Use CSS variables for all tokens.
- Start with prototype `styles.css` values.
- Convert inline prototype styles into reusable components/classes.
- Keep compact density as default.
- Implement light theme first.
- Add dark/system mode later if needed, but keep settings surface ready.

Accessibility:

- Keyboard navigation for rail, tabs, trees, comments, and review actions.
- Real buttons/menus, not div-only interactions.
- Focus rings matching design.
- ARIA labels for icon-only controls.
- Reduced motion support.

## Settings

Settings sections:

- General
- Appearance
- Editor
- AI Review
- Notifications
- Integrations
- Keybindings
- About

Important v1 settings:

- Accent color
- Density
- Data mode preference: Auto, Light/API, Managed Worktree
- Managed repo storage location
- Worktree cache size
- AI provider/model
- AI enabled per repo
- GitHub account
- Extension enable/disable
- Keybindings display

## Security

Electron:

- `contextIsolation: true`
- `nodeIntegration: false`
- strict CSP
- no remote module
- no arbitrary shell commands from renderer
- validate all IPC input
- sanitize provider markdown before rendering

Secrets:

- Store tokens/API keys in macOS Keychain.
- Main process only.
- Renderer receives configured/not-configured state, never secret values.
- Mask any diagnostic logs.

Git:

- Managed worktrees only under app data.
- No destructive commands against user repos.
- Clear confirmation before deleting cached mirrors/worktrees.
- Read-only review mode until explicit editing support exists.

Markdown:

- Render provider markdown through a sanitizer.
- No raw HTML execution.
- Link handling opens externally through main process.

## Testing Plan

Unit tests:

- Provider normalization.
- GitHub adapter request/response mapping.
- Mode selection.
- Diff model conversion.
- Tree model conversion.
- AI tour schema validation.
- Cache invalidation by head SHA.
- Settings persistence.
- IPC validation.

Integration tests:

- Open PR in light/API mode.
- Upgrade PR to managed worktree mode.
- Refresh PR after new head SHA.
- Render review threads and resolve/reopen.
- Submit comment/review through provider interface.
- Open file from diff into editor.
- Generate tour and display storyboard.
- LSP starts only after checkout.

Performance tests:

- Synthetic PR with 1k changed files.
- Synthetic PR with 100k changed lines.
- Workspace tree with 250k paths.
- Large generated file fallback.
- Scroll performance in Review mode.
- Search latency in huge tree.
- AI prompt prep time.

UI tests:

- Playwright screenshot tests for:
  - Search
  - PR overview
  - Activity tabs
  - Diff review
  - Tour chapters
  - Storyboard
  - Editor
  - Settings
  - Extensions
- Compare layout against prototype structure and visual tokens.

Manual acceptance:

- App opens to a usable PR search.
- A PR can be reviewed without checkout.
- Checkout upgrades the same PR into local/LSP mode.
- UI remains responsive while fetching/parsing/generating.
- Finish review supports comment/request changes/approve.
- Huge PRs degrade gracefully instead of freezing.

## Milestones

### Milestone 1: Foundation

- Electron/Vite/React/TypeScript app scaffold.
- Secure preload IPC.
- App shell matching prototype.
- CSS token system.
- SQLite setup.
- Basic settings persistence.

### Milestone 2: Provider and PR Overview

- GitHub auth.
- Provider abstraction.
- PR search/list/open.
- PR overview page.
- Timeline/comments/checks/reviewers.
- Light/API mode changed-file loading.

### Milestone 3: Diffs and Trees

- Diffs integration.
- Trees integration for changed files.
- Review diff mode with inline/split support.
- Lazy diff loading.
- Large file fallback.
- Performance instrumentation.

### Milestone 4: Managed Worktrees

- Bare mirror management.
- PR fetch/checkout.
- Local diff/file loading.
- Workspace tree.
- File tabs shared across Review/Editor.
- Checkout progress and failure fallback.

### Milestone 5: AI Tour and Storyboard

- AI provider settings and keychain storage.
- Tour generation pipeline.
- Tour chapter UI.
- Storyboard graph UI.
- Diff anchors and selected chapter diff panel.
- Tour cache by head SHA.

### Milestone 6: Editor and Extensions

- Editor code viewer.
- LSP process supervision.
- Extension registry/logs.
- Diagnostics/hover/symbol basics.
- Extension settings surfaces.

### Milestone 7: Hardening and Packaging

- macOS menu, signing/notarization plan.
- Auto-update architecture.
- Performance test suite.
- Screenshot regression suite.
- Error handling and diagnostics.
- Cache cleanup policies.

## Acceptance Criteria

The architecture is successful when:

- The app visually matches the prototype's structure and design language.
- Real PR data loads through provider abstraction.
- GitHub works as the first provider.
- Users can review PRs in API-only mode.
- Users can upgrade a PR to managed checkout mode.
- Diffs and Trees are used for code/diff/tree surfaces.
- AI Tour generates real structured chapters from PR data.
- Large PRs remain responsive.
- Huge repo trees remain searchable/navigable.
- Renderer never performs trusted git/provider/secret operations directly.
- All major flows are covered by automated tests.

## Assumptions and Defaults

- macOS-first distribution.
- GitHub provider first.
- Managed Worktrees default when available.
- Light/API mode always available.
- Real AI Tour in v1.
- React renderer with Electron main/preload split.
- SQLite for local cache.
- Keychain for secrets.
- No code editing/write operations in initial v1 beyond review comments and review submission.
- Prototype visual design is authoritative, but prototype code structure is not.

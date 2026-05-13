# KRT — Implementation Plan

A desktop code-review app, shipped as a VSCodium fork. This document captures the
shape of the work: what we're building, why VSCodium is a viable foundation,
how the design maps onto VSCode's architecture, and a phased roadmap to a
shippable v1.

---

## 1. What we're building

A focused desktop app for reviewing pull requests, distinct from a generic IDE.
The design (`Kol's Review Tool` bundle from Claude Design) describes four primary
modes, all reachable from a left icon rail, with PRs stacked in a tab bar across
the top:

1. **Search** — type-ahead PR search across repos, with scope filters
   ("All open" / "You've reviewed" / "Awaiting your review") and a recent-repos
   grid. Opened from the rail as a transient overlay (no tab slot).
2. **PR view** — description (markdown), threaded comments, reviewers, checks
   (clickable rows that link to CI runs), labels, stats, and a dual-tab Activity
   feed (Discussion / Automation).
3. **Review** — three top-level sub-modes selected from a segmented control:
   - **Diff** — single scrollable surface, all files stacked, with a folder-tree
     file list that scroll-syncs an "active file" highlight.
   - **Tour** — AI-generated chapters (rail of chunks + focused diff per chapter,
     with a Reading-mode prose variant available via Tweaks).
   - **Storyboard** — chapters laid out as a flow chart with typed, color-coded
     edges (`depends on` / `extends` / `gated by` / `verified by`). Hover to
     spotlight connections; right-side detail rail.
4. **Editor** — a regular code editor (file tree, tabs, syntax highlighting,
   status bar, AI context panel).

Other visual specifics worth holding onto from the design:

- macOS-style traffic-light titlebar with repo/branch badge in the center.
- Light/document theme. Inter (UI) + Inter Display (titles) + JetBrains Mono
  (code). Deep-indigo accent (`oklch(0.5 0.18 280)`) with optional Ember/Pine/
  Graphite alternates exposed in a "Tweaks" panel.
- Compact density by default; regular density toggleable.
- Sensitive-chapter caution badges, reviewed checkmarks per chapter, "via Tour"
  comment provenance.

Out of scope for v1: writing/authoring code in production workflows, debugger
integration, terminal, multi-window. The Editor mode is a viewer + light-edit
surface, not a full-IDE replacement.

---

## 2. Why VSCodium (and what a "fork" actually means)

VSCodium itself is not a fork — it is a build pipeline that pulls
`microsoft/vscode` (MIT-licensed core) and rebuilds it with a custom
`product.json`, the Microsoft-only bits stripped (telemetry, gallery,
proprietary marketplace), and a community-friendly extension registry
(open-vsx.org) wired in.

Two interpretations of "fork VSCodium":

- **Branding reskin** — clone VSCodium's build scripts, swap our `product.json`
  + icon + URLs + a small patch set, ship a binary. Easy. But we still have
  VSCode's workbench, command palette, activity bar, etc., which doesn't match
  the design.
- **True source fork** — fork `microsoft/vscode`, replace/repurpose the
  workbench shell, keep using VSCodium's build/release tooling for the Linux/
  macOS/Windows binary pipeline.

KRT needs the second. The design's left rail, tab strip, titlebar, and PR-
centric views are not extensions on top of VSCode — they replace its primary
shell. We need source-level changes to:

- Activity bar → our 4-mode left rail (Search/PR/Review/Editor)
- Side bar → context-sensitive panel (file tree in diff, chapter rail in tour, etc.)
- Editor groups → keep, but the "tab" concept is a *PR* tab containing a view mode
- Title bar → custom traffic-lights + repo/branch badge

We keep the Monaco editor, the file system abstractions, the extension host (so
language servers and syntax highlighting work in the Editor mode), and the
build/packaging infrastructure. We replace the workbench's outer chrome and
add a `vs/workbench/contrib/krt/` tree for all the new views.

### Repo layout for the fork

```
krt/                                     # this repo (you are here)
├── PLAN.md                              # this file
├── vscode/                              # vendored fork of microsoft/vscode
│   └── src/vs/workbench/contrib/krt/    # all KRT-specific UI code
├── build/                               # build scripts
│   ├── build.sh                         # one-shot npm install + compile
│   └── clean.sh                         # wipe vscode/ build artifacts
├── design/                              # checked-in copy of the design bundle
│   └── kol-s-review-tool/               # from the Claude Design handoff
└── docs/                                # ADRs, contributor guide, release notes
    ├── upstream-vscode.md               # fork base + upstream-bump workflow
    └── phases/                          # one working checklist per phase, written when the phase starts
```

This keeps KRT-specific code visible at the top level. `vscode/` is vendored
source — no submodule, no patches. Originally (Phase 0) we ran a clone-and-patch
setup; on 2026-05-13 the patch series was collapsed into the committed source
and the nested `.git` was dropped. See `docs/upstream-vscode.md` for the
upstream-bump workflow.

### Licensing reality check

- `microsoft/vscode` source is MIT-licensed — we can fork.
- Microsoft's *binary* VS Code includes a non-OSS license and proprietary
  components (gallery, remote dev, C/C++ debugger). We must strip those (as
  VSCodium does) and not ship the Microsoft-branded marketplace.
- KRT will use open-vsx.org if we expose extensions at all. For v1 we may not
  need a marketplace — extensions can be a v2 concern.
- We need our own application name, URL protocol (`krt://`), bundle identifier
  (`com.krt.app`), and icon set. No use of "Visual Studio" / "VSCode" branding.

---

## 3. Architecture: mapping the design onto VSCode primitives

| Design element              | VSCode primitive                                 | Notes |
| --------------------------- | ------------------------------------------------ | ----- |
| macOS title bar             | `workbench/browser/parts/titlebar`               | Fork or replace; suppress menu bar in custom layout. |
| Left icon rail (4 modes)    | `workbench/browser/parts/activitybar` (replaced) | New `KrtRailPart`; 4 fixed buttons + settings. |
| PR tab strip                | `editor/group/tabsTitleControl` (themed)         | Tabs become PR tabs; the "editor" inside is a PR-mode view. |
| Search overlay              | New `Workbench` overlay component                | Modeled on the Quick Open pattern, full-screen modal. |
| PR view (description + …)   | New webview-style React surface (custom editor input) | Lives as a custom `EditorInput` so it slots into editor groups. |
| Review view                 | Same — custom `EditorInput` with internal mode state | Diff view can reuse Monaco's diff editor under the hood. |
| Editor view                 | Stock `CodeEditorWidget`                         | This is where VSCode shines; minimal customization. |
| Tweaks panel                | New `WorkbenchContribution`                      | Persists to `IPreferencesService`. |
| Theme tokens (`--accent`…)  | Theme color contributions + CSS variables        | Map design tokens to VSCode's theming system. |
| Settings (incl. Extensions) | Stock `workbench/contrib/preferences` + `extensions` | Reachable from the gear at the bottom of the rail; not in the primary 4. |

**Key insight**: the design's "open PR" concept maps cleanly onto VSCode's
`EditorInput` model. Each open PR is one editor input that internally has a
"view mode" (PR / Review / Editor). The left rail switches the view mode of the
active PR's input; the tab bar lists all open PR inputs. This keeps editor
group lifecycle, tab stacking, and split views working for free.

### Extension host: keep it whole

VSCode's extension host stays fully functional. This is non-negotiable because
language support — syntax highlighting beyond TextMate grammars, IntelliSense,
hover docs, go-to-definition, diagnostics, formatters, refactoring — is
implemented as **extensions** (mostly LSP-backed). Stripping them would reduce
the Editor view to a glorified text viewer and degrade the Diff view's
in-context understanding.

Concretely:

- **Built-in extensions** ship with the upstream `vscode/extensions/` tree and
  get bundled into our build automatically: `typescript-language-features`,
  `json-language-features`, `html-language-features`, `css-language-features`,
  `markdown-language-features`, `git`, plus all TextMate grammars. We keep
  every one of these.
- **Third-party extensions** (rust-analyzer, gopls, clangd, pylance/pyright,
  ESLint, Prettier, etc.) are installed by the user from **open-vsx.org**.
  VSCodium's build scripts already swap the gallery URL; we inherit that.
- **Surfacing**: the Settings gear at the bottom of the left rail opens the
  standard Settings UI, where Extensions is one tab. We don't redesign that
  surface for v1 — it's a known, well-tested VSCode UI and our users benefit
  from familiarity.
- **Language recommendations**: keep upstream's "you opened a `.rs` file —
  install rust-analyzer?" prompt. It points at open-vsx now.

### Data layer

- **GitHub access via the `gh` CLI**: every API call shells out to
  `gh api ...` (or `gh api graphql -F ...` for richer queries). This means we
  inherit whatever auth the user already has configured (PAT, OAuth, enterprise
  host) without writing any auth UI. We detect missing/outdated `gh` on launch
  and surface an install hint. No keychain, no OAuth flow, no token refresh —
  `gh` handles all of it.
- **PR provider abstraction**: thin TypeScript interface so all `gh` calls are
  funnelled through one module. Future providers can land later; v1 is
  GitHub-only.
- **AI Tour generation, BYOK**: user pastes an Anthropic API key in Settings →
  KRT → AI; we store it in the OS keychain (`KeytarCredentialsService`) and
  call `https://api.anthropic.com/v1/messages` directly from the desktop. No
  KRT-operated backend. Prompt caching is on by default. When no key is
  configured, Tour and Storyboard show a clear "configure your Anthropic key"
  CTA instead of failing silently. Default model: Sonnet 4.6; opt-in to Opus
  4.7 for big PRs via Settings.
- **Local storage**: Reviewed-chapter state, recent PRs, generated Tour
  chapters (cached by PR head SHA so we don't re-bill on revisit), tweaks
  preferences — all via `IStorageService`.
- **No telemetry** — no analytics, crash reports, or usage pings. Strip every
  upstream telemetry hook in Phase 1 and add a CI check that fails on
  reintroduction.

### Theming

VSCode's theming language is JSON colour tokens. The design uses oklch CSS
variables. Approach:

1. Build a `KrtTheme` colour theme that emits the same hue palette.
2. Inject CSS variables (`--accent`, `--ink-*`, `--add`, `--del`, `--line`)
   from theme tokens into a root stylesheet on workbench startup.
3. KRT components consume the variables directly (matching the design's CSS
   verbatim).

### Component reuse from the design

The design hands us about 1500 lines of React (`app.jsx`, `pr-view.jsx`,
`review-view.jsx`, `search-view.jsx`, `editor-view.jsx`, `styles.css`,
`icons.jsx`, `tweaks-panel.jsx`). We won't ship that React app in production —
VSCode's workbench isn't React-based — but we will:

- Reuse the **CSS** verbatim (it's framework-agnostic, just tokens + layout).
- Reuse the **SVG icons** verbatim (move to a `media/icons/` folder).
- Translate the **layout/structure** into VSCode's preferred UI pattern
  (`Disposable` + DOM helpers + `IThemeService`). Where it's pragmatic — for
  large interactive surfaces like the Storyboard flow chart — we will host a
  webview and run a stripped React island inside it. That's a cleanly isolated
  pattern VSCode already uses (e.g. for notebook outputs).

Decision tree per surface:
- **Title bar / left rail / tab strip** → native workbench DOM (touches lots of
  workbench services; React would fight the framework).
- **Search overlay / PR view / Review (Diff sub-mode)** → native workbench DOM
  with the Monaco diff editor for diff bodies.
- **Tour Reading + Storyboard** → webview + React (heavy custom layout, no
  reason to fight VSCode's DOM model).
- **Editor** → stock Monaco.

---

## 4. Phased roadmap

A "phase" here is a milestone with a demo-able artifact. Estimates are calendar-
weeks of focused work; calibrate as we go.

### Working process: per-phase checklists

When a phase begins, the **first action** is to create a working checklist file
at `docs/phases/phase-NN-<slug>.md` (e.g. `docs/phases/phase-03-pr-data-plane.md`).
The bullets in this PLAN are the high-level shape of each phase; the checklist
file is where that shape gets broken down into granular, checkable tasks once
we actually start work.

Rules:

- Created **lazily, at the start of the phase** — not all at once up front. The
  shape of the work is clearer once the prior phase has shipped.
- Lives in the repo (committed) so future contributors can see how the work
  actually unfolded vs. what this plan anticipated.
- Loose format. Suggested sections: tasks (checkable list), open questions,
  decisions made during execution, follow-ups deferred to later phases.
- When the phase ships, the checklist stays in tree as a record. Don't delete
  it; it's the receipt for the work.

### Phase 0 — Scaffold the fork (1 week)
- Create `vscode/` submodule from `microsoft/vscode` at a known-good tag.
- Stand up VSCodium-style build scripts in `build/`. Get `yarn watch` running
  locally; verify a stock VSCode build launches.
- Add empty `src/vs/workbench/contrib/krt/` with one trivial contribution to
  prove the wiring works (a status-bar item that says "KRT").
- **Demo**: stock VSCodium build with one KRT status bar item visible.

### Phase 1 — Branding + product identity (4 days)
- `product.json`: `nameShort: "KRT"`, `nameLong: "KRT"`,
  `applicationName: "krt"`, `urlProtocol: "krt"`, bundle id, icon set.
- Point the extension gallery at **open-vsx.org** (`extensionsGallery` block
  with `serviceUrl`, `itemUrl`, `resourceUrlTemplate`); same wiring VSCodium
  uses. Verify `Extensions: Install from VSIX` and gallery search both work.
- **Smoke-test the extension host**: install rust-analyzer + ESLint + Prettier
  from open-vsx, open a `.rs` and a `.ts` file, confirm hover info,
  diagnostics, and formatters work end-to-end.
- Confirm the bundled language extensions ship correctly (TS, JSON, HTML,
  CSS, Markdown, Git, all TextMate grammars).
- Replace icons (`resources/darwin/code.icns`, `resources/win32/code.ico`,
  `resources/linux/code.png`) with KRT marks.
- Strip Microsoft-only features: **all telemetry**, the Microsoft Marketplace
  gallery URL, MS sign-in, walkthrough, "Get Started" page, Live Share. Keep
  the extension host, the Settings UI, and the bundled language extensions
  intact. Add a CI grep that fails on `applicationinsights`,
  `vscode-telemetry`, or any `https://*.microsoft.com` endpoint reaching
  production builds.
- Lock the app to **single-window**: disable `File → New Window` and the
  `workbench.action.newWindow` command; remove the multi-window code paths
  in `electron-main`.
- Verify build still launches as "KRT" with our branding.
- **Demo**: dock shows KRT icon, About dialog says KRT, no Microsoft strings,
  Cmd+Shift+N is a no-op, rust-analyzer installed from open-vsx is giving you
  hover docs in a `.rs` file.

### Phase 2 — Shell replacement (2 weeks)
- Replace the title bar with the design's traffic-lights + repo/branch badge.
- Replace the activity bar with the 4-button left rail (Search/PR/Review/Editor)
  plus a Settings gear pinned to the bottom (matches the design's
  `app.jsx` layout).
- Wire the gear to the stock Settings UI editor (`workbench.action.openSettings`
  / `workbench.action.openSettings2`); confirm the Extensions tab is reachable
  from there.
- Theme the tab bar to match (light backgrounds, accent underline on active tab,
  per-mode dot colour).
- Wire CSS-variable injection from theme tokens.
- Hide / disable: menu bar, status bar (keep minimal), command palette
  default keybinding (we'll re-bind `⌘K` to PR search).
- **Demo**: empty shell with KRT chrome, no PR data yet, tabs are placeholders,
  clicking the gear opens Settings, Extensions tab still installs from open-vsx.

### Phase 3 — PR data plane (2 weeks)
- Detect `gh` on launch; if missing or unauthenticated, show a one-time
  onboarding screen with copy-pasteable install + `gh auth login` commands.
- `GhClient`: a thin wrapper that spawns `gh api ...` / `gh api graphql ...`
  and parses JSON. Handles error surfaces (rate limit, auth expired). All
  GitHub access funnels through this one module.
- `IPullRequestProvider` interface backed by `GhClient`. Define core types
  (`PullRequest`, `PullRequestFile`, `Comment`, `Reviewer`, `CheckRun`,
  `AutomationEvent`) once; share between renderer and main.
- Persist recent PRs / open tabs to `IStorageService`.
- **Demo**: command "KRT: Open PR" prompts for a URL, shells out via `gh`,
  dumps the parsed PR object to console. No UI yet.

### Phase 4 — Search view (1 week)
- Build the Search overlay: input, scope tabs, result list, recent repos grid.
- Wire to `IPullRequestProvider.search(query, scope)`.
- Cmd+K opens; Esc closes; Enter opens selected PR as a new tab.
- **Demo**: cmd+K, type, results stream in, Enter opens a PR tab (showing a
  placeholder body for now).

### Phase 5 — PR view (1.5 weeks)
- Description rendered via VSCode's markdown renderer (already exists as
  `IMarkdownRenderer`).
- Reviewers / Checks / Labels / Stats sidebar cards.
- Activity section with Discussion / Automation tabs and the timeline UI.
- Reply box (functional: posts comment via provider).
- **Demo**: open a real GitHub PR, see the description, comments, reviewers,
  CI status, post a comment.

### Phase 6 — Review view: Diff sub-mode (1.5 weeks)
> **Final state**: rebuilt in [Phase 10 — Diff view rebuild](docs/phases/phase-10-diff-rebuild.md)
> (patches 0067-0088). The original `<div>`-stacked patch-text renderer this
> phase shipped was thrown out and replaced with one stock VS Code
> `DiffEditorWidget` per file, content-sized into a flat scrollable stack.
> File-tree, mark-reviewed, side-by-side / inline toggle survived; everything
> below the file tree is new code.

- File tree (folder-grouped, status dots, +/- counts) + Monaco diff editor for
  each file. Single scroll surface; active-file highlight scroll-syncs.
- Per-file actions: comment, mark reviewed.
- Inline comments anchored to lines (read existing PR review comments; create
  pending review threads).
- **Demo**: open a real PR, scroll through the diff, leave an inline comment.

### Phase 7 — Review view: Tour (Chapters + Reading) (2 weeks)
- Settings → KRT → AI panel: input for Anthropic API key (stored in OS
  keychain), model picker (Sonnet 4.6 default, Opus 4.7 for big PRs), toggle
  for prompt caching (on by default).
- `TourGenerator`: takes a PR, calls Anthropic Messages API directly with the
  user's BYOK, returns chapters with `{ title, summary, bullets, files, plus,
  minus, sensitive, sensitiveReason, diffFile, dependsOn[] }`. Stubbed canned
  data for early dev; live API once the panel is wired.
- Cache generated chapters by `{ prId, headSha }` in `IStorageService` so
  reopening a PR doesn't re-bill the user.
- Chapters variant: rail + focused diff per chapter, mark-reviewed checkmark,
  caution badge for sensitive chapters, "flagged by reviewer" callout.
- Reading variant: prose layout with mini-diffs. Selectable from Tweaks.
- When no API key is configured, Tour mode shows a friendly empty state with
  a "Configure your Anthropic API key" CTA → opens the Settings panel.
- Persist reviewed-chapter state per PR.
- **Demo**: paste API key in Settings, open a real PR, switch to Tour, see
  AI-generated chapters, mark some reviewed.

### Phase 8 — Review view: Storyboard (1.5 weeks)
- Webview with React island for the flow chart.
- Layout algorithm: tier-by-dependency-depth columns; orthogonal Manhattan
  edge routing with port staggering; relationship colour coding.
- Hover-to-spotlight; detail rail with connection links.
- Pull edge data from the Tour service (chapters now include `dependsOn[]`).
- **Demo**: switch any PR to Storyboard, see the chapter graph, hover to
  highlight relationships.

### Phase 8.5 — Monaco-backed diff views (1 week)
> **Final state**: superseded by [Phase 10 — Diff view rebuild](docs/phases/phase-10-diff-rebuild.md)
> (patches 0067-0088). The unified-diff-derived virtual models with blank-line
> padding (and the line-translation map they implied) were abandoned. Phase 10
> uses real `file://` content on the modified side and full-content
> `krt-git://` content on the base side, so model line == real file line on
> both sides — no padding, no translation. Monaco diff rendering, language
> detection / syntax highlighting goal preserved.

- Replace the hand-rolled `<div>`-based unified-diff renderer used by the
  Diff sub-mode and the Tour mini-diffs with embedded Monaco diff editors.
- Hosts on `IModelService` text models created from unified-diff-derived
  virtual models with blank-line padding for unknown context. Real
  base/head content (and the LSP that comes with it) lands in Phase 8.6.
- Wire language detection via VS Code's existing language detection so
  syntax highlighting "just works" for Rust/Go/TS/Python/etc.
- **Demo**: Diff / Tour Chapters / Tour Reading / Storyboard all render
  Monaco side-by-side diffs with syntax colours. Inline review-comment
  threads + composer attach as Monaco view zones.

### Phase 8.6 — Workspace registry + LSP via real file URIs (1 week)
> **Final state**: workspace registry survives unchanged. URI strategy
> evolved in [Phase 10 — Diff view rebuild](docs/phases/phase-10-diff-rebuild.md)
> (patches 0067-0088): `krt-git://` metadata moved from authority-encoded
> (which `URI.from` lowercases) to query-encoded JSON, and the
> `KrtGitContentProvider` gained a `gh` Contents API fallback for SHAs the
> local clone hasn't fetched. `git merge-base` replaced `pr.base.sha` for
> base-side resolution so target-tip movement doesn't break the diff.

- Workspace registry: an explicit list of local repository folders KRT
  is allowed to surface PRs from. Add / remove via Settings → KRT or
  the PR Search overlay. Stored in `IStorageService` (application
  scope).
- PR Search filters to those repos: GraphQL query gets `repo:o/n`
  filters per registered workspace.
- `KrtMonacoDiffView` switches URI strategy when the PR's repo matches
  a workspace: head model uses the real `file://` URI of the working
  copy, base model uses a `krt-git://` URI backed by
  `git -C <workspace> show ${baseSha}:${path}`. Models go through
  `ITextModelService.createModelReference` so language extensions
  activate the normal way.
- Empty state when no workspaces registered: "Add a workspace to start
  finding PRs" CTA.
- **Demo**: add a Cargo repo as a workspace, search shows that repo's
  PRs, open one, command-click a function name in the diff -> jump to
  its definition via rust-analyzer.

### Phase 8.7 — Auto-switch on review (jj + git, 1 week)
- When opening a PR for a registered workspace, prompt to switch the
  workspace's working copy to the PR's head commit.
  - **jj-managed workspace**: `git fetch +refs/pull/N/head:refs/remotes/origin/krt-pr/N`
    → `jj git import` → `jj new ${headSha}` (the fetch+import is
    required for forks and any PR head the local clone hasn't pulled
    yet). Non-destructive — KRT captures the pre-switch op id and
    returns via `jj op restore <opId>`, which works even when the
    previous change was empty + got auto-abandoned.
  - **plain git, clean tree**: `gh pr checkout ${n}`.
  - **plain git, dirty tree**: strong warning dialog, then
    `git stash push -m "krt: PR #${n}"` followed by checkout. KRT
    reminds the user to `git stash pop` when the PR closes (manual,
    intentionally — auto-popping is too surprising).
- Resume token persisted to `IStorageService` so even a crash mid-review
  is recoverable.
- Workbench refresh after switch so the file tree, status bar, and any
  open editors re-read.
- **Demo**: open a PR in a registered jj-colocated repo, confirm the
  switch dialog, files in the Editor view reflect the PR's head, close
  the PR tab → prompted to return → working copy back where it was.

### Phase 9 — Workbench shell + Editor view (2 weeks)
- Workbench chrome aligns with the demo:
  - Replace the stock title bar with the demo's PR header (PR number,
    title, state pill, in-app refresh + "Open on GitHub" buttons). Drop
    the temporary KRT pill from the status bar.
  - Functional left rail: Search button opens the PR Search overlay; PR
    button reveals open PR tabs; Code button switches to the standalone
    editor view. Today these buttons are no-ops.
  - Editor view (Code rail mode) gets its own tab group, independent of
    the PR view's tabs — flipping rail modes doesn't churn either.
  - Remove the Copilot side panel entirely (KRT doesn't ship it).
    Terminal becomes vertical-by-default on the right, surfaced via a
    Terminal button that takes Copilot's old slot.
  - Add the Extensions marketplace button to the rail, immediately above
    Settings.
  - Apply the demo's color theming as default (indigo accent, compact
    density). The Tweaks panel idea is dropped — these are defaults, not
    user-tunable variants.
- Editor view (mostly stock Monaco):
  - Read-only by default for files in the PR's base; editable when the
    workspace is on the feature branch (caveat: clear UX for editing-
    during-review — likely tied to Phase 10's review mode).
  - LSP via extensions repointed at open-vsx; keep upstream's "install
    the recommended extension?" prompt.
  - Verify hover / diagnostics / go-to-definition / find-references for
    Rust (rust-analyzer), Go (gopls), TypeScript (built-in), Python.
- **Demo**: rail buttons all do something useful; vertical terminal
  toggles via the Terminal button; opening a file via the Code rail
  surfaces full IntelliSense; the Tweaks panel doesn't exist.

### Phase 9.5 — Native comments API migration (~3 sessions)
> **Final state**: rebuilt from scratch in [Phase 10 — Diff view rebuild](docs/phases/phase-10-diff-rebuild.md)
> (patches 0067-0088). The 9.5 attempt at a `realLines` translation map for
> synthetic base text was abandoned along with the patch-text base. The new
> `KrtPrCommentController` (patch 0071) uses real file line numbers
> directly. The `bumpDataProvider` workaround (patch 0076) for
> `editor.contrib.review`'s `AfterFirstRender` lifecycle is the new
> canonical reference for that subtle interaction.

- Replace KRT's custom view-zone-based review-comment overlay with the
  workbench's `ICommentService` infrastructure. End state: GitHub-style
  native gutter affordances (the `+` hover icon on commentable lines),
  native comment-thread chrome (collapse, reply, resolve, reactions),
  and a draft-review state model that Phase 10 builds on directly.
- **Session A — Foundation**: register a `KrtPrCommentController`
  against `ICommentService` and surface existing review comments
  through it. Set `commentingRanges` so the native gutter shows the
  `+` affordance. Custom view zones for threads stay in place; double
  rendering is the accepted price for the intermediate.
- **Session B — Posting**: hook `createCommentThreadTemplate` and the
  thread-accept flow to post to GitHub via
  `IPullRequestProvider.postReviewComment`. Add
  `IContinueOnCommentProvider` for typed-but-not-submitted comment
  bodies.
- **Session C — Cleanup**: remove the custom view-zone overlay
  (`mountComposer` / `dismountComposer` / `attachReviewCommentZones` /
  `renderInlineComposer` and their CSS). Verify `liveReviewComments`
  flow still works with the native UI.
- Lands BEFORE Phase 10 — Phase 10's draft / submit / reply features
  should target the native thread surface, not the custom one.
- **Demo**: open a PR; native thread widgets render at the right
  lines on both sides of the diff; native gutter `+` works for
  posting; the Comments view (Activity Bar) lists every thread on
  the PR.
- Working checklist: `docs/phases/phase-09-5-native-comments.md`.

### Phase 10 — Review mode + comment fidelity (1.5 weeks)
- Replace the "Check Out" button on the PR header with a "Start Review"
  button that:
  - Runs the existing Phase 8.7 check-out flow.
  - Enters review-composition mode where inline comments accumulate as
    a draft review attached to the PR (multiple PRs can carry concurrent
    drafts).
  - Exposes Submit / Discard. Submit posts the entire draft to GitHub in
    one batch; Discard drops the draft and returns the workspace via the
    resume token.
- Mode-switching UI (PR / Diff / Tour / Storyboard) restyled to match
  the demo's segmented control. Refresh button moves to the left of the
  PR title. Add an "Open on GitHub" affordance on the PR header.
- Comment + automation fidelity (these are mostly bug-fix work, but
  share the comment-rendering surface area review mode lives on):
  - Reply-to-comment threading on review comments.
  - Per-workspace local "bot list": GitHub usernames whose comments
    route to the Automation tab instead of Discussion. Add via a small
    command + persist to `IStorageService`.
  - Markdown rendering supports inline HTML — at minimum `<details>` —
    in comments and PR descriptions.
  - User avatar pops next to authors in Discussion.
  - Checks tab: dedupe re-runs (currently shows duplicates, sometimes
    misses runs); restyle to the demo's design.
- **Demo**: open a PR, click Start Review, leave inline comments + a
  reply, submit; everything lands on GitHub at once. Add a bot user;
  their comments shift to Automation. `<details>` blocks render. Avatar
  pops next to commenters.

### Phase 11 — Diff + tour polish + AI inline chips (1 week)
- Diff view:
  - File list becomes a tree (vs flat list) with collapse-by-folder.
  - Clicking a filename opens that file in the Editor view (Phase 9
    hand-off) rather than just scrolling within the diff.
- Tour:
  - Generate a final "Coverage" chapter that walks any diff lines the
    other chapters didn't touch, ensuring full coverage.
  - Reading mode uses the full screen width (currently capped narrow,
    feels cramped on wide monitors).
- AI inline chip comments: the tour generator produces short, line-
  anchored review nudges that render as chips inside the diff editor.
  Hover-to-expand or per-chapter.
- **Demo**: open a Rust PR, browse the diff with the file tree; click a
  filename to jump into the Editor view; flip to Tour, see the Coverage
  chapter, see chip comments inside the diff guiding what to look at.

### Phase 12 — Polish + packaging for public OSS release (2 weeks)
- Window chrome polish: drop shadow, rounded corners (the "windowed" mode in
  the design).
- Keyboard shortcuts: `⌘K` (search), `⌘1/2/3/4` (rail modes), `⌘W` (close tab),
  `j/k` (next/prev chapter in Tour).
- Public-release plumbing:
  - Apple Developer ID for codesign + notarization on macOS (`.dmg` + `.zip`).
  - Windows code-signing certificate (EV preferred to dodge SmartScreen
    warmup). MSI + `.exe` installer.
  - Linux: `.deb`, `.rpm`, AppImage, `.tar.gz`. No signing required, but
    consistent SHA256 manifests.
  - Auto-update server: GitHub Releases as the artifact host;
    `electron-updater` or VSCodium-style update endpoint pointing at a static
    JSON feed.
- Public website (one page): download links per platform, screenshots,
  privacy stance ("no telemetry" stated up front), GitHub link.
- LICENSE file (MIT) + NOTICE crediting `microsoft/vscode` and VSCodium.
- README with clear "this is a community fork; not affiliated with Microsoft."
- **Demo**: download a signed installer from `github.com/<you>/krt/releases`,
  install on a clean machine, launch, use, get an in-app update prompt when
  we publish v1.0.1.

### Phase 13 — Public beta (open-ended)
- Tag a `v0.1.0-beta`, write a launch post, share with a small group, collect
  feedback in GitHub issues. Iterate. Ship v1.

Aggregate ~22-25 weeks of work for a single engineer, less with a small team.

---

## 5. Decisions

The early-architecture questions are resolved as follows:

1. **GitHub auth** — shell out to the local `gh` CLI for every API call. We
   inherit whatever auth `gh` has (PAT, OAuth, enterprise host) and write zero
   auth code ourselves. On launch, detect missing/unauthenticated `gh` and
   surface install/login instructions.
2. **Provider scope** — GitHub-only. No internal/Datadog provider. Architecture
   leaves room for future providers behind `IPullRequestProvider` but v1 ships
   with `GhProvider` only.
3. **AI hosting** — BYOK. User pastes their Anthropic API key into Settings;
   KRT calls `api.anthropic.com` directly. Key lives in the OS keychain. No
   KRT-operated backend.
4. **Window model** — single window. `File → New Window` and the multi-window
   code paths are removed in Phase 1. Every PR is a tab in the one window.
5. **Extensions are first-class in v1.** Language servers (rust-analyzer,
   gopls, pylance, clangd, etc.) are extensions in VSCode's architecture, and
   without them the Editor view would just be syntax-coloured text. We keep
   the extension host fully functional, ship all upstream built-in language
   extensions in the binary, and point the marketplace at open-vsx.org. The
   user-facing Extensions panel is reached through **Settings** (gear at the
   bottom of the rail), not the rail's four primary buttons.
6. **Telemetry** — none. Strip every upstream hook in Phase 1 and CI-check
   that nothing reintroduces analytics or crash-report endpoints.
7. **Distribution** — public OSS release. Treat trademark/license hygiene as
   a hard requirement: no Microsoft assets, no "Visual Studio" / "VSCode"
   strings in the binary, MIT LICENSE + NOTICE file crediting upstream,
   signed installers per platform, update feed on GitHub Releases.
8. **Workspace model** — KRT is a per-repo tool. Users register a list of
   local repository folders ("workspaces") and PR Search filters to those
   repos only. Diff models are backed by the local clone (real `file://`
   URI for head, `git show` for base) so language servers activate
   normally. Reviewing a PR optionally switches the workspace's working
   copy to the PR head — non-destructively via `jj new` when the
   workspace is jj-managed, or via `git stash + checkout` (behind a
   strong warning dialog) for plain git. Established in Phases 8.6 / 8.7.

---

## 6. Risks and how we'll handle them

- **Upstream churn** — `microsoft/vscode` lands ~150 commits/week. Our
  divergence (title bar / activity bar / tabs / custom editor inputs) will
  bit-rot against upstream. Mitigation: merge upstream weekly (see
  `docs/upstream-vscode.md` for the workflow), prefer additive
  contributions under `vscode/src/vs/workbench/contrib/krt/` over invasive
  edits to upstream files; keep the upstream-edit surface as small as we
  can.
- **Editor coupling** — VSCode's editor groups assume editors edit text. Our
  PR-mode editor inputs are non-text. Mitigation: model them as
  `IEditorInput` with a custom `EditorPane`, mirroring how the existing
  `Walkthrough` / `Settings UI` editors work.
- **AI cost / latency** — generating Tour chapters per PR is expensive, and
  with BYOK every dollar lands on the user's bill. Mitigation: prompt caching
  on by default, persisted results keyed by `{ prId, headSha }` so revisiting
  a PR is free, optional background generation on PR open, a visible "this
  request will use ~$X" estimate before triggering Tour on big PRs.
- **`gh` CLI dependency** — KRT can't function without `gh` installed and
  authenticated. Mitigation: detect on launch, dedicated onboarding panel
  with copy-pasteable commands per platform, link to `gh` install docs,
  retry-on-fix without restart.
- **Webview isolation overhead** — bouncing data between workbench and the
  Storyboard webview adds plumbing. Mitigation: a single `IPCRouter` we reuse
  across all KRT webviews, structured payloads, MessageChannel for streams.
- **License compliance** — easy to accidentally pull a Microsoft-trademarked
  asset or proprietary file. Mitigation: explicit allowlist of files we copy
  from upstream and a CI check that fails on any reference to "Microsoft" /
  "Visual Studio Code" / "VSCode" in our build outputs.

---

## 7. Immediate next steps

Once this plan is signed off, the first concrete actions are:

1. Initialize this repo with `jj` + GitHub remote.
2. Move the design bundle from `/tmp/krt-design/` into `design/` so it's
   version-controlled.
3. Create `docs/phases/phase-00-scaffold.md` — the first per-phase checklist
   (see "Working process" in §4).
4. Add `vscode/` as a submodule pinned to `microsoft/vscode@<latest tag>`.
5. Stand up `build/` with a stripped-down `prepare_vscode.sh` and a starter
   `product.json`.
6. Verify a stock VSCode build runs locally (sanity check before any patching).

Phase 0 (Scaffold the fork) starts there.

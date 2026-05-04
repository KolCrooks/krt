# Phase 3 — PR data plane

Goal: stand up the GitHub data layer. By the end, KRT can take a PR
URL, shell out to `gh`, parse the response, and dump a typed
`PullRequest` to the dev console. No UI surface yet — the visible
artifact is a single `KRT: Open PR` command. All future GitHub access
funnels through one module.

Reference: PLAN.md §4 Phase 3, §3 Data layer. PLAN.md is the source of
truth; this file is the working checklist.

## Working order

Smallest reversible piece first. Types → main-process spawner → IPC
glue → renderer proxy → command. No UI in this phase, so the demo gate
is "command runs, dev tools console shows parsed PR".

1. **Types + decorators** — `vs/platform/krt/common/krt.ts` defines
   `PullRequest`, `PullRequestFile`, `Comment`, `Reviewer`, `CheckRun`,
   `AutomationEvent` plus the `IGhClient` and `IPullRequestProvider`
   service decorators. Renderer-safe (no Node imports). All future
   phases consume these types.
2. **Main-process `GhClientMainService`** — detects `gh` on PATH,
   spawns `gh api ...` via `child_process.spawn`, accumulates stdout,
   parses JSON. Surfaces auth-expired (exit 4) and rate-limit (HTTP
   403 X-RateLimit-Remaining=0) as typed errors so the renderer can
   render onboarding / "wait" hints later.
3. **Main-process `PullRequestProviderMainService`** — built on
   `IGhClient`. `getPullRequest(url)` parses owner/repo/number from
   the URL, calls `gh api repos/{owner}/{repo}/pulls/{number}`, and
   maps the JSON to `PullRequest`. This is the only place where
   GitHub-shape JSON gets translated to KRT types.
4. **IPC wiring** — register two channels in `app.ts`: `krt:gh` and
   `krt:pullRequest`, both via `ProxyChannel.fromService`. Renderer
   pulls them via `IMainProcessService.getChannel(...)` and wraps
   with `ProxyChannel.toService<...>`.
5. **Renderer-side singletons** — register `IGhClient` and
   `IPullRequestProvider` as `InstantiationType.Delayed` workbench
   singletons; the implementing classes are pure proxies (NativeHost
   pattern).
6. **`KRT: Open PR` command** — `registerAction2` action that:
   - prompts via `IQuickInputService` for a PR URL
   - calls `IPullRequestProvider.getPullRequest(url)`
   - persists the URL + title to `IStorageService` under
     `krt.recentPRs` (capped at 20, JSON-encoded)
   - `console.log`s the parsed object
   - on `gh` missing/auth-expired, dumps a friendly hint to the
     console (Phase 4+ replaces this with the onboarding screen).
7. **Demo gate** — launch via `scripts/code.sh`, F1 → "KRT: Open PR",
   paste a real PR URL, see the typed object in DevTools console.

## Tasks

### Types + decorators

- [x] `vscode/src/vs/platform/krt/common/krt.ts` — types and the two
      `createDecorator` calls. Field set covers Phase 5/6 needs
      (description, comments, reviewers, checks, head/base SHAs,
      stats). Reviewers/checks/comments default to empty arrays in
      Phase 3; Phase 5 fills them in.
- [x] `vscode/src/vs/platform/krt/common/errors.ts` — single
      `KrtError` carrying `kind` discriminator + `hint`. One class
      with a kind tag was lighter than five subclasses; consumers
      branch on `kind` (works across the IPC boundary, where
      `instanceof` would not).

### Main-process `GhClientMainService`

- [x] `vscode/src/vs/platform/krt/electron-main/ghClientMainService.ts`
      — `detect()` runs `gh --version` once (cached on success);
      `apiJson(path)` spawns `gh api` and accumulates stdout. Stderr
      captured for error messages.
- [x] Three failure modes mapped to `KrtError` kinds:
      `gh-missing` (ENOENT), `gh-auth-expired` (stderr contains
      "auth login" / "not authenticated"), `gh-rate-limit` (stderr
      contains "rate limit", with optional reset-at extracted).
- [x] **Deferred**: `apiGraphql`. Phase 5 needs it for richer
      reviewer + check + thread queries; Phase 3 demo only needs the
      REST PR endpoint, so we don't speculatively design the GraphQL
      surface.

### Main-process `PullRequestProviderMainService`

- [x] `vscode/src/vs/platform/krt/electron-main/pullRequestProviderMainService.ts`
      — `getPullRequest(url)` parses with `PULL_URL_RE` and calls
      `repos/{owner}/{repo}/pulls/{number}`.
- [x] Field mapping → `PullRequest`. State derived from
      `merged`/`state`/`draft` flags. Reviewers/checks/comments
      empty in Phase 3.

### IPC wiring

- [x] Patched `vscode/src/vs/code/electron-main/app.ts` to register
      `krt:gh` and `krt:pullRequest` channels next to `process`.
      Both channels share a single `GhClientMainService` instance —
      the provider is constructed with that instance, so the
      detection cache is shared across renderer calls.

### Renderer-side singletons

- [x] `vscode/src/vs/workbench/services/krt/electron-browser/krtGhClient.ts`
      — `ProxyChannel.toService` wrapper, registered as Delayed
      singleton.
- [x] `vscode/src/vs/workbench/services/krt/electron-browser/krtPullRequestProvider.ts`
      — same pattern.
- [x] Side-effect imports landed in `workbench.desktop.main.ts`'s
      contributions block (alongside `keybindingsExport`). The KRT
      barrel `krt.contribution.ts` is `browser/`-only and can't reach
      into `electron-browser/`, so the desktop main is the right
      sink.

### `KRT: Open PR` command

- [x] `vscode/src/vs/workbench/contrib/krt/electron-browser/krtOpenPullRequest.contribution.ts`
      — `registerAction2(KrtOpenPullRequestAction)`. ID
      `krt.openPullRequest`, label "Open PR", category "KRT".
- [x] Persists recent PRs to `IStorageService` under
      `krt.recentPRs` (`APPLICATION` / `MACHINE`), capped at 20.
      Quick-pick surfaces recents ahead of an "Enter PR URL…"
      fallback. On `KrtError`, prints `kind`+`message`+`hint` to the
      console; Phase 4 replaces with the onboarding screen.

### Demo gate

- [x] `npm run compile-check-ts-native` clean.
- [x] `npm run valid-layers-check` clean.
- [x] `npm run compile` clean (1.08 min).
- [x] `bash scripts/code.sh` launches.
- [x] F1 → "KRT: Open PR" → `https://github.com/cli/cli/pull/1` →
      console emits `[KRT] Open PR → [object Object]` and
      `[krt] opened PR cli/cli#1: interactive pr list`. End-to-end
      gh detection (logged `[krt] gh detected: 2.83.2`) + IPC +
      mapping all working.
- [x] Re-running the command shows `cli/cli#1 — interactive pr list`
      as a quick-pick option ahead of "Enter PR URL…".
- [x] Tag `phase-03-complete`.

## Open questions

- [ ] Where should the `gh-missing` onboarding screen live structurally?
      A workbench contribution that conditionally opens an editor input
      on first launch is the cleanest, but Phase 3's demo only needs
      the console hint. Defer the screen to Phase 4 unless it's
      trivial.
- [ ] Should the GraphQL path land in Phase 3 or wait until Phase 5
      needs it for richer queries (reviews + reviewers + check runs in
      one round-trip)? Probably wait — REST is enough for the demo and
      we don't want to design the GraphQL surface speculatively.
- [ ] Storage scope: APPLICATION or PROFILE? PROFILE means a user with
      multiple profiles gets per-profile recent lists; APPLICATION is
      shared. PROFILE is more idiomatic for VS Code but APPLICATION
      matches the "single window, single user" KRT model. Defaulting
      to APPLICATION; revisit if it bites.

## Decisions made during execution

- **One `KrtError` class with a `kind` discriminator** rather than
  five subclasses. `ProxyChannel` ships errors across IPC by
  serialising plain props — `instanceof` doesn't survive the round
  trip — so a tagged union is the only thing that actually works.
- **Single `GhClientMainService` instance shared between channels.**
  The provider receives the same client the `krt:gh` channel exposes,
  so the `detect()` cache is hit by both renderer paths. Two
  instances would have re-spawned `gh --version` on every renderer
  ↔ provider call.
- **Phase 3 ships REST only; GraphQL deferred to Phase 5.** PLAN.md
  mentions both but the demo gate only needs `repos/.../pulls/N`.
  Designing the GraphQL surface speculatively would lock us in
  before Phase 5 reveals the real reviewer / check / thread query
  shape.
- **Renderer-side singletons live in `services/krt/electron-browser/`,
  not the contrib barrel.** The KRT barrel (`contrib/krt/browser/
  krt.contribution.ts`) cannot reach into `electron-browser/`
  without violating layer rules. Side-effect imports moved to
  `workbench.desktop.main.ts` next to the existing electron-browser
  contributions.
- **Storage scope: APPLICATION / MACHINE.** KRT is single-window
  single-user; PROFILE scope would buy nothing here. Revisit if we
  ever ship multi-profile.
- **One patch instead of three.** Phase 2 split into 4 patches
  because each touched a distinct workbench surface. Phase 3 is one
  cohesive data plane — types + main impl + renderer proxies are
  meaningless apart. Patch 0011.

## Deferred to later phases

- `gh missing/unauthenticated` onboarding screen — Phase 4 (it shares
  pixels with the Search view's empty state).
- Full reviewer / check-run / comment fetching — Phase 5 (PR view
  needs them; Phase 3 doesn't).
- GraphQL query surface — Phase 5.
- Streaming / incremental fetch (e.g. paginated review threads) —
  Phase 5+.
- Provider abstraction beyond GitHub — out of scope for v1 entirely.

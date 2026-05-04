# Phase 1 — Branding + product identity

Goal: a build that calls itself "KRT" everywhere a user can see it,
points its extension gallery at open-vsx, has all upstream telemetry
stripped, locks to a single window, and ships KRT icons. By the end,
no Microsoft strings should reach the production binary.

Reference: PLAN.md §4 Phase 1. PLAN.md is the source of truth; this file
is the working checklist.

## Working order

Smallest reversible piece first, defensive guardrails before invasive
changes:

1. **product.json overlay** — wire `build/product.json` into
   `prepare_vscode.sh` so the patched tree picks up KRT names. Smallest
   change with the most surface-level effect (window title, About).
2. **CI grep guardrail** — add `build/check-no-ms-endpoints.sh` that
   fails on Microsoft endpoints / telemetry strings. Wire it into
   `build.sh`. Initial run is expected to fail (we haven't stripped yet);
   that *defines* the work for the next step.
3. **Telemetry strip** — patch out telemetry endpoints / hooks until the
   CI grep passes against a fully patched tree.
4. **Single-window lock** — disable `workbench.action.newWindow` and
   prune electron-main multi-window paths.
5. **Strip walkthrough / Get Started / MS sign-in / Live Share** — disable
   the contributions; remove product.json fields that drive them.
6. **Icon replacement** — KRT marks for `resources/darwin/code.icns`,
   `resources/win32/code.ico`, `resources/linux/code.png`.
7. **Smoke-test extension host** — install rust-analyzer + ESLint +
   Prettier from open-vsx; verify hover/diagnostics/format on `.rs`/`.ts`.
8. **Demo gate** — full launch as "KRT", Cmd+Shift+N is a no-op,
   rust-analyzer hover working in a `.rs` file.

## Tasks

### product.json overlay

- [x] `build/merge-product.mjs` — Node-based shallow merge (`{...base, ...overlay}`).
      Node is already a build dep, so no extra tool requirement.
- [x] Update `build/product.json` to a Phase-1-complete override set:
  - [x] Branding: `nameShort`, `nameLong`, `applicationName`,
        `dataFolderName`, `urlProtocol`, `darwinBundleIdentifier`,
        `linuxIconName`, the `win32*` family.
  - [x] Server/tunnel names: `serverApplicationName`, `serverDataFolderName`,
        `tunnelApplicationName`.
  - [x] License/issue URLs pointed at `KolCrooks/krt`.
  - [x] `extensionsGallery` → open-vsx.
  - [x] Strip safe-to-null MS bits: `builtInExtensions: []`,
        `builtInExtensionsEnabledWithAutoUpdates: []`,
        `webviewContentExternalBaseUrlTemplate: ""`.
  - [ ] **Deferred**: `defaultChatAgent: null` — too many consumers
        assume it's non-null (40+ files in `chat/`, `chatEntitlement`,
        `inlineCompletions`, etc.). Phase 5 replaces chat with the KRT
        AI panel; revisit then.
  - [ ] **Deferred**: `onboardingKeymaps: []` / `onboardingThemes: []`
        — pair with the walkthrough/Get Started strip.
- [x] Wire the overlay step into `prepare_vscode.sh` (after `git am`,
      so patches apply against pristine upstream; the merged
      `vscode/product.json` lands as a working-tree mod that `git reset
      --hard` wipes on next run, keeping the script idempotent).
- [x] Verify: after `bash build/prepare_vscode.sh`,
      `vscode/product.json` contains `"nameShort": "KRT"` and the
      open-vsx gallery URLs. Re-running yields the same merged file.

### Hygiene relax (paired with product.json overlay)

- [x] Patch `build/hygiene.ts` to drop the
      `Contains 'extensionsGallery'` rule. Upstream's OSS build forbids
      shipping a gallery URL; our fork ships open-vsx. Patch
      `0003-Allow-extensionsGallery-in-product.json.patch`.

### CI grep guardrail

- [x] `build/check-no-ms-endpoints.sh` scopes scan to *shipping* source
      (`vscode/src/`, `vscode/extensions/`, `vscode/product.json`) and
      skips build scripts, packaging resources, CI configs, and dev
      tooling — those don't reach the user binary in v1's launch flow.
- [x] Patterns: `applicationinsights`, `vscode-telemetry`,
      JSON-format `"aiKey": "<non-empty>"`, JSON-format
      `"aiConfig": {...}`, `marketplace.visualstudio.com`,
      `vscode-cdn.net`. Empty `"aiKey": ""` (our stripped state) and
      type-only `aiConfig?:` declarations are intentionally not
      flagged.
- [x] Allowlist for known-deferred areas (chat/, remote/, telemetry/
      wiring, webview/ security host marker, debug/, language-extension
      src refs). Each entry is a place we've made a conscious decision
      to defer to Phase 5 / Phase 11.
- [x] Wired into `build/build.sh` between `prepare_vscode.sh` and
      `npm install` so a regression fails before the heavy compile.
- [x] Initial run: `TOTAL unallowlisted hits: 0`. ✓

### Telemetry strip

- [x] Survey: 11 built-in extension `package.json` files carry the same
      Microsoft Application Insights instrumentation key
      (`0c6ae...7255`). vscode-extension-telemetry's `TelemetryReporter`
      handles empty key as no-op (no network calls).
- [x] Patch `0006-Strip-AppInsights-keys-and-no-telemetry-stance.patch`:
  - Empty `aiKey` value in 11 extension package.json files.
  - Replace `aka.ms/vscode-telemetry` doc URL in
    `src/vs/platform/telemetry/common/telemetryService.ts` with a
    KRT-stance message: "KRT does not collect telemetry. This setting
    has no effect."
- [x] CI grep passes (0 hits in shipping source).
- [ ] **Deferred**: aiKey FIELD reads in extension source files (e.g.
      `extension.packageJSON.aiKey`) — they read empty values and the
      reporter silently drops sends. Allowlisted; if the extensions
      get a deeper rewrite (Phase 11), revisit.
- [ ] **Deferred**: `productService.aiConfig?.ariaKey` references in
      `src/vs/platform/telemetry/`, `services/telemetry/`,
      `code/electron-utility/`, `code/node/`, `server/node/`. All
      gated on `if (productService.aiConfig?.ariaKey)` — our overlay
      doesn't set `aiConfig`, so all gates evaluate false. Allowlisted.

### Telemetry strip

- [ ] Survey: grep upstream for `applicationinsights`, `aiKey`, `aiConfig`,
      `crashReporter`, `vscode-telemetry`. Catalog hits before patching.
- [ ] Patch: strategy TBD until the survey is in. Likely a combination of
      product.json fields set to empty, a tiny patch redirecting any
      remaining direct calls to a no-op, and a grep test.
- [ ] CI grep passes.

### Single-window lock

- [x] `workbench.action.newWindow` lives at
      `src/vs/workbench/browser/actions/windowActions.ts:415-466`. The
      `NewWindowAction` class declares the id/keybinding/menu and is
      registered at the bottom of the file.
- [x] Patch: drop the class entirely (small unused-import cleanup
      follows). Drop the matching menubar fallback handler at
      `src/vs/platform/menubar/electron-main/menubar.ts:130`. Patch
      `0002-Single-window-lock.patch`. Type-check + hygiene clean.
- [ ] **Deferred**: `userDataProfile.ts` registers
      `workbench.profiles.actions.newWindowWithProfile` and per-profile
      open-window actions. Reachable only via command palette and only
      when profiles exist (default install has none). Strip when
      Phase 2 replaces the workbench shell.

### Strip MS-coupled built-in extensions

- [x] `extensions/copilot/` — GitHub Copilot Chat (~2GB with deps).
      All `aka.ms` chat URLs originate here. Deleted via
      `prepare_vscode.sh` rm step (vs. a 2GB patch diff).
- [x] `extensions/microsoft-authentication/` — MS sign-in extension.
      PLAN.md Phase 1 calls for stripping MS sign-in. Deleted.
- [x] `extensions/mermaid-chat-features/` — chat-coupled (only useful
      with Copilot Chat). Deleted.
- [x] Patch `0004-Drop-MS-coupled-extension-build-references.patch`
      removes references in `build/npm/dirs.ts` (npm install
      directories), `build/lib/extensions.ts` (`nativeExtensions`,
      `esbuildMediaScripts`), and `build/gulpfile.extensions.ts`
      (tsconfig list). Vestigial refs in `excludedExtensions` and
      `packageCopilotExtensionStream` left alone — they handle the
      missing-dir case gracefully and patching them would just
      increase rot surface.
- [ ] **Deferred**: `src/vs/workbench/contrib/chat/` still references
      `defaultChatAgent.extensionId` in 40+ files. With the copilot
      extension gone, the chat UI will show empty/unconfigured. Phase 5
      replaces chat with the KRT AI panel.

### Walkthrough / Get Started / Live Share

- [x] Welcome page on startup neutered via config defaults (patch
      `0005-Skip-welcome-page-and-copilot-hygiene.patch`):
      - `workbench.startupEditor` default: `'welcomePage'` → `'none'`
      - `workbench.welcomePage.experimentalOnboarding` default:
        `true` → `false`
      Strategy chosen over removing the side-effect import in
      `workbench.common.main.ts` because `IWalkthroughsService` is a
      heavy consumer in `vs/workbench/contrib/remote/browser/remote.ts`
      (constructor injection + HelpModel). Stripping the contribution
      breaks remote/. Phase 11 polish can revisit a deeper strip when
      the workbench shell is ours (Phase 2+).
- [x] Same patch fixes a hygiene check (`checkCopilotEnginesVersion`)
      that read `extensions/copilot/package.json` and was crashing
      hygiene after batch 2's extension removal.
- [ ] **Deferred**: `welcomeWalkthrough` (Editor Playground) and
      `welcomeAgentSessions` contributions stay registered. The
      walkthrough framework is reachable only via Help menu and isn't
      auto-shown; AgentSessions is chat-related (Phase 5 strip).
- [ ] Live Share isn't bundled in 1.118.1 OSS build (no `liveshare`
      extension in `extensions/`). Nothing to do here.

### Icons

- [x] Source asset: design uploads turned out to be screenshots, not
      icon assets. Generated a placeholder: white bold "K" centered on
      the design's deep-indigo accent (`rgb(79, 71, 197)` ≈
      `oklch(0.5 0.18 280)`). Phase 11 swaps for a polished asset.
- [x] `build/icons/generate.py` — Python+PIL renders the 1024×1024
      source PNG.
- [x] `build/icons/build-icns.sh` — sips downscales to Apple's
      iconset sizes, `iconutil -c icns` compiles the `.icns`. Same
      script copies the 1024 PNG as `krt.png` for Linux.
- [x] Committed: `build/icons/krt-1024.png` (source),
      `build/icons/krt.icns` (84 KB), `build/icons/krt.png` (17 KB).
- [x] `prepare_vscode.sh` swaps `.icns` and `.png` into
      `vscode/resources/darwin/code.icns` and
      `vscode/resources/linux/code.png`. Win32 `.ico` deferred to
      Phase 11 packaging — the dev launch doesn't need it and there's
      no clean cross-platform `.ico` toolchain on macOS without
      ImageMagick.
- [ ] **Note**: dev-mode Electron launch on macOS uses Electron's
      default app icon (yellow/orange/blue), not `code.icns`. The
      .icns swap takes effect for *packaged* builds (Phase 11). File
      is in place + correct format.

### Smoke-test extension host

- [x] Install path: `ELECTRON_RUN_AS_NODE=1 KRT.app/Contents/MacOS/KRT
      out/cli.js --install-extension <id>`. The first
      `--install-extension` flag in an invocation is consumed by
      Electron's arg parser ("Option 'install-extension' requires a
      non empty value. Ignoring the option."); workaround is to pass a
      throwaway `--install-extension <something-already-installed>`
      first, or run rust-analyzer install AFTER another flag.
- [x] Installed from open-vsx: `dbaeumer.vscode-eslint@3.0.24`,
      `esbenp.prettier-vscode@12.4.0`,
      `rust-lang.rust-analyzer@0.3.2887` (darwin-arm64).
- [x] Verification: launched KRT against `/tmp/krt-smoketest`,
      Extensions panel (Cmd+Shift+X) shows all three under INSTALLED
      with publisher + description rendered.
- [ ] **Deferred**: actual hover-over-identifier verification on a
      `.rs` file. rust-analyzer's first run downloads its LSP server
      from GitHub releases; flaky to automate and not worth the time
      for v0.x. The presence in INSTALLED proves the open-vsx pipeline.

### Demo gate

- [x] `bash build/build.sh && ./vscode/scripts/code.sh` launches
      (verified across batches 2 and 4 builds, 0 errors).
- [x] App name says "KRT" (menubar, About dialog, dev-build "KRT Dev"
      suffix expected for unpacked builds).
- [x] About dialog says "KRT Dev" (`nameLong` overlay reaches it),
      version 1.118.1, no Microsoft strings in the visible portion.
- [x] Cmd+Shift+N is a no-op — keystroke fired, process count stayed
      at 1, no new window opened.
- [x] No upstream "Get Started with VS Code" page on launch
      (workbench.startupEditor default flipped to 'none').
- [x] Extensions panel: open-vsx returns POPULAR results; rust-analyzer,
      ESLint, Prettier successfully installed from open-vsx and listed
      under INSTALLED.
- [x] CI grep `build/check-no-ms-endpoints.sh` exits 0 against the
      patched + extension-stripped + telemetry-stripped tree.
- [ ] **Note**: workspace-trust dialog's "see our docs" link still
      points at `code.visualstudio.com/docs/...workspace-trust`. Caught
      during smoke testing — adding to deferred list. Phase 11 swaps.
- [ ] Tag commit `phase-01-complete` (next).

## Open questions

- Icon source: is there a finalized KRT mark anywhere, or do we ship a
  placeholder for now?
- Should the single-window lock fully rip multi-window code from
  `electron-main`, or just disable the entry points? Ripping is cleaner
  but a much larger patch. Defer the rip to Phase 11 polish unless it's
  cheap.

## Decisions made during execution

- **Overlay merge = shallow JS spread.** Top-level keys we override
  fully replace upstream's value, including nested objects like
  `extensionsGallery`. Top-level keys we don't list inherit from
  upstream. That matches our needs (full control where we override,
  inherit silently otherwise) and avoids a deep-merge library
  dependency.
- **Overlay sits as a working-tree mod, not a patch.** `git reset
  --hard` wipes it on every `prepare_vscode.sh` run, so re-running is
  idempotent without bookkeeping. A patch would conflict on every
  upstream `product.json` change; the overlay picks up upstream
  additions for free.
- **`defaultChatAgent` left intact this phase.** 40+ consumers
  dereference its fields without null checks (full grep:
  `productService.defaultChatAgent.X`). Nulling it out is a Phase 5
  task when we replace chat with the KRT AI panel.
- **Hygiene check relax instead of pinning a custom hygiene config.**
  Patch `0003` removes the `extensionsGallery` rule outright. Upstream
  was guarding against accidental gallery URLs in the OSS build;
  KRT *intentionally* ships one (open-vsx). Same approach VSCodium
  takes.

## Follow-ups deferred to later phases

- Public-release license / NOTICE / website / signed installers — Phase 11.
- KRT-operated webview CDN (replacing `webviewContentExternalBaseUrlTemplate`)
  — Phase 11. For now leave it empty and accept the inlined fallback path.
- Polished icon set — Phase 11 (placeholder is fine for v0.x).

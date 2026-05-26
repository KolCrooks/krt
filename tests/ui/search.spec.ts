import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const settings = {
      appearance: { accentColor: "#4f46e5", density: "compact" },
      data: { preferredMode: "auto", managedRepoStorage: null, worktreeCacheSizeGb: 20 },
      ai: { enabled: false, provider: "disabled", model: "", keyProvider: "keychain", keyCommand: "" },
      github: { configured: true, login: "octo" as string | null, tokenProvider: "keychain" },
      updates: { enabled: false, channel: "stable", feedUrl: null },
      extensions: {},
      pinnedRepos: [] as string[]
    };
    let aiKeyConfigured = false;
    const copySettings = () => ({
      appearance: { ...settings.appearance },
      data: { ...settings.data },
      ai: { ...settings.ai },
      github: { ...settings.github },
      updates: { ...settings.updates },
      extensions: { ...settings.extensions },
      pinnedRepos: [...settings.pinnedRepos]
    });

    (window as any).krt = {
      auth: {
        getStatus: async () => ({
          github: settings.github.configured && settings.github.login ? { provider: "github", id: settings.github.login, login: settings.github.login, configured: true, scopes: [] } : null,
          ai: { configured: settings.ai.keyProvider === "keychain" ? aiKeyConfigured : Boolean(settings.ai.keyCommand) || settings.ai.keyProvider === "environment" }
        }),
        saveGitHubToken: async () => {
          settings.github = { configured: true, login: "octo", tokenProvider: "keychain" };
          return { provider: "github", id: "1", login: "octo", configured: true, scopes: [] };
        },
        clearGitHubToken: async () => {
          settings.github = { configured: false, login: null, tokenProvider: "keychain" };
          return { cleared: true };
        },
        saveAiKey: async () => {
          settings.ai = { ...settings.ai, keyProvider: "keychain" };
          aiKeyConfigured = true;
          return { configured: true };
        },
        clearAiKey: async () => {
          aiKeyConfigured = false;
          return { cleared: true };
        }
      },
      settings: {
        get: async () => copySettings(),
        update: async (input: any) => {
          settings.appearance = { ...settings.appearance, ...input.appearance };
          settings.data = { ...settings.data, ...input.data };
          settings.ai = { ...settings.ai, ...input.ai };
          settings.github = { ...settings.github, ...input.github };
          settings.updates = { ...settings.updates, ...input.updates };
          settings.extensions = { ...settings.extensions, ...input.extensions };
          if (input.pinnedRepos) {
            settings.pinnedRepos = [...input.pinnedRepos];
          }
          return copySettings();
        }
      },
      updates: {
        getStatus: async () => ({
          enabled: false,
          configured: false,
          channel: "stable",
          state: "disabled",
          currentVersion: "0.1.0",
          feedUrl: null,
          message: "Updates are disabled."
        }),
        check: async () => ({
          enabled: false,
          configured: false,
          channel: "stable",
          state: "disabled",
          currentVersion: "0.1.0",
          feedUrl: null,
          message: "Updates are disabled."
        }),
        installDownloaded: async () => ({
          enabled: false,
          configured: false,
          channel: "stable",
          state: "disabled",
          currentVersion: "0.1.0",
          feedUrl: null,
          message: "Updates are disabled."
        })
      },
      cache: {
        getStats: async () => ({
          prCache: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
          providerResponses: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
          aiTours: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
          performanceMeasurements: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null }
        }),
        cleanup: async (input: any) => ({
          dryRun: input.dryRun ?? false,
          prCache: { deletedCount: 0, freedBytes: 0 },
          providerResponses: { deletedCount: 0, freedBytes: 0 },
          aiTours: { deletedCount: 0, freedBytes: 0 },
          performanceMeasurements: { deletedCount: 0, freedBytes: 0 }
        })
      },
      diagnostics: {
        getSnapshot: async () => ({
          generatedAt: "2026-05-22T00:00:00.000Z",
          appVersion: "0.1.0",
          platform: "test",
          paths: { root: "/test", cache: "/test/cache", logs: "/test/logs", indexes: "/test/indexes" },
          settings: {
            appearance: settings.appearance,
            data: settings.data,
            ai: {
              enabled: settings.ai.enabled,
              provider: settings.ai.provider,
              model: settings.ai.model,
              baseUrlConfigured: Boolean((settings.ai as any).baseUrl),
              keyProvider: settings.ai.keyProvider,
              keyCommandConfigured: Boolean(settings.ai.keyCommand)
            },
            github: settings.github,
            updates: settings.updates,
            enabledExtensionCount: 0
          },
          cache: {
            prCache: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
            providerResponses: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
            aiTours: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
            performanceMeasurements: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null }
          },
          worktrees: { count: 0, activeCount: 0, totalBytes: 0 },
          recentPerformance: [],
          operations: [],
          updates: {
            enabled: false,
            configured: false,
            channel: "stable",
            state: "disabled",
            currentVersion: "0.1.0",
            feedUrl: null,
            message: "Updates are disabled."
          }
        })
      },
      providers: {
        fetchUser: async () => ({ provider: "github", id: "1", login: "octo", configured: true, scopes: [] })
      },
      repos: {
        getCloneInfo: async () => ({ repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" }, htmlUrl: "https://github.com/kol/repo", cloneUrl: "https://github.com/kol/repo.git", sshUrl: "git@github.com:kol/repo.git", defaultBranch: "main" }),
        selectMode: async () => ({ mode: "light", reason: "test" }),
        checkoutPullRequest: async () => ({ operationId: "op", mode: "managed", worktreePath: "/tmp/worktree" }),
        releaseWorktree: async () => ({ released: true }),
        listManagedWorktrees: async () => [],
        cleanupWorktrees: async (input: any) => ({ deleted: [], retained: [], deletedCount: 0, retainedCount: 0, freedBytes: 0, dryRun: input.dryRun ?? false }),
        onWorkspaceFileChange: () => () => undefined
      },
      pullRequests: {
        search: async () => [
          {
            provider: "github",
            id: "1",
            number: 12,
            repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo", url: "https://github.com/kol/repo" },
            title: "Wire review workspace",
            state: "open",
            draft: false,
            url: "https://github.com/kol/repo/pull/12",
            author: { login: "kol" },
            labels: ["review"],
            reviewers: [],
            baseRef: "main",
            headRef: "feature",
            headSha: "abc123",
            baseSha: "def456",
            additions: 10,
            deletions: 2,
            changedFileCount: 1,
            commentCount: 0,
            updatedAt: "2026-05-22T00:00:00.000Z",
            createdAt: "2026-05-22T00:00:00.000Z"
          }
        ],
        open: async (input: any) => ({
          mode: "light",
          detail: {
            provider: "github",
            id: "1",
            number: input.number,
            repository: input.repository,
            title: "Wire review workspace",
            state: "open",
            draft: false,
            url: "https://github.com/kol/repo/pull/12",
            author: { login: "kol" },
            labels: ["review", "frontend"],
            reviewers: [{ login: "alex" }, { login: "sam" }],
            baseRef: "main",
            headRef: "feature",
            headSha: "abc123",
            baseSha: "def456",
            additions: 10,
            deletions: 2,
            changedFileCount: 1,
            commentCount: 0,
            updatedAt: "2026-05-22T00:00:00.000Z",
            createdAt: "2026-05-22T00:00:00.000Z",
            body: "Review workspace smoke fixture.",
            isFromFork: false
          },
          changedFiles: [
            {
              path: "src/App.tsx",
              status: "modified",
              additions: 10,
              deletions: 2,
              changes: 12,
              isLarge: false,
              isGenerated: false,
              reviewStatus: "unreviewed",
              annotations: 0,
              diagnostics: 0
            }
          ],
          timeline: [
            {
              id: "activity-comment",
              kind: "comment",
              actor: { login: "alex" },
              title: "Review note",
              body: "Please double-check the workspace event flow.",
              createdAt: "2026-05-22T00:10:00.000Z",
              severity: "info"
            },
            {
              id: "activity-bot",
              kind: "bot",
              actor: { login: "codecov[bot]", type: "Bot" },
              title: "Coverage report",
              body: "Patch coverage is stable.",
              createdAt: "2026-05-22T00:12:00.000Z",
              severity: "success"
            },
            {
              id: "activity-check",
              kind: "check",
              title: "typecheck completed",
              createdAt: "2026-05-22T00:14:00.000Z",
              severity: "success"
            },
            {
              id: "activity-review",
              kind: "review",
              actor: { login: "sam" },
              title: "Review requested changes",
              body: "The UI path needs one more pass.",
              createdAt: "2026-05-22T00:16:00.000Z",
              severity: "warning"
            },
            {
              id: "activity-label",
              kind: "label",
              actor: { login: "kol" },
              title: "frontend label added",
              createdAt: "2026-05-22T00:18:00.000Z",
              severity: "info"
            }
          ],
          reviewThreads: [
            {
              id: "thread",
              provider: "github",
              repository: input.repository,
              pullNumber: input.number,
              path: "src/App.tsx",
              line: 1,
              resolved: false,
              outdated: false,
              comments: [
                {
                  id: "thread-comment",
                  threadId: "thread",
                  author: { login: "alex" },
                  body: "This render path should stay API-backed until checkout finishes.",
                  path: "src/App.tsx",
                  line: 1,
                  createdAt: "2026-05-22T00:11:00.000Z",
                  isBot: false
                }
              ]
            }
          ],
          checks: [
            {
              id: "check-typecheck",
              provider: "github",
              name: "typecheck",
              status: "completed",
              conclusion: "success",
              startedAt: "2026-05-22T00:12:00.000Z",
              completedAt: "2026-05-22T00:13:00.000Z",
              summary: "TypeScript passed"
            },
            {
              id: "check-ui",
              provider: "github",
              name: "ui snapshots",
              status: "completed",
              conclusion: "failure",
              startedAt: "2026-05-22T00:12:00.000Z",
              completedAt: "2026-05-22T00:13:00.000Z",
              summary: "One snapshot changed"
            }
          ]
        }),
        startOpen: async (input: any) => {
          (window as any).__lastOpenInput = input;
          return { operationId: "open-op" };
        },
        openResult: async () =>
          (window as any).krt.pullRequests.open(
            (window as any).__lastOpenInput ?? {
              repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" },
              number: 12
            }
          ),
        refresh: async () => undefined,
        startRefresh: async () => ({ operationId: "refresh-op" }),
        refreshResult: async () =>
          (window as any).krt.pullRequests.open(
            (window as any).__lastOpenInput ?? {
              repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" },
              number: 12
            }
          ),
        changedFiles: async () => [],
        filePatch: async () => ({ provider: "github", repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" }, pullNumber: 12, path: "src/App.tsx", patch: "@@ -1,1 +1,1 @@\n-old\n+new", headSha: "abc123", isLarge: false }),
        fileContent: async () => ({ provider: "github", repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" }, path: "src/App.tsx", ref: "abc123", contents: "export const app = true;\n", encoding: "utf-8", isLarge: false }),
        timeline: async () => [],
        reviewThreads: async () => [],
        checks: async () => []
      },
      comments: {
        postIssueComment: async () => ({ id: "comment", author: { login: "kol" }, body: "ok", createdAt: "2026-05-22T00:00:00.000Z", isBot: false }),
        replyToReviewThread: async (input: any) => ({
          id: "reply",
          threadId: input.threadId,
          author: { login: "kol" },
          body: input.body,
          createdAt: "2026-05-22T00:00:00.000Z",
          isBot: false
        })
      },
      reviews: {
        resolveThread: async () => ({ id: "thread", provider: "github", repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" }, pullNumber: 12, resolved: true, outdated: false, comments: [] }),
        reopenThread: async () => ({ id: "thread", provider: "github", repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" }, pullNumber: 12, resolved: false, outdated: false, comments: [] }),
        submit: async () => ({ id: "review", provider: "github", repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" }, pullNumber: 12, event: "comment", body: "ok", submittedAt: "2026-05-22T00:00:00.000Z" })
      },
      trees: {
        loadWorkspaceTree: async () => ({ repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" }, headSha: "abc123", worktreePath: "/tmp/worktree", paths: ["src/App.tsx"] }),
        searchWorkspaceText: async (input: any) => ({
          repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" },
          headSha: "abc123",
          query: input.query,
          searchedFiles: 1,
          skippedFiles: 0,
          truncated: false,
          results: [
            {
              path: "src/App.tsx",
              matches: [{ lineNumber: 1, lineText: "export const app = true;" }]
            }
          ]
        })
      },
      lsp: {
        startForWorktree: async () => ({ id: "lsp", repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" }, headSha: "abc123", worktreePath: "/tmp/worktree", status: "degraded", activeExtensions: [], unavailableExtensions: [], capabilities: ["diagnostics", "hover", "definition", "symbols"], startedAt: "2026-05-22T00:00:00.000Z" }),
        stopForWorktree: async () => null,
        getSession: async () => null,
        getDiagnostics: async () => [],
        getHover: async () => null,
        getDocumentSymbols: async () => [],
        getDefinition: async () => null
      },
      ai: {
        getCachedTour: async () => null,
        generateTour: async () => ({
          id: "tour",
          provider: "github",
          repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" },
          pullNumber: 12,
          headSha: "abc123",
          generatedAt: "2026-05-22T00:00:00.000Z",
          model: "test",
          chapters: [
            {
              id: "chapter-1",
              title: "Workspace shell",
              summary: "Review and editor routes share the selected file state while patches load lazily.",
              files: ["src/App.tsx"],
              diffAnchors: [{ path: "src/App.tsx", side: "right" }],
              changeStats: { additions: 10, deletions: 2, files: 1 },
              riskLevel: "medium",
              riskReasons: ["Touches shared navigation state."],
              reviewChecklist: ["Open the file from tour.", "Check the API-backed diff path."],
              dependencies: [],
              generatedAt: "2026-05-22T00:00:00.000Z",
              model: "test",
              headSha: "abc123"
            },
            {
              id: "chapter-2",
              title: "Verification path",
              summary: "CI and review activity indicate where the reviewer should focus first.",
              files: ["src/App.tsx"],
              diffAnchors: [{ path: "src/App.tsx", side: "right" }],
              changeStats: { additions: 4, deletions: 1, files: 1 },
              riskLevel: "low",
              riskReasons: [],
              reviewChecklist: ["Review the failing UI snapshot.", "Confirm comments remain actionable."],
              dependencies: ["chapter-1"],
              generatedAt: "2026-05-22T00:00:00.000Z",
              model: "test",
              headSha: "abc123"
            }
          ],
          graph: {
            nodes: [
              { id: "chapter-1", label: "Workspace shell", riskLevel: "medium", files: ["src/App.tsx"] },
              { id: "chapter-2", label: "Verification path", riskLevel: "low", files: ["src/App.tsx"] }
            ],
            edges: [
              { id: "edge-1", from: "chapter-1", to: "chapter-2", relation: "verification", confidence: 0.8, source: "deterministic" }
            ]
          },
          riskSignals: [
            {
              id: "risk-1",
              level: "medium",
              title: "Shared selection state",
              files: ["src/App.tsx"],
              reason: "Navigation and diff loading depend on the same selected path."
            }
          ]
        }),
        startTourGeneration: async () => ({
          operationId: "tour-op",
          cachedTour: {
            id: "tour",
            provider: "github",
            repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" },
            pullNumber: 12,
            headSha: "abc123",
            generatedAt: "2026-05-22T00:00:00.000Z",
            model: "test",
            chapters: [
              {
                id: "chapter-1",
                title: "Workspace shell",
                summary: "Review and editor routes share the selected file state while patches load lazily.",
                files: ["src/App.tsx"],
                diffAnchors: [{ path: "src/App.tsx", side: "right" }],
                changeStats: { additions: 10, deletions: 2, files: 1 },
                riskLevel: "medium",
                riskReasons: ["Touches shared navigation state."],
                reviewChecklist: ["Open the file from tour.", "Check the API-backed diff path."],
                dependencies: [],
                generatedAt: "2026-05-22T00:00:00.000Z",
                model: "test",
                headSha: "abc123"
              },
              {
                id: "chapter-2",
                title: "Verification path",
                summary: "CI and review activity indicate where the reviewer should focus first.",
                files: ["src/App.tsx"],
                diffAnchors: [{ path: "src/App.tsx", side: "right" }],
                changeStats: { additions: 4, deletions: 1, files: 1 },
                riskLevel: "low",
                riskReasons: [],
                reviewChecklist: ["Review the failing UI snapshot.", "Confirm comments remain actionable."],
                dependencies: ["chapter-1"],
                generatedAt: "2026-05-22T00:00:00.000Z",
                model: "test",
                headSha: "abc123"
              }
            ],
            graph: {
              nodes: [
                { id: "chapter-1", label: "Workspace shell", riskLevel: "medium", files: ["src/App.tsx"] },
                { id: "chapter-2", label: "Verification path", riskLevel: "low", files: ["src/App.tsx"] }
              ],
              edges: [
                { id: "edge-1", from: "chapter-1", to: "chapter-2", relation: "verification", confidence: 0.8, source: "deterministic" }
              ]
            },
            riskSignals: [
              {
                id: "risk-1",
                level: "medium",
                title: "Shared selection state",
                files: ["src/App.tsx"],
                reason: "Navigation and diff loading depend on the same selected path."
              }
            ]
          }
        })
      },
      extensions: {
        list: async () => [
          {
            id: "typescript-language-server",
            name: "TypeScript",
            enabled: true,
            description: "Diagnostics, symbols, hover, and definition support for TypeScript worktrees.",
            activationGlobs: ["**/*.ts", "**/*.tsx"],
            capabilities: ["diagnostics", "symbols", "hover", "definition"],
            command: { program: "typescript-language-server", args: ["--stdio"] }
          },
          {
            id: "review-tools",
            name: "Review Tools",
            enabled: false,
            description: "Local review helpers for generated file detection and checklist hints.",
            activationGlobs: ["**/*"],
            capabilities: ["review"]
          }
        ],
        logs: async () => [
          {
            id: "log-1",
            extensionId: "typescript-language-server",
            level: "warning",
            message: "Language server is unavailable in browser preview.",
            createdAt: "2026-05-22T00:20:00.000Z"
          }
        ],
        setEnabled: async (input: any) => ({
          id: input.extensionId,
          name: input.extensionId,
          enabled: input.enabled,
          description: "Test extension",
          activationGlobs: ["**/*"],
          capabilities: []
        })
      },
      perf: {
        record: async () => ({ stored: true })
      },
      operations: {
        progressSnapshot: async (input: any) =>
          input.operationId === "open-op"
            ? {
                operationId: input.operationId,
                phase: "complete",
                message: "Opened pull request",
                percent: 100,
                done: true,
                cancelled: false
            }
            : input.operationId === "refresh-op"
              ? {
                  operationId: input.operationId,
                  phase: "complete",
                  message: "Refreshed pull request",
                  percent: 100,
                  done: true,
                  cancelled: false
                }
            : null,
        cancel: async () => null,
        onProgress: () => () => undefined
      }
    };
  });
});

test("opens to PR search and can open a PR overview", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByLabel("Pull request search")).toBeVisible();
  await expect(page.getByText("Wire review workspace")).toBeVisible();
  await expect(page).toHaveScreenshot("search-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });

  await page.getByText("Wire review workspace").click();
  await expect(page.getByRole("heading", { name: "Wire review workspace" })).toBeVisible();
  await expect(page).toHaveScreenshot("overview-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });

  // Review threads on the overview (now a section after activity)
  await page.locator(".thread-card").first().scrollIntoViewIfNeeded();
  await page.locator(".thread-card").first().getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator(".thread-card .status-success")).toBeVisible();
  await page.locator(".thread-card textarea").fill("Following up after resolving this.");
  await page.locator(".thread-card").first().getByRole("button", { name: "Reply" }).click();
  await expect(page.getByText("Following up after resolving this.")).toBeVisible();

  // Activity tabs — Bots tab filters out human comments
  await page.getByRole("tab", { name: /Bots/ }).click();
  await expect(page.getByText("Coverage report")).toBeVisible();
  await expect(page).toHaveScreenshot("activity-tabs-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });

  // Switch to Review via rail
  await page.locator(".rail").getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("button", { name: "Finish review" })).toBeVisible();
  await expect(page.getByLabel("Diff annotations for src/App.tsx")).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("review-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });

  // Switch sub-mode to Tour — tours auto-generate, no manual click needed
  await page.locator(".rev-actions").getByRole("button", { name: "Tour" }).click();
  await expect(page.locator(".tour-shell")).toBeVisible();
  await expect(page.getByLabel("Selected tour diff")).toBeVisible();
  await expect(page).toHaveScreenshot("tour-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });

  // Switch sub-mode to Storyboard
  await page.locator(".rev-actions").getByRole("button", { name: "Storyboard" }).click();
  await expect(page.getByLabel("Tour dependency graph")).toBeVisible();
  await expect(page.getByLabel("Selected chapter diff")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workspace shell" })).toBeVisible();
  await expect(page).toHaveScreenshot("storyboard-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });

  // Switch to Editor via rail
  await page.locator(".rail").getByRole("button", { name: "Editor" }).click();
  await expect(page.getByRole("button", { name: "Check out branch" })).toBeVisible();
  await expect(page.getByText("export const app = true;")).toBeVisible();
  await expect(page).toHaveScreenshot("editor-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });

  // Extensions / Settings global views
  await page.locator(".rail").getByRole("button", { name: "Extensions" }).click();
  await expect(page.getByRole("heading", { name: "Extensions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "TypeScript" })).toBeVisible();
  await expect(page).toHaveScreenshot("extensions-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });
  await page.locator(".rail").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page).toHaveScreenshot("settings-view.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });

  // Finish review popover (anchored card style)
  await page.locator(".rail").getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Finish review" }).click();
  await expect(page.getByLabel("Finish review")).toBeVisible();
  await page.getByLabel("Summary").fill("Looks good from the smoke path.");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Review submitted")).toBeVisible();
});

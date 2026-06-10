// @vitest-environment node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAppPaths } from "../../src/main/appPaths.js";
import { openDatabase } from "../../src/main/services/database.js";
import { DiagnosticsService } from "../../src/main/services/diagnosticsService.js";
import { MaintenanceService } from "../../src/main/services/maintenanceService.js";
import { OperationService } from "../../src/main/services/operationService.js";
import { PerfService } from "../../src/main/services/perfService.js";
import { SettingsStore } from "../../src/main/services/settingsStore.js";
import { UpdateService, type AutoUpdateDriver } from "../../src/main/services/updateService.js";
import type { ManagedWorktree } from "../../src/shared/schemas.js";

describe("DiagnosticsService", () => {
  it("builds a sanitized diagnostics snapshot from main-process state", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-diagnostics-"));
    const appPaths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const settings = new SettingsStore(db);
    settings.update({
      ai: {
        enabled: true,
        provider: "openai",
        model: "review-model",
        baseUrl: "https://models.example.com",
        keyProvider: "command",
        keyCommand: "secret-owner/secret-repo"
      },
      github: { configured: true, login: "kol" },
      extensions: { "review-tools": true, "typescript-language-server": false }
    });
    const maintenance = new MaintenanceService(db);
    const perf = new PerfService(db);
    perf.record({ name: "path.index", durationMs: 42, metadata: { count: 250_000 } });
    const operations = new OperationService();
    const operationId = operations.create("checkout", "Checking out PR");
    const repos = {
      listManagedWorktrees: vi.fn(async () => [
        worktree("abc123", true, 100),
        worktree("def456", false, 250)
      ])
    };
    const updates = new UpdateService(() => settings.get(), "0.1.0", new NoopAutoUpdateDriver());
    const diagnostics = new DiagnosticsService(
      appPaths,
      "0.1.0",
      settings,
      maintenance,
      repos as never,
      perf,
      operations,
      updates,
      "darwin",
      () => "2026-05-22T00:00:00.000Z"
    );

    const snapshot = await diagnostics.getSnapshot();

    expect(snapshot).toMatchObject({
      generatedAt: "2026-05-22T00:00:00.000Z",
      appVersion: "0.1.0",
      platform: "darwin",
      settings: {
        ai: {
          enabled: true,
          provider: "openai",
          model: "review-model",
          baseUrlConfigured: true,
          keyProvider: "command",
          keyCommandConfigured: true
        },
        github: { configured: true, login: "kol", tokenProvider: "keychain" },
        enabledExtensionCount: 1
      },
      worktrees: { count: 2, activeCount: 1, totalBytes: 350 },
      updates: { state: "idle", message: "Ready to check for updates." }
    });
    expect(snapshot.recentPerformance[0]).toMatchObject({
      name: "path.index",
      durationMs: 42,
      metadata: { count: 250_000 }
    });
    expect(snapshot.operations[0]).toMatchObject({ operationId, phase: "checkout" });
    expect(JSON.stringify(snapshot)).not.toContain("secret-owner/secret-repo");
  });
});

function worktree(headSha: string, active: boolean, sizeBytes: number): ManagedWorktree {
  return {
    repository: {
      provider: "github",
      owner: "kol",
      name: "repo",
      fullName: "kol/repo"
    },
    number: 12,
    headSha,
    worktreePath: `/tmp/${headSha}`,
    lastUsedAt: "2026-05-22T00:00:00.000Z",
    active,
    sizeBytes
  };
}

class NoopAutoUpdateDriver implements AutoUpdateDriver {
  setFeedURL(): void {}
  checkForUpdates(): void {}
  quitAndInstall(): void {}
  on(): this {
    return this;
  }
}

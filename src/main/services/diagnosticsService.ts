import type { DiagnosticsSnapshot } from "../../shared/schemas.js";
import type { AppPaths } from "../appPaths.js";
import type { MaintenanceService } from "./maintenanceService.js";
import type { OperationService } from "./operationService.js";
import type { PerfService } from "./perfService.js";
import type { RepoService } from "./repoService.js";
import type { SettingsStore } from "./settingsStore.js";
import type { UpdateService } from "./updateService.js";

export class DiagnosticsService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly appVersion: string,
    private readonly settings: SettingsStore,
    private readonly maintenance: MaintenanceService,
    private readonly repos: RepoService,
    private readonly perf: PerfService,
    private readonly operations: OperationService,
    private readonly updates: UpdateService,
    private readonly platform = process.platform,
    private readonly now = () => new Date().toISOString()
  ) {}

  async getSnapshot(): Promise<DiagnosticsSnapshot> {
    const settings = this.settings.get();
    const worktrees = await this.repos.listManagedWorktrees();

    return {
      generatedAt: this.now(),
      appVersion: this.appVersion,
      platform: this.platform,
      paths: {
        root: this.appPaths.root,
        cache: this.appPaths.cache,
        logs: this.appPaths.logs,
        indexes: this.appPaths.indexes
      },
      settings: {
        appearance: settings.appearance,
        data: settings.data,
        ai: {
          enabled: settings.ai.enabled,
          provider: settings.ai.provider,
          model: settings.ai.model,
          baseUrlConfigured: Boolean(settings.ai.baseUrl),
          keyProvider: settings.ai.keyProvider,
          keyCommandConfigured: Boolean(settings.ai.keyCommand)
        },
        github: settings.github,
        updates: settings.updates,
        enabledExtensionCount: Object.values(settings.extensions).filter(Boolean).length
      },
      cache: this.maintenance.getCacheStats(),
      worktrees: {
        count: worktrees.length,
        activeCount: worktrees.filter((worktree) => worktree.active).length,
        totalBytes: worktrees.reduce((sum, worktree) => sum + worktree.sizeBytes, 0)
      },
      recentPerformance: this.perf.listRecent(20),
      operations: this.operations.snapshot(20),
      updates: this.updates.getStatus()
    };
  }
}

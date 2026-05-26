// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/main/services/database.js";
import { MaintenanceService } from "../../src/main/services/maintenanceService.js";

describe("MaintenanceService", () => {
  it("reports cache stats across durable cache tables", () => {
    const db = openDatabase(":memory:");
    const service = new MaintenanceService(db);
    insertPrCache(db, "old", "2026-01-01T00:00:00.000Z");
    insertProviderCache(db, "provider-old", "2026-01-01T00:00:00.000Z");
    insertAiTour(db, "old", "2026-01-01T00:00:00.000Z");
    insertPerf(db, "2026-01-01T00:00:00.000Z");

    expect(service.getCacheStats()).toMatchObject({
      prCache: { entryCount: 1 },
      providerResponses: { entryCount: 1 },
      aiTours: { entryCount: 1 },
      performanceMeasurements: { entryCount: 1 }
    });
  });

  it("cleans cache entries by age while preserving newer entries", () => {
    const db = openDatabase(":memory:");
    const service = new MaintenanceService(db);
    insertPrCache(db, "old", "2020-01-01T00:00:00.000Z");
    insertPrCache(db, "new", new Date().toISOString());
    insertProviderCache(db, "provider-old", "2020-01-01T00:00:00.000Z");
    insertProviderCache(db, "provider-new", new Date().toISOString());

    const result = service.cleanupCaches({ maxAgeDays: 30, maxEntriesPerTable: 5_000, dryRun: false });

    expect(result.prCache.deletedCount).toBe(1);
    expect(result.providerResponses.deletedCount).toBe(1);
    expect(countRows(db, "pr_cache")).toBe(1);
    expect(countRows(db, "provider_response_cache")).toBe(1);
  });

  it("supports dry-run and max-entry cleanup policies", () => {
    const db = openDatabase(":memory:");
    const service = new MaintenanceService(db);
    insertPrCache(db, "1", new Date(Date.now() - 3_000).toISOString());
    insertPrCache(db, "2", new Date(Date.now() - 2_000).toISOString());
    insertPrCache(db, "3", new Date(Date.now() - 1_000).toISOString());

    const dryRun = service.cleanupCaches({ maxAgeDays: 30, maxEntriesPerTable: 1, dryRun: true });

    expect(dryRun.prCache.deletedCount).toBe(2);
    expect(countRows(db, "pr_cache")).toBe(3);

    const actual = service.cleanupCaches({ maxAgeDays: 30, maxEntriesPerTable: 1, dryRun: false });

    expect(actual.prCache.deletedCount).toBe(2);
    expect(countRows(db, "pr_cache")).toBe(1);
  });
});

function insertPrCache(db: ReturnType<typeof openDatabase>, headSha: string, updatedAt: string): void {
  db.prepare(
    `INSERT INTO pr_cache (provider, owner, repo, number, head_sha, payload, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("github", "kol", "repo", 12, headSha, `{"headSha":"${headSha}"}`, updatedAt);
}

function insertProviderCache(db: ReturnType<typeof openDatabase>, key: string, updatedAt: string): void {
  db.prepare(
    `INSERT INTO provider_response_cache (cache_key, provider, scope, etag, head_sha, payload, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(key, "github", "repo:kol/repo:pr:12", null, null, `{"key":"${key}"}`, updatedAt);
}

function insertAiTour(db: ReturnType<typeof openDatabase>, headSha: string, generatedAt: string): void {
  db.prepare(
    `INSERT INTO ai_tours (provider, owner, repo, number, head_sha, payload, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("github", "kol", "repo", 12, headSha, `{"headSha":"${headSha}"}`, generatedAt);
}

function insertPerf(db: ReturnType<typeof openDatabase>, createdAt: string): void {
  db.prepare("INSERT INTO perf_measurements (name, duration_ms, metadata, created_at) VALUES (?, ?, ?, ?)")
    .run("test.measurement", 12, "{}", createdAt);
}

function countRows(db: ReturnType<typeof openDatabase>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

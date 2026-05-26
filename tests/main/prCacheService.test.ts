// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/main/services/database.js";
import { PrCacheService } from "../../src/main/services/prCacheService.js";
import type { PullRequestBundle, RepositoryRef } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

describe("PrCacheService", () => {
  it("stores only the current head SHA for a pull request", () => {
    const service = new PrCacheService(openDatabase(":memory:"));

    service.put(bundleForHead("old-head"));
    service.put(bundleForHead("new-head"));

    expect(service.get(repository, 12, "old-head")).toBeNull();
    expect(service.getFilePatch(repository, 12, "src/App.tsx", "old-head")).toBeNull();
    expect(service.get(repository, 12, "new-head")?.detail.headSha).toBe("new-head");
    expect(service.getLatest(repository, 12)?.detail.headSha).toBe("new-head");
  });

  it("stores patches separately from PR metadata and returns them by path and head SHA", () => {
    const service = new PrCacheService(openDatabase(":memory:"));
    const stored = service.put(bundleForHead("abc123"));

    expect(stored.changedFiles[0]?.patch).toBeUndefined();
    expect(service.get(repository, 12, "abc123")?.changedFiles[0]?.patch).toBeUndefined();
    const patch = service.getFilePatch(repository, 12, "src/App.tsx", "abc123");

    expect(patch?.patch).toContain("+export const App");
    expect(patch?.isLarge).toBe(false);
    expect(service.getFilePatch(repository, 12, "src/Missing.tsx", "abc123")).toBeNull();
  });

  it("hydrates changed file metadata with cached patches for main-process consumers", () => {
    const service = new PrCacheService(openDatabase(":memory:"));
    const stored = service.put(bundleForHead("abc123"));

    const hydrated = service.hydrateChangedFilePatches(repository, 12, "abc123", stored.changedFiles);

    expect(hydrated[0]?.patch).toContain("+export const App");
  });

  it("strips and migrates legacy cache rows that still contain patches", () => {
    const db = openDatabase(":memory:");
    const service = new PrCacheService(db);
    const legacy = bundleForHead("legacy-head");

    db.prepare(
      `INSERT INTO pr_cache (provider, owner, repo, number, head_sha, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("github", "kol", "repo", 12, "legacy-head", JSON.stringify(legacy), "2026-05-22T00:00:00.000Z");

    expect(service.get(repository, 12, "legacy-head")?.changedFiles[0]?.patch).toBeUndefined();
    expect(service.getFilePatch(repository, 12, "src/App.tsx", "legacy-head")?.patch).toContain("+export const App");
  });

  it("invalidates all cached payloads for a pull request", () => {
    const service = new PrCacheService(openDatabase(":memory:"));
    service.put(bundleForHead("abc123"));

    expect(service.invalidate(repository, 12)).toBe(1);
    expect(service.get(repository, 12, "abc123")).toBeNull();
  });
});

function bundleForHead(headSha: string): PullRequestBundle {
  return {
    detail: {
      provider: "github",
      id: "1",
      number: 12,
      repository,
      title: `PR at ${headSha}`,
      state: "open",
      draft: false,
      url: "https://github.com/kol/repo/pull/12",
      author: { login: "kol" },
      labels: [],
      reviewers: [],
      baseRef: "main",
      headRef: "feature",
      headSha,
      baseSha: "base123",
      additions: 1,
      deletions: 0,
      changedFileCount: 1,
      commentCount: 0,
      updatedAt: "2026-05-22T00:00:00.000Z",
      createdAt: "2026-05-22T00:00:00.000Z",
      body: "",
      isFromFork: false
    },
    mode: "light",
    changedFiles: [
      {
        path: "src/App.tsx",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -1 +1 @@\n+export const App = () => null;\n",
        language: "typescript",
        isLarge: false,
        isGenerated: false,
        reviewStatus: "unreviewed",
        annotations: 0,
        diagnostics: 0
      }
    ],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}

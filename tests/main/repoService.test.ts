// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { workspaceFileChangeEvent } from "../../src/shared/ipc.js";
import { createAppPaths } from "../../src/main/appPaths.js";
import { AppError } from "../../src/main/errors.js";
import { openDatabase } from "../../src/main/services/database.js";
import { OperationService } from "../../src/main/services/operationService.js";
import { RepoService } from "../../src/main/services/repoService.js";
import { defaultAppSettings } from "../../src/shared/schemas.js";
import type { RepositoryRef } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

describe("RepoService managed worktree reads", () => {
  it("returns a checkout operation immediately and completes the worktree mapping in the background", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const operations = new OperationService();
    const watchFactory = vi.fn(() => createFakeWatcher());
    const service = new RepoService(paths, db, operations, { watchFactory: watchFactory as never });
    const mirrorPath = join(paths.repos, "github", "kol", "repo", "mirror.git");
    const worktreePath = join(paths.worktrees, "github", "kol", "repo", "12-abc123");
    await mkdir(mirrorPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    const result = await service.checkoutPullRequest({
      repository,
      number: 12,
      headRef: "feature",
      baseRef: "main",
      headSha: "abc123"
    });

    expect(result).toEqual({
      operationId: expect.any(String),
      mode: "managed",
      worktreePath
    });
    expect(operations.get(result.operationId)).toMatchObject({
      phase: "checkout",
      done: false
    });

    await waitForOperationDone(operations, result.operationId);

    expect(operations.get(result.operationId)).toMatchObject({
      phase: "complete",
      done: true
    });
    expect(service.getWorktreePath(repository, "abc123")).toBe(worktreePath);
    expect(await service.listManagedWorktrees(repository)).toEqual([
      expect.objectContaining({
        headSha: "abc123",
        headRef: "feature",
        baseRef: "main"
      })
    ]);
    expect(watchFactory).toHaveBeenCalledWith(worktreePath, expect.any(Function));
  });

  it("honors the managed repo storage setting for mirrors and worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const customStorage = join(root, "custom-managed-storage");
    const paths = createAppPaths(join(root, "app-data"));
    const db = openDatabase(":memory:");
    const operations = new OperationService();
    const watchFactory = vi.fn(() => createFakeWatcher());
    const service = new RepoService(paths, db, operations, {
      getSettings: () => ({
        ...defaultAppSettings,
        data: {
          ...defaultAppSettings.data,
          managedRepoStorage: customStorage
        }
      }),
      watchFactory: watchFactory as never
    });
    const mirrorPath = join(customStorage, "repos", "github", "kol", "repo", "mirror.git");
    const worktreePath = join(customStorage, "worktrees", "github", "kol", "repo", "12-abc123");
    await mkdir(mirrorPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    expect(service.selectMode(repository, "auto", "abc123")).toEqual({
      mode: "light",
      reason: "A managed mirror exists, but this pull request is not checked out yet."
    });

    const result = await service.checkoutPullRequest({
      repository,
      number: 12,
      headRef: "feature",
      baseRef: "main",
      headSha: "abc123"
    });
    await waitForOperationDone(operations, result.operationId);

    expect(result.worktreePath).toBe(worktreePath);
    expect(service.getWorktreePath(repository, "abc123")).toBe(worktreePath);
    expect(service.selectMode(repository, "auto", "abc123")).toEqual({
      mode: "managed",
      reason: "A managed checkout exists for this pull request."
    });
    expect(watchFactory).toHaveBeenCalledWith(worktreePath, expect.any(Function));
  });

  it("does not treat a repository mirror as a checked-out pull request worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    await mkdir(join(paths.repos, "github", "kol", "repo", "mirror.git"), { recursive: true });

    expect(service.selectMode(repository, "auto", "abc123")).toEqual({
      mode: "light",
      reason: "A managed mirror exists, but this pull request is not checked out yet."
    });
    expect(service.selectMode(repository, "managed", "abc123")).toEqual({
      mode: "light",
      reason: "Managed mode was requested, but this pull request is not checked out yet."
    });
  });

  it("reads file content from the managed worktree mapped by head SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "index.ts"), "export const value = 1;\n");

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "abc123", worktreePath, new Date().toISOString());

    const content = await service.getLocalFileContent(repository, "src/index.ts", "abc123");

    expect(content?.contents).toBe("export const value = 1;\n");
    expect(content?.isLarge).toBe(false);
  });

  it("reads absolute local files for managed worktree definition targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const dependencyPath = join(root, "cargo-registry", "src", "lib.rs");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(join(root, "cargo-registry", "src"), { recursive: true });
    await writeFile(dependencyPath, "pub fn dependency() {}\n");

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "abc123", worktreePath, new Date().toISOString());

    const content = await service.getLocalFileContent(repository, dependencyPath, "abc123");

    expect(content?.path).toBe(dependencyPath);
    expect(content?.contents).toBe("pub fn dependency() {}\n");
  });

  it("loads the editor workspace tree from the worktree filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(worktreePath, "target", "debug"), { recursive: true });
    await mkdir(join(worktreePath, ".jj", "repo"), { recursive: true });
    await writeFile(join(worktreePath, "Cargo.toml"), "[package]\nname = \"repo\"\n");
    await writeFile(join(worktreePath, "src", "lib.rs"), "pub fn lib() {}\n");
    await writeFile(join(worktreePath, "src", "generated.rs"), "pub fn generated() {}\n");
    await writeFile(join(worktreePath, "node_modules", "pkg", "index.js"), "ignored\n");
    await writeFile(join(worktreePath, "target", "debug", "repo"), "ignored\n");
    await writeFile(join(worktreePath, ".jj", "repo", "store"), "ignored\n");
    insertWorktree(db, "abc123", worktreePath, new Date().toISOString(), 1);

    const tree = await service.loadWorkspaceTree(repository, "abc123");

    expect(tree.paths).toEqual(["Cargo.toml", "src/generated.rs", "src/lib.rs"]);
  });

  it("searches bounded text content in a managed worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(worktreePath, "src", "App.tsx"), "export const workspace = true;\nconst eventFlow = workspace;\n");
    await writeFile(join(worktreePath, "src", "Other.ts"), "export const other = true;\n");
    await writeFile(join(worktreePath, "node_modules", "pkg", "index.js"), "workspace event should be ignored\n");

    insertWorktree(db, "abc123", worktreePath, new Date().toISOString(), 1);

    const result = await service.searchWorkspaceText(repository, "abc123", "workspace event", {
      maxResults: 5,
      maxFiles: 10,
      maxFileBytes: 10_000
    });

    expect(result).toMatchObject({
      repository,
      headSha: "abc123",
      query: "workspace event",
      searchedFiles: 2,
      skippedFiles: 0,
      truncated: false
    });
    expect(result.results).toEqual([
      {
        path: "src/App.tsx",
        matches: [
          { lineNumber: 1, lineText: "export const workspace = true;" },
          { lineNumber: 2, lineText: "const eventFlow = workspace;" }
        ]
      }
    ]);
  });

  it("rejects worktree path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    await mkdir(worktreePath, { recursive: true });

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "abc123", worktreePath, new Date().toISOString());

    await expect(service.getLocalFileContent(repository, "../secret.txt", "abc123")).rejects.toBeInstanceOf(AppError);
  });

  it("releases and cleans up inactive worktrees by LRU without deleting active worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    const oldInactive = join(paths.worktrees, "github", "kol", "repo", "12-old");
    const active = join(paths.worktrees, "github", "kol", "repo", "12-active");
    const newInactive = join(paths.worktrees, "github", "kol", "repo", "12-new");

    await mkdir(oldInactive, { recursive: true });
    await mkdir(active, { recursive: true });
    await mkdir(newInactive, { recursive: true });
    await writeFile(join(oldInactive, "old.txt"), "old");
    await writeFile(join(active, "active.txt"), "active");
    await writeFile(join(newInactive, "new.txt"), "new");

    insertWorktree(db, "old", oldInactive, "2026-05-20T00:00:00.000Z", 0);
    insertWorktree(db, "active", active, "2026-05-21T00:00:00.000Z", 1);
    insertWorktree(db, "new", newInactive, "2026-05-22T00:00:00.000Z", 0);

    expect(service.releaseWorktree(repository, "new")).toEqual({ released: true });

    const cleanup = await service.cleanupWorktrees({ repository, maxEntries: 1 });

    expect(cleanup.deleted.map((worktree) => worktree.headSha).sort()).toEqual(["new", "old"]);
    expect(cleanup.retained.map((worktree) => worktree.headSha)).toEqual(["active"]);
    expect(existsSync(oldInactive)).toBe(false);
    expect(existsSync(newInactive)).toBe(false);
    expect(existsSync(active)).toBe(true);
  });

  it("lists checked out worktrees with cached branch metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    const worktreePath = join(paths.worktrees, "github", "kol", "repo", "12-abc123");

    await mkdir(worktreePath, { recursive: true });
    insertWorktree(db, "abc123", worktreePath, "2026-05-22T00:00:00.000Z", 1);
    db.prepare(
      `INSERT INTO pr_cache (provider, owner, repo, number, head_sha, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "github",
      "kol",
      "repo",
      12,
      "abc123",
      JSON.stringify({ detail: { title: "Add branch list", headRef: "feature/branch-list", baseRef: "main" } }),
      "2026-05-22T00:00:00.000Z"
    );

    const worktrees = await service.listManagedWorktrees(repository);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({
      title: "Add branch list",
      headRef: "feature/branch-list",
      baseRef: "main"
    });
  });

  it("deletes a checked out worktree and stops watching it", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const watcher = createFakeWatcher();
    const watchFactory = vi.fn(() => watcher);
    const service = new RepoService(paths, db, new OperationService(), { watchFactory: watchFactory as never });
    const worktreePath = join(paths.worktrees, "github", "kol", "repo", "12-abc123");

    await mkdir(worktreePath, { recursive: true });
    await writeFile(join(worktreePath, "local.txt"), "local");
    insertWorktree(db, "abc123", worktreePath, "2026-05-22T00:00:00.000Z", 1);
    expect(service.watchWorktree(repository, "abc123")).toBe(true);

    const result = await service.deleteWorktree({ repository, number: 12, headSha: "abc123" });

    expect(result.deleted).toBe(true);
    expect(result.worktree?.headSha).toBe("abc123");
    expect(existsSync(worktreePath)).toBe(false);
    expect(await service.listManagedWorktrees(repository)).toEqual([]);
    expect(watcher.close).toHaveBeenCalledOnce();
  });

  it("emits managed worktree file changes and stops watching on release", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const worktreePath = join(root, "worktree");
    const watcher = createFakeWatcher();
    const watchFactory = vi.fn((_path: string, listener: (eventType: "rename" | "change", filename: string | Buffer | null) => void) => {
      watcher.listener = listener;
      return watcher;
    });
    const service = new RepoService(paths, db, new OperationService(), { watchFactory: watchFactory as never });
    const send = vi.fn();
    const window = {
      on: vi.fn(),
      isDestroyed: () => false,
      webContents: { send }
    };

    await mkdir(worktreePath, { recursive: true });
    insertWorktree(db, "abc123", worktreePath, new Date().toISOString(), 1);
    service.attachWindow(window as never);

    expect(service.watchWorktree(repository, "abc123")).toBe(true);
    watcher.listener?.("change", "src/index.ts");

    expect(send).toHaveBeenCalledWith(
      workspaceFileChangeEvent,
      expect.objectContaining({
        repository,
        headSha: "abc123",
        worktreePath,
        path: "src/index.ts",
        eventType: "change"
      })
    );

    expect(service.releaseWorktree(repository, "abc123")).toEqual({ released: true });
    expect(watcher.close).toHaveBeenCalledOnce();
  });
});

function insertWorktree(
  db: ReturnType<typeof openDatabase>,
  headSha: string,
  worktreePath: string,
  lastUsedAt: string,
  active: 0 | 1
): void {
  db.prepare(
    `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("github", "kol", "repo", 12, headSha, worktreePath, lastUsedAt, active);
}

async function waitForOperationDone(operations: OperationService, operationId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (operations.get(operationId)?.done) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${operationId}`);
}

function createFakeWatcher(): {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  listener?: (eventType: "rename" | "change", filename: string | Buffer | null) => void;
} {
  const watcher = {
    close: vi.fn(),
    on: vi.fn()
  };
  watcher.on.mockReturnValue(watcher);
  return watcher;
}

// @vitest-environment node
import { Buffer } from "node:buffer";
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
import { buildGitEnvironment, formatGitCommandError, RepoService, worktreeAddArgs } from "../../src/main/services/repoService.js";
import { defaultAppSettings } from "../../src/shared/schemas.js";
import type { RepositoryRef } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

describe("RepoService managed worktree reads", () => {
  it("passes configured GitHub tokens to git through process-local config", () => {
    const env = buildGitEnvironment(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "*"
      },
      repository,
      "secret-token"
    );

    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(env.GIT_CONFIG_VALUE_0).toBe("*");
    expect(env.GIT_CONFIG_KEY_1).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_1).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:secret-token").toString("base64")}`
    );
  });

  it("forces worktree creation over stale git worktree metadata", () => {
    expect(worktreeAddArgs("/tmp/mirror.git", "/tmp/worktree", "abc123")).toEqual([
      "--git-dir",
      "/tmp/mirror.git",
      "worktree",
      "add",
      "--force",
      "--detach",
      "/tmp/worktree",
      "abc123"
    ]);
  });

  it("formats git clone timeouts without surfacing progress output as the failure", () => {
    const error = Object.assign(
      new Error("Command failed: git clone --bare --no-progress https://github.com/DataDog/dd-go.git /tmp/mirror.git\nCloning into bare repository '/tmp/mirror.git'..."),
      {
        killed: true,
        signal: "SIGTERM",
        stderr: "Cloning into bare repository '/tmp/mirror.git'...\n"
      }
    );

    expect(
      formatGitCommandError(
        ["clone", "--bare", "--no-progress", "https://github.com/DataDog/dd-go.git", "/tmp/mirror.git"],
        error,
        10 * 60_000
      )
    ).toBe("Git clone timed out after 10 minutes.");
  });

  it("formats git command failures with the actionable fatal line", () => {
    const error = Object.assign(new Error("Command failed: git clone"), {
      code: 128,
      stderr: [
        "Cloning into bare repository '/tmp/mirror.git'...",
        "remote: Repository not found.",
        "fatal: Authentication failed for 'https://github.com/kol/repo.git/'"
      ].join("\n")
    });

    expect(formatGitCommandError(["clone", "--bare", "https://github.com/kol/repo.git", "/tmp/mirror.git"], error, 120_000)).toBe(
      "Git clone failed: Authentication failed for 'https://github.com/kol/repo.git/'"
    );
  });

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

  it("enforces the configured cache budget, evicting inactive worktrees but keeping active ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    // A near-zero budget forces eviction of everything that is eligible.
    const service = new RepoService(paths, db, new OperationService(), {
      getSettings: () => ({ ...defaultAppSettings, data: { ...defaultAppSettings.data, worktreeCacheSizeGb: 1e-9 } })
    });
    const inactive = join(paths.worktrees, "github", "kol", "repo", "12-old");
    const active = join(paths.worktrees, "github", "kol", "repo", "12-active");
    await mkdir(inactive, { recursive: true });
    await mkdir(active, { recursive: true });
    await writeFile(join(inactive, "f.txt"), "data");
    await writeFile(join(active, "f.txt"), "data");
    insertWorktree(db, "old", inactive, "2026-05-20T00:00:00.000Z", 0);
    insertWorktree(db, "active", active, "2026-05-21T00:00:00.000Z", 1);

    await service.enforceWorktreeCacheBudget();

    expect(existsSync(inactive)).toBe(false); // over budget and inactive → evicted
    expect(existsSync(active)).toBe(true); // active worktrees are never evicted
  });

  it("does not enforce a cache budget when no settings are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-repo-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());
    const inactive = join(paths.worktrees, "github", "kol", "repo", "12-old");
    await mkdir(inactive, { recursive: true });
    await writeFile(join(inactive, "f.txt"), "data");
    insertWorktree(db, "old", inactive, "2026-05-20T00:00:00.000Z", 0);

    await service.enforceWorktreeCacheBudget();

    expect(existsSync(inactive)).toBe(true); // no budget configured → no-op
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

describe("RepoService local repo support", () => {
  it("localGitDir returns null when getSettings is not provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-local-repo-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const service = new RepoService(paths, db, new OperationService());

    // No getSettings injected — should silently return null (falls back to bare clone).
    const worktrees = await service.listManagedWorktrees(repository);
    expect(worktrees).toHaveLength(0);
    // The public observable effect: selectMode treats repository as unmanaged.
    expect(service.selectMode(repository, "auto", "abc123")).toMatchObject({ mode: "light" });
  });

  it("localGitDir resolves to path/.git for a regular cloned repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-local-repo-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const operations = new OperationService();
    const repoPath = join(root, "my-repo");
    const dotGit = join(repoPath, ".git");
    await mkdir(dotGit, { recursive: true });

    const service = new RepoService(paths, db, operations, {
      getSettings: () => ({
        ...defaultAppSettings,
        data: {
          ...defaultAppSettings.data,
          localRepos: [{ fullName: "kol/repo", path: repoPath }],
        },
      }),
    });

    // Verify via checkout that it picks up the local git dir and stores it in the DB.
    const mirrorPath = join(paths.repos, "github", "kol", "repo", "mirror.git");
    const worktreePath = join(paths.worktrees, "github", "kol", "repo", "12-abc123");
    await mkdir(mirrorPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    const result = await service.checkoutPullRequest({
      repository,
      number: 12,
      headRef: "feature",
      baseRef: "main",
      headSha: "abc123",
    });
    await waitForOperationDone(operations, result.operationId);

    const worktrees = await service.listManagedWorktrees(repository);
    // The git_dir stored in DB should be path/.git, not the mirror path.
    expect(worktrees[0]?.gitDir).toBe(dotGit);
  });

  it("localGitDir treats a path with no .git subdir as a bare repo and uses the path itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-bare-repo-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const operations = new OperationService();
    const bareRepoPath = join(root, "bare.git");
    // Bare repo: the path itself is the git dir (no .git subdir).
    await mkdir(bareRepoPath, { recursive: true });

    const service = new RepoService(paths, db, operations, {
      getSettings: () => ({
        ...defaultAppSettings,
        data: {
          ...defaultAppSettings.data,
          localRepos: [{ fullName: "kol/repo", path: bareRepoPath }],
        },
      }),
    });

    const mirrorPath = join(paths.repos, "github", "kol", "repo", "mirror.git");
    const worktreePath = join(paths.worktrees, "github", "kol", "repo", "12-abc123");
    await mkdir(mirrorPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    const result = await service.checkoutPullRequest({
      repository,
      number: 12,
      headRef: "feature",
      baseRef: "main",
      headSha: "abc123",
    });
    await waitForOperationDone(operations, result.operationId);

    const worktrees = await service.listManagedWorktrees(repository);
    // For a bare repo the gitDir should be the path itself, not path/.git.
    expect(worktrees[0]?.gitDir).toBe(bareRepoPath);
  });


  it("removeWorktreeFiles uses git worktree prune when gitDir is set but path is already gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-prune-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const gitCommands: string[][] = [];
    const service = new RepoService(paths, db, new OperationService());

    const gitDir = join(root, "repo.git");
    const worktreePath = join(root, "worktree-already-gone");
    // worktreePath intentionally NOT created — simulates already-deleted path.
    await mkdir(gitDir, { recursive: true });

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active, git_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run("github", "kol", "repo", 12, "abc123", worktreePath, new Date().toISOString(), gitDir);

    // Spy on the private runGitForOutput to capture git calls.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(service as any, "runGitForOutput").mockResolvedValue("");
    const result = await service.deleteWorktree({ repository, number: 12, headSha: "abc123" });

    expect(result.deleted).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pruneCall = spy.mock.calls.find((call: any[]) =>
      (call[0] as string[]).includes("prune")
    );
    expect(pruneCall).toBeDefined();
    expect(pruneCall![0]).toContain("--git-dir");
    expect(pruneCall![0]).toContain(gitDir);
  });
});

function insertWorktree(
  db: ReturnType<typeof openDatabase>,
  headSha: string,
  worktreePath: string,
  lastUsedAt: string,
  active: 0 | 1,
  gitDir?: string
): void {
  if (gitDir !== undefined) {
    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active, git_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("github", "kol", "repo", 12, headSha, worktreePath, lastUsedAt, active, gitDir);
  } else {
    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("github", "kol", "repo", 12, headSha, worktreePath, lastUsedAt, active);
  }
}

async function waitForOperationDone(operations: OperationService, operationId: string, maxAttempts = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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

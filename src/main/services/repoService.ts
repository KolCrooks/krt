import { Buffer } from "node:buffer";
import { existsSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserWindow } from "electron";
import { workspaceFileChangeEvent } from "../../shared/ipc.js";
import { selectDataMode } from "../../shared/modeSelection.js";
import type {
  AppSettings,
  FileContent,
  FilePatch,
  ManagedWorktree,
  PreferredDataMode,
  RepositoryRef,
  WorkspaceTextSearchResult,
  WorkspaceTree,
  WorktreeCleanupResult
} from "../../shared/schemas.js";
import type { AppPaths } from "../appPaths.js";
import type { OperationService } from "./operationService.js";
import type { SqliteDatabase } from "./database.js";
import { AppError } from "../errors.js";

const execFileAsync = promisify(execFile);
const SEARCH_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".jj",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv"
]);
const DEFAULT_WORKSPACE_TREE_MAX_FILES = 50_000;
const DEFAULT_TEXT_SEARCH_MAX_RESULTS = 25;
const TEXT_SEARCH_MAX_SNIPPET_LENGTH = 180;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const GIT_NETWORK_TIMEOUT_MS = 10 * 60_000;

type WatchEventType = "rename" | "change";
type WatchFactory = (
  path: string,
  listener: (eventType: WatchEventType, filename: string | Buffer | null) => void
) => Pick<FSWatcher, "close" | "on">;

interface GitCommandOptions {
  allowFailure?: boolean;
  operationId?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class RepoService {
  private readonly watchers = new Map<string, Pick<FSWatcher, "close" | "on">>();
  private readonly windows = new Set<BrowserWindow>();
  private readonly watchFactory: WatchFactory;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly db: SqliteDatabase,
    private readonly operations: OperationService,
    options: {
      getSettings?: () => AppSettings;
      getGitHubToken?: () => Promise<string | null>;
      watchFactory?: WatchFactory;
    } = {}
  ) {
    this.getSettings = options.getSettings;
    this.getGitHubToken = options.getGitHubToken;
    this.watchFactory =
      options.watchFactory ??
      ((path, listener) =>
        watch(path, { recursive: true }, (eventType, filename) =>
          listener(eventType === "change" || eventType === "rename" ? eventType : "change", filename)
        ));
  }

  private readonly getSettings?: () => AppSettings;
  private readonly getGitHubToken?: () => Promise<string | null>;

  attachWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on("closed", () => this.windows.delete(window));
  }

  selectMode(
    repository: RepositoryRef,
    preferredMode: PreferredDataMode,
    headSha?: string
  ): { mode: "light" | "managed"; reason: string } {
    const mirrorPath = this.mirrorPath(repository);
    const mirrorExists = existsSync(mirrorPath);
    const selection = selectDataMode({
      preferredMode,
      mirrorExists,
      mirrorFresh: mirrorExists,
      worktreeExists: this.hasManagedWorktree(repository, headSha)
    });
    if (selection.mode === "managed" && headSha) {
      this.activateWorktree(repository, headSha);
    }
    return selection;
  }

  hasManagedWorktree(repository: RepositoryRef, headSha: string | undefined): boolean {
    return headSha ? this.getWorktreePath(repository, headSha) !== null : false;
  }

  activateWorktree(repository: RepositoryRef, headSha: string): boolean {
    const worktreePath = this.getWorktreePath(repository, headSha);
    if (!worktreePath) {
      return false;
    }

    this.db
      .prepare(
        `UPDATE worktrees SET active = 1, last_used_at = ?
         WHERE provider = ? AND owner = ? AND repo = ? AND head_sha = ?`
      )
      .run(new Date().toISOString(), repository.provider, repository.owner, repository.name, headSha);
    this.watchWorktree(repository, headSha);
    return true;
  }

  checkoutPullRequest(input: {
    repository: RepositoryRef;
    number: number;
    headRef: string;
    baseRef: string;
    headSha: string;
  }): Promise<{ operationId: string; mode: "managed"; worktreePath: string }> {
    const operationId = this.operations.create("checkout", "Preparing managed checkout");
    const mirrorPath = this.mirrorPath(input.repository);
    const worktreePath = this.worktreePath(input.repository, input.number, input.headSha);

    void this.runCheckout(input, operationId, mirrorPath, worktreePath);

    return Promise.resolve({ operationId, mode: "managed", worktreePath });
  }

  private localRepoDirs(repository: RepositoryRef): { gitDir: string; workDir: string } | null {
    const settings = this.getSettings?.();
    if (!settings) return null;
    const fullName = `${repository.owner}/${repository.name}`;
    const entry = settings.data.localRepos.find((r) => r.fullName === fullName);
    if (!entry?.path) return null;
    // Regular repo: path/.git exists → workDir is path, gitDir is path/.git.
    // Bare repo: no .git subdir → both workDir and gitDir are path.
    const dotGit = join(entry.path, ".git");
    if (existsSync(dotGit)) return { gitDir: dotGit, workDir: entry.path };
    return { gitDir: entry.path, workDir: entry.path };
  }

  private localGitDir(repository: RepositoryRef): string | null {
    return this.localRepoDirs(repository)?.gitDir ?? null;
  }

  private async resolveRemoteName(gitDir: string, repository: RepositoryRef): Promise<string> {
    const candidates = [
      `https://github.com/${repository.owner}/${repository.name}.git`,
      `https://github.com/${repository.owner}/${repository.name}`,
      `git@github.com:${repository.owner}/${repository.name}.git`,
      `git@github.com:${repository.owner}/${repository.name}`,
    ];
    try {
      const output = await this.runGitForOutput(["--git-dir", gitDir, "remote", "-v"], { allowFailure: true });
      for (const line of output.split("\n")) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
        if (m && candidates.includes(m[2])) return m[1];
      }
    } catch { /* fall through */ }
    return "origin";
  }



  private async runCheckout(
    input: {
      repository: RepositoryRef;
      number: number;
      headRef: string;
      baseRef: string;
      headSha: string;
    },
    operationId: string,
    mirrorPath: string,
    worktreePath: string
  ): Promise<void> {
    try {
      this.operations.assertNotCancelled(operationId);
      await mkdir(this.repoRoot(input.repository), { recursive: true });
      await mkdir(this.worktreeRoot(input.repository), { recursive: true });
      const gitEnv = await this.gitNetworkEnvironment(input.repository);

      // If the user has configured a local repo for this repository, use its git
      // dir instead of the managed bare clone — skipping the clone step entirely.
      const localRepoDirs = this.localRepoDirs(input.repository);
      const localGitDir = localRepoDirs?.gitDir ?? null;
      const effectiveGitDir = localGitDir ?? mirrorPath;

      if (!localGitDir && !existsSync(worktreePath) && existsSync(mirrorPath) && !(await this.isUsableMirror(mirrorPath))) {
        await rm(mirrorPath, { recursive: true, force: true });
      }

      if (!localGitDir && !existsSync(mirrorPath)) {
        this.operations.update({
          operationId,
          phase: "clone",
          message: "Cloning bare repository mirror",
          percent: 10,
          done: false,
          cancelled: false
        });
        try {
          await this.runGit(["clone", "--bare", "--no-progress", this.cloneUrl(input.repository), mirrorPath], {
            operationId,
            env: gitEnv,
            timeoutMs: GIT_NETWORK_TIMEOUT_MS
          });
        } catch (error) {
          await rm(mirrorPath, { recursive: true, force: true });
          throw error;
        }
      }

      this.operations.assertNotCancelled(operationId);
      this.operations.update({
        operationId,
        phase: "fetch",
        message: "Fetching pull request refs",
        percent: 40,
        done: false,
        cancelled: false
      });

      const remote = localGitDir
        ? await this.resolveRemoteName(localGitDir, input.repository)
        : "origin";

      await this.runGit(
        ["--git-dir", effectiveGitDir, "fetch", remote, `refs/heads/${input.baseRef}:refs/krt/base/${input.number}`],
        {
          allowFailure: true,
          operationId,
          env: gitEnv,
          timeoutMs: GIT_NETWORK_TIMEOUT_MS
        }
      );
      await this.runGit(
        ["--git-dir", effectiveGitDir, "fetch", remote, `pull/${input.number}/head:refs/krt/head/${input.number}`],
        {
          allowFailure: true,
          operationId,
          env: gitEnv,
          timeoutMs: GIT_NETWORK_TIMEOUT_MS
        }
      );
      await this.runGit(["--git-dir", effectiveGitDir, "fetch", remote, input.headSha], {
        allowFailure: true,
        operationId,
        env: gitEnv,
        timeoutMs: GIT_NETWORK_TIMEOUT_MS
      });

      if (!existsSync(worktreePath)) {
        this.operations.assertNotCancelled(operationId);
        this.operations.update({
          operationId,
          phase: "worktree",
          message: "Creating pull request worktree",
          percent: 70,
          done: false,
          cancelled: false
        });

        await this.runGit(worktreeAddArgs(effectiveGitDir, worktreePath, input.headSha), {
          operationId
        });
      }

      this.operations.assertNotCancelled(operationId);
      this.db
        .prepare(
          `INSERT INTO worktrees (provider, owner, repo, number, head_sha, head_ref, base_ref, worktree_path, git_dir, last_used_at, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(provider, owner, repo, number, head_sha)
           DO UPDATE SET head_ref = excluded.head_ref, base_ref = excluded.base_ref, worktree_path = excluded.worktree_path, git_dir = excluded.git_dir, last_used_at = excluded.last_used_at, active = 1`
        )
        .run(
          input.repository.provider,
          input.repository.owner,
          input.repository.name,
          input.number,
          input.headSha,
          input.headRef,
          input.baseRef,
          worktreePath,
          localGitDir ?? null,
          new Date().toISOString()
        );

      this.operations.update({
        operationId,
        phase: "complete",
        message: "Managed checkout is ready",
        percent: 100,
        done: true,
        cancelled: false
      });
      this.watchWorktree(input.repository, input.headSha);
    } catch (error) {
      const signal = this.operations.signal(operationId);
      const cancelled = signal?.aborted || (error instanceof AppError && error.code === "operation_cancelled");
      this.operations.markFailed(
        operationId,
        cancelled ? "Managed checkout was cancelled" : "Managed checkout failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async getLocalFileContent(repository: RepositoryRef, path: string, ref: string): Promise<FileContent | null> {
    const worktreePath = this.getWorktreePath(repository, ref);
    if (!worktreePath) {
      return null;
    }

    const filePath = isAbsolute(path) ? resolve(path) : this.safeWorktreePath(worktreePath, path);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new AppError("local_file_not_file", `${path} is not a file in the managed worktree.`);
    }

    return {
      provider: repository.provider,
      repository,
      path,
      ref,
      contents: await readFile(filePath, "utf8"),
      encoding: "utf-8",
      size: fileStat.size,
      isLarge: fileStat.size > 500_000
    };
  }

  async getLocalFilePatch(repository: RepositoryRef, number: number, path: string, headSha: string): Promise<FilePatch | null> {
    const localGitDir = this.localGitDir(repository);
    const mirrorPath = this.mirrorPath(repository);
    const effectiveGitDir = localGitDir ?? mirrorPath;

    if (!localGitDir && !existsSync(mirrorPath)) {
      return null;
    }

    if (!this.getWorktreePath(repository, headSha)) {
      return null;
    }
    const patch = await this.runGitForOutput(
      [
        "--git-dir",
        effectiveGitDir,
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--find-renames",
        `refs/krt/base/${number}`,
        headSha,
        "--",
        path
      ],
      { allowFailure: true }
    );

    return {
      provider: repository.provider,
      repository,
      pullNumber: number,
      path,
      patch,
      headSha,
      isLarge: patch.length > 250_000
    };
  }

  async loadWorkspaceTree(repository: RepositoryRef, headSha: string): Promise<WorkspaceTree> {
    const worktreePath = this.getWorktreePath(repository, headSha);
    if (!worktreePath) {
      throw new AppError("worktree_not_found", "No managed worktree exists for this head SHA.");
    }

    const workspaceFiles = await this.listWorkspaceFilesForSearch(worktreePath, DEFAULT_WORKSPACE_TREE_MAX_FILES);

    return {
      repository,
      headSha,
      worktreePath,
      paths: workspaceFiles.paths
    };
  }

  async searchWorkspaceText(
    repository: RepositoryRef,
    headSha: string,
    query: string,
    options: { maxResults?: number; maxFiles?: number; maxFileBytes?: number } = {}
  ): Promise<WorkspaceTextSearchResult> {
    const worktreePath = this.getWorktreePath(repository, headSha);
    if (!worktreePath) {
      throw new AppError("worktree_not_found", "No managed worktree exists for this head SHA.");
    }

    const terms = normalizeSearchTerms(query);
    const maxResults = Math.max(1, options.maxResults ?? DEFAULT_TEXT_SEARCH_MAX_RESULTS);

    if (terms.length === 0) {
      return { repository, headSha, query, searchedFiles: 0, skippedFiles: 0, truncated: false, results: [] };
    }

    // Use `git grep` over the whole worktree rather than a bounded manual walk.
    // The previous JS walk read files itself and capped scanning at a few
    // thousand files, so in a large monorepo it silently missed code that was
    // checked out but never reached. git grep scans every tracked file fast and
    // naturally skips ignored/untracked junk (node_modules, build output, etc.).
    // -n line numbers, -I skip binaries, -i case-insensitive, -F literal terms
    // (so identifiers like `context.WithoutCancel` aren't treated as regex), and
    // --all-match requires every term to appear in a file (mirrors the prior
    // file-level AND).
    const grepArgs = ["-C", worktreePath, "grep", "-n", "-I", "-i", "-F", "--no-color"];
    if (terms.length > 1) {
      grepArgs.push("--all-match");
    }
    for (const term of terms) {
      grepArgs.push("-e", term);
    }
    // allowFailure: git grep exits non-zero when there are no matches (1) or when
    // the worktree is not a git repo (128); both surface here as empty output.
    const output = await this.runGitForOutput(grepArgs, { allowFailure: true });

    const byPath = new Map<string, Array<{ lineNumber: number; lineText: string }>>();
    let truncated = false;
    for (const rawLine of output.split("\n")) {
      if (!rawLine) {
        continue;
      }
      // Format: <path>:<lineNumber>:<lineText>. Split on the first two colons so
      // colons inside the matched line are preserved.
      const firstColon = rawLine.indexOf(":");
      const secondColon = firstColon < 0 ? -1 : rawLine.indexOf(":", firstColon + 1);
      if (firstColon < 0 || secondColon < 0) {
        continue;
      }
      const path = rawLine.slice(0, firstColon);
      const lineNumber = Number(rawLine.slice(firstColon + 1, secondColon));
      if (!Number.isInteger(lineNumber)) {
        continue;
      }
      let matches = byPath.get(path);
      if (!matches) {
        if (byPath.size >= maxResults) {
          truncated = true;
          break;
        }
        matches = [];
        byPath.set(path, matches);
      }
      // Keep a few representative lines per file, as the prior implementation did.
      if (matches.length < 3) {
        matches.push({ lineNumber, lineText: truncateSearchSnippet(rawLine.slice(secondColon + 1).trim()) });
      }
    }

    const results: WorkspaceTextSearchResult["results"] = [...byPath.entries()].map(([path, matches]) => ({ path, matches }));
    return {
      repository,
      headSha,
      query,
      // searchedFiles now reports files with matches; git grep scans the whole
      // tree, so a per-file "scanned" count is no longer meaningful.
      searchedFiles: results.length,
      skippedFiles: 0,
      truncated,
      results
    };
  }

  getWorktreePath(repository: RepositoryRef, headSha: string): string | null {
    const row = this.db
      .prepare(
        `SELECT worktree_path FROM worktrees
         WHERE provider = ? AND owner = ? AND repo = ? AND head_sha = ?
         ORDER BY last_used_at DESC
         LIMIT 1`
      )
      .get(repository.provider, repository.owner, repository.name, headSha) as { worktree_path: string } | undefined;

    if (!row || !existsSync(row.worktree_path)) {
      return null;
    }

    this.db
      .prepare(
        `UPDATE worktrees SET last_used_at = ?
         WHERE provider = ? AND owner = ? AND repo = ? AND head_sha = ?`
      )
      .run(new Date().toISOString(), repository.provider, repository.owner, repository.name, headSha);

    return row.worktree_path;
  }

  releaseWorktree(repository: RepositoryRef, headSha: string): { released: boolean } {
    const result = this.db
      .prepare(
        `UPDATE worktrees SET active = 0, last_used_at = ?
         WHERE provider = ? AND owner = ? AND repo = ? AND head_sha = ?`
      )
      .run(new Date().toISOString(), repository.provider, repository.owner, repository.name, headSha);

    if (result.changes > 0) {
      this.stopWatchingWorktree(repository, headSha);
    }

    return { released: result.changes > 0 };
  }

  private async removeWorktreeFiles(worktree: ManagedWorktree): Promise<void> {
    // When a worktree was created from a user-managed local repo we must tell
    // git to unregister it first; a plain rm -rf leaves stale entries in the
    // local repo's worktree list.
    if (worktree.gitDir) {
      if (existsSync(worktree.worktreePath)) {
        await this.runGitForOutput(
          ["--git-dir", worktree.gitDir, "worktree", "remove", "--force", worktree.worktreePath],
          { allowFailure: true }
        );
        // If the git dir was moved or deleted the command fails silently.
        // Fall back to a plain recursive delete so the directory is never
        // left orphaned with no way for later cleanup to find it.
        if (existsSync(worktree.worktreePath)) {
          await rm(worktree.worktreePath, { recursive: true, force: true });
        }
      } else {
        // Path already gone — prune stale worktree entry from the git index.
        await this.runGitForOutput(
          ["--git-dir", worktree.gitDir, "worktree", "prune"],
          { allowFailure: true }
        );
      }
    } else if (this.isInsideWorktreeRoot(worktree.worktreePath)) {
      await rm(worktree.worktreePath, { recursive: true, force: true });
    }
  }


  async deleteWorktree(input: {
    repository: RepositoryRef;
    number: number;
    headSha: string;
  }): Promise<{ deleted: boolean; worktree: ManagedWorktree | null }> {
    const worktrees = await this.listManagedWorktrees(input.repository);
    const worktree = worktrees.find(
      (candidate) => candidate.number === input.number && candidate.headSha === input.headSha
    );
    if (!worktree) {
      return { deleted: false, worktree: null };
    }

    await this.removeWorktreeFiles(worktree);

    const result = this.db
      .prepare(
        `DELETE FROM worktrees
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?`
      )
      .run(
        input.repository.provider,
        input.repository.owner,
        input.repository.name,
        input.number,
        input.headSha
      );
    this.stopWatchingWorktree(input.repository, input.headSha);

    return { deleted: result.changes > 0, worktree };
  }

  watchWorktree(repository: RepositoryRef, headSha: string): boolean {
    const key = worktreeWatchKey(repository, headSha);
    if (this.watchers.has(key)) {
      return true;
    }

    const worktreePath = this.getWorktreePath(repository, headSha);
    if (!worktreePath) {
      return false;
    }

    try {
      const watcher = this.watchFactory(worktreePath, (eventType, filename) => {
        this.emitWorkspaceFileChange(repository, headSha, worktreePath, eventType, filename);
      });
      watcher.on("error", () => this.stopWatchingWorktree(repository, headSha));
      this.watchers.set(key, watcher);
      return true;
    } catch {
      return false;
    }
  }

  async listManagedWorktrees(repository?: RepositoryRef): Promise<ManagedWorktree[]> {
    const rows = repository
      ? (this.db
          .prepare(
            `SELECT provider, owner, repo, number, head_sha, head_ref, base_ref, worktree_path, git_dir, last_used_at, active
             FROM worktrees
             WHERE provider = ? AND owner = ? AND repo = ?
             ORDER BY last_used_at DESC`
          )
          .all(repository.provider, repository.owner, repository.name) as WorktreeRow[])
      : (this.db
          .prepare(
            `SELECT provider, owner, repo, number, head_sha, head_ref, base_ref, worktree_path, git_dir, last_used_at, active
             FROM worktrees
             ORDER BY last_used_at DESC`
          )
          .all() as WorktreeRow[]);

    return Promise.all(rows.map((row) => this.mapWorktreeRow(row)));
  }

  async cleanupWorktrees(input: {
    repository?: RepositoryRef;
    maxEntries?: number;
    maxBytes?: number;
    dryRun?: boolean;
  }): Promise<WorktreeCleanupResult> {
    const dryRun = input.dryRun ?? false;
    const worktrees = await this.listManagedWorktrees(input.repository);
    const active = worktrees.filter((worktree) => worktree.active);
    const inactiveOldestFirst = worktrees
      .filter((worktree) => !worktree.active)
      .sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt));
    const deleteSet = new Set<string>();

    if (input.maxEntries !== undefined) {
      const inactiveToKeep = Math.max(0, input.maxEntries - active.length);
      for (const worktree of inactiveOldestFirst.slice(0, Math.max(0, inactiveOldestFirst.length - inactiveToKeep))) {
        deleteSet.add(worktreeKey(worktree));
      }
    }

    if (input.maxBytes !== undefined) {
      let projectedBytes = worktrees.reduce((sum, worktree) => sum + worktree.sizeBytes, 0);
      for (const worktree of inactiveOldestFirst) {
        if (projectedBytes <= input.maxBytes) {
          break;
        }
        deleteSet.add(worktreeKey(worktree));
        projectedBytes -= worktree.sizeBytes;
      }
    }

    const deleted = worktrees.filter((worktree) => deleteSet.has(worktreeKey(worktree)));
    const retained = worktrees.filter((worktree) => !deleteSet.has(worktreeKey(worktree)));

    if (!dryRun) {
      for (const worktree of deleted) {
        await this.removeWorktreeFiles(worktree);
        this.db
          .prepare(
            `DELETE FROM worktrees
             WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?`
          )
          .run(
            worktree.repository.provider,
            worktree.repository.owner,
            worktree.repository.name,
            worktree.number,
            worktree.headSha
          );
        this.stopWatchingWorktree(worktree.repository, worktree.headSha);
      }
    }

    return {
      deleted,
      retained,
      deletedCount: deleted.length,
      retainedCount: retained.length,
      freedBytes: deleted.reduce((sum, worktree) => sum + worktree.sizeBytes, 0),
      dryRun
    };
  }

  private safeWorktreePath(worktreePath: string, path: string): string {
    const root = resolve(worktreePath);
    const candidate = resolve(root, path);
    const relativePath = relative(root, candidate);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new AppError("invalid_worktree_path", "The requested path escapes the managed worktree.");
    }
    return candidate;
  }

  private async listWorkspaceFilesForSearch(
    worktreePath: string,
    maxFiles: number
  ): Promise<{ paths: string[]; skippedFiles: number; truncated: boolean }> {
    const paths: string[] = [];
    let skippedFiles = 0;
    let truncated = false;
    const stack = [""];

    while (stack.length > 0) {
      const relativeDirectory = stack.pop() ?? "";
      const absoluteDirectory = this.safeWorktreePath(worktreePath, relativeDirectory);
      let entries: Dirent[];
      try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch {
        skippedFiles += 1;
        continue;
      }

      for (const entry of entries) {
        const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
        if (entry.isDirectory()) {
          if (!SEARCH_IGNORED_DIRECTORIES.has(entry.name)) {
            stack.push(relativePath);
          }
          continue;
        }
        if (!entry.isFile()) {
          skippedFiles += 1;
          continue;
        }
        if (paths.length >= maxFiles) {
          truncated = true;
          break;
        }
        paths.push(relativePath);
      }
      if (truncated) {
        break;
      }
    }

    return { paths: paths.sort((left, right) => left.localeCompare(right)), skippedFiles, truncated };
  }

  private mirrorPath(repository: RepositoryRef): string {
    return join(this.repoRoot(repository), "mirror.git");
  }

  private repoRoot(repository: RepositoryRef): string {
    const roots = this.managedStorageRoots();
    return join(roots.repos, repository.provider, repository.owner, repository.name);
  }

  private worktreeRoot(repository: RepositoryRef): string {
    const roots = this.managedStorageRoots();
    return join(roots.worktrees, repository.provider, repository.owner, repository.name);
  }

  private worktreePath(repository: RepositoryRef, number: number, headSha: string): string {
    return join(this.worktreeRoot(repository), `${number}-${headSha.slice(0, 12)}`);
  }

  private cloneUrl(repository: RepositoryRef): string {
    return `https://github.com/${repository.owner}/${repository.name}.git`;
  }

  private async mapWorktreeRow(row: WorktreeRow): Promise<ManagedWorktree> {
    const cachedMetadata = this.cachedWorktreeMetadata(row);
    return {
      repository: {
        provider: row.provider,
        owner: row.owner,
        name: row.repo,
        fullName: `${row.owner}/${row.repo}`
      },
      number: row.number,
      headSha: row.head_sha,
      worktreePath: row.worktree_path,
      lastUsedAt: row.last_used_at,
      active: row.active === 1,
      sizeBytes: await this.directorySize(row.worktree_path),
      title: cachedMetadata.title,
      headRef: stringValue(row.head_ref) ?? cachedMetadata.headRef,
      baseRef: stringValue(row.base_ref) ?? cachedMetadata.baseRef,
      gitDir: stringValue(row.git_dir) ?? null
    };
  }

  private cachedWorktreeMetadata(row: WorktreeRow): Pick<ManagedWorktree, "title" | "headRef" | "baseRef"> {
    const cacheRow = this.db
      .prepare(
        `SELECT payload FROM pr_cache
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?
         LIMIT 1`
      )
      .get(row.provider, row.owner, row.repo, row.number, row.head_sha) as { payload: string } | undefined;
    if (!cacheRow) {
      return {};
    }

    try {
      const detail = (JSON.parse(cacheRow.payload) as { detail?: Record<string, unknown> }).detail;
      return {
        title: stringValue(detail?.title),
        headRef: stringValue(detail?.headRef),
        baseRef: stringValue(detail?.baseRef)
      };
    } catch {
      return {};
    }
  }

  private async directorySize(path: string): Promise<number> {
    try {
      const entry = await lstat(path);
      if (entry.isFile()) {
        return entry.size;
      }
      if (!entry.isDirectory()) {
        return 0;
      }
      const children = await readdir(path);
      const sizes = await Promise.all(children.map((child) => this.directorySize(join(path, child))));
      return sizes.reduce((sum, size) => sum + size, 0);
    } catch {
      return 0;
    }
  }

  private isInsideWorktreeRoot(path: string): boolean {
    const root = resolve(this.managedStorageRoots().worktrees);
    const candidate = resolve(path);
    const relativePath = relative(root, candidate);
    return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  }

  private managedStorageRoots(): { repos: string; worktrees: string } {
    const root = this.getSettings?.().data.managedRepoStorage;
    if (!root) {
      return {
        repos: this.appPaths.repos,
        worktrees: this.appPaths.worktrees
      };
    }

    const resolvedRoot = resolve(root);
    return {
      repos: join(resolvedRoot, "repos"),
      worktrees: join(resolvedRoot, "worktrees")
    };
  }

  private stopWatchingWorktree(repository: RepositoryRef, headSha: string): void {
    const key = worktreeWatchKey(repository, headSha);
    const watcher = this.watchers.get(key);
    if (!watcher) {
      return;
    }
    watcher.close();
    this.watchers.delete(key);
  }

  private emitWorkspaceFileChange(
    repository: RepositoryRef,
    headSha: string,
    worktreePath: string,
    eventType: WatchEventType,
    filename: string | Buffer | null
  ): void {
    const change = {
      repository,
      headSha,
      worktreePath,
      path: normalizeWatchedPath(worktreePath, filename),
      eventType,
      changedAt: new Date().toISOString()
    };

    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(workspaceFileChangeEvent, change);
      }
    }
  }

  private async gitNetworkEnvironment(repository: RepositoryRef): Promise<NodeJS.ProcessEnv> {
    let token: string | null = null;
    if (repository.provider === "github" && this.getGitHubToken) {
      token = await this.getGitHubToken();
    }
    return buildGitEnvironment(process.env, repository, token);
  }

  private async runGit(
    args: string[],
    options: GitCommandOptions = {}
  ): Promise<void> {
    const signal = options.operationId ? this.operations.signal(options.operationId) : undefined;
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    try {
      await execFileAsync("git", args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 10,
        signal,
        env: options.env
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError("operation_cancelled", "The git operation was cancelled.", { retryable: true });
      }
      if (!options.allowFailure) {
        throw new AppError("git_command_failed", formatGitCommandError(args, error, timeoutMs), {
          retryable: isRetryableGitError(error)
        });
      }
    }
  }

  private async runGitForOutput(args: string[], options: GitCommandOptions = {}): Promise<string> {
    const signal = options.operationId ? this.operations.signal(options.operationId) : undefined;
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    try {
      const result = await execFileAsync("git", args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 20,
        signal,
        env: options.env
      });
      return result.stdout;
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError("operation_cancelled", "The git operation was cancelled.", { retryable: true });
      }
      if (options.allowFailure) {
        return "";
      }
      throw new AppError("git_command_failed", formatGitCommandError(args, error, timeoutMs), {
        retryable: isRetryableGitError(error)
      });
    }
  }

  private async isUsableMirror(mirrorPath: string): Promise<boolean> {
    try {
      await this.runGitForOutput(["--git-dir", mirrorPath, "rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }
}

export function buildGitEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  repository: RepositoryRef,
  token: string | null | undefined
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: "0"
  };

  if (repository.provider !== "github" || !token) {
    return env;
  }

  const configIndex = parseGitConfigCount(env.GIT_CONFIG_COUNT);
  const credential = Buffer.from(`x-access-token:${token}`).toString("base64");
  env.GIT_CONFIG_COUNT = String(configIndex + 1);
  env[`GIT_CONFIG_KEY_${configIndex}`] = "http.https://github.com/.extraheader";
  env[`GIT_CONFIG_VALUE_${configIndex}`] = `AUTHORIZATION: basic ${credential}`;
  return env;
}

export function worktreeAddArgs(mirrorPath: string, worktreePath: string, headSha: string): string[] {
  return ["--git-dir", mirrorPath, "worktree", "add", "--force", "--detach", worktreePath, headSha];
}

interface GitExecError {
  message?: string;
  stderr?: string;
  stdout?: string;
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
}

export function formatGitCommandError(args: readonly string[], error: unknown, timeoutMs: number): string {
  const execError = error as GitExecError;
  const action = gitActionLabel(args);
  if (execError.killed && execError.signal === "SIGTERM") {
    return `Git ${action} timed out after ${formatDuration(timeoutMs)}.`;
  }

  const detail = actionableGitErrorLine(execError);
  if (detail) {
    return `Git ${action} failed: ${detail}`;
  }

  if (execError.code != null) {
    return `Git ${action} failed with exit code ${execError.code}.`;
  }

  return `Git ${action} failed.`;
}

function actionableGitErrorLine(error: GitExecError): string | null {
  const lines = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const actionable = lines
    .filter((line) => !isGitProgressLine(line))
    .filter((line) => !/^Command failed:/i.test(line));
  const preferred = actionable.findLast((line) =>
    /^(fatal|error):|authentication failed|could not read|permission denied|repository not found|not found|timed out|operation timed out|could not resolve|connection/i.test(line)
  );
  const line = preferred ?? actionable.at(-1) ?? null;
  return line?.replace(/^(fatal|error):\s*/i, "") ?? null;
}

function isGitProgressLine(line: string): boolean {
  return (
    /^Cloning into /i.test(line) ||
    /^remote: /i.test(line) ||
    /^(Receiving objects|Resolving deltas|Updating files|Compressing objects|Counting objects):/i.test(line) ||
    /^From https?:\/\//i.test(line)
  );
}

function isRetryableGitError(error: unknown): boolean {
  const execError = error as GitExecError;
  if (execError.killed && execError.signal === "SIGTERM") {
    return true;
  }
  const text = `${execError.stderr ?? ""}\n${execError.stdout ?? ""}\n${execError.message ?? ""}`;
  return /timed out|operation timed out|connection reset|connection refused|could not resolve|network/i.test(text);
}

function gitActionLabel(args: readonly string[]): string {
  const offset = args[0] === "--git-dir" ? 2 : 0;
  const command = args[offset] ?? "command";
  if (command === "worktree" && args[offset + 1]) {
    return `worktree ${args[offset + 1]}`;
  }
  return command;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = Math.round(milliseconds / 1_000);
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function parseGitConfigCount(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeSearchTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function truncateSearchSnippet(value: string): string {
  if (value.length <= TEXT_SEARCH_MAX_SNIPPET_LENGTH) {
    return value;
  }
  return `${value.slice(0, TEXT_SEARCH_MAX_SNIPPET_LENGTH - 3)}...`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

type WorktreeRow = {
  provider: "github";
  owner: string;
  repo: string;
  number: number;
  head_sha: string;
  head_ref: string | null;
  base_ref: string | null;
  worktree_path: string;
  git_dir: string | null;
  last_used_at: string;
  active: number;
};

function worktreeKey(worktree: ManagedWorktree): string {
  return `${worktree.repository.provider}:${worktree.repository.fullName}:${worktree.number}:${worktree.headSha}`;
}

function worktreeWatchKey(repository: RepositoryRef, headSha: string): string {
  return `${repository.provider}:${repository.fullName}:${headSha}`;
}

function normalizeWatchedPath(worktreePath: string, filename: string | Buffer | null): string | null {
  if (!filename) {
    return null;
  }

  const rawPath = filename.toString();
  const root = resolve(worktreePath);
  const candidate = resolve(root, rawPath);
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return relativePath.replace(/\\/g, "/");
}

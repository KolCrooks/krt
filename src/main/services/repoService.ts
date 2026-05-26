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
const DEFAULT_TEXT_SEARCH_MAX_FILES = 2_000;
const DEFAULT_TEXT_SEARCH_MAX_FILE_BYTES = 200_000;
const TEXT_SEARCH_MAX_SNIPPET_LENGTH = 180;

type WatchEventType = "rename" | "change";
type WatchFactory = (
  path: string,
  listener: (eventType: WatchEventType, filename: string | Buffer | null) => void
) => Pick<FSWatcher, "close" | "on">;

export class RepoService {
  private readonly watchers = new Map<string, Pick<FSWatcher, "close" | "on">>();
  private readonly windows = new Set<BrowserWindow>();
  private readonly watchFactory: WatchFactory;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly db: SqliteDatabase,
    private readonly operations: OperationService,
    options: { getSettings?: () => AppSettings; watchFactory?: WatchFactory } = {}
  ) {
    this.getSettings = options.getSettings;
    this.watchFactory =
      options.watchFactory ??
      ((path, listener) =>
        watch(path, { recursive: true }, (eventType, filename) =>
          listener(eventType === "change" || eventType === "rename" ? eventType : "change", filename)
        ));
  }

  private readonly getSettings?: () => AppSettings;

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

      if (!existsSync(mirrorPath)) {
        this.operations.update({
          operationId,
          phase: "clone",
          message: "Cloning bare repository mirror",
          percent: 10,
          done: false,
          cancelled: false
        });
        await this.runGit(["clone", "--bare", this.cloneUrl(input.repository), mirrorPath], { operationId });
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

      await this.runGit(["--git-dir", mirrorPath, "fetch", "origin", `refs/heads/${input.baseRef}:refs/krt/base/${input.number}`], {
        allowFailure: true,
        operationId
      });
      await this.runGit(["--git-dir", mirrorPath, "fetch", "origin", `pull/${input.number}/head:refs/krt/head/${input.number}`], {
        allowFailure: true,
        operationId
      });
      await this.runGit(["--git-dir", mirrorPath, "fetch", "origin", input.headSha], { allowFailure: true, operationId });

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
        await this.runGit(["--git-dir", mirrorPath, "worktree", "add", "--detach", worktreePath, input.headSha], {
          operationId
        });
      }

      this.operations.assertNotCancelled(operationId);
      this.db
        .prepare(
          `INSERT INTO worktrees (provider, owner, repo, number, head_sha, head_ref, base_ref, worktree_path, last_used_at, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(provider, owner, repo, number, head_sha)
           DO UPDATE SET head_ref = excluded.head_ref, base_ref = excluded.base_ref, worktree_path = excluded.worktree_path, last_used_at = excluded.last_used_at, active = 1`
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
    const mirrorPath = this.mirrorPath(repository);
    if (!existsSync(mirrorPath)) {
      return null;
    }

    if (!this.getWorktreePath(repository, headSha)) {
      return null;
    }
    const patch = await this.runGitForOutput(
      [
        "--git-dir",
        mirrorPath,
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
    const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_TEXT_SEARCH_MAX_FILES);
    const maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_TEXT_SEARCH_MAX_FILE_BYTES);
    const workspaceFiles = await this.listWorkspaceFilesForSearch(worktreePath, maxFiles);
    const results: WorkspaceTextSearchResult["results"] = [];
    let searchedFiles = 0;
    let skippedFiles = workspaceFiles.skippedFiles;
    let truncated = workspaceFiles.truncated;

    if (terms.length === 0) {
      return {
        repository,
        headSha,
        query,
        searchedFiles: 0,
        skippedFiles,
        truncated,
        results: []
      };
    }

    for (const path of workspaceFiles.paths) {
      if (results.length >= maxResults) {
        truncated = true;
        break;
      }

      try {
        const filePath = this.safeWorktreePath(worktreePath, path);
        const fileStat = await stat(filePath);
        if (!fileStat.isFile() || fileStat.size > maxFileBytes) {
          skippedFiles += 1;
          continue;
        }

        const contents = await readFile(filePath, "utf8");
        if (contents.includes("\0")) {
          skippedFiles += 1;
          continue;
        }
        searchedFiles += 1;

        const matches = findTextMatches(contents, terms);
        if (matches.length > 0) {
          results.push({ path, matches });
        }
      } catch {
        skippedFiles += 1;
      }
    }

    return {
      repository,
      headSha,
      query,
      searchedFiles,
      skippedFiles,
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

    if (this.isInsideWorktreeRoot(worktree.worktreePath)) {
      await rm(worktree.worktreePath, { recursive: true, force: true });
    }

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
            `SELECT provider, owner, repo, number, head_sha, head_ref, base_ref, worktree_path, last_used_at, active
             FROM worktrees
             WHERE provider = ? AND owner = ? AND repo = ?
             ORDER BY last_used_at DESC`
          )
          .all(repository.provider, repository.owner, repository.name) as WorktreeRow[])
      : (this.db
          .prepare(
            `SELECT provider, owner, repo, number, head_sha, head_ref, base_ref, worktree_path, last_used_at, active
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
        if (this.isInsideWorktreeRoot(worktree.worktreePath)) {
          await rm(worktree.worktreePath, { recursive: true, force: true });
        }
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
      baseRef: stringValue(row.base_ref) ?? cachedMetadata.baseRef
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

  private async runGit(args: string[], options: { allowFailure?: boolean; operationId?: string } = {}): Promise<void> {
    const signal = options.operationId ? this.operations.signal(options.operationId) : undefined;
    try {
      await execFileAsync("git", args, {
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 10,
        signal
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError("operation_cancelled", "The git operation was cancelled.", { retryable: true });
      }
      if (!options.allowFailure) {
        throw error;
      }
    }
  }

  private async runGitForOutput(args: string[], options: { allowFailure?: boolean; operationId?: string } = {}): Promise<string> {
    const signal = options.operationId ? this.operations.signal(options.operationId) : undefined;
    try {
      const result = await execFileAsync("git", args, {
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 20,
        signal
      });
      return result.stdout;
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError("operation_cancelled", "The git operation was cancelled.", { retryable: true });
      }
      if (options.allowFailure) {
        return "";
      }
      throw error;
    }
  }
}

function normalizeSearchTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function findTextMatches(contents: string, terms: readonly string[]): Array<{ lineNumber: number; lineText: string }> {
  if (terms.length === 0 || !terms.every((term) => contents.toLowerCase().includes(term))) {
    return [];
  }

  const matches: Array<{ lineNumber: number; lineText: string }> = [];
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length && matches.length < 3; index += 1) {
    const line = lines[index] ?? "";
    const searchableLine = line.toLowerCase();
    if (!terms.some((term) => searchableLine.includes(term))) {
      continue;
    }
    matches.push({
      lineNumber: index + 1,
      lineText: truncateSearchSnippet(line.trim())
    });
  }

  return matches;
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

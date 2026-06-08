import { spawn, type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { AppError } from "../errors.js";
import type {
  LspDefinition,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspPosition,
  LspRange,
  LspServerActivity,
  LspServerStatus,
  LspSession,
  RepositoryRef,
  ExtensionDescriptor
} from "../../shared/schemas.js";
import type { RepoService } from "./repoService.js";
import type { ExtensionService } from "./extensionService.js";

const execFileAsync = promisify(execFile);

// find-references can be slow on a freshly-opened workspace; cap it so blast-
// radius computation degrades to "unknown" rather than hanging the agent.
const REFERENCES_TIMEOUT_MS = 10_000;

type LspCapability = LspSession["capabilities"][number];

interface ProcessHandle {
  extensionId: string;
  extension: ExtensionDescriptor;
  process: ChildProcessWithoutNullStreams;
  client: LspJsonRpcClient;
  worktreePath: string;
  openedUris: Set<string>;
  diagnosticsByUri: Map<string, LspDiagnostic[]>;
  progressByToken: Map<string, LspServerActivity>;
  serverStatus?: LspServerStatus;
  session: InternalSession;
}

interface InternalSession {
  session: LspSession;
  processes: ProcessHandle[];
}

export class LspService {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly startingSessions = new Map<string, Promise<LspSession>>();

  constructor(
    private readonly repos: RepoService,
    private readonly extensions: ExtensionService
  ) {}

  async startForWorktree(repository: RepositoryRef, headSha: string, paths?: string[]): Promise<LspSession> {
    const worktreePath = this.repos.getWorktreePath(repository, headSha);
    if (!worktreePath) {
      throw new AppError("lsp_requires_managed_worktree", "LSP is available only after a managed checkout.");
    }

    const key = this.key(repository, headSha);
    const activationPaths = normalizeActivationPaths(paths);
    const existing = this.sessions.get(key);
    const starting = this.startingSessions.get(key);
    if (existing && existing.session.status !== "stopped") {
      if (existing.session.status === "starting" && starting) {
        await starting;
        const started = this.sessions.get(key);
        if (started && activationPaths.length > 0) {
          await this.startMissingExtensions(started, worktreePath, activationPaths);
          return started.session;
        }
        return this.sessions.get(key)?.session ?? existing.session;
      }
      if (existing.session.status === "degraded" && existing.processes.length === 0) {
        this.disposeSession(existing);
        this.sessions.delete(key);
      } else {
        if (activationPaths.length > 0) {
          await this.startMissingExtensions(existing, worktreePath, activationPaths);
        }
        return existing.session;
      }
    }

    if (starting) {
      return starting;
    }

    const start = this.startSession(repository, headSha, key, worktreePath, activationPaths);
    this.startingSessions.set(key, start);
    try {
      return await start;
    } finally {
      this.startingSessions.delete(key);
    }
  }

  private async startSession(
    repository: RepositoryRef,
    headSha: string,
    key: string,
    worktreePath: string,
    activationPaths: string[] = []
  ): Promise<LspSession> {
    const treePaths = activationPaths.length > 0
      ? activationPaths
      : await this.getWorkspacePaths(repository, headSha, worktreePath);
    const matchingExtensions = this.matchingExtensionsForPaths(treePaths);

    const session: InternalSession = {
      session: {
        id: randomUUID(),
        repository,
        headSha,
        worktreePath,
        status: "starting",
        activeExtensions: [],
        unavailableExtensions: [],
        capabilities: [],
        startedAt: new Date().toISOString()
      },
      processes: []
    };
    this.sessions.set(key, session);

    for (const extension of matchingExtensions) {
      await this.startExtension(session, extension, worktreePath);
    }

    if (matchingExtensions.length === 0) {
      session.session.unavailableExtensions.push({
        id: "language-server",
        reason: activationPaths.length > 0
          ? "No built-in language server extension matched the requested files."
          : "No built-in language server extension matched the workspace files."
      });
    }
    this.refreshSessionStatus(session);

    return session.session;
  }

  private matchingExtensionsForPaths(paths: string[]): ExtensionDescriptor[] {
    return this.extensions
      .list()
      .filter((extension) =>
        extension.enabled &&
        extension.contributes?.lsp &&
        extension.activationGlobs.some((glob) => paths.some((path) => matchesGlob(glob, path)))
      );
  }

  private async startMissingExtensions(session: InternalSession, worktreePath: string, paths: string[]): Promise<void> {
    const existingExtensionIds = new Set([
      ...session.session.activeExtensions,
      ...session.session.unavailableExtensions.map((extension) => extension.id)
    ]);
    const matchingExtensions = this.matchingExtensionsForPaths(paths)
      .filter((extension) => !existingExtensionIds.has(extension.id));
    if (matchingExtensions.length === 0) {
      return;
    }

    session.session.unavailableExtensions = session.session.unavailableExtensions
      .filter((extension) => extension.id !== "language-server");
    for (const extension of matchingExtensions) {
      await this.startExtension(session, extension, worktreePath);
    }
    this.refreshSessionStatus(session);
  }

  private async startExtension(session: InternalSession, extension: ExtensionDescriptor, worktreePath: string): Promise<void> {
    const lsp = extension.contributes?.lsp;
    if (!lsp) {
      return;
    }

    addCapabilities(session.session, extension);
    const resolvedCommand = await resolveCommand(lsp.command.program);
    if (!resolvedCommand) {
      session.session.unavailableExtensions.push({
        id: extension.id,
        reason: `${lsp.command.program} is not installed or not on PATH.`
      });
      this.extensions.appendLog({
        extensionId: extension.id,
        level: "warning",
        message: `${lsp.command.program} is not available; language-server features are unavailable.`
      });
      return;
    }

    this.extensions.appendLog({
      extensionId: extension.id,
      level: "info",
      message: `Starting language server ${resolvedCommand.program} ${lsp.command.args.join(" ")} in ${worktreePath}.`
    });
    const childProcess = spawn(resolvedCommand.program, lsp.command.args, {
      cwd: worktreePath,
      stdio: "pipe",
      env: resolvedCommand.env,
      detached: false,
      shell: false,
      windowsHide: true
    });
    let stderrTail = "";
    let handle: ProcessHandle | null = null;
    const lspSettings = lsp.settings ?? lsp.initializationOptions ?? {};
    const initializationOptions = lsp.initializationOptions ?? lsp.settings;
    const client = new LspJsonRpcClient(
      childProcess,
      (message) => {
        if (handle) {
          this.handleLspNotification(handle, message);
        }
      },
      lspSettings,
      extension.id
    );
    handle = {
      extensionId: extension.id,
      extension,
      process: childProcess,
      client,
      worktreePath,
      openedUris: new Set(),
      diagnosticsByUri: new Map(),
      progressByToken: new Map(),
      session
    };

    childProcess.once("exit", (code, signal) => {
      if (handle) {
        handle.progressByToken.clear();
        session.processes = session.processes.filter((candidate) => candidate !== handle);
        this.refreshSessionActivity(session);
        if (session.session.status !== "stopped") {
          session.session.activeExtensions = session.session.activeExtensions.filter((id) => id !== extension.id);
          session.session.status = "degraded";
          handle.serverStatus = {
            extensionId: extension.id,
            health: code === 0 ? "warning" : "error",
            quiescent: true,
            message: `Language server exited with code ${code ?? "none"} and signal ${signal ?? "none"}.`,
            updatedAt: new Date().toISOString()
          };
          this.refreshSessionActivity(session);
        }
      }
      this.extensions.appendLog({
        extensionId: extension.id,
        level: code === 0 ? "info" : "warning",
        message: `Language server exited with code ${code ?? "none"} and signal ${signal ?? "none"}.`
      });
    });
    childProcess.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text) {
        return;
      }
      stderrTail = trimLogTail(`${stderrTail}\n${text}`);
      this.extensions.appendLog({
        extensionId: extension.id,
        level: "warning",
        message: `Language server stderr: ${trimLogLine(text)}`
      });
    });
    childProcess.once("error", (error) => {
      this.extensions.appendLog({
        extensionId: extension.id,
        level: "error",
        message: error.message
      });
    });

    try {
      await client.initialize(worktreePath, initializationOptions);
      client.notify("initialized", {});
      session.processes.push(handle);
      this.refreshSessionActivity(session);
      session.session.activeExtensions.push(extension.id);
      this.extensions.appendLog({
        extensionId: extension.id,
        level: "info",
        message: `Language server initialized with root ${pathToFileURL(worktreePath).href}.`
      });
    } catch (error) {
      client.dispose();
      if (!childProcess.killed) {
        childProcess.kill();
      }
      const detail = error instanceof Error ? error.message : String(error);
      const stderrDetail = stderrTail ? ` Stderr: ${trimLogLine(stderrTail, 500)}` : "";
      session.session.unavailableExtensions.push({
        id: extension.id,
        reason: `Language server did not initialize: ${detail}${stderrDetail}`
      });
      this.extensions.appendLog({
        extensionId: extension.id,
        level: "warning",
        message: `Language server did not initialize: ${detail}${stderrDetail}`
      });
    }
  }

  private refreshSessionStatus(session: InternalSession): void {
    session.session.status =
      session.processes.length > 0 && session.session.unavailableExtensions.length === 0
        ? "ready"
        : "degraded";
  }

  stopForWorktree(repository: RepositoryRef, headSha: string): LspSession | null {
    const session = this.sessions.get(this.key(repository, headSha));
    if (!session) {
      return null;
    }

    this.disposeSession(session);
    session.session.status = "stopped";
    return session.session;
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.disposeSession(session);
      session.session.status = "stopped";
    }
    this.sessions.clear();
    this.startingSessions.clear();
  }

  getSession(repository: RepositoryRef, headSha: string): LspSession | null {
    return this.sessions.get(this.key(repository, headSha))?.session ?? null;
  }

  async restartActiveSessionsForExtension(extensionId: string): Promise<LspSession[]> {
    const targets = new Map<string, { repository: RepositoryRef; headSha: string }>();
    for (const session of this.sessions.values()) {
      if (session.session.status === "stopped") {
        continue;
      }
      targets.set(this.key(session.session.repository, session.session.headSha), {
        repository: session.session.repository,
        headSha: session.session.headSha
      });
    }

    if (targets.size === 0) {
      this.extensions.appendLog({
        extensionId,
        level: "info",
        message: "No active language server sessions to restart."
      });
      return [];
    }

    for (const [key] of targets) {
      await this.startingSessions.get(key)?.catch(() => undefined);
      const session = this.sessions.get(key);
      if (session) {
        this.disposeSession(session);
        this.sessions.delete(key);
      }
    }

    const restarted: LspSession[] = [];
    for (const target of targets.values()) {
      try {
        restarted.push(await this.startForWorktree(target.repository, target.headSha));
      } catch {
        // A worktree can disappear while an extension is being restarted.
      }
    }

    this.extensions.appendLog({
      extensionId,
      level: "info",
      message: `Restarted ${restarted.length} language server session${restarted.length === 1 ? "" : "s"}.`
    });
    return restarted;
  }

  async getDiagnostics(repository: RepositoryRef, headSha: string, path?: string): Promise<LspDiagnostic[]> {
    const worktreePath = this.requireWorktree(repository, headSha);
    const session = await this.getExistingOrStartingSession(repository, headSha);
    if (!path || !session) {
      return [];
    }

    const content = await this.repos.getLocalFileContent(repository, path, headSha);
    return content ? this.getServerDiagnostics(session, worktreePath, path, content.contents) : [];
  }

  async getHover(repository: RepositoryRef, headSha: string, path: string, position: LspPosition): Promise<LspHover | null> {
    const worktreePath = this.requireWorktree(repository, headSha);
    const content = await this.repos.getLocalFileContent(repository, path, headSha);
    if (!content) {
      return null;
    }

    const session = await this.getOrStartSession(repository, headSha, [path]);
    return session
      ? await this.getServerHover(session, worktreePath, path, content.contents, position)
      : null;
  }

  async getDocumentSymbols(repository: RepositoryRef, headSha: string, path: string): Promise<LspDocumentSymbol[]> {
    const worktreePath = this.requireWorktree(repository, headSha);
    const content = await this.repos.getLocalFileContent(repository, path, headSha);
    if (!content || content.isLarge) {
      return [];
    }

    const session = await this.getExistingOrStartingSession(repository, headSha);
    return session
      ? await this.getServerDocumentSymbols(session, worktreePath, path, content.contents)
      : [];
  }

  async getDefinition(repository: RepositoryRef, headSha: string, path: string, position: LspPosition): Promise<LspDefinition | null> {
    const worktreePath = this.requireWorktree(repository, headSha);
    const content = await this.repos.getLocalFileContent(repository, path, headSha);
    if (!content) {
      return null;
    }

    const session = await this.getOrStartSession(repository, headSha, [path]);
    return session
      ? await this.getServerDefinition(session, worktreePath, path, content.contents, position)
      : null;
  }

  // Find the distinct worktree-relative files that reference the symbol at the
  // given position. Used to compute blast radius. Best-effort: returns [] when
  // no language server matches, the symbol is unknown, or the request times out
  // (cross-file references are only complete once the server has indexed).
  async getReferences(repository: RepositoryRef, headSha: string, path: string, position: LspPosition): Promise<string[]> {
    const worktreePath = this.requireWorktree(repository, headSha);
    const content = await this.repos.getLocalFileContent(repository, path, headSha);
    if (!content) {
      return [];
    }

    const session = await this.getOrStartSession(repository, headSha, [path]);
    return session ? await this.getServerReferences(session, worktreePath, path, content.contents, position) : [];
  }

  private requireWorktree(repository: RepositoryRef, headSha: string): string {
    const worktreePath = this.repos.getWorktreePath(repository, headSha);
    if (!worktreePath) {
      throw new AppError("lsp_requires_managed_worktree", "LSP is available only after a managed checkout.");
    }
    return worktreePath;
  }

  private key(repository: RepositoryRef, headSha: string): string {
    return `${repository.provider}:${repository.owner}/${repository.name}:${headSha}`;
  }

  private async getWorkspacePaths(repository: RepositoryRef, headSha: string, worktreePath: string): Promise<string[]> {
    try {
      return (await this.repos.loadWorkspaceTree(repository, headSha)).paths;
    } catch {
      return collectWorkspacePaths(worktreePath);
    }
  }

  private async getOrStartSession(repository: RepositoryRef, headSha: string, paths: string[] = []): Promise<InternalSession | null> {
    const key = this.key(repository, headSha);
    const existing = this.sessions.get(key);
    if (existing && existing.session.status !== "stopped") {
      if (existing.session.status === "starting") {
        await this.startingSessions.get(key);
        const started = this.sessions.get(key) ?? null;
        if (paths.length > 0 && started && started.processes.length > 0) {
          await this.startForWorktree(repository, headSha, paths);
        }
        return this.sessions.get(key) ?? null;
      }
      if (paths.length > 0 && existing.processes.length > 0) {
        await this.startForWorktree(repository, headSha, paths);
      }
      return existing;
    }
    await this.startForWorktree(repository, headSha, paths);
    return this.sessions.get(key) ?? null;
  }

  private async getExistingOrStartingSession(repository: RepositoryRef, headSha: string): Promise<InternalSession | null> {
    const key = this.key(repository, headSha);
    const existing = this.sessions.get(key);
    if (!existing || existing.session.status === "stopped") {
      return null;
    }
    if (existing.session.status === "starting") {
      await this.startingSessions.get(key);
      return this.sessions.get(key) ?? null;
    }
    return existing;
  }

  private async getServerHover(
    session: InternalSession,
    worktreePath: string,
    path: string,
    contents: string,
    position: LspPosition
  ): Promise<LspHover | null> {
    const handle = this.handleForPath(session, path, "hover");
    if (!handle) {
      return null;
    }

    try {
      const uri = this.ensureDocumentOpen(handle, worktreePath, path, contents);
      const result = await handle.client.request("textDocument/hover", {
        textDocument: { uri },
        position
      });
      return hoverFromLspResult(result, handle.extensionId, path, position);
    } catch (error) {
      this.logLspRequestFailure(handle, "hover", error);
      return null;
    }
  }

  private async getServerDefinition(
    session: InternalSession,
    worktreePath: string,
    path: string,
    contents: string,
    position: LspPosition
  ): Promise<LspDefinition | null> {
    const handle = this.handleForPath(session, path, "definition");
    if (!handle) {
      return null;
    }

    try {
      const uri = this.ensureDocumentOpen(handle, worktreePath, path, contents);
      const result = await handle.client.request("textDocument/definition", {
        textDocument: { uri },
        position
      });
      return definitionFromLspResult(result, handle.extensionId, worktreePath);
    } catch (error) {
      this.logLspRequestFailure(handle, "definition", error);
      return null;
    }
  }

  private async getServerReferences(
    session: InternalSession,
    worktreePath: string,
    path: string,
    contents: string,
    position: LspPosition
  ): Promise<string[]> {
    // References and definition are backed by the same servers (e.g. tsserver),
    // so reuse the "definition" capability rather than adding a new feature flag.
    const handle = this.handleForPath(session, path, "definition");
    if (!handle) {
      return [];
    }

    try {
      const uri = this.ensureDocumentOpen(handle, worktreePath, path, contents);
      const result = await handle.client.request(
        "textDocument/references",
        { textDocument: { uri }, position, context: { includeDeclaration: false } },
        REFERENCES_TIMEOUT_MS
      );
      const locations = Array.isArray(result) ? result : [];
      const paths = new Set<string>();
      for (const location of locations) {
        const refUri = stringValue(objectValue(location)?.uri);
        const relativePath = refUri ? pathFromUri(worktreePath, refUri) : null;
        if (relativePath) {
          paths.add(relativePath);
        }
      }
      return [...paths];
    } catch (error) {
      this.logLspRequestFailure(handle, "references", error);
      return [];
    }
  }

  private async getServerDocumentSymbols(
    session: InternalSession,
    worktreePath: string,
    path: string,
    contents: string
  ): Promise<LspDocumentSymbol[]> {
    const handle = this.handleForPath(session, path, "symbols");
    if (!handle) {
      return [];
    }

    try {
      const uri = this.ensureDocumentOpen(handle, worktreePath, path, contents);
      const result = await handle.client.request("textDocument/documentSymbol", {
        textDocument: { uri }
      });
      return documentSymbolsFromLspResult(result, path, worktreePath);
    } catch (error) {
      this.logLspRequestFailure(handle, "document symbols", error);
      return [];
    }
  }

  private async getServerDiagnostics(
    session: InternalSession,
    worktreePath: string,
    path: string,
    contents: string
  ): Promise<LspDiagnostic[]> {
    const handle = this.handleForPath(session, path, "diagnostics");
    if (!handle) {
      return [];
    }

    const uri = this.ensureDocumentOpen(handle, worktreePath, path, contents);
    return handle.diagnosticsByUri.get(uri) ?? [];
  }

  private ensureDocumentOpen(handle: ProcessHandle, worktreePath: string, path: string, contents: string): string {
    const uri = fileUriForWorktreePath(worktreePath, path);
    if (handle.openedUris.has(uri)) {
      return uri;
    }

    handle.client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageIdForPath(path, handle.extension),
        version: 1,
        text: contents
      }
    });
    handle.openedUris.add(uri);
    return uri;
  }

  private handleForPath(session: InternalSession, path: string, feature: LspCapability): ProcessHandle | null {
    return session.processes.find((handle) => {
      const lsp = handle.extension.contributes?.lsp;
      const features = lsp?.features ?? [];
      return features.includes(feature) && handle.extension.activationGlobs.some((glob) => matchesGlob(glob, path));
    }) ?? null;
  }

  private handleLspNotification(handle: ProcessHandle, message: JsonRpcMessage): void {
    if (message.method === "textDocument/publishDiagnostics") {
      const params = objectValue(message.params);
      const uri = stringValue(params?.uri);
      const diagnostics = Array.isArray(params?.diagnostics)
        ? params.diagnostics
            .map((diagnostic, index) => diagnosticFromLspResult(diagnostic, handle.extensionId, handle.worktreePath, uri ?? "", index))
            .filter(isLspDiagnostic)
        : [];
      if (uri) {
        handle.diagnosticsByUri.set(uri, diagnostics);
      }
      return;
    }

    if (message.method === "$/progress") {
      this.handleLspProgress(handle, message);
      return;
    }

    if (message.method === "experimental/serverStatus" || message.method === "rust-analyzer/status") {
      this.handleLspServerStatus(handle, message);
    }
  }

  private handleLspProgress(handle: ProcessHandle, message: JsonRpcMessage): void {
    const params = objectValue(message.params);
    const token = progressToken(params?.token);
    const value = objectValue(params?.value);
    const kind = stringValue(value?.kind);
    if (!token || !value || !kind) {
      return;
    }

    if (kind === "end") {
      handle.progressByToken.delete(token);
      this.refreshSessionActivity(handle.session);
      return;
    }

    const existing = handle.progressByToken.get(token);
    const title = stringValue(value.title) ?? existing?.title ?? "Working";
    const messageText = stringValue(value.message) ?? existing?.message;
    const percentage = progressPercentage(value.percentage) ?? existing?.percentage;
    handle.progressByToken.set(token, {
      extensionId: handle.extensionId,
      title,
      ...(messageText ? { message: messageText } : {}),
      ...(percentage !== undefined ? { percentage } : {}),
      updatedAt: new Date().toISOString()
    });
    this.refreshSessionActivity(handle.session);
  }

  private handleLspServerStatus(handle: ProcessHandle, message: JsonRpcMessage): void {
    const params = objectValue(message.params);
    const health = lspServerHealth(params?.health);
    const quiescent = booleanValue(params?.quiescent);
    if (!health || quiescent === null) {
      return;
    }
    const messageText = stringValue(params?.message);
    handle.serverStatus = {
      extensionId: handle.extensionId,
      health,
      quiescent,
      ...(messageText ? { message: messageText } : {}),
      updatedAt: new Date().toISOString()
    };
    this.refreshSessionActivity(handle.session);
  }

  private refreshSessionActivity(session: InternalSession): void {
    const activities = session.processes
      .flatMap((handle) => [...handle.progressByToken.values()])
      .sort(compareUpdatedAtDesc);
    session.session.activities = activities;
    const activity = newestByUpdatedAt(activities);
    if (activity) {
      session.session.activity = activity;
    } else {
      delete session.session.activity;
    }

    const serverStatuses = session.processes
      .flatMap((handle) => handle.serverStatus ? [handle.serverStatus] : [])
      .sort(compareUpdatedAtDesc);
    session.session.serverStatuses = serverStatuses;
    const serverStatus = newestByUpdatedAt(serverStatuses);
    if (serverStatus) {
      session.session.serverStatus = serverStatus;
    } else {
      delete session.session.serverStatus;
    }
  }

  private logLspRequestFailure(handle: ProcessHandle, method: string, error: unknown): void {
    this.extensions.appendLog({
      extensionId: handle.extensionId,
      level: "warning",
      message: `LSP ${method} request failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  private disposeSession(session: InternalSession): void {
    for (const handle of session.processes) {
      handle.client.dispose();
      if (!handle.process.killed) {
        handle.process.kill();
      }
    }
  }
}

type JsonRpcId = number | string;
type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

class LspJsonRpcClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly onNotification: (message: JsonRpcMessage) => void,
    private readonly configuration: unknown = {},
    private readonly configurationSection?: string
  ) {
    this.process.stdout.on("data", this.handleData);
    this.process.once("exit", this.handleClosed);
    this.process.once("error", this.handleError);
  }

  async initialize(worktreePath: string, initializationOptions?: unknown): Promise<unknown> {
    const params: Record<string, unknown> = {
      processId: process.pid,
      rootUri: pathToFileURL(worktreePath).href,
      workspaceFolders: [
        {
          uri: pathToFileURL(worktreePath).href,
          name: "workspace"
        }
      ],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true }
        },
        workspace: {
          workspaceFolders: true,
          configuration: true
        },
        window: {
          workDoneProgress: true
        },
        experimental: {
          serverStatusNotification: true
        }
      }
    };
    if (initializationOptions !== undefined) {
      params.initializationOptions = initializationOptions;
    }
    return this.request("initialize", params, 5_000);
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const key = String(id);
    const request = new Promise<unknown>((resolve, reject) => {
      const timer = typeof timeoutMs === "number"
        ? setTimeout(() => {
            this.pending.delete(key);
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;
      this.pending.set(key, { resolve, reject, timer });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return request;
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  dispose(): void {
    this.process.stdout.off("data", this.handleData);
    this.process.off("exit", this.handleClosed);
    this.process.off("error", this.handleError);
    this.rejectPending(new Error("Language server client disposed."));
  }

  private readonly handleData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (this.buffer.length < messageEnd) {
        return;
      }

      const body = this.buffer.subarray(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);
      try {
        this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Invalid server messages are ignored. The pending request timeout will surface the failure.
      }
    }
  };

  private readonly handleClosed = (): void => {
    this.rejectPending(new Error("Language server process exited."));
  };

  private readonly handleError = (error: Error): void => {
    this.rejectPending(error);
  };

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null) {
      if (message.method) {
        this.handleServerRequest(message);
        return;
      }

      const pending = this.pending.get(String(message.id));
      if (!pending) {
        return;
      }
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Language server request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.onNotification(message);
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    switch (message.method) {
      case "workspace/configuration": {
        const params = objectValue(message.params);
        const items = Array.isArray(params?.items) ? params.items : [];
        this.write({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: items.map((item) => this.configurationForItem(item))
        });
        return;
      }
      case "workspace/workspaceFolders":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
      case "rust-analyzer/reloadWorkspace":
        this.write({ jsonrpc: "2.0", id: message.id ?? null, result: null });
        return;
      default:
        this.write({ jsonrpc: "2.0", id: message.id ?? null, result: null });
    }
  }

  private configurationForItem(item: unknown): unknown {
    const section = stringValue(objectValue(item)?.section);
    if (!section) {
      return this.configuration ?? {};
    }

    const direct = lookupConfiguration(this.configuration, section);
    if (direct !== undefined) {
      return direct;
    }

    if (this.configurationSection && section === this.configurationSection) {
      return this.configuration ?? {};
    }

    const sectionPrefix = this.configurationSection ? `${this.configurationSection}.` : "";
    if (sectionPrefix && section.startsWith(sectionPrefix)) {
      const nested = lookupConfiguration(this.configuration, section.slice(sectionPrefix.length));
      if (nested !== undefined) {
        return nested;
      }
    }

    return {};
  }

  private rejectPending(error: Error): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(key);
    }
  }

  private write(message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
}

function processEnv(path?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(path ? { PATH: path } : {}),
    NO_COLOR: "1"
  };
}

function addCapabilities(session: LspSession, extension: ExtensionDescriptor): void {
  const capabilities = new Set<LspCapability>(session.capabilities);
  for (const feature of extension.contributes?.lsp?.features ?? []) {
    capabilities.add(feature);
  }
  session.capabilities = [...capabilities];
}

function normalizeActivationPaths(paths: string[] | undefined): string[] {
  return [...new Set((paths ?? []).map((path) => path.trim()).filter(Boolean))];
}

interface ResolvedCommand {
  program: string;
  env: NodeJS.ProcessEnv;
}

async function resolveCommand(command: string): Promise<ResolvedCommand | null> {
  if (isPathCommand(command)) {
    return (await isExecutable(command))
      ? { program: command, env: processEnv(prependPath(process.env.PATH, dirname(command))) }
      : null;
  }

  const inheritedPath = process.env.PATH;
  const inheritedProgram = await resolveCommandFromPath(command, inheritedPath);
  if (inheritedProgram) {
    return {
      program: inheritedProgram,
      env: processEnv(prependPath(inheritedPath, dirname(inheritedProgram)))
    };
  }

  const commonPath = appendPaths(inheritedPath, commonExecutableDirs());
  if (commonPath !== inheritedPath) {
    const commonProgram = await resolveCommandFromPath(command, commonPath);
    if (commonProgram) {
      return {
        program: commonProgram,
        env: processEnv(prependPath(commonPath, dirname(commonProgram)))
      };
    }
  }

  const shellResolved = await resolveCommandFromLoginShell(command);
  if (!shellResolved) {
    return null;
  }

  return {
    program: shellResolved.program,
    env: processEnv(prependPath(shellResolved.path, dirname(shellResolved.program)))
  };
}

function isPathCommand(command: string): boolean {
  return isAbsolute(command) || command.includes("/") || (sep !== "/" && command.includes(sep));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandFromPath(command: string, path: string | undefined): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [command], {
      env: processEnv(path),
      timeout: 2_000
    });
    return firstLine(String(stdout));
  } catch {
    return null;
  }
}

async function resolveCommandFromLoginShell(command: string): Promise<{ program: string; path: string } | null> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(
      shell,
      [
        "-lc",
        'resolved=$(command -v -- "$1" 2>/dev/null || true); printf "%s\\n%s" "$resolved" "$PATH"',
        "krt-resolve-command",
        command
      ],
      { timeout: 3_000 }
    );
    const [programLine, ...pathLines] = String(stdout).split("\n");
    const program = programLine.trim();
    if (!program) {
      return null;
    }
    return {
      program,
      path: pathLines.join("\n").trim()
    };
  } catch {
    return null;
  }
}

function firstLine(value: string): string | null {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function prependPath(path: string | undefined, entry: string): string {
  return appendPaths(path, [entry], true);
}

function appendPaths(path: string | undefined, entries: string[], prepend = false): string {
  const parts = (path ?? "").split(delimiter).filter(Boolean);
  for (const entry of entries) {
    if (parts.includes(entry)) {
      continue;
    }
    if (prepend) {
      parts.unshift(entry);
    } else {
      parts.push(entry);
    }
  }
  return parts.join(delimiter);
}

function commonExecutableDirs(): string[] {
  const home = process.env.HOME;
  return [
    ...appExecutableDirs(),
    home ? join(home, ".cargo", "bin") : null,
    home ? join(home, ".pyenv", "shims") : null,
    home ? join(home, ".local", "bin") : null,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].filter((entry): entry is string => Boolean(entry));
}

function appExecutableDirs(): string[] {
  const dirs = new Set<string>([join(process.cwd(), "node_modules", ".bin")]);
  try {
    dirs.add(fileURLToPath(new URL("../../../node_modules/.bin/", import.meta.url)));
  } catch {
    // import.meta.url can be non-file in tests or future bundling modes.
  }
  if (process.resourcesPath) {
    dirs.add(join(process.resourcesPath, "app.asar.unpacked", "node_modules", ".bin"));
    dirs.add(join(process.resourcesPath, "app", "node_modules", ".bin"));
  }
  return [...dirs];
}

function trimLogLine(text: string, maxLength = 1_000): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function trimLogTail(text: string, maxLength = 4_000): string {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function fileUriForWorktreePath(worktreePath: string, path: string): string {
  return pathToFileURL(isAbsolute(path) ? path : join(worktreePath, path)).href;
}

function pathFromUri(worktreePath: string, uri: string): string | null {
  if (!uri.startsWith("file:")) {
    return null;
  }

  try {
    const absolute = fileURLToPath(uri);
    const relativePath = relative(worktreePath, absolute);
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      return relativePath.split(sep).join("/");
    }
    return absolute;
  } catch {
    return null;
  }
}

function languageIdForPath(path: string, extension: ExtensionDescriptor): string {
  if (/\.tsx$/i.test(path)) {
    return "typescriptreact";
  }
  if (/\.jsx$/i.test(path)) {
    return "javascriptreact";
  }
  if (/\.ts$/i.test(path)) {
    return "typescript";
  }
  if (/\.js$/i.test(path)) {
    return "javascript";
  }
  if (/\.rs$/i.test(path)) {
    return "rust";
  }
  if (/\.go$/i.test(path)) {
    return "go";
  }
  if (/\.py$/i.test(path)) {
    return "python";
  }
  if (/\.jsonc$/i.test(path)) {
    return "jsonc";
  }
  if (/\.json$/i.test(path)) {
    return "json";
  }
  return extension.contributes?.lsp?.languages[0] ?? "plaintext";
}

function hoverFromLspResult(
  result: unknown,
  source: string,
  path: string,
  position: LspPosition
): LspHover | null {
  const hover = objectValue(result);
  if (!hover) {
    return null;
  }

  const contents = hoverContentsToString(hover.contents);
  if (!contents) {
    return null;
  }

  return {
    source,
    path,
    position,
    contents,
    range: rangeFromLsp(hover.range) ?? undefined
  };
}

function hoverContentsToString(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (Array.isArray(value)) {
    return value.map(hoverContentsToString).filter(Boolean).join("\n\n") || null;
  }

  const object = objectValue(value);
  if (!object) {
    return null;
  }
  const markedStringValue = stringValue(object.value);
  if (markedStringValue) {
    return markedStringValue.trim() || null;
  }
  const markupValue = stringValue(object.contents);
  return markupValue?.trim() || null;
}

function definitionFromLspResult(result: unknown, source: string, worktreePath: string): LspDefinition | null {
  const first = Array.isArray(result) ? result[0] : result;
  const location = objectValue(first);
  if (!location) {
    return null;
  }

  const uri = stringValue(location.uri) ?? stringValue(location.targetUri);
  const path = uri ? pathFromUri(worktreePath, uri) : null;
  const range = rangeFromLsp(location.targetSelectionRange) ?? rangeFromLsp(location.targetRange) ?? rangeFromLsp(location.range);
  if (!path || !range) {
    return null;
  }

  return { source, path, range };
}

function documentSymbolsFromLspResult(result: unknown, fallbackPath: string, worktreePath: string): LspDocumentSymbol[] {
  if (!Array.isArray(result)) {
    return [];
  }

  return result.flatMap((symbol) => documentSymbolFromLspResult(symbol, fallbackPath, worktreePath));
}

function documentSymbolFromLspResult(value: unknown, fallbackPath: string, worktreePath: string): LspDocumentSymbol[] {
  const symbol = objectValue(value);
  const name = stringValue(symbol?.name);
  const kind = symbolKindFromLsp(symbol?.kind);
  if (!symbol || !name || !kind) {
    return [];
  }

  const location = objectValue(symbol.location);
  const locationUri = stringValue(location?.uri);
  const path = locationUri ? pathFromUri(worktreePath, locationUri) ?? fallbackPath : fallbackPath;
  const locationRange = rangeFromLsp(location?.range);
  const range = rangeFromLsp(symbol.range) ?? locationRange;
  const selectionRange = rangeFromLsp(symbol.selectionRange) ?? range;
  if (!range || !selectionRange) {
    return [];
  }

  const current: LspDocumentSymbol = {
    name,
    kind,
    path,
    range,
    selectionRange,
    detail: stringValue(symbol.detail) ?? undefined,
    containerName: stringValue(symbol.containerName) ?? undefined
  };
  const children = Array.isArray(symbol.children)
    ? symbol.children.flatMap((child) => documentSymbolFromLspResult(child, path, worktreePath))
    : [];
  return [current, ...children];
}

function diagnosticFromLspResult(
  value: unknown,
  source: string,
  worktreePath: string,
  uri: string,
  index: number
): LspDiagnostic | null {
  const diagnostic = objectValue(value);
  const range = rangeFromLsp(diagnostic?.range);
  if (!diagnostic || !range) {
    return null;
  }
  const path = pathFromUri(worktreePath, uri) ?? uri;
  return {
    id: `${source}:${uri}:${index}`,
    source,
    severity: diagnosticSeverityFromLsp(diagnostic.severity),
    message: stringValue(diagnostic.message) ?? "Language server diagnostic.",
    path,
    range,
    code: stringValue(diagnostic.code) ?? undefined
  };
}

function rangeFromLsp(value: unknown): LspRange | null {
  const range = objectValue(value);
  const start = positionFromLsp(range?.start);
  const end = positionFromLsp(range?.end);
  return start && end ? { start, end } : null;
}

function positionFromLsp(value: unknown): LspPosition | null {
  const position = objectValue(value);
  const line = numberValue(position?.line);
  const character = numberValue(position?.character);
  return line !== null && character !== null
    ? { line: Math.max(0, Math.trunc(line)), character: Math.max(0, Math.trunc(character)) }
    : null;
}

function symbolKindFromLsp(kind: unknown): LspDocumentSymbol["kind"] | null {
  const index = numberValue(kind);
  if (index === null) {
    return null;
  }
  const kinds: Array<LspDocumentSymbol["kind"] | undefined> = [
    undefined,
    "file",
    "module",
    "namespace",
    "package",
    "class",
    "method",
    "property",
    "field",
    "constructor",
    "enum",
    "interface",
    "function",
    "variable",
    "constant",
    "string",
    "number",
    "boolean",
    "array",
    "object",
    "key",
    "null",
    "enum_member",
    "struct",
    "event",
    "operator",
    "type_parameter"
  ];
  return kinds[index] ?? null;
}

function diagnosticSeverityFromLsp(severity: unknown): LspDiagnostic["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "info";
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function lookupConfiguration(value: unknown, path: string): unknown | undefined {
  if (!path) {
    return value;
  }
  const root = objectValue(value);
  if (root && path in root) {
    return root[path];
  }
  let current: unknown = value;
  for (const segment of path.split(".")) {
    const record = objectValue(current);
    if (!record || !(segment in record)) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function progressToken(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function progressPercentage(value: unknown): number | undefined {
  const percentage = numberValue(value);
  if (percentage === null) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round(percentage)));
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function lspServerHealth(value: unknown): LspServerStatus["health"] | null {
  return value === "ok" || value === "warning" || value === "error" ? value : null;
}

function newestByUpdatedAt<T extends { updatedAt: string }>(values: T[]): T | undefined {
  return values.reduce<T | undefined>((newest, value) => {
    if (!newest) {
      return value;
    }
    return Date.parse(value.updatedAt) >= Date.parse(newest.updatedAt) ? value : newest;
  }, undefined);
}

function compareUpdatedAtDesc(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isLspDiagnostic(value: LspDiagnostic | null): value is LspDiagnostic {
  return value !== null;
}

function matchesGlob(glob: string, path: string): boolean {
  if (glob === "**/*") {
    return true;
  }
  if (glob.startsWith("**/*.")) {
    return path.endsWith(glob.slice(4));
  }
  if (glob.startsWith("**/")) {
    const basename = glob.slice(3);
    return path === basename || path.endsWith(`/${basename}`);
  }
  return path === glob;
}

async function collectWorkspacePaths(root: string, directory = "", limit = 10_000): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await collectWorkspacePaths(root, relativePath, limit - paths.length)));
    } else if (entry.isFile()) {
      paths.push(relativePath);
    }
    if (paths.length >= limit) {
      break;
    }
  }
  return paths.slice(0, limit);
}

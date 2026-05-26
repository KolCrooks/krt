import { spawn, type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../errors.js";
import type {
  LspDefinition,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspPosition,
  LspRange,
  LspSession,
  RepositoryRef
} from "../../shared/schemas.js";
import type { RepoService } from "./repoService.js";
import type { ExtensionDescriptor, ExtensionService } from "./extensionService.js";

const execFileAsync = promisify(execFile);

type LspCapability = LspSession["capabilities"][number];

interface ProcessHandle {
  extensionId: string;
  process: ChildProcessWithoutNullStreams;
}

interface InternalSession {
  session: LspSession;
  processes: ProcessHandle[];
}

export class LspService {
  private readonly sessions = new Map<string, InternalSession>();

  constructor(
    private readonly repos: RepoService,
    private readonly extensions: ExtensionService
  ) {}

  async startForWorktree(repository: RepositoryRef, headSha: string): Promise<LspSession> {
    const worktreePath = this.repos.getWorktreePath(repository, headSha);
    if (!worktreePath) {
      throw new AppError("lsp_requires_managed_worktree", "LSP is available only after a managed checkout.");
    }

    const key = this.key(repository, headSha);
    const existing = this.sessions.get(key);
    if (existing && existing.session.status !== "stopped") {
      return existing.session;
    }

    const treePaths = await this.getWorkspacePaths(repository, headSha, worktreePath);
    const matchingExtensions = this.extensions
      .list()
      .filter((extension) => extension.enabled && extension.command && extension.activationGlobs.some((glob) => treePaths.some((path) => matchesGlob(glob, path))));

    const session: InternalSession = {
      session: {
        id: randomUUID(),
        repository,
        headSha,
        worktreePath,
        status: "starting",
        activeExtensions: [],
        unavailableExtensions: [],
        capabilities: ["diagnostics", "hover", "definition", "symbols"],
        startedAt: new Date().toISOString()
      },
      processes: []
    };
    this.sessions.set(key, session);

    for (const extension of matchingExtensions) {
      if (!extension.command) {
        continue;
      }

      const available = await commandExists(extension.command.program);
      if (!available) {
        session.session.unavailableExtensions.push({
          id: extension.id,
          reason: `${extension.command.program} is not installed or not on PATH.`
        });
        this.extensions.appendLog({
          extensionId: extension.id,
          level: "warning",
          message: `${extension.command.program} is not available; using fallback code intelligence.`
        });
        continue;
      }

      const process = spawn(extension.command.program, extension.command.args, {
        cwd: worktreePath,
        stdio: "pipe",
        env: processEnv()
      });
      session.processes.push({ extensionId: extension.id, process });
      session.session.activeExtensions.push(extension.id);
      this.initializeServer(process, worktreePath);

      process.once("exit", (code, signal) => {
        this.extensions.appendLog({
          extensionId: extension.id,
          level: code === 0 ? "info" : "warning",
          message: `Language server exited with code ${code ?? "none"} and signal ${signal ?? "none"}.`
        });
      });
      process.once("error", (error) => {
        this.extensions.appendLog({
          extensionId: extension.id,
          level: "error",
          message: error.message
        });
      });
    }

    session.session.status =
      session.processes.length > 0 && session.session.unavailableExtensions.length === 0
        ? "ready"
        : session.processes.length > 0
          ? "degraded"
          : "degraded";

    if (matchingExtensions.length === 0) {
      session.session.unavailableExtensions.push({
        id: "fallback",
        reason: "No built-in language server extension matched the workspace files."
      });
    }

    return session.session;
  }

  stopForWorktree(repository: RepositoryRef, headSha: string): LspSession | null {
    const session = this.sessions.get(this.key(repository, headSha));
    if (!session) {
      return null;
    }

    for (const handle of session.processes) {
      if (!handle.process.killed) {
        handle.process.kill();
      }
    }
    session.session.status = "stopped";
    return session.session;
  }

  getSession(repository: RepositoryRef, headSha: string): LspSession | null {
    return this.sessions.get(this.key(repository, headSha))?.session ?? null;
  }

  async getDiagnostics(repository: RepositoryRef, headSha: string, path?: string): Promise<LspDiagnostic[]> {
    this.requireWorktree(repository, headSha);
    const paths = path ? [path] : (await this.repos.loadWorkspaceTree(repository, headSha)).paths.slice(0, 200);
    const diagnostics: LspDiagnostic[] = [];

    for (const candidate of paths) {
      const content = await this.repos.getLocalFileContent(repository, candidate, headSha);
      if (!content || content.isLarge || isBinaryLike(candidate)) {
        continue;
      }
      diagnostics.push(...analyzeContent(candidate, content.contents));
    }

    return diagnostics;
  }

  async getHover(repository: RepositoryRef, headSha: string, path: string, position: LspPosition): Promise<LspHover | null> {
    this.requireWorktree(repository, headSha);
    const content = await this.repos.getLocalFileContent(repository, path, headSha);
    if (!content) {
      return null;
    }

    const word = wordAtPosition(content.contents, position);
    if (!word) {
      return null;
    }

    return {
      source: "fallback-index",
      path,
      position,
      contents: `Symbol: ${word.text}`,
      range: word.range
    };
  }

  async getDocumentSymbols(repository: RepositoryRef, headSha: string, path: string): Promise<LspDocumentSymbol[]> {
    this.requireWorktree(repository, headSha);
    const content = await this.repos.getLocalFileContent(repository, path, headSha);
    if (!content || content.isLarge) {
      return [];
    }

    return extractSymbols(path, content.contents);
  }

  async getDefinition(repository: RepositoryRef, headSha: string, path: string, position: LspPosition): Promise<LspDefinition | null> {
    this.requireWorktree(repository, headSha);
    const content = await this.repos.getLocalFileContent(repository, path, headSha);
    if (!content) {
      return null;
    }

    const word = wordAtPosition(content.contents, position);
    if (!word) {
      return null;
    }

    const symbol = extractSymbols(path, content.contents).find((candidate) => candidate.name === word.text);
    return symbol
      ? {
          source: "fallback-index",
          path,
          range: symbol.selectionRange
        }
      : null;
  }

  private requireWorktree(repository: RepositoryRef, headSha: string): string {
    const worktreePath = this.repos.getWorktreePath(repository, headSha);
    if (!worktreePath) {
      throw new AppError("lsp_requires_managed_worktree", "LSP is available only after a managed checkout.");
    }
    return worktreePath;
  }

  private initializeServer(process: ChildProcessWithoutNullStreams, worktreePath: string): void {
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid ?? null,
        rootUri: pathToFileURL(worktreePath).href,
        capabilities: {}
      }
    };
    const body = JSON.stringify(message);
    process.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
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
}

function processEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1"
  };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
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

function analyzeContent(path: string, contents: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  const lines = contents.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (line.startsWith("<<<<<<<") || line.startsWith("=======") || line.startsWith(">>>>>>>")) {
      diagnostics.push(createDiagnostic(path, lineIndex, 0, Math.max(1, line.length), "error", "Unresolved merge conflict marker.", "merge-conflict"));
    }
    if (line.includes("TODO")) {
      diagnostics.push(createDiagnostic(path, lineIndex, line.indexOf("TODO"), line.indexOf("TODO") + 4, "info", "TODO marker found.", "todo"));
    }
    if (line.includes("console.log")) {
      diagnostics.push(createDiagnostic(path, lineIndex, line.indexOf("console.log"), line.indexOf("console.log") + 11, "hint", "Debug logging statement.", "debug-log"));
    }
    if (line.length > 160) {
      diagnostics.push(createDiagnostic(path, lineIndex, 160, line.length, "warning", "Line exceeds 160 characters.", "long-line"));
    }
  }
  return diagnostics;
}

function createDiagnostic(
  path: string,
  line: number,
  start: number,
  end: number,
  severity: LspDiagnostic["severity"],
  message: string,
  code: string
): LspDiagnostic {
  return {
    id: `${path}:${line}:${start}:${code}`,
    source: "fallback-index",
    severity,
    message,
    path,
    range: {
      start: { line, character: start },
      end: { line, character: end }
    },
    code
  };
}

function extractSymbols(path: string, contents: string): LspDocumentSymbol[] {
  const symbols: LspDocumentSymbol[] = [];
  const patterns: Array<{ regex: RegExp; kind: LspDocumentSymbol["kind"] }> = [
    { regex: /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { regex: /^\s*class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { regex: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { regex: /^\s*interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { regex: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type_parameter" },
    { regex: /^\s*type\s+([A-Za-z_$][\w$]*)/, kind: "type_parameter" },
    { regex: /^\s*export\s+function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { regex: /^\s*function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "variable" }
  ];

  const lines = contents.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (!match?.[1]) {
        continue;
      }
      const startCharacter = line.indexOf(match[1]);
      const range = createRange(lineIndex, startCharacter, startCharacter + match[1].length);
      symbols.push({
        name: match[1],
        kind: pattern.kind,
        path,
        range,
        selectionRange: range
      });
      break;
    }
  }
  return symbols;
}

function wordAtPosition(contents: string, position: LspPosition): { text: string; range: LspRange } | null {
  const line = contents.split(/\r?\n/)[position.line];
  if (!line) {
    return null;
  }
  const character = Math.min(position.character, Math.max(0, line.length - 1));
  const wordRegex = /[A-Za-z_$][\w$]*/g;
  for (const match of line.matchAll(wordRegex)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return {
        text: match[0],
        range: createRange(position.line, start, end)
      };
    }
  }
  return null;
}

function createRange(line: number, start: number, end: number): LspRange {
  return {
    start: { line, character: start },
    end: { line, character: end }
  };
}

function isBinaryLike(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|pdf|zip|gz|woff2?|ttf|ico)$/i.test(path);
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

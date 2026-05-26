// @vitest-environment node
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createAppPaths } from "../../src/main/appPaths.js";
import { openDatabase } from "../../src/main/services/database.js";
import { ExtensionService } from "../../src/main/services/extensionService.js";
import { LspService } from "../../src/main/services/lspService.js";
import { OperationService } from "../../src/main/services/operationService.js";
import { RepoService } from "../../src/main/services/repoService.js";
import type { RepositoryRef } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

describe("LspService", () => {
  it("routes hover, definition, and symbols to an active language server", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-real-lsp-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const serverPath = join(root, "fake-lsp.cjs");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(serverPath, fakeLspServerSource());

    const extensions = new ExtensionService(undefined, undefined, {
      builtinManifests: [
        {
          schemaVersion: 1,
          id: "fake-lsp",
          name: "Fake LSP",
          version: "0.0.1",
          description: "Fake test language server.",
          kind: ["language"],
          activation: { globs: ["**/*.ts"], languages: ["typescript"] },
          contributes: {
            lsp: {
              command: { program: process.execPath, args: [serverPath] },
              transport: "stdio",
              languages: ["typescript"],
              features: ["diagnostics", "hover", "definition", "symbols"]
            }
          }
        }
      ]
    });
    const service = new LspService(repos, extensions);

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "lsp123", worktreePath, new Date().toISOString());

    const session = await service.startForWorktree(repository, "lsp123");
    expect(session.activeExtensions).toContain("fake-lsp");

    const hover = await service.getHover(repository, "lsp123", "src/index.ts", { line: 0, character: 13 });
    expect(hover).toMatchObject({
      source: "fake-lsp",
      contents: "real hover from fake-lsp"
    });

    const definition = await service.getDefinition(repository, "lsp123", "src/index.ts", { line: 0, character: 13 });
    expect(definition).toMatchObject({
      source: "fake-lsp",
      path: "src/index.ts",
      range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } }
    });

    const symbols = await service.getDocumentSymbols(repository, "lsp123", "src/index.ts");
    expect(symbols).toEqual([
      expect.objectContaining({
        name: "serverSymbol",
        kind: "variable",
        path: "src/index.ts"
      })
    ]);

    service.stopForWorktree(repository, "lsp123");
  });

  it("keeps definition targets outside the managed worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-external-definition-lsp-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const dependencyPath = join(root, "cargo-registry", "src", "lib.rs");
    const serverPath = join(root, "external-definition-lsp.cjs");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await mkdir(join(root, "cargo-registry", "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "index.ts"), "export const value = dependency;\n");
    await writeFile(dependencyPath, "pub fn dependency() {}\n");
    await writeFile(serverPath, externalDefinitionLspServerSource(pathToFileURL(dependencyPath).href));

    const extensions = new ExtensionService(undefined, undefined, {
      builtinManifests: [
        {
          schemaVersion: 1,
          id: "fake-lsp",
          name: "Fake LSP",
          version: "0.0.1",
          description: "Fake test language server.",
          kind: ["language"],
          activation: { globs: ["**/*.ts"], languages: ["typescript"] },
          contributes: {
            lsp: {
              command: { program: process.execPath, args: [serverPath] },
              transport: "stdio",
              languages: ["typescript"],
              features: ["definition"]
            }
          }
        }
      ]
    });
    const service = new LspService(repos, extensions);

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "external123", worktreePath, new Date().toISOString());

    const definition = await service.getDefinition(repository, "external123", "src/index.ts", { line: 0, character: 21 });

    expect(definition).toMatchObject({
      source: "fake-lsp",
      path: dependencyPath,
      range: { start: { line: 0, character: 7 }, end: { line: 0, character: 17 } }
    });

    service.stopForWorktree(repository, "external123");
  });

  it("starts only language servers that match requested files and expands the session on demand", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-scoped-lsp-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const serverPath = join(root, "fake-lsp.cjs");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "web"), { recursive: true });
    await writeFile(join(worktreePath, "src", "lib.rs"), "pub fn value() -> i32 { 1 }\n");
    await writeFile(join(worktreePath, "web", "app.ts"), "export const value = 1;\n");
    await writeFile(serverPath, fakeLspServerSource());

    const extensions = new ExtensionService(undefined, undefined, {
      builtinManifests: [
        {
          schemaVersion: 1,
          id: "rust-analyzer",
          name: "Rust Analyzer",
          version: "0.0.1",
          description: "Fake Rust server.",
          kind: ["language"],
          activation: { globs: ["**/*.rs"], languages: ["rust"] },
          contributes: {
            lsp: {
              command: { program: process.execPath, args: [serverPath] },
              transport: "stdio",
              languages: ["rust"],
              features: ["hover"]
            }
          }
        },
        {
          schemaVersion: 1,
          id: "typescript-language-server",
          name: "TypeScript Language Server",
          version: "0.0.1",
          description: "Fake TypeScript server.",
          kind: ["language"],
          activation: { globs: ["**/*.ts"], languages: ["typescript"] },
          contributes: {
            lsp: {
              command: { program: process.execPath, args: [serverPath] },
              transport: "stdio",
              languages: ["typescript"],
              features: ["hover"]
            }
          }
        }
      ]
    });
    const service = new LspService(repos, extensions);

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "scope123", worktreePath, new Date().toISOString());

    const rustOnly = await service.startForWorktree(repository, "scope123", ["src/lib.rs"]);
    expect(rustOnly.activeExtensions).toEqual(["rust-analyzer"]);

    const expanded = await service.startForWorktree(repository, "scope123", ["web/app.ts"]);
    expect(expanded.activeExtensions).toEqual(expect.arrayContaining(["rust-analyzer", "typescript-language-server"]));

    service.stopForWorktree(repository, "scope123");
  });

  it("restarts active language server sessions for an extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-lsp-restart-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const serverPath = join(root, "fake-lsp.cjs");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(serverPath, fakeLspServerSource());

    const extensions = new ExtensionService(undefined, undefined, {
      builtinManifests: [
        {
          schemaVersion: 1,
          id: "fake-lsp",
          name: "Fake LSP",
          version: "0.0.1",
          description: "Fake test language server.",
          kind: ["language"],
          activation: { globs: ["**/*.ts"], languages: ["typescript"] },
          contributes: {
            lsp: {
              command: { program: process.execPath, args: [serverPath] },
              transport: "stdio",
              languages: ["typescript"],
              features: ["diagnostics", "hover", "definition", "symbols"]
            }
          }
        }
      ]
    });
    const service = new LspService(repos, extensions);

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "restart123", worktreePath, new Date().toISOString());

    const firstSession = await service.startForWorktree(repository, "restart123");
    const restarted = await service.restartActiveSessionsForExtension("fake-lsp");

    expect(restarted).toHaveLength(1);
    expect(restarted[0]?.id).not.toBe(firstSession.id);
    expect(restarted[0]?.activeExtensions).toContain("fake-lsp");

    const hover = await service.getHover(repository, "restart123", "src/index.ts", { line: 0, character: 13 });
    expect(hover).toMatchObject({
      source: "fake-lsp",
      contents: "real hover from fake-lsp"
    });

    service.stopForWorktree(repository, "restart123");
  });

  it("answers server-to-client requests during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-lsp-server-requests-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const serverPath = join(root, "server-request-lsp.cjs");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(serverPath, serverRequestLspServerSource());

    const extensions = new ExtensionService(undefined, undefined, {
      builtinManifests: [
        {
          schemaVersion: 1,
          id: "server-request-lsp",
          name: "Server Request LSP",
          version: "0.0.1",
          description: "Fake server requiring client request handling.",
          kind: ["language"],
          activation: { globs: ["**/*.ts"], languages: ["typescript"] },
          contributes: {
            lsp: {
              command: { program: process.execPath, args: [serverPath] },
              transport: "stdio",
              languages: ["typescript"],
              features: ["hover"],
              settings: {
                checkOnSave: false,
                diagnostics: { enable: false }
              }
            }
          }
        }
      ]
    });
    const service = new LspService(repos, extensions);

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "request123", worktreePath, new Date().toISOString());

    const session = await service.startForWorktree(repository, "request123");
    expect(session.activeExtensions).toContain("server-request-lsp");

    const hover = await service.getHover(repository, "request123", "src/index.ts", { line: 0, character: 13 });
    expect(hover).toMatchObject({
      source: "server-request-lsp",
      contents: "configured hover"
    });

    service.stopForWorktree(repository, "request123");
  });

  it("tracks language server progress and rust-analyzer server status", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-lsp-status-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const serverPath = join(root, "status-lsp.cjs");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "lib.rs"), "pub fn demo() -> i32 { 1 }\n");
    await writeFile(serverPath, statusLspServerSource());

    const extensions = new ExtensionService(undefined, undefined, {
      builtinManifests: [
        {
          schemaVersion: 1,
          id: "rust-analyzer",
          name: "Rust Analyzer",
          version: "0.0.1",
          description: "Fake rust-analyzer status server.",
          kind: ["language"],
          activation: { globs: ["**/*.rs"], languages: ["rust"] },
          contributes: {
            lsp: {
              command: { program: process.execPath, args: [serverPath] },
              transport: "stdio",
              languages: ["rust"],
              features: ["hover"]
            }
          }
        }
      ]
    });
    const service = new LspService(repos, extensions);

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "status123", worktreePath, new Date().toISOString());

    const session = await service.startForWorktree(repository, "status123");

    expect(session.activity).toMatchObject({
      extensionId: "rust-analyzer",
      title: "loading workspace",
      message: "cargo metadata",
      percentage: 42
    });
    expect(session.serverStatus).toMatchObject({
      extensionId: "rust-analyzer",
      health: "ok",
      quiescent: false,
      message: "loading workspace"
    });

    service.stopForWorktree(repository, "status123");
  });

  it("does not retry a degraded no-process session from hover requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-lsp-retry-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const serverPath = join(root, "fake-lsp");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "index.ts"), "export const value = 1;\n");

    const extensions = new ExtensionService(undefined, undefined, {
      builtinManifests: [
        {
          schemaVersion: 1,
          id: "fake-lsp",
          name: "Fake LSP",
          version: "0.0.1",
          description: "Fake test language server.",
          kind: ["language"],
          activation: { globs: ["**/*.ts"], languages: ["typescript"] },
          contributes: {
            lsp: {
              command: { program: serverPath, args: [] },
              transport: "stdio",
              languages: ["typescript"],
              features: ["diagnostics", "hover"]
            }
          }
        }
      ]
    });
    const service = new LspService(repos, extensions);

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "retry123", worktreePath, new Date().toISOString());

    const unavailable = await service.startForWorktree(repository, "retry123");
    expect(unavailable.activeExtensions).toEqual([]);
    expect(unavailable.unavailableExtensions[0]?.id).toBe("fake-lsp");
    const logCountAfterFailedStart = extensions.getLogs("fake-lsp").length;

    await writeFile(serverPath, `#!/usr/bin/env node\n${fakeLspServerSource()}`);
    await chmod(serverPath, 0o755);

    const failedHover = await service.getHover(repository, "retry123", "src/index.ts", { line: 0, character: 13 });
    expect(failedHover).toBeNull();
    expect(extensions.getLogs("fake-lsp")).toHaveLength(logCountAfterFailedStart);

    const restarted = await service.startForWorktree(repository, "retry123", ["src/index.ts"]);
    expect(restarted.activeExtensions).toContain("fake-lsp");

    const hover = await service.getHover(repository, "retry123", "src/index.ts", { line: 0, character: 13 });
    expect(hover).toMatchObject({
      source: "fake-lsp",
      contents: "real hover from fake-lsp"
    });

    service.stopForWorktree(repository, "retry123");
  });

  it("waits for in-flight language server startup before serving hover", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-lsp-starting-hover-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const worktreePath = join(root, "worktree");
    const serverPath = join(root, "slow-lsp.cjs");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(serverPath, slowInitializeLspServerSource());

    const extensions = new ExtensionService(undefined, undefined, {
      builtinManifests: [
        {
          schemaVersion: 1,
          id: "slow-lsp",
          name: "Slow LSP",
          version: "0.0.1",
          description: "Fake language server with delayed initialize.",
          kind: ["language"],
          activation: { globs: ["**/*.ts"], languages: ["typescript"] },
          contributes: {
            lsp: {
              command: { program: process.execPath, args: [serverPath] },
              transport: "stdio",
              languages: ["typescript"],
              features: ["hover"]
            }
          }
        }
      ]
    });
    const service = new LspService(repos, extensions);

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "starting123", worktreePath, new Date().toISOString());

    const start = service.startForWorktree(repository, "starting123");
    await waitForStartingSession(service, "starting123");

    const hover = await service.getHover(repository, "starting123", "src/index.ts", { line: 0, character: 13 });
    expect(hover).toMatchObject({
      source: "slow-lsp",
      contents: "hover after delayed initialize"
    });
    await start;

    service.stopForWorktree(repository, "starting123");
  });

  it("activates the rust-analyzer demo extension for Rust worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-rust-lsp-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const extensions = new ExtensionService();
    const service = new LspService(repos, extensions);
    const worktreePath = join(root, "rust-worktree");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
    await writeFile(join(worktreePath, "src", "lib.rs"), "pub fn demo() -> i32 { 1 }\n");

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "rust123", worktreePath, new Date().toISOString());

    const session = await service.startForWorktree(repository, "rust123");
    const extensionIds = [
      ...session.activeExtensions,
      ...session.unavailableExtensions.map((extension) => extension.id)
    ];

    expect(extensionIds).toContain("rust-analyzer");
    expect(session.capabilities).toEqual(expect.arrayContaining(["hover", "definition", "symbols"]));
    expect(session.capabilities).not.toContain("diagnostics");

    service.stopForWorktree(repository, "rust123");
  });

  it("starts only against managed worktrees and returns no code intelligence without a language server", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-lsp-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const extensions = new ExtensionService(undefined, undefined, { builtinManifests: [] });
    const service = new LspService(repos, extensions);
    const worktreePath = join(root, "worktree");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(
      join(worktreePath, "src", "index.ts"),
      [
        "export const value = 1;",
        "function greet() {",
        "  console.log(value);",
        "}",
        "<<<<<<< HEAD"
      ].join("\n")
    );

    db.prepare(
      `INSERT INTO worktrees (provider, owner, repo, number, head_sha, worktree_path, last_used_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run("github", "kol", "repo", 12, "abc123", worktreePath, new Date().toISOString());

    const [session, duplicateSession] = await Promise.all([
      service.startForWorktree(repository, "abc123"),
      service.startForWorktree(repository, "abc123")
    ]);
    expect(["ready", "degraded"]).toContain(session.status);
    expect(session.capabilities).toEqual([]);
    expect(session.unavailableExtensions).toEqual([
      expect.objectContaining({
        id: "language-server",
        reason: "No built-in language server extension matched the workspace files."
      })
    ]);
    expect(duplicateSession.id).toBe(session.id);

    const diagnostics = await service.getDiagnostics(repository, "abc123", "src/index.ts");
    expect(diagnostics).toEqual([]);

    const symbols = await service.getDocumentSymbols(repository, "abc123", "src/index.ts");
    expect(symbols).toEqual([]);

    const hover = await service.getHover(repository, "abc123", "src/index.ts", { line: 0, character: 14 });
    expect(hover).toBeNull();

    const definition = await service.getDefinition(repository, "abc123", "src/index.ts", { line: 0, character: 14 });
    expect(definition).toBeNull();

    service.stopForWorktree(repository, "abc123");
  });
});

async function waitForStartingSession(service: LspService, headSha: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (service.getSession(repository, headSha)?.status === "starting") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for starting LSP session.");
}

function fakeLspServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
const opened = new Set();

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
});

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          documentSymbolProvider: true
        }
      }
    });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "textDocument/didOpen") {
    opened.add(message.params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/hover") {
    send({
      id: message.id,
      result: {
        contents: { kind: "markdown", value: opened.has(message.params.textDocument.uri) ? "real hover from fake-lsp" : "not opened" },
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } }
      }
    });
    return;
  }
  if (message.method === "textDocument/definition") {
    send({
      id: message.id,
      result: {
        uri: message.params.textDocument.uri,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } }
      }
    });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({
      id: message.id,
      result: [
        {
          name: "serverSymbol",
          kind: 13,
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
          selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } }
        }
      ]
    });
  }
}
`;
}

function externalDefinitionLspServerSource(definitionUri: string): string {
  return `
let buffer = Buffer.alloc(0);
const definitionUri = ${JSON.stringify(definitionUri)};

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
});

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true } } });
    return;
  }
  if (message.method === "initialized" || message.method === "textDocument/didOpen") {
    return;
  }
  if (message.method === "textDocument/definition") {
    send({
      id: message.id,
      result: {
        uri: definitionUri,
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 17 } }
      }
    });
  }
}
`;
}

function statusLspServerSource(): string {
  return `
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
});

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    const capabilities = message.params.capabilities;
    if (capabilities.window.workDoneProgress && capabilities.experimental.serverStatusNotification) {
      send({
        method: "$/progress",
        params: {
          token: "rust-analyzer/loading",
          value: {
            kind: "begin",
            title: "loading workspace",
            message: "cargo metadata",
            percentage: 42
          }
        }
      });
      send({
        method: "experimental/serverStatus",
        params: {
          health: "ok",
          quiescent: false,
          message: "loading workspace"
        }
      });
    }
    send({
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true
        }
      }
    });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
}
`;
}

function slowInitializeLspServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
const opened = new Set();

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
});

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    setTimeout(() => {
      send({
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true
          }
        }
      });
    }, 150);
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "textDocument/didOpen") {
    opened.add(message.params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/hover") {
    send({
      id: message.id,
      result: {
        contents: { kind: "markdown", value: opened.has(message.params.textDocument.uri) ? "hover after delayed initialize" : "not opened" }
      }
    });
  }
}
`;
}

function serverRequestLspServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
let initializeMessage = null;
let configured = false;
const opened = new Set();

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
});

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}

function sendInitializeResult() {
  send({
    id: initializeMessage.id,
    result: {
      capabilities: {
        textDocumentSync: 1,
        hoverProvider: true
      }
    }
  });
}

function handle(message) {
  if (message.id === 900 && !message.method) {
    const config = Array.isArray(message.result) ? message.result[0] : null;
    configured =
      initializeMessage?.params?.initializationOptions?.checkOnSave === false &&
      config?.diagnostics?.enable === false;
    sendInitializeResult();
    return;
  }
  if (message.method === "initialize") {
    initializeMessage = message;
    send({
      id: 900,
      method: "workspace/configuration",
      params: { items: [{ section: "server-request-lsp" }] }
    });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "textDocument/didOpen") {
    opened.add(message.params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/hover") {
    send({
      id: message.id,
      result: {
        contents: { kind: "markdown", value: configured && opened.has(message.params.textDocument.uri) ? "configured hover" : "not configured" }
      }
    });
  }
}
`;
}

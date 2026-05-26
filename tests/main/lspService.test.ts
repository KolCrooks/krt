// @vitest-environment node
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  it("starts only against managed worktrees and provides fallback code intelligence", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-lsp-service-"));
    const paths = createAppPaths(root);
    const db = openDatabase(":memory:");
    const repos = new RepoService(paths, db, new OperationService());
    const extensions = new ExtensionService();
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

    const session = await service.startForWorktree(repository, "abc123");
    expect(["ready", "degraded"]).toContain(session.status);
    expect(session.capabilities).toContain("diagnostics");

    const diagnostics = await service.getDiagnostics(repository, "abc123", "src/index.ts");
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining(["debug-log", "merge-conflict"]));

    const symbols = await service.getDocumentSymbols(repository, "abc123", "src/index.ts");
    expect(symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["value", "greet"]));

    const hover = await service.getHover(repository, "abc123", "src/index.ts", { line: 0, character: 14 });
    expect(hover?.contents).toContain("value");

    const definition = await service.getDefinition(repository, "abc123", "src/index.ts", { line: 0, character: 14 });
    expect(definition?.path).toBe("src/index.ts");

    service.stopForWorktree(repository, "abc123");
  });
});

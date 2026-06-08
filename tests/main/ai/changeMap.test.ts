// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  blastRadiusForFiles,
  deterministicEdgesFromChangeMap,
  parseChangedLineRanges,
  summarizeChangeMap,
  type ChangeMap
} from "../../../src/main/services/ai/changeMap.js";
import { ChangeMapService } from "../../../src/main/services/changeMapService.js";
import type { ChangedFile, LspDocumentSymbol } from "../../../src/shared/schemas.js";

const repository = { provider: "github" as const, owner: "kol", name: "repo", fullName: "kol/repo" };

describe("change map helpers", () => {
  it("parses new-side line ranges from hunk headers", () => {
    const patch = ["@@ -1,3 +10,4 @@ ctx", "+a", " b", "-c", "@@ -20 +40 @@", "+x"].join("\n");
    expect(parseChangedLineRanges(patch)).toEqual([
      { start: 10, end: 13 },
      { start: 40, end: 40 }
    ]);
    expect(parseChangedLineRanges(undefined)).toEqual([]);
  });

  it("computes blast radius for a chapter's files, excluding the chapter's own files", () => {
    const changeMap: ChangeMap = {
      symbols: [
        { symbol: "reserve", definedIn: "src/permit.ts", line: 4, referencedBy: ["src/writer.ts", "src/pool.ts", "src/permit.ts"] }
      ]
    };
    const impact = blastRadiusForFiles(changeMap, ["src/permit.ts"]);
    expect(impact.touchedSymbols).toEqual(["reserve"]);
    expect(impact.blastRadiusFiles.sort()).toEqual(["src/pool.ts", "src/writer.ts"]);
    expect(impact.referenceCount).toBe(2);
  });

  it("derives deterministic edges between chapters from references", () => {
    const changeMap: ChangeMap = {
      symbols: [{ symbol: "reserve", definedIn: "src/permit.ts", line: 4, referencedBy: ["src/writer.ts"] }]
    };
    const chapters = [
      { id: "chapter-1", files: ["src/permit.ts"] },
      { id: "chapter-2", files: ["src/writer.ts"] }
    ];
    const edges = deterministicEdgesFromChangeMap(changeMap, chapters);
    expect(edges).toEqual([
      expect.objectContaining({ from: "chapter-1", to: "chapter-2", relation: "dependency", source: "deterministic" })
    ]);
    expect(edges[0]?.evidence).toEqual(["reserve", "src/writer.ts"]);
  });

  it("summarizes the most-referenced symbols", () => {
    const changeMap: ChangeMap = {
      symbols: [
        { symbol: "reserve", definedIn: "src/permit.ts", line: 4, referencedBy: ["a.ts", "b.ts"] },
        { symbol: "unused", definedIn: "src/x.ts", line: 1, referencedBy: [] }
      ]
    };
    const summary = summarizeChangeMap(changeMap);
    expect(summary).toContain("`reserve`");
    expect(summary).not.toContain("`unused`");
  });
});

describe("ChangeMapService", () => {
  const changedFiles: ChangedFile[] = [
    { path: "src/permit.ts", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@ -1,2 +1,3 @@\n+export function reserve() {}\n", isLarge: false, isGenerated: false, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 },
    { path: "vendor/bundle.js", status: "modified", additions: 9000, deletions: 0, changes: 9000, patch: "@@ -1 +1,9000 @@\n+x", isLarge: true, isGenerated: true, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 }
  ];

  function symbol(name: string, line: number): LspDocumentSymbol {
    return { name, kind: "function", path: "src/permit.ts", range: { start: { line, character: 0 }, end: { line, character: 10 } }, selectionRange: { start: { line, character: 7 }, end: { line, character: 7 + name.length } } };
  }

  it("maps touched symbols to their reverse dependencies and skips large/generated files", async () => {
    const getDocumentSymbols = vi.fn(async () => [symbol("reserve", 0), symbol("offscreen", 50)]);
    const getReferences = vi.fn(async () => ["src/writer.ts", "src/permit.ts"]);
    const service = new ChangeMapService({ getDocumentSymbols, getReferences });

    const changeMap = await service.build(repository, "abc", changedFiles);

    // Only the symbol on a changed line (line 0 → 1-based 1, in range 1..3) is kept.
    expect(changeMap.symbols).toHaveLength(1);
    expect(changeMap.symbols[0]).toMatchObject({ symbol: "reserve", definedIn: "src/permit.ts" });
    // The defining file is filtered out of its own reverse-deps.
    expect(changeMap.symbols[0]?.referencedBy).toEqual(["src/writer.ts"]);
    // The large generated vendor bundle is never analyzed.
    expect(getDocumentSymbols).toHaveBeenCalledTimes(1);
    expect(getDocumentSymbols).toHaveBeenCalledWith(repository, "abc", "src/permit.ts");
  });

  it("degrades to an empty map when the language server errors", async () => {
    const service = new ChangeMapService({
      getDocumentSymbols: vi.fn(async () => {
        throw new Error("no server");
      }),
      getReferences: vi.fn(async () => [])
    });
    const changeMap = await service.build(repository, "abc", changedFiles);
    expect(changeMap.symbols).toEqual([]);
  });
});

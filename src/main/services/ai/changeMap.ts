// Phase 0 grounding: a deterministic map of what each change touches and what
// depends on it, computed from the diff + LSP before the agent runs. Pure data
// and pure helpers live here; the LSP-driven builder is ChangeMapService.

export interface SymbolImpact {
  /** Name of a symbol defined/modified inside a changed hunk. */
  symbol: string;
  /** Repository-relative path the symbol is defined in. */
  definedIn: string;
  /** 1-based line of the symbol's name in the head revision. */
  line: number;
  /** Distinct repository-relative files that reference the symbol (excluding definedIn). */
  referencedBy: string[];
}

export interface ChangeMap {
  symbols: SymbolImpact[];
}

export interface LineRange {
  start: number;
  end: number;
}

export interface ChapterLike {
  id: string;
  files: string[];
}

export interface DeterministicEdge {
  from: string;
  to: string;
  relation: "dependency";
  confidence: number;
  source: "deterministic";
  reason: string;
  evidence: string[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// New-side (added/modified) line ranges of a unified diff patch.
export function parseChangedLineRanges(patch: string | undefined): LineRange[] {
  if (!patch) {
    return [];
  }
  const ranges: LineRange[] = [];
  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (!match) {
      continue;
    }
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    if (Number.isFinite(start) && start > 0) {
      ranges.push({ start, end: start + Math.max(0, length - 1) });
    }
  }
  return ranges;
}

export function lineInRanges(line: number, ranges: LineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

// Aggregate the blast radius for the set of files in one chapter: the distinct
// external files that depend on the chapter's changed symbols.
export function blastRadiusForFiles(
  changeMap: ChangeMap,
  files: string[]
): { blastRadiusFiles: string[]; referenceCount: number; touchedSymbols: string[] } {
  const owned = new Set(files);
  const touchedSymbols = new Set<string>();
  const blastRadiusFiles = new Set<string>();
  for (const symbol of changeMap.symbols) {
    if (!owned.has(symbol.definedIn)) {
      continue;
    }
    touchedSymbols.add(symbol.symbol);
    for (const referencer of symbol.referencedBy) {
      if (!owned.has(referencer)) {
        blastRadiusFiles.add(referencer);
      }
    }
  }
  return {
    blastRadiusFiles: [...blastRadiusFiles],
    referenceCount: blastRadiusFiles.size,
    touchedSymbols: [...touchedSymbols]
  };
}

// Connect chapters when a symbol defined in one chapter's files is referenced in
// another chapter's files. These edges are grounded in real references, so they
// carry source "deterministic".
export function deterministicEdgesFromChangeMap(changeMap: ChangeMap, chapters: ChapterLike[]): DeterministicEdge[] {
  const fileToChapters = new Map<string, string[]>();
  for (const chapter of chapters) {
    for (const file of chapter.files) {
      const list = fileToChapters.get(file) ?? [];
      if (!list.includes(chapter.id)) {
        list.push(chapter.id);
      }
      fileToChapters.set(file, list);
    }
  }

  const edges: DeterministicEdge[] = [];
  const seen = new Set<string>();
  for (const symbol of changeMap.symbols) {
    const fromChapters = fileToChapters.get(symbol.definedIn) ?? [];
    if (fromChapters.length === 0) {
      continue;
    }
    for (const referencer of symbol.referencedBy) {
      for (const to of fileToChapters.get(referencer) ?? []) {
        for (const from of fromChapters) {
          if (from === to) {
            continue;
          }
          const key = `${from}->${to}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          edges.push({
            from,
            to,
            relation: "dependency",
            confidence: 0.9,
            source: "deterministic",
            reason: `\`${symbol.symbol}\` (defined in ${symbol.definedIn}) is referenced in ${referencer}`,
            evidence: [symbol.symbol, referencer]
          });
        }
      }
    }
  }
  return edges;
}

// A compact, human-readable digest of the most impactful symbols, injected into
// the agent's prompt so it knows the blast radius up front.
export function summarizeChangeMap(changeMap: ChangeMap, maxSymbols = 12): string {
  const ranked = changeMap.symbols
    .filter((symbol) => symbol.referencedBy.length > 0)
    .sort((left, right) => right.referencedBy.length - left.referencedBy.length)
    .slice(0, maxSymbols);
  if (ranked.length === 0) {
    return "";
  }
  const lines = ranked.map((symbol) => {
    const sample = symbol.referencedBy.slice(0, 5).join(", ");
    const more = symbol.referencedBy.length > 5 ? `, +${symbol.referencedBy.length - 5} more` : "";
    return `- \`${symbol.symbol}\` (${symbol.definedIn}) is referenced by ${symbol.referencedBy.length} file(s): ${sample}${more}`;
  });
  return `Blast radius of changed symbols (from static analysis — use get_blast_radius for details):\n${lines.join("\n")}`;
}

const ANALYZABLE = /\.(tsx?|jsx?|mts|cts|go|rs|py)$/i;

export function isAnalyzablePath(path: string): boolean {
  return ANALYZABLE.test(path);
}

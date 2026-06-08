import type { ChangedFile, LspDocumentSymbol, LspPosition, RepositoryRef } from "../../shared/schemas.js";
import { isAnalyzablePath, lineInRanges, parseChangedLineRanges, type ChangeMap, type SymbolImpact } from "./ai/changeMap.js";

// The LSP surface ChangeMapService needs. Declared structurally so it can be
// unit-tested with a stub and decoupled from the full LspService.
export interface ChangeMapLsp {
  getDocumentSymbols(repository: RepositoryRef, headSha: string, path: string): Promise<LspDocumentSymbol[]>;
  getReferences(repository: RepositoryRef, headSha: string, path: string, position: LspPosition): Promise<string[]>;
}

export interface BuildChangeMapOptions {
  signal?: AbortSignal;
  /** Wall-clock budget for the whole pass; on expiry we return what we have. */
  budgetMs?: number;
  maxFiles?: number;
  maxSymbolsPerFile?: number;
}

const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 12;

// Builds the deterministic change map (touched symbols + reverse dependencies)
// for a pull request. Entirely best-effort: any file/symbol that errors, times
// out, or has no language server simply contributes nothing.
export class ChangeMapService {
  constructor(private readonly lsp: ChangeMapLsp) {}

  async build(
    repository: RepositoryRef,
    headSha: string,
    changedFiles: ChangedFile[],
    options: BuildChangeMapOptions = {}
  ): Promise<ChangeMap> {
    const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxSymbolsPerFile = options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE;
    const deadline = Date.now() + budgetMs;
    const symbols: SymbolImpact[] = [];

    const candidates = changedFiles
      .filter((file) => !file.isLarge && !file.isGenerated && file.status !== "removed" && isAnalyzablePath(file.path) && Boolean(file.patch))
      .slice(0, maxFiles);

    for (const file of candidates) {
      if (options.signal?.aborted || Date.now() > deadline) {
        break;
      }
      const ranges = parseChangedLineRanges(file.patch);
      if (ranges.length === 0) {
        continue;
      }

      let documentSymbols: LspDocumentSymbol[];
      try {
        documentSymbols = await this.lsp.getDocumentSymbols(repository, headSha, file.path);
      } catch {
        continue;
      }

      const touched = documentSymbols
        // LSP positions are 0-based; diff ranges are 1-based.
        .filter((symbol) => lineInRanges(symbol.selectionRange.start.line + 1, ranges))
        .slice(0, maxSymbolsPerFile);

      for (const symbol of touched) {
        if (options.signal?.aborted || Date.now() > deadline) {
          break;
        }
        let referencedBy: string[] = [];
        try {
          referencedBy = await this.lsp.getReferences(repository, headSha, file.path, symbol.selectionRange.start);
        } catch {
          referencedBy = [];
        }
        symbols.push({
          symbol: symbol.name,
          definedIn: file.path,
          line: symbol.selectionRange.start.line + 1,
          referencedBy: referencedBy.filter((path) => path !== file.path)
        });
      }
    }

    return { symbols };
  }
}

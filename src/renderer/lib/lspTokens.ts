import type { LspPosition } from "../../shared/schemas.js";

export type LspTokenSide = "additions" | "deletions";

export interface LspTokenPointer {
  lineNumber: number;
  lineCharStart: number;
  lineCharEnd: number;
  tokenText: string;
  tokenElement?: HTMLElement;
  side?: LspTokenSide;
}

export interface LspTokenTarget {
  key: string;
  position: LspPosition;
  tokenText: string;
}

export function tokenPointerFromComposedPath(path: readonly EventTarget[]): LspTokenPointer | null {
  let codeElement: HTMLElement | null = null;
  let lineNumber: number | null = null;
  let lineType: string | null = null;
  let tokenElement: HTMLElement | null = null;
  let lineCharStart: number | null = null;
  let tokenText = "";

  for (const target of path) {
    if (!(target instanceof HTMLElement)) {
      continue;
    }

    if (!tokenElement && target.hasAttribute("data-char")) {
      tokenElement = target;
      lineCharStart = parseIntegerAttribute(target, "data-char");
      tokenText = target.textContent ?? "";
      continue;
    }

    if (lineNumber === null) {
      lineNumber = parseIntegerAttribute(target, "data-line") ?? parseIntegerAttribute(target, "data-column-number");
      lineType = target.getAttribute("data-line-type");
    }

    if (!codeElement && target.hasAttribute("data-code")) {
      codeElement = target;
      break;
    }
  }

  if (!tokenElement || lineCharStart === null || lineNumber === null || tokenText.trim().length === 0) {
    return null;
  }

  return {
    lineNumber,
    lineCharStart,
    lineCharEnd: lineCharStart + tokenText.length,
    tokenText,
    tokenElement,
    side: sideFromRenderedLine(lineType, codeElement)
  };
}

export function targetFromLspToken(path: string, token: LspTokenPointer): LspTokenTarget | null {
  if (!path || token.side === "deletions" || token.tokenText.trim().length === 0) {
    return null;
  }
  if (!Number.isFinite(token.lineNumber) || !Number.isFinite(token.lineCharStart)) {
    return null;
  }

  const line = Math.max(0, Math.trunc(token.lineNumber) - 1);
  const character = Math.max(0, Math.trunc(token.lineCharStart));
  return {
    key: `${path}:${line}:${character}:${token.tokenText}`,
    position: { line, character },
    tokenText: token.tokenText
  };
}

export function isDefinitionGesture(event: Pick<MouseEvent, "ctrlKey" | "metaKey">): boolean {
  return event.ctrlKey || event.metaKey;
}

function parseIntegerAttribute(element: HTMLElement, attribute: string): number | null {
  const value = element.getAttribute(attribute);
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function sideFromRenderedLine(lineType: string | null, codeElement: HTMLElement | null): LspTokenSide | undefined {
  if (lineType === "change-deletion") {
    return "deletions";
  }
  if (lineType === "change-addition") {
    return "additions";
  }
  if (codeElement?.hasAttribute("data-deletions")) {
    return "deletions";
  }
  return codeElement ? "additions" : undefined;
}

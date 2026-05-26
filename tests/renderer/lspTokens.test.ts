import { describe, expect, it } from "vitest";
import { isDefinitionGesture, targetFromLspToken, tokenPointerFromComposedPath } from "../../src/renderer/lib/lspTokens.js";

describe("lsp token helpers", () => {
  it("converts renderer token coordinates to zero-based LSP positions", () => {
    expect(
      targetFromLspToken("src/app.ts", {
        lineNumber: 12,
        lineCharStart: 8,
        lineCharEnd: 14,
        tokenText: "render"
      })
    ).toEqual({
      key: "src/app.ts:11:8:render",
      position: { line: 11, character: 8 },
      tokenText: "render"
    });
  });

  it("ignores deleted diff-side tokens", () => {
    expect(
      targetFromLspToken("src/app.ts", {
        lineNumber: 12,
        lineCharStart: 8,
        lineCharEnd: 14,
        tokenText: "render",
        side: "deletions"
      })
    ).toBeNull();
  });

  it("recognizes platform definition gestures", () => {
    expect(isDefinitionGesture({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(isDefinitionGesture({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(isDefinitionGesture({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("resolves rendered token pointers from composed DOM paths", () => {
    const token = document.createElement("span");
    token.dataset.char = "10";
    token.textContent = "FlushContext";
    const line = document.createElement("div");
    line.dataset.line = "42";
    line.dataset.lineType = "context";
    const code = document.createElement("code");
    code.dataset.code = "";

    expect(tokenPointerFromComposedPath([token, line, code])).toMatchObject({
      lineNumber: 42,
      lineCharStart: 10,
      lineCharEnd: 22,
      tokenText: "FlushContext",
      tokenElement: token,
      side: "additions"
    });
  });

  it("marks deletion-side rendered token pointers", () => {
    const token = document.createElement("span");
    token.dataset.char = "4";
    token.textContent = "removed";
    const line = document.createElement("div");
    line.dataset.line = "8";
    line.dataset.lineType = "change-deletion";
    const code = document.createElement("code");
    code.dataset.code = "";

    expect(tokenPointerFromComposedPath([token, line, code])?.side).toBe("deletions");
  });
});

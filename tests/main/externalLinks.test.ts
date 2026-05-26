// @vitest-environment node
import { shell } from "electron";
import { describe, expect, it, vi } from "vitest";
import { isAllowedAppNavigation, normalizeExternalUrl, openExternalUrl } from "../../src/main/externalLinks.js";

vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn(async () => undefined)
  }
}));

describe("external link hardening", () => {
  it("allows only HTTP(S) URLs to leave the app", async () => {
    expect(normalizeExternalUrl("https://github.com/kol/repo")).toBe("https://github.com/kol/repo");
    expect(normalizeExternalUrl("http://localhost:5173/path")).toBe("http://localhost:5173/path");
    expect(normalizeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeExternalUrl("not a url")).toBeNull();

    await expect(openExternalUrl("javascript:alert(1)")).resolves.toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();

    await expect(openExternalUrl("https://github.com/")).resolves.toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith("https://github.com/");
  });

  it("allows app navigation only for packaged files or the configured dev server origin", () => {
    expect(isAllowedAppNavigation("file:///Applications/KRT/index.html")).toBe(true);
    expect(isAllowedAppNavigation("http://127.0.0.1:5173/src/main.tsx", "http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedAppNavigation("http://127.0.0.1:5174/src/main.tsx", "http://127.0.0.1:5173")).toBe(false);
    expect(isAllowedAppNavigation("https://github.com/kol/repo", "http://127.0.0.1:5173")).toBe(false);
    expect(isAllowedAppNavigation("javascript:alert(1)", "http://127.0.0.1:5173")).toBe(false);
  });
});

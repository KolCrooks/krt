// @vitest-environment node
import { describe, expect, it } from "vitest";
import { selectDataMode } from "../../src/shared/modeSelection.js";

describe("selectDataMode", () => {
  it("uses light mode when explicitly requested", () => {
    expect(selectDataMode({ preferredMode: "light", mirrorExists: true, mirrorFresh: true, worktreeExists: true }).mode).toBe("light");
  });

  it("uses managed mode only when the pull request worktree exists", () => {
    expect(selectDataMode({ preferredMode: "managed", mirrorExists: true, mirrorFresh: false, worktreeExists: true }).mode).toBe("managed");
    expect(selectDataMode({ preferredMode: "managed", mirrorExists: true, mirrorFresh: true, worktreeExists: false }).mode).toBe("light");
  });

  it("auto mode prefers checked-out pull request worktrees", () => {
    expect(selectDataMode({ preferredMode: "auto", mirrorExists: true, mirrorFresh: true, worktreeExists: true }).mode).toBe("managed");
    expect(selectDataMode({ preferredMode: "auto", mirrorExists: true, mirrorFresh: true, worktreeExists: false }).mode).toBe("light");
  });
});

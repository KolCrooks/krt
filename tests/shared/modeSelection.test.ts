// @vitest-environment node
import { describe, expect, it } from "vitest";
import { selectDataMode } from "../../src/shared/modeSelection.js";

describe("selectDataMode", () => {
  it("uses light mode when explicitly requested", () => {
    expect(selectDataMode({ preferredMode: "light", mirrorExists: true, mirrorFresh: true }).mode).toBe("light");
  });

  it("uses managed mode only when a managed mirror can be used", () => {
    expect(selectDataMode({ preferredMode: "managed", mirrorExists: true, mirrorFresh: false }).mode).toBe("managed");
    expect(selectDataMode({ preferredMode: "managed", mirrorExists: false, mirrorFresh: false }).mode).toBe("light");
  });

  it("auto mode prefers fresh mirrors", () => {
    expect(selectDataMode({ preferredMode: "auto", mirrorExists: true, mirrorFresh: true }).mode).toBe("managed");
    expect(selectDataMode({ preferredMode: "auto", mirrorExists: true, mirrorFresh: false }).mode).toBe("light");
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/main/services/database.js";
import { SettingsStore } from "../../src/main/services/settingsStore.js";

describe("SettingsStore", () => {
  it("persists nested settings updates without losing defaults", () => {
    const db = openDatabase(":memory:");
    const store = new SettingsStore(db);

    const updated = store.update({
      data: { preferredMode: "light" },
      appearance: { density: "comfortable" },
      updates: { enabled: true, feedUrl: "https://updates.example.com/stable.json" }
    });

    expect(updated.data.preferredMode).toBe("light");
    expect(updated.data.worktreeCacheSizeGb).toBe(20);
    expect(updated.updates.channel).toBe("stable");
    expect(store.get().appearance.density).toBe("comfortable");
  });
});

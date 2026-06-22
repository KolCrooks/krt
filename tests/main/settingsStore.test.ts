// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/main/services/database.js";
import { SettingsStore } from "../../src/main/services/settingsStore.js";
import { DEFAULT_AI_MODELS } from "../../src/shared/aiModels.js";

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

  it("migrates stale bundled AI model defaults without overwriting custom models", () => {
    const db = openDatabase(":memory:");
    const store = new SettingsStore(db);

    db.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)").run(
      "settings",
      JSON.stringify({ ai: { enabled: true, provider: "anthropic", model: "claude-sonnet-4-5" } }),
      "2026-06-22T00:00:00.000Z"
    );
    expect(store.get().ai.model).toBe(DEFAULT_AI_MODELS.anthropic);

    store.update({ ai: { model: "claude-custom-review-model" } });
    expect(store.get().ai.model).toBe("claude-custom-review-model");
  });
});

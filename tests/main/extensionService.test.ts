// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors.js";
import { ExtensionService } from "../../src/main/services/extensionService.js";
import { openDatabase } from "../../src/main/services/database.js";
import { SettingsStore } from "../../src/main/services/settingsStore.js";

describe("ExtensionService", () => {
  it("persists enablement overrides through settings", () => {
    const settings = new SettingsStore(openDatabase(":memory:"));
    const service = new ExtensionService(() => settings.get(), (update) => settings.update(update));

    const updated = service.setEnabled("typescript-language-server", false);

    expect(updated.enabled).toBe(false);
    expect(settings.get().extensions["typescript-language-server"]).toBe(false);
    expect(service.list().find((extension) => extension.id === "typescript-language-server")?.enabled).toBe(false);
    expect(service.getLogs("typescript-language-server")[0]?.message).toBe("Extension disabled.");
  });

  it("rejects unknown extension ids", () => {
    const service = new ExtensionService();

    expect(() => service.setEnabled("missing-extension", false)).toThrow(AppError);
  });
});

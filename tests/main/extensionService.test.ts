// @vitest-environment node
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors.js";
import { ExtensionService } from "../../src/main/services/extensionService.js";
import { openDatabase } from "../../src/main/services/database.js";
import { SettingsStore } from "../../src/main/services/settingsStore.js";

describe("ExtensionService", () => {
  it("loads built-in extension manifests including the rust-analyzer demo", () => {
    const service = new ExtensionService();

    const rust = service.list().find((extension) => extension.id === "rust-analyzer");

    expect(rust).toMatchObject({
      name: "Rust Analyzer",
      enabled: true,
      source: "builtin",
      version: "1.0.0",
      activationGlobs: ["**/*.rs", "**/Cargo.toml"],
      command: { program: "rust-analyzer", args: [] }
    });
    expect(rust?.kind).toContain("language");
    expect(rust?.contributes?.lsp?.features).toEqual(["hover", "definition", "symbols"]);
    expect(rust?.contributes?.lsp?.settings).toMatchObject({
      cachePriming: { enable: true },
      cargo: {
        allTargets: true,
        autoreload: true,
        buildScripts: { enable: true }
      },
      checkOnSave: false,
      diagnostics: { enable: false },
      hover: { memoryLayout: { enable: true } },
      lens: { enable: true },
      procMacro: { enable: true }
    });
  });

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

  it("loads local extension manifests from the configured extension directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt2-extensions-"));
    const extensionDir = join(root, "demo-language");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "demo-language",
        name: "Demo Language",
        version: "0.0.1",
        description: "Local extension loaded from disk.",
        kind: ["language"],
        activation: { globs: ["**/*.demo"], languages: ["demo"] },
        contributes: {
          lsp: {
            command: { program: "demo-lsp", args: ["--stdio"] },
            languages: ["demo"],
            features: ["diagnostics"]
          }
        }
      })
    );

    const service = new ExtensionService(undefined, undefined, { builtinManifests: [], localExtensionDir: root });

    expect(service.list()).toEqual([
      expect.objectContaining({
        id: "demo-language",
        source: "local",
        manifestPath: join(extensionDir, "extension.json"),
        activationGlobs: ["**/*.demo"],
        capabilities: ["diagnostics"],
        command: { program: "demo-lsp", args: ["--stdio"] }
      })
    ]);
  });
});

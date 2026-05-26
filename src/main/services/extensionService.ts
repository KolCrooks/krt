import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings, ExtensionDescriptor, ExtensionLog, ExtensionManifest } from "../../shared/schemas.js";
import { extensionManifestSchema } from "../../shared/schemas.js";
import type { SettingsUpdate } from "./settingsStore.js";
import { AppError } from "../errors.js";
import rustAnalyzerManifest from "../extensions/builtin/rust-analyzer/extension.json" with { type: "json" };
import typescriptManifest from "../extensions/builtin/typescript-language-server/extension.json" with { type: "json" };
import goplsManifest from "../extensions/builtin/gopls/extension.json" with { type: "json" };
import ruffManifest from "../extensions/builtin/ruff/extension.json" with { type: "json" };
import reviewToolsManifest from "../extensions/builtin/review-tools/extension.json" with { type: "json" };

interface ExtensionServiceOptions {
  builtinManifests?: unknown[];
  localExtensionDir?: string | null;
}

type RegisteredExtension = ExtensionDescriptor & {
  version: string;
  source: "builtin" | "local";
  kind: NonNullable<ExtensionDescriptor["kind"]>;
  contributes: NonNullable<ExtensionDescriptor["contributes"]>;
  manifest: ExtensionManifest;
};

const defaultBuiltinManifests: unknown[] = [
  rustAnalyzerManifest,
  typescriptManifest,
  goplsManifest,
  ruffManifest,
  reviewToolsManifest
];

export class ExtensionService {
  private readonly extensions: RegisteredExtension[];
  private readonly logs: ExtensionLog[] = [
    {
      id: "log-1",
      extensionId: "review-tools",
      level: "info",
      message: "Extension registry initialized.",
      createdAt: new Date().toISOString()
    }
  ];

  constructor(
    private readonly getSettings: () => Pick<AppSettings, "extensions"> = () => ({ extensions: {} }),
    private readonly updateSettings: (update: SettingsUpdate) => void = () => undefined,
    options: ExtensionServiceOptions = {}
  ) {
    this.extensions = this.loadExtensions(options);
  }

  list(): ExtensionDescriptor[] {
    const overrides = this.getSettings().extensions;
    return this.extensions.map((extension) => ({
      ...extension,
      enabled: overrides[extension.id] ?? extension.enabled
    }));
  }

  setEnabled(extensionId: string, enabled: boolean): ExtensionDescriptor {
    const extension = this.extensions.find((candidate) => candidate.id === extensionId);
    if (!extension) {
      throw new AppError("extension_not_found", `No extension named ${extensionId} exists.`);
    }

    this.updateSettings({ extensions: { [extensionId]: enabled } });
    this.appendLog({
      extensionId,
      level: "info",
      message: enabled ? "Extension enabled." : "Extension disabled."
    });
    return {
      ...extension,
      enabled
    };
  }

  getLogs(extensionId?: string): ExtensionLog[] {
    return extensionId ? this.logs.filter((log) => log.extensionId === extensionId) : this.logs;
  }

  appendLog(input: Omit<ExtensionLog, "id" | "createdAt">): ExtensionLog {
    const log = {
      ...input,
      id: `log-${this.logs.length + 1}`,
      createdAt: new Date().toISOString()
    };
    this.logs.unshift(log);
    return log;
  }

  private loadExtensions(options: ExtensionServiceOptions): RegisteredExtension[] {
    const manifests = [
      ...this.parseManifestList(options.builtinManifests ?? defaultBuiltinManifests, "builtin"),
      ...this.loadLocalManifests(options.localExtensionDir ?? null)
    ];
    const byId = new Map<string, RegisteredExtension>();

    for (const extension of manifests) {
      if (byId.has(extension.id)) {
        this.appendLog({
          extensionId: extension.id,
          level: "warning",
          message: `Duplicate extension id ignored from ${extension.source} manifest.`
        });
        continue;
      }
      byId.set(extension.id, extension);
    }

    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private parseManifestList(inputs: unknown[], source: "builtin" | "local", manifestPath?: string): RegisteredExtension[] {
    return inputs.flatMap((input) => {
      try {
        return [descriptorFromManifest(extensionManifestSchema.parse(input), source, manifestPath)];
      } catch (error) {
        this.appendLog({
          extensionId: "extension-registry",
          level: "error",
          message: `Invalid ${source} extension manifest${manifestPath ? ` at ${manifestPath}` : ""}: ${error instanceof Error ? error.message : String(error)}`
        });
        return [];
      }
    });
  }

  private loadLocalManifests(localExtensionDir: string | null): RegisteredExtension[] {
    if (!localExtensionDir || !existsSync(localExtensionDir)) {
      return [];
    }

    const manifests: RegisteredExtension[] = [];
    for (const entry of readdirSync(localExtensionDir)) {
      const extensionDir = join(localExtensionDir, entry);
      if (!statSync(extensionDir).isDirectory()) {
        continue;
      }

      const manifestPath = join(extensionDir, "extension.json");
      if (!existsSync(manifestPath)) {
        continue;
      }

      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
        manifests.push(...this.parseManifestList([raw], "local", manifestPath));
      } catch (error) {
        this.appendLog({
          extensionId: entry,
          level: "error",
          message: `Failed to read local extension manifest: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    return manifests;
  }
}

function descriptorFromManifest(
  manifest: ExtensionManifest,
  source: "builtin" | "local",
  manifestPath?: string
): RegisteredExtension {
  const command = manifest.contributes.lsp?.command ?? manifest.contributes.diagnostics[0]?.command;
  const activationGlobs = manifest.activation.globs;
  const capabilities = capabilitiesFromManifest(manifest);
  return {
    id: manifest.id,
    name: manifest.name,
    enabled: true,
    description: manifest.description,
    activationGlobs,
    capabilities,
    command,
    version: manifest.version,
    publisher: manifest.publisher,
    source,
    kind: manifest.kind,
    contributes: manifest.contributes,
    manifestPath,
    manifest
  };
}

function capabilitiesFromManifest(manifest: ExtensionManifest): string[] {
  const capabilities = new Set<string>();
  for (const feature of manifest.contributes.lsp?.features ?? []) {
    capabilities.add(feature);
  }
  for (const diagnostic of manifest.contributes.diagnostics) {
    if (diagnostic.command) {
      capabilities.add("diagnostics");
    }
  }
  for (const capability of manifest.contributes.review?.capabilities ?? []) {
    capabilities.add(capability);
  }
  if (manifest.contributes.commands.length > 0) {
    capabilities.add("commands");
  }
  return [...capabilities];
}

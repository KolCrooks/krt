import type { AppSettings } from "../../shared/schemas.js";
import type { SettingsUpdate } from "./settingsStore.js";
import { AppError } from "../errors.js";

export interface ExtensionDescriptor {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  activationGlobs: string[];
  capabilities: string[];
  command?: {
    program: string;
    args: string[];
  };
}

export interface ExtensionLog {
  id: string;
  extensionId: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  createdAt: string;
}

export class ExtensionService {
  constructor(
    private readonly getSettings: () => Pick<AppSettings, "extensions"> = () => ({ extensions: {} }),
    private readonly updateSettings: (update: SettingsUpdate) => void = () => undefined
  ) {}

  private readonly extensions: ExtensionDescriptor[] = [
    {
      id: "rust-analyzer",
      name: "rust-analyzer",
      enabled: true,
      description: "Rust diagnostics, hover, symbols, and definitions in managed worktrees.",
      activationGlobs: ["**/*.rs", "**/Cargo.toml"],
      capabilities: ["diagnostics", "hover", "definition", "symbols"],
      command: { program: "rust-analyzer", args: [] }
    },
    {
      id: "typescript-language-server",
      name: "TypeScript",
      enabled: true,
      description: "TypeScript and JavaScript language context for review-focused editor mode.",
      activationGlobs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
      capabilities: ["diagnostics", "hover", "definition", "symbols"],
      command: { program: "typescript-language-server", args: ["--stdio"] }
    },
    {
      id: "gopls",
      name: "gopls",
      enabled: true,
      description: "Go language server support.",
      activationGlobs: ["**/*.go", "**/go.mod"],
      capabilities: ["diagnostics", "hover", "definition", "symbols"],
      command: { program: "gopls", args: [] }
    },
    {
      id: "ruff",
      name: "Ruff",
      enabled: true,
      description: "Python lint diagnostics for managed worktrees.",
      activationGlobs: ["**/*.py", "**/pyproject.toml"],
      capabilities: ["diagnostics"],
      command: { program: "ruff", args: ["server"] }
    },
    {
      id: "review-tools",
      name: "Review Tools",
      enabled: true,
      description: "Built-in review comments, AI anchors, and PR workflow commands.",
      activationGlobs: ["**/*"],
      capabilities: ["comments", "ai-anchors", "review-submit"]
    }
  ];

  private readonly logs: ExtensionLog[] = [
    {
      id: "log-1",
      extensionId: "review-tools",
      level: "info",
      message: "Extension registry initialized.",
      createdAt: new Date().toISOString()
    }
  ];

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
}

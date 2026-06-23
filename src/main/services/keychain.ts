import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "../errors.js";
import { resolveCommand, type ResolvedCommand } from "./commandResolver.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class Keychain {
  constructor(
    private readonly serviceName = "KolReviewTool",
    private readonly resolveExecutable: (command: string) => Promise<ResolvedCommand | null> = resolveCommand
  ) {}

  async getSecret(account: string): Promise<string | null> {
    if (process.platform !== "darwin") {
      return process.env[account] ?? null;
    }

    try {
      const result = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        this.serviceName,
        "-a",
        account,
        "-w"
      ]);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async setSecret(account: string, secret: string): Promise<void> {
    if (process.platform !== "darwin") {
      process.env[account] = secret;
      return;
    }

    try {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-s",
        this.serviceName,
        "-a",
        account,
        "-w",
        secret
      ]);
    } catch (error) {
      throw new AppError("keychain_write_failed", "Unable to store the secret in macOS Keychain.", {
        details: error
      });
    }
  }

  async deleteSecret(account: string): Promise<void> {
    if (process.platform !== "darwin") {
      delete process.env[account];
      return;
    }

    try {
      await execFileAsync("security", ["delete-generic-password", "-s", this.serviceName, "-a", account]);
    } catch {
      // Missing credentials are already cleared from the app's perspective.
    }
  }

  async getGhAuthToken(): Promise<string | null> {
    try {
      const gh = await this.resolveExecutable("gh");
      if (!gh) {
        return null;
      }

      const result = await execFileAsync(gh.program, ["auth", "token"], {
        env: gh.env,
        timeout: 5_000,
        maxBuffer: 64 * 1024
      });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getCommandSecret(command: string): Promise<string | null> {
    const trimmed = command.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const result = await execAsync(trimmed, {
        timeout: 5_000,
        maxBuffer: 64 * 1024
      });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }
}

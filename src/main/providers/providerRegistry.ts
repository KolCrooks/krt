import { GitHubProvider } from "./githubProvider.js";
import type { Provider } from "./provider.js";
import type { Keychain } from "../services/keychain.js";
import type { ProviderResponseCache } from "../services/providerResponseCache.js";
import { defaultAppSettings, type AppSettings } from "../../shared/schemas.js";

export class ProviderRegistry {
  constructor(
    private readonly keychain: Keychain,
    private readonly responseCache: ProviderResponseCache,
    private readonly getSettings: () => AppSettings = () => defaultAppSettings
  ) {}

  async get(providerId: "github"): Promise<Provider> {
    if (providerId === "github") {
      const token = await this.getGitHubToken();
      return new GitHubProvider(token, this.responseCache);
    }

    throw new Error(`Unsupported provider: ${providerId}`);
  }

  async getGitHubToken(): Promise<string | null> {
    const settings = this.getSettings();

    switch (settings.github.tokenProvider) {
      case "environment":
        return process.env.GITHUB_TOKEN ?? null;
      case "gh-cli":
        return this.keychain.getGhAuthToken();
      case "keychain":
      default:
        return (
          (await this.keychain.getSecret("GITHUB_TOKEN")) ??
          process.env.GITHUB_TOKEN ??
          (await this.keychain.getGhAuthToken())
        );
    }
  }
}

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../../src/main/providers/providerRegistry.js";
import type { Keychain } from "../../src/main/services/keychain.js";
import type { ProviderResponseCache } from "../../src/main/services/providerResponseCache.js";
import { defaultAppSettings } from "../../src/shared/schemas.js";

describe("ProviderRegistry", () => {
  const originalGitHubToken = process.env.GITHUB_TOKEN;

  afterEach(() => {
    if (originalGitHubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGitHubToken;
    }
    vi.restoreAllMocks();
  });

  it("loads GitHub tokens from gh CLI when selected", async () => {
    const getGhAuthToken = vi.fn(async () => "gh-cli-token");
    const registry = new ProviderRegistry(
      { getGhAuthToken } as unknown as Keychain,
      {} as ProviderResponseCache,
      () => ({
        ...defaultAppSettings,
        github: { ...defaultAppSettings.github, tokenProvider: "gh-cli" }
      })
    );

    await expect(registry.getGitHubToken()).resolves.toBe("gh-cli-token");
    expect(getGhAuthToken).toHaveBeenCalledOnce();
  });

  it("loads GitHub tokens from the environment when selected", async () => {
    process.env.GITHUB_TOKEN = "env-token";
    const getSecret = vi.fn(async () => "keychain-token");
    const registry = new ProviderRegistry(
      { getSecret } as unknown as Keychain,
      {} as ProviderResponseCache,
      () => ({
        ...defaultAppSettings,
        github: { ...defaultAppSettings.github, tokenProvider: "environment" }
      })
    );

    await expect(registry.getGitHubToken()).resolves.toBe("env-token");
    expect(getSecret).not.toHaveBeenCalled();
  });
});

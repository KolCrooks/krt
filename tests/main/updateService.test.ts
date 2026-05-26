// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppSettings } from "../../src/shared/schemas.js";
import { AppError } from "../../src/main/errors.js";
import { UpdateService, type AutoUpdateDriver, type AutoUpdateEvent } from "../../src/main/services/updateService.js";

describe("UpdateService", () => {
  it("reports disabled status without touching the updater", () => {
    const driver = new FakeAutoUpdateDriver();
    const service = new UpdateService(() => defaultAppSettings, "0.1.0", driver);

    expect(service.getStatus()).toMatchObject({
      enabled: false,
      configured: false,
      state: "disabled",
      currentVersion: "0.1.0"
    });
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
  });

  it("configures the feed and starts a check when updates are enabled", () => {
    const driver = new FakeAutoUpdateDriver();
    const service = new UpdateService(() => enabledSettings(), "0.1.0", driver, () => "2026-05-22T00:00:00.000Z");

    const status = service.checkForUpdates();

    expect(driver.feed).toEqual({ url: "https://updates.example.com/stable.json", serverType: "json" });
    expect(driver.checkForUpdates).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      enabled: true,
      configured: true,
      state: "checking",
      checkedAt: "2026-05-22T00:00:00.000Z"
    });
  });

  it("tracks downloaded updates and installs only after download", () => {
    const driver = new FakeAutoUpdateDriver();
    const service = new UpdateService(() => enabledSettings(), "0.1.0", driver, () => "2026-05-22T00:00:00.000Z");

    expect(() => service.installDownloadedUpdate()).toThrow(AppError);

    service.checkForUpdates();
    driver.emit("update-downloaded", {}, "", "0.2.0", new Date("2026-05-23T00:00:00.000Z"), "");

    expect(service.getStatus()).toMatchObject({
      state: "downloaded",
      availableVersion: "0.2.0",
      releaseDate: "2026-05-23T00:00:00.000Z"
    });

    expect(service.installDownloadedUpdate()).toMatchObject({ state: "installing" });
    expect(driver.quitAndInstall).toHaveBeenCalledOnce();
  });
});

function enabledSettings(): AppSettings {
  return {
    ...defaultAppSettings,
    updates: {
      enabled: true,
      channel: "stable",
      feedUrl: "https://updates.example.com/stable.json"
    }
  };
}

class FakeAutoUpdateDriver implements AutoUpdateDriver {
  readonly checkForUpdates = vi.fn();
  readonly quitAndInstall = vi.fn();
  feed: { url: string; serverType?: "json" | "default" } | null = null;
  private readonly listeners = new Map<AutoUpdateEvent, Array<(...args: any[]) => void>>();

  setFeedURL(options: { url: string; serverType?: "json" | "default" }): void {
    this.feed = options;
  }

  on(event: AutoUpdateEvent, listener: (...args: any[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: AutoUpdateEvent, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppSettings } from "../../src/shared/schemas.js";
import { krtUpdateFeedUrl } from "../../src/shared/releases.js";
import { AppError } from "../../src/main/errors.js";
import {
  UpdateService,
  type AutoUpdateDriver,
  type AutoUpdateEvent,
  type UpdateFeedProbeResult
} from "../../src/main/services/updateService.js";

describe("UpdateService", () => {
  it("reports the default GitHub updater feed without touching the updater", () => {
    const driver = new FakeAutoUpdateDriver();
    const service = serviceWithDefaultFeed(driver);

    expect(service.getStatus()).toMatchObject({
      enabled: false,
      configured: true,
      state: "idle",
      currentVersion: "0.1.0",
      feedUrl: testFeedUrl(),
      message: "Ready to check for updates."
    });
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
  });

  it("configures the default GitHub updater feed and reports latest version metadata", async () => {
    const driver = new FakeAutoUpdateDriver();
    const service = serviceWithDefaultFeed(driver);

    const status = await service.checkForUpdates();

    expect(driver.feed).toEqual({ url: testFeedUrl(), serverType: "default" });
    expect(driver.checkForUpdates).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      enabled: false,
      configured: true,
      state: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      message: "Update available.",
      checkedAt: "2026-05-22T00:00:00.000Z"
    });
  });

  it("does not start the updater when the latest release matches the current version", async () => {
    const driver = new FakeAutoUpdateDriver();
    const service = serviceWithDefaultFeed(driver, { version: "v0.1.0" });

    const status = await service.checkForUpdates();

    expect(driver.checkForUpdates).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      state: "not_available",
      availableVersion: "0.1.0",
      message: "App is up to date."
    });
  });

  it("preserves explicit update feeds for packaged update metadata", async () => {
    const driver = new FakeAutoUpdateDriver();
    const service = new UpdateService(
      () => enabledSettings(),
      "0.1.0",
      driver,
      () => "2026-05-22T00:00:00.000Z",
      "darwin",
      "arm64",
      async () => ({ version: "0.2.0" }),
      async () => ({ state: "available" })
    );

    await service.checkForUpdates();

    expect(driver.feed).toEqual({ url: "https://updates.example.com/stable.json", serverType: "json" });
  });

  it("tracks downloaded updates and installs only after download", async () => {
    const driver = new FakeAutoUpdateDriver();
    const service = new UpdateService(
      () => enabledSettings(),
      "0.1.0",
      driver,
      () => "2026-05-22T00:00:00.000Z",
      "darwin",
      "arm64",
      async () => ({ version: "0.2.0" }),
      async () => ({ state: "available" })
    );

    expect(() => service.installDownloadedUpdate()).toThrow(AppError);

    await service.checkForUpdates();
    driver.emit("update-downloaded", {}, "", "0.2.0", new Date("2026-05-23T00:00:00.000Z"), "");

    expect(service.getStatus()).toMatchObject({
      state: "downloaded",
      availableVersion: "0.2.0",
      releaseDate: "2026-05-23T00:00:00.000Z"
    });

    expect(service.installDownloadedUpdate()).toMatchObject({ state: "installing" });
    expect(driver.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("falls back to update available when the native updater keeps checking", async () => {
    vi.useFakeTimers();
    try {
      const driver = new FakeAutoUpdateDriver();
      const service = serviceWithDefaultFeed(driver, { version: "0.2.0" }, 10);

      await service.checkForUpdates();
      driver.emit("checking-for-update");

      expect(service.getStatus()).toMatchObject({
        state: "checking",
        availableVersion: "0.2.0"
      });

      vi.advanceTimersByTime(10);

      expect(service.getStatus()).toMatchObject({
        state: "available",
        availableVersion: "0.2.0",
        message: "Update available."
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unavailable update package without invoking the native updater", async () => {
    const driver = new FakeAutoUpdateDriver();
    const service = serviceWithDefaultFeed(driver, { version: "0.2.0" }, 15_000, {
      state: "unavailable",
      message: "Update package is not available yet."
    });

    const status = await service.checkForUpdates();

    expect(driver.checkForUpdates).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      state: "available",
      availableVersion: "0.2.0",
      message: "Update package is not available yet."
    });
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

function serviceWithDefaultFeed(
  driver: FakeAutoUpdateDriver,
  latestRelease = { version: "0.2.0" },
  timeoutMs = 15_000,
  feedProbe: UpdateFeedProbeResult = { state: "available" }
): UpdateService {
  return new UpdateService(
    () => defaultAppSettings,
    "0.1.0",
    driver,
    () => "2026-05-22T00:00:00.000Z",
    "darwin",
    "arm64",
    async () => latestRelease,
    async () => feedProbe,
    timeoutMs
  );
}

function testFeedUrl(): string {
  return krtUpdateFeedUrl("darwin", "arm64", "0.1.0");
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

import type { AppSettings, UpdateStatus } from "../../shared/schemas.js";
import { AppError } from "../errors.js";

export type AutoUpdateEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "update-downloaded"
  | "error";

export interface AutoUpdateDriver {
  setFeedURL(options: { url: string; serverType?: "json" | "default" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: AutoUpdateEvent, listener: (...args: any[]) => void): this;
}

type RuntimeStatus = Pick<
  UpdateStatus,
  "state" | "message" | "availableVersion" | "releaseDate" | "checkedAt"
>;

export class UpdateService {
  private wired = false;
  private runtimeStatus: RuntimeStatus | null = null;

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly appVersion: string,
    private readonly driver: AutoUpdateDriver,
    private readonly now = () => new Date().toISOString()
  ) {}

  getStatus(): UpdateStatus {
    const settings = this.getSettings().updates;
    const configured = Boolean(settings.feedUrl);

    if (!settings.enabled) {
      return this.statusFromRuntime({
        state: "disabled",
        message: "Updates are disabled."
      });
    }

    if (!configured) {
      return this.statusFromRuntime({
        state: "disabled",
        message: "Update feed is not configured."
      });
    }

    return this.statusFromRuntime(this.runtimeStatus ?? { state: "idle", message: "Ready to check for updates." });
  }

  checkForUpdates(): UpdateStatus {
    const settings = this.getSettings().updates;
    if (!settings.enabled || !settings.feedUrl) {
      return this.getStatus();
    }

    this.wireEvents();
    try {
      this.driver.setFeedURL({ url: settings.feedUrl, serverType: "json" });
      this.setRuntimeStatus({
        state: "checking",
        message: "Checking for updates."
      });
      this.driver.checkForUpdates();
      return this.getStatus();
    } catch (error) {
      this.setRuntimeStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Unable to check for updates."
      });
      throw new AppError("update_check_failed", "Unable to check for updates.", { details: error });
    }
  }

  installDownloadedUpdate(): UpdateStatus {
    if (this.runtimeStatus?.state !== "downloaded") {
      throw new AppError("update_not_downloaded", "No downloaded update is ready to install.");
    }

    this.setRuntimeStatus({
      ...this.runtimeStatus,
      state: "installing",
      message: "Installing downloaded update."
    });
    this.driver.quitAndInstall();
    return this.getStatus();
  }

  private wireEvents(): void {
    if (this.wired) {
      return;
    }

    this.driver.on("checking-for-update", () => {
      this.setRuntimeStatus({ state: "checking", message: "Checking for updates." });
    });
    this.driver.on("update-available", () => {
      this.setRuntimeStatus({ state: "available", message: "Update found and download started." });
    });
    this.driver.on("update-not-available", () => {
      this.setRuntimeStatus({ state: "not_available", message: "App is up to date." });
    });
    this.driver.on("update-downloaded", (_event, _releaseNotes, releaseName, releaseDate) => {
      this.setRuntimeStatus({
        state: "downloaded",
        message: "Update downloaded and ready to install.",
        availableVersion: releaseName || undefined,
        releaseDate: Number.isNaN(releaseDate.getTime()) ? undefined : releaseDate.toISOString()
      });
    });
    this.driver.on("error", (error) => {
      this.setRuntimeStatus({
        state: "error",
        message: error.message || "Updater failed."
      });
    });

    this.wired = true;
  }

  private setRuntimeStatus(status: Omit<RuntimeStatus, "checkedAt"> & { checkedAt?: string }): void {
    this.runtimeStatus = {
      ...status,
      checkedAt: status.checkedAt ?? this.now()
    };
  }

  private statusFromRuntime(runtime: RuntimeStatus | (Omit<RuntimeStatus, "checkedAt"> & { checkedAt?: string })): UpdateStatus {
    const settings = this.getSettings().updates;
    return {
      enabled: settings.enabled,
      configured: Boolean(settings.feedUrl),
      channel: settings.channel,
      state: runtime.state,
      currentVersion: this.appVersion,
      feedUrl: settings.feedUrl,
      availableVersion: runtime.availableVersion,
      releaseDate: runtime.releaseDate,
      message: runtime.message,
      checkedAt: runtime.checkedAt
    };
  }
}

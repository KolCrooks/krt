import type { AppSettings, UpdateStatus } from "../../shared/schemas.js";
import { KRT_LATEST_RELEASE_API_URL, krtUpdateFeedUrl } from "../../shared/releases.js";
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

export interface LatestRelease {
  version: string;
  releaseDate?: string;
}

export type LatestReleaseFetcher = () => Promise<LatestRelease | null>;

export interface UpdateFeedProbeResult {
  state: "available" | "not_available" | "unavailable";
  message?: string;
}

export type UpdateFeedProbe = (feedUrl: string) => Promise<UpdateFeedProbeResult>;

type RuntimeStatus = Pick<
  UpdateStatus,
  "state" | "message" | "availableVersion" | "releaseDate" | "checkedAt"
>;

const updateCheckTimeoutMs = 15_000;

export class UpdateService {
  private wired = false;
  private runtimeStatus: RuntimeStatus | null = null;
  private checkTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly appVersion: string,
    private readonly driver: AutoUpdateDriver,
    private readonly now = () => new Date().toISOString(),
    private readonly platform = process.platform,
    private readonly arch = process.arch,
    private readonly fetchLatestRelease: LatestReleaseFetcher = fetchLatestKrtRelease,
    private readonly probeUpdateFeed: UpdateFeedProbe = probeElectronUpdateFeed,
    private readonly checkTimeoutMs = updateCheckTimeoutMs
  ) {}

  getStatus(): UpdateStatus {
    return this.statusFromRuntime(this.runtimeStatus ?? { state: "idle", message: "Ready to check for updates." });
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    const settings = this.getSettings().updates;
    const feedUrl = settings.feedUrl ?? this.defaultFeedUrl();
    const serverType = settings.feedUrl ? "json" : "default";

    this.wireEvents();
    this.setRuntimeStatus({
      state: "checking",
      message: "Checking for updates."
    });

    const latestRelease = await this.getLatestReleaseMetadata();
    if (latestRelease) {
      const latestVersion = normalizeReleaseVersion(latestRelease.version);
      if (isNewerVersion(latestVersion, this.appVersion)) {
        this.setRuntimeStatus({
          state: "available",
          message: "Update available.",
          availableVersion: latestVersion,
          releaseDate: latestRelease.releaseDate
        });
      } else {
        this.setRuntimeStatus({
          state: "not_available",
          message: "App is up to date.",
          availableVersion: latestVersion,
          releaseDate: latestRelease.releaseDate
        });
        return this.getStatus();
      }
    }

    const feedProbe = await this.getUpdateFeedProbe(feedUrl);
    if (feedProbe.state === "not_available") {
      this.setRuntimeStatus({
        state: "not_available",
        message: "App is up to date.",
        availableVersion: this.runtimeStatus?.availableVersion,
        releaseDate: this.runtimeStatus?.releaseDate
      });
      return this.getStatus();
    }
    if (feedProbe.state === "unavailable") {
      this.setRuntimeStatus({
        state: this.runtimeStatus?.availableVersion ? "available" : "error",
        message: feedProbe.message ?? "Update package is not available yet.",
        availableVersion: this.runtimeStatus?.availableVersion,
        releaseDate: this.runtimeStatus?.releaseDate
      });
      return this.getStatus();
    }

    try {
      this.driver.setFeedURL({ url: feedUrl, serverType });
      this.driver.checkForUpdates();
      this.scheduleCheckTimeout();
      return this.getStatus();
    } catch (error) {
      this.setRuntimeStatus({
        state: "error",
        message: normalizeUpdateErrorMessage(error instanceof Error ? error.message : undefined)
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
      this.setRuntimeStatus({
        state: "checking",
        message: "Checking for updates.",
        availableVersion: this.runtimeStatus?.availableVersion,
        releaseDate: this.runtimeStatus?.releaseDate
      });
      this.scheduleCheckTimeout();
    });
    this.driver.on("update-available", () => {
      this.setRuntimeStatus({
        state: "available",
        message: "Update available.",
        availableVersion: this.runtimeStatus?.availableVersion,
        releaseDate: this.runtimeStatus?.releaseDate
      });
    });
    this.driver.on("update-not-available", () => {
      this.setRuntimeStatus({ state: "not_available", message: "App is up to date." });
    });
    this.driver.on("update-downloaded", (_event, _releaseNotes, releaseName, releaseDate) => {
      const nextReleaseDate = releaseDate instanceof Date && !Number.isNaN(releaseDate.getTime())
        ? releaseDate.toISOString()
        : this.runtimeStatus?.releaseDate;
      this.setRuntimeStatus({
        state: "downloaded",
        message: "Update downloaded and ready to install.",
        availableVersion: releaseName ? normalizeReleaseVersion(releaseName) : this.runtimeStatus?.availableVersion,
        releaseDate: nextReleaseDate
      });
    });
    this.driver.on("error", (error) => {
      this.setRuntimeStatus({
        state: "error",
        message: normalizeUpdateErrorMessage(error.message)
      });
    });

    this.wired = true;
  }

  private setRuntimeStatus(status: Omit<RuntimeStatus, "checkedAt"> & { checkedAt?: string }): void {
    if (status.state !== "checking") {
      this.clearCheckTimeout();
    }
    this.runtimeStatus = {
      ...status,
      checkedAt: status.checkedAt ?? this.now()
    };
  }

  private statusFromRuntime(runtime: RuntimeStatus | (Omit<RuntimeStatus, "checkedAt"> & { checkedAt?: string })): UpdateStatus {
    const settings = this.getSettings().updates;
    const feedUrl = settings.feedUrl ?? this.defaultFeedUrl();
    return {
      enabled: settings.enabled,
      configured: true,
      channel: settings.channel,
      state: runtime.state,
      currentVersion: this.appVersion,
      feedUrl,
      availableVersion: runtime.availableVersion,
      releaseDate: runtime.releaseDate,
      message: runtime.message,
      checkedAt: runtime.checkedAt
    };
  }

  private defaultFeedUrl(): string {
    return krtUpdateFeedUrl(this.platform, this.arch, this.appVersion);
  }

  private async getLatestReleaseMetadata(): Promise<LatestRelease | null> {
    try {
      return await this.fetchLatestRelease();
    } catch {
      return null;
    }
  }

  private async getUpdateFeedProbe(feedUrl: string): Promise<UpdateFeedProbeResult> {
    try {
      return await this.probeUpdateFeed(feedUrl);
    } catch {
      return { state: "unavailable", message: "Update service is not reachable." };
    }
  }

  private scheduleCheckTimeout(): void {
    this.clearCheckTimeout();
    this.checkTimeout = setTimeout(() => {
      if (this.runtimeStatus?.state !== "checking") {
        return;
      }

      if (this.runtimeStatus.availableVersion) {
        this.setRuntimeStatus({
          state: "available",
          message: "Update available.",
          availableVersion: this.runtimeStatus.availableVersion,
          releaseDate: this.runtimeStatus.releaseDate
        });
        return;
      }

      this.setRuntimeStatus({
        state: "error",
        message: "Update check timed out."
      });
    }, this.checkTimeoutMs);
  }

  private clearCheckTimeout(): void {
    if (!this.checkTimeout) {
      return;
    }

    clearTimeout(this.checkTimeout);
    this.checkTimeout = null;
  }
}

async function fetchLatestKrtRelease(): Promise<LatestRelease | null> {
  const response = await fetch(KRT_LATEST_RELEASE_API_URL, {
    headers: { Accept: "application/vnd.github+json" }
  });
  if (!response.ok) {
    return null;
  }

  const release = await response.json() as {
    tag_name?: unknown;
    name?: unknown;
    published_at?: unknown;
  };
  const version = extractReleaseVersion(release);
  if (!version) {
    return null;
  }

  return {
    version,
    releaseDate: typeof release.published_at === "string" ? release.published_at : undefined
  };
}

async function probeElectronUpdateFeed(feedUrl: string): Promise<UpdateFeedProbeResult> {
  const response = await fetch(feedUrl, {
    headers: { Accept: "application/json, text/plain;q=0.9" }
  });

  if (response.status === 200) {
    return { state: "available" };
  }
  if (response.status === 204) {
    return { state: "not_available" };
  }

  const body = await response.text().catch(() => "");
  if (body.includes("needs asset matching")) {
    return { state: "unavailable", message: "Update package is not available yet." };
  }

  return { state: "unavailable", message: "Update service returned an invalid response." };
}

function extractReleaseVersion(release: { tag_name?: unknown; name?: unknown }): string | null {
  const tagName = typeof release.tag_name === "string" ? release.tag_name : "";
  if (parseVersionParts(tagName).length > 0) {
    return tagName;
  }

  const name = typeof release.name === "string" ? release.name : "";
  const versionMatch = name.match(/\b\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)?\b/);
  return versionMatch?.[0] ?? null;
}

function normalizeReleaseVersion(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function isNewerVersion(availableVersion: string, currentVersion: string): boolean {
  const available = parseVersionParts(availableVersion);
  const current = parseVersionParts(currentVersion);
  const length = Math.max(available.length, current.length);
  for (let index = 0; index < length; index += 1) {
    const availablePart = available[index] ?? 0;
    const currentPart = current[index] ?? 0;
    if (availablePart > currentPart) {
      return true;
    }
    if (availablePart < currentPart) {
      return false;
    }
  }

  return false;
}

function parseVersionParts(version: string): number[] {
  return normalizeReleaseVersion(version)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function normalizeUpdateErrorMessage(message: string | undefined): string {
  if (!message) {
    return "Updater failed.";
  }
  if (message.includes("invalid response")) {
    return "Update package is not available yet.";
  }

  return message;
}

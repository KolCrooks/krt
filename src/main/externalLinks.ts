import { shell } from "electron";
export { KRT_LATEST_RELEASE_URL } from "../shared/releases.js";

const allowedExternalProtocols = new Set(["https:", "http:"]);

export function normalizeExternalUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!allowedExternalProtocols.has(url.protocol)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function isAllowedAppNavigation(rawUrl: string, devServerUrl?: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      return true;
    }

    if (!devServerUrl) {
      return false;
    }

    const devUrl = new URL(devServerUrl);
    return url.origin === devUrl.origin;
  } catch {
    return false;
  }
}

export async function openExternalUrl(rawUrl: string): Promise<boolean> {
  const url = normalizeExternalUrl(rawUrl);
  if (!url) {
    return false;
  }

  await shell.openExternal(url);
  return true;
}

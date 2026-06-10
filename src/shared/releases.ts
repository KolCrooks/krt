export const KRT_LATEST_RELEASE_URL = "https://github.com/KolCrooks/krt/releases/latest";
export const KRT_LATEST_RELEASE_API_URL = "https://api.github.com/repos/KolCrooks/krt/releases/latest";
export const KRT_UPDATE_FEED_BASE_URL = "https://update.electronjs.org/KolCrooks/krt";

export function krtUpdateFeedUrl(platform: string, arch: string, version: string): string {
  return `${KRT_UPDATE_FEED_BASE_URL}/${platform}-${arch}/${version}`;
}

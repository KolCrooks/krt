import type { ChangedFile, TourChapter } from "../../../shared/schemas.js";

// Resolve every file a chapter touches to its ChangedFile, ordered with the
// chapter's diff anchors first, then its remaining files, de-duplicated. Files
// the chapter references but that are absent from the bundle are skipped.
export function resolveChapterFiles(chapter: TourChapter | null, changedFiles: ChangedFile[]): ChangedFile[] {
  if (!chapter) {
    return [];
  }
  const byPath = new Map(changedFiles.map((file) => [file.path, file]));
  const orderedPaths = [...chapter.diffAnchors.map((anchor) => anchor.path), ...chapter.files];
  const seen = new Set<string>();
  const resolved: ChangedFile[] = [];
  for (const path of orderedPaths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    const file = byPath.get(path);
    if (file) {
      resolved.push(file);
    }
  }
  return resolved;
}

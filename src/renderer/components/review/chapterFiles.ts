import type { ChangedFile, TourChapter } from "../../../shared/schemas.js";
import { cropPatchToFocusRanges, type FocusRange } from "../diffs/cropPatch.js";

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

// Compute addition/deletion counts restricted to the chapter's focused hunks.
// When a file has no patch string, falls back to its full-file stats.
export function computeFocusedChangeStats(
  chapter: TourChapter,
  changedFiles: ChangedFile[]
): { additions: number; deletions: number; files: number } {
  const byPath = new Map(changedFiles.map((file) => [file.path, file]));
  let additions = 0;
  let deletions = 0;
  for (const path of chapter.files) {
    const file = byPath.get(path);
    if (!file) {
      continue;
    }
    const patch = file.patch;
    if (!patch) {
      additions += file.additions;
      deletions += file.deletions;
      continue;
    }
    const ranges = chapterFocusRanges(chapter, path);
    const cropped = ranges.length > 0 ? cropPatchToFocusRanges(patch, ranges) : patch;
    for (const line of cropped.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++;
      }
    }
  }
  return { additions, deletions, files: chapter.files.length };
}

// The line ranges a chapter cares about in a given file, derived from its diff
// anchors. Used to crop the tour diff to only the relevant hunks. Returns an
// empty array (still "focus mode") when the chapter has no line-anchored
// comments for the file, so the diff shows the file's hunks but not the whole
// file's unchanged context.
export function chapterFocusRanges(chapter: TourChapter | null, path: string): FocusRange[] {
  if (!chapter) {
    return [];
  }
  const ranges: FocusRange[] = [];
  for (const anchor of chapter.diffAnchors) {
    if (anchor.path !== path || typeof anchor.startLine !== "number") {
      continue;
    }
    ranges.push({
      start: anchor.startLine,
      end: anchor.endLine ?? anchor.startLine,
      side: anchor.side === "left" ? "left" : "right"
    });
  }
  return ranges;
}

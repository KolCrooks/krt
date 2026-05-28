export interface FocusRange {
  start: number;
  end: number;
  side: "left" | "right";
}

// Keep only the hunks of a unified-diff patch that overlap one of the focus
// ranges (a chapter's diffAnchors), so tour/storyboard diffs show the relevant
// sections instead of the whole file. Header lines are preserved. Falls back to
// the full patch if nothing overlaps (so the view is never empty).
export function cropPatchToFocusRanges(renderablePatch: string, ranges: FocusRange[]): string {
  if (ranges.length === 0) {
    return renderablePatch;
  }
  const lines = renderablePatch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk === -1) {
    return renderablePatch;
  }

  const header = lines.slice(0, firstHunk);
  const kept: string[] = [];
  let current: string[] | null = null;
  let currentKeep = false;
  const flush = (): void => {
    if (current && currentKeep) {
      kept.push(...current);
    }
    current = null;
  };

  for (let index = firstHunk; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("@@")) {
      flush();
      current = [line];
      currentKeep = hunkOverlapsRanges(line, ranges);
    } else if (current) {
      current.push(line);
    }
  }
  flush();

  if (kept.length === 0) {
    return renderablePatch;
  }
  return [...header, ...kept].join("\n");
}

function hunkOverlapsRanges(hunkHeader: string, ranges: FocusRange[]): boolean {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);
  if (!match) {
    return true;
  }
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  const oldEnd = oldStart + Math.max(0, oldCount - 1);
  const newEnd = newStart + Math.max(0, newCount - 1);
  return ranges.some((range) => {
    const spanStart = range.side === "left" ? oldStart : newStart;
    const spanEnd = range.side === "left" ? oldEnd : newEnd;
    return range.start <= spanEnd && spanStart <= range.end;
  });
}

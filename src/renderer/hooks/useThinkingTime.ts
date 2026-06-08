import { useEffect, useState } from "react";

/**
 * Whole seconds elapsed since `startedAt`, re-evaluated once a second while
 * `active`. Returns null when there is no start time. Because it reads a shared
 * start timestamp (stored on the tab) rather than its own mount time, every
 * surface that displays it agrees — even one opened part-way through a run.
 */
export function useThinkingSeconds(startedAt: number | null | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt == null) {
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  if (startedAt == null) {
    return null;
  }
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** Format a whole-second count as m:ss, e.g. 5 → "0:05", 83 → "1:23". */
export function formatThinkingTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

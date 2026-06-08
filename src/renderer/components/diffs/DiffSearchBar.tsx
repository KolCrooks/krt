import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { krtClient } from "../../api/client.js";
import type { ChangedFile, PullRequestDetail } from "../../../shared/schemas.js";

export interface DiffSearchMatch {
  id: string;
  path: string;
  lineNumber: number | null;
  side: "left" | "right";
  preview: string;
  matchStart: number | null;
  matchLength: number | null;
}

interface DiffSearchBarProps {
  pullRequest: PullRequestDetail;
  files: ChangedFile[];
  active?: boolean;
  onActiveMatch: (match: DiffSearchMatch | null) => void;
}

export function DiffSearchBar({
  pullRequest,
  files,
  active = true,
  onActiveMatch
}: DiffSearchBarProps): React.JSX.Element | null {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [popupPosition, setPopupPosition] = useState<{ top: number; right: number; width: number } | null>(null);
  const trimmedQuery = query.trim();
  const patchQuery = useQuery({
    queryKey: ["diff-search-patches", pullRequest.repository.fullName, pullRequest.number, pullRequest.headSha, files.map((file) => file.path).join("\0")],
    enabled: active && open && trimmedQuery.length > 0 && files.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        files.map(async (file) => {
          const patch = file.patch ?? (await krtClient.pullRequests.filePatch({
            repository: pullRequest.repository,
            number: pullRequest.number,
            path: file.path,
            headSha: pullRequest.headSha
          })).patch;
          return [file.path, patch] as const;
        })
      );
      return new Map(entries);
    }
  });
  const matches = useMemo(
    () => findDiffSearchMatches(files, patchQuery.data ?? new Map(), trimmedQuery),
    [files, patchQuery.data, trimmedQuery]
  );
  const activeMatch = active && open && trimmedQuery ? matches[activeIndex] ?? null : null;
  const ordinal = activeMatch ? activeIndex + 1 : 0;
  const focusInput = useCallback((): void => {
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, []);
  const closeSearch = useCallback((): void => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);
  const updatePopupPosition = useCallback((): void => {
    const anchor = getSearchViewport(popupRef.current);
    if (!anchor) {
      setPopupPosition(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.right <= 0) {
      setPopupPosition(null);
      return;
    }
    const offset = diffSearchTopOffset(anchor);
    setPopupPosition({
      top: Math.max(8, rect.top + offset),
      right: Math.max(18, window.innerWidth - rect.right + 18),
      width: Math.min(420, Math.max(260, rect.width - 36))
    });
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmedQuery, files]);
  useEffect(() => {
    setActiveIndex((index) => (matches.length === 0 ? 0 : Math.min(index, matches.length - 1)));
  }, [matches.length]);
  useEffect(() => {
    onActiveMatch(activeMatch);
  }, [activeMatch, onActiveMatch]);
  useEffect(() => {
    if (active && open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [active, open]);
  useEffect(() => {
    if (!active) {
      closeSearch();
    }
  }, [active, closeSearch]);
  useLayoutEffect(() => {
    if (!active || !open) {
      setPopupPosition(null);
      return undefined;
    }
    updatePopupPosition();
    const anchor = getSearchViewport(popupRef.current);
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !anchor ? null : new ResizeObserver(updatePopupPosition);
    if (resizeObserver && anchor) {
      resizeObserver.observe(anchor);
    }
    window.addEventListener("resize", updatePopupPosition);
    window.addEventListener("scroll", updatePopupPosition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePopupPosition);
      window.removeEventListener("scroll", updatePopupPosition, true);
    };
  }, [active, open, updatePopupPosition]);
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        focusInput();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active, focusInput]);

  const go = useCallback(
    (direction: 1 | -1): void => {
      if (matches.length === 0) {
        return;
      }
      setActiveIndex((index) => (index + direction + matches.length) % matches.length);
    },
    [matches.length]
  );

  if (!active || !open) {
    return null;
  }

  return (
    <div
      className="diff-search-bar"
      ref={popupRef}
      role="search"
      aria-label="Find in diff"
      style={popupPosition ?? undefined}
    >
      <Search size={13} aria-hidden="true" />
      <input
        ref={inputRef}
        aria-label="Find in diff"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            closeSearch();
          }
        }}
        placeholder="Find in diff"
      />
      <span className="diff-search-count mono">
        {trimmedQuery ? `${ordinal}/${matches.length}` : "0/0"}
      </span>
      <button type="button" className="icon-button diff-search-button" aria-label="Previous diff match" onClick={() => go(-1)}>
        <ChevronUp size={13} aria-hidden="true" />
      </button>
      <button type="button" className="icon-button diff-search-button" aria-label="Next diff match" onClick={() => go(1)}>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <button type="button" className="icon-button diff-search-button" aria-label="Close diff search" onClick={closeSearch}>
        <X size={13} aria-hidden="true" />
      </button>
      {patchQuery.isLoading ? <span className="diff-search-hint">Loading patches</span> : null}
      {activeMatch ? (
        <span className="diff-search-active mono" title={`${activeMatch.path}: ${activeMatch.preview}`}>
          {activeMatch.path}{activeMatch.lineNumber ? `:${activeMatch.lineNumber}` : ""}
        </span>
      ) : null}
    </div>
  );
}

export function findDiffSearchMatches(
  files: readonly ChangedFile[],
  patchesByPath: ReadonlyMap<string, string>,
  query: string
): DiffSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return [];
  }

  const matches: DiffSearchMatch[] = [];
  for (const file of files) {
    if (file.path.toLocaleLowerCase().includes(needle)) {
      matches.push({
        id: `${file.path}:path`,
        path: file.path,
        lineNumber: null,
        side: "right",
        preview: file.path,
        matchStart: null,
        matchLength: null
      });
    }
    const patch = patchesByPath.get(file.path);
    if (!patch) {
      continue;
    }
    matches.push(...findPatchMatches(file.path, patch, needle));
  }
  return matches.slice(0, 500);
}

function findPatchMatches(path: string, patch: string, needle: string): DiffSearchMatch[] {
  const matches: DiffSearchMatch[] = [];
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;
  for (const rawLine of patch.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      insideHunk = true;
      continue;
    }

    if (!insideHunk) {
      continue;
    }

    const marker = rawLine[0] ?? "";
    const body = rawLine.startsWith("\\ No newline") ? rawLine : rawLine.slice(1);
    const haystack = body.toLocaleLowerCase();
    const matchStart = haystack.indexOf(needle);
    if ((marker === "-" || marker === "+") && matchStart !== -1) {
      const side = marker === "-" ? "left" : "right";
      const lineNumber = marker === "-" ? oldLine : newLine;
      matches.push({
        id: `${path}:${side}:${lineNumber}:${matches.length}`,
        path,
        lineNumber: lineNumber > 0 ? lineNumber : null,
        side,
        preview: body.trim() || rawLine.trim(),
        matchStart,
        matchLength: needle.length
      });
    }

    if (marker === " ") {
      oldLine += 1;
      newLine += 1;
    } else if (marker === "-") {
      oldLine += 1;
    } else if (marker === "+") {
      newLine += 1;
    }
  }
  return matches;
}

function getSearchViewport(node: HTMLElement | null): HTMLElement | null {
  return node?.closest<HTMLElement>(".diff-stack, .tour-diff, .storyboard-v2-diff") ?? null;
}

function diffSearchTopOffset(anchor: HTMLElement): number {
  const raw = window.getComputedStyle(anchor).getPropertyValue("--diff-search-top").trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 10;
}

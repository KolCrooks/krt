import { ChevronDown, ChevronRight, File as FileIcon } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffPanel, DiffChangeCounts, DiffStatusBadge } from "../diffs/DiffPanel.js";
import { DiffSearchBar, type DiffSearchMatch } from "../diffs/DiffSearchBar.js";
import { ChangedFileTree } from "../trees/ChangedFileTree.js";
import type { ChangedFile } from "../../../shared/schemas.js";
import { orderChangedFilesDepthFirst } from "../../../shared/treeModel.js";
import type { PrTab } from "../../store/uiStore.js";
import { useUiStore } from "../../store/uiStore.js";

const EMPTY_TOUR_CHAPTERS: [] = [];

interface DiffReviewBodyProps {
  tab: PrTab;
  layout: "inline" | "split";
  active?: boolean;
}

export const DiffReviewBody = memo(function DiffReviewBody({ tab, layout, active = true }: DiffReviewBodyProps): React.JSX.Element {
  const selectFile = useUiStore((state) => state.selectFile);
  const openFileInTab = useUiStore((state) => state.openFileInTab);
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const files = useMemo(() => orderChangedFilesDepthFirst(tab.bundle.changedFiles), [tab.bundle.changedFiles]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileEls = useRef<Array<HTMLElement | null>>([]);
  const lastReportedPath = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeSearchMatch, setActiveSearchMatch] = useState<DiffSearchMatch | null>(null);
  const handleOpenDefinition = useCallback(
    (path: string, line: number) => {
      openFileInTab(tab.key, path, line);
      setTabViewMode(tab.key, "editor");
    },
    [openFileInTab, setTabViewMode, tab.key]
  );

  const selectedIndex = useMemo(() => {
    const idx = files.findIndex((file) => file.path === tab.selectedFilePath);
    return idx === -1 ? null : idx;
  }, [files, tab.selectedFilePath]);

  // When the tree selects a file, scroll the stack to it.
  useEffect(() => {
    if (!active || selectedIndex === null) {
      return;
    }
    const sc = scrollRef.current;
    const target = fileEls.current[selectedIndex];
    if (!sc || !target) {
      return;
    }
    if (lastReportedPath.current === tab.selectedFilePath) {
      return;
    }
    sc.scrollTo({ top: Math.max(0, target.offsetTop - 8), behavior: "auto" });
  }, [active, selectedIndex, tab.selectedFilePath]);

  const onScroll = (): void => {
    if (!active) {
      return;
    }
    if (tab.selectedFilePath && selectedIndex === null) {
      return;
    }
    const sc = scrollRef.current;
    if (!sc) {
      return;
    }
    const probe = sc.scrollTop + 12;
    let activeIdx = 0;
    for (let i = 0; i < fileEls.current.length; i += 1) {
      const el = fileEls.current[i];
      if (el && el.offsetTop <= probe) {
        activeIdx = i;
      }
    }
    const activeFile = files[activeIdx];
    if (activeFile && activeFile.path !== tab.selectedFilePath) {
      lastReportedPath.current = activeFile.path;
      selectFile(tab.key, activeFile.path);
    }
  };

  const toggleCollapse = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!active || !activeSearchMatch) {
      return;
    }
    const index = files.findIndex((file) => file.path === activeSearchMatch.path);
    if (index === -1) {
      return;
    }
    setCollapsed((previous) => {
      if (!previous.has(activeSearchMatch.path)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(activeSearchMatch.path);
      return next;
    });
    lastReportedPath.current = null;
    selectFile(tab.key, activeSearchMatch.path);
    scheduleAfterRender(() => {
      const target = fileEls.current[index];
      if (target) {
        scrollRef.current?.scrollTo({ top: Math.max(0, target.offsetTop - 8), behavior: "auto" });
      }
    });
  }, [active, activeSearchMatch, files, selectFile, tab.key]);

  return (
    <section className="diff-review-body">
      <aside className="workspace-sidebar">
        <ChangedFileTree
          files={files}
          selectedPath={tab.selectedFilePath}
          onSelectPath={(path) => {
            lastReportedPath.current = null;
            selectFile(tab.key, path);
          }}
        />
      </aside>
      <section className="diff-stack" ref={scrollRef} onScroll={onScroll} aria-label="Stacked diff">
        <DiffSearchBar
          pullRequest={tab.bundle.detail}
          files={files}
          active={active}
          onActiveMatch={setActiveSearchMatch}
        />
        {files.map((file, index) => {
          const isCollapsed = collapsed.has(file.path);
          return (
            <Fragment key={file.path}>
              <StackFileHeader
                file={file}
                ordinal={index + 1}
                total={files.length}
                collapsed={isCollapsed}
                elementRef={(el) => {
                  fileEls.current[index] = el;
                }}
                onToggle={() => toggleCollapse(file.path)}
              />
              {!isCollapsed ? (
                <article className="diff-stack-file-body">
                  <DiffPanel
                    tabKey={tab.key}
                    pullRequest={tab.bundle.detail}
                    file={file}
                    layout={layout}
                    reviewThreads={tab.bundle.reviewThreads}
                    tourChapters={tab.tour?.chapters ?? EMPTY_TOUR_CHAPTERS}
                    searchTarget={searchTargetForFile(activeSearchMatch, file.path)}
                    headerless
                    enableLsp={active && tab.mode === "managed"}
                    onOpenDefinition={handleOpenDefinition}
                  />
                </article>
              ) : null}
            </Fragment>
          );
        })}
        <div className="diff-stack-end">End of diff · {files.length} files</div>
      </section>
    </section>
  );
}, areDiffReviewBodyPropsEqual);

function areDiffReviewBodyPropsEqual(previous: DiffReviewBodyProps, next: DiffReviewBodyProps): boolean {
  return (
    previous.layout === next.layout &&
    previous.active === next.active &&
    previous.tab.key === next.tab.key &&
    previous.tab.mode === next.tab.mode &&
    previous.tab.selectedFilePath === next.tab.selectedFilePath &&
    previous.tab.bundle.detail === next.tab.bundle.detail &&
    previous.tab.bundle.changedFiles === next.tab.bundle.changedFiles &&
    previous.tab.bundle.reviewThreads === next.tab.bundle.reviewThreads &&
    (previous.tab.tour?.chapters ?? EMPTY_TOUR_CHAPTERS) === (next.tab.tour?.chapters ?? EMPTY_TOUR_CHAPTERS)
  );
}

function searchTargetForFile(match: DiffSearchMatch | null, path: string) {
  if (!match || match.path !== path || !match.lineNumber) {
    return null;
  }
  return {
    start: match.lineNumber,
    end: match.lineNumber,
    side: match.side === "left" ? "deletions" as const : "additions" as const,
    matchId: match.id,
    matchStart: match.matchStart,
    matchLength: match.matchLength
  };
}

function scheduleAfterRender(callback: () => void): void {
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }
  window.setTimeout(callback, 0);
}

interface StackFileHeaderProps {
  file: ChangedFile;
  ordinal: number;
  total: number;
  collapsed: boolean;
  elementRef: (element: HTMLButtonElement | null) => void;
  onToggle: () => void;
}

function StackFileHeader({ file, ordinal, total, collapsed, elementRef, onToggle }: StackFileHeaderProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={collapsed ? "diff-stack-file-header is-collapsed" : "diff-stack-file-header"}
      ref={elementRef}
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand diff" : "Collapse diff"}
    >
      {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      <span className="diff-stack-file-ordinal mono">
        {String(ordinal).padStart(2, "0")}/{String(total).padStart(2, "0")}
      </span>
      <FileIcon size={12} aria-hidden="true" className="diff-stack-file-icon" />
      <span className="diff-stack-file-path mono">{file.path}</span>
      <DiffStatusBadge status={file.status} />
      <span className="diff-stack-file-spacer" />
      <DiffChangeCounts additions={file.additions} deletions={file.deletions} />
    </button>
  );
}

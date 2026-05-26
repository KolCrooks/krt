import { ChevronDown, ChevronRight, File as FileIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffPanel, DiffChangeCounts, DiffStatusBadge } from "../diffs/DiffPanel.js";
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
        {files.map((file, index) => {
          const isCollapsed = collapsed.has(file.path);
          return (
            <article
              key={file.path}
              className={isCollapsed ? "diff-stack-file is-collapsed" : "diff-stack-file"}
              ref={(el) => {
                fileEls.current[index] = el;
              }}
            >
              <StackFileHeader
                file={file}
                ordinal={index + 1}
                total={files.length}
                collapsed={isCollapsed}
                onToggle={() => toggleCollapse(file.path)}
              />
              {!isCollapsed ? (
                <DiffPanel
                  tabKey={tab.key}
                  pullRequest={tab.bundle.detail}
                  file={file}
                  layout={layout}
                  reviewThreads={tab.bundle.reviewThreads}
                  tourChapters={tab.tour?.chapters ?? EMPTY_TOUR_CHAPTERS}
                  headerless
                  enableLsp={active && tab.mode === "managed"}
                  onOpenDefinition={handleOpenDefinition}
                />
              ) : null}
            </article>
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

interface StackFileHeaderProps {
  file: ChangedFile;
  ordinal: number;
  total: number;
  collapsed: boolean;
  onToggle: () => void;
}

function StackFileHeader({ file, ordinal, total, collapsed, onToggle }: StackFileHeaderProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="diff-stack-file-header"
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

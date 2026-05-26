import { ChevronDown, ChevronRight, File as FileIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DiffPanel, DiffChangeCounts, DiffStatusBadge } from "../diffs/DiffPanel.js";
import { ChangedFileTree } from "../trees/ChangedFileTree.js";
import type { ChangedFile } from "../../../shared/schemas.js";
import type { PrTab } from "../../store/uiStore.js";
import { useUiStore } from "../../store/uiStore.js";

interface DiffReviewBodyProps {
  tab: PrTab;
  layout: "inline" | "split";
}

export function DiffReviewBody({ tab, layout }: DiffReviewBodyProps): React.JSX.Element {
  const selectFile = useUiStore((state) => state.selectFile);
  const files = tab.bundle.changedFiles;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileEls = useRef<Array<HTMLElement | null>>([]);
  const lastReportedPath = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const selectedIndex = useMemo(() => {
    const idx = files.findIndex((file) => file.path === tab.selectedFilePath);
    return idx === -1 ? 0 : idx;
  }, [files, tab.selectedFilePath]);

  // When the tree selects a file, scroll the stack to it.
  useEffect(() => {
    const sc = scrollRef.current;
    const target = fileEls.current[selectedIndex];
    if (!sc || !target) {
      return;
    }
    if (lastReportedPath.current === tab.selectedFilePath) {
      return;
    }
    sc.scrollTo({ top: Math.max(0, target.offsetTop - 8), behavior: "smooth" });
  }, [selectedIndex, tab.selectedFilePath]);

  const onScroll = (): void => {
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
          openEditorPaths={tab.openFilePaths}
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
                  pullRequest={tab.bundle.detail}
                  file={file}
                  layout={layout}
                  reviewThreads={tab.bundle.reviewThreads}
                  tourChapters={tab.tour?.chapters ?? []}
                  headerless
                />
              ) : null}
            </article>
          );
        })}
        <div className="diff-stack-end">End of diff · {files.length} files</div>
      </section>
    </section>
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

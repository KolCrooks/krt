import { Ban, Bot, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAutoTour } from "../../hooks/useAutoTour.js";
import { DiffPanel } from "../diffs/DiffPanel.js";
import { DiffSearchBar, type DiffSearchMatch } from "../diffs/DiffSearchBar.js";
import { renderMarkdown, renderInlineMarkdown } from "../../lib/markdown.js";
import { AgentActivityFeed } from "./AgentActivityFeed.js";
import { AgentWorkingOverlay } from "./AgentWorkingOverlay.js";
import { RiskLevelPill } from "./RiskLevelPill.js";
import { resolveChapterFiles } from "./chapterFiles.js";
import type { PrTab } from "../../store/uiStore.js";
import { useUiStore } from "../../store/uiStore.js";

interface TourBodyProps {
  tab: PrTab;
  layout: "inline" | "split";
  active?: boolean;
}

export function TourBody({ tab, layout, active = true }: TourBodyProps): React.JSX.Element {
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const openFileInTab = useUiStore((state) => state.openFileInTab);
  const toggleTourChapterReviewed = useUiStore((state) => state.toggleTourChapterReviewed);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(tab.tour?.chapters[0]?.id ?? null);
  const [activeSearchMatch, setActiveSearchMatch] = useState<DiffSearchMatch | null>(null);
  const [watchingAgent, setWatchingAgent] = useState(false);
  const diffFileRefs = useRef<Record<string, HTMLElement | null>>({});
  const auto = useAutoTour(tab);
  // Close the "watch the agent" overlay once generation finishes.
  useEffect(() => {
    if (!auto.isGenerating) {
      setWatchingAgent(false);
    }
  }, [auto.isGenerating]);

  const tour = tab.tour;
  useEffect(() => {
    if (!tour) {
      setSelectedChapterId(null);
      return;
    }
    if (!tour.chapters.some((chapter) => chapter.id === selectedChapterId)) {
      setSelectedChapterId(tour.chapters[0]?.id ?? null);
    }
  }, [selectedChapterId, tour]);

  const selectedChapter = useMemo(
    () => tour?.chapters.find((chapter) => chapter.id === selectedChapterId) ?? tour?.chapters[0] ?? null,
    [selectedChapterId, tour]
  );
  const chapterFiles = useMemo(
    () => resolveChapterFiles(selectedChapter, tab.bundle.changedFiles),
    [selectedChapter, tab.bundle.changedFiles]
  );
  const reviewedChapterIds = useMemo(() => new Set(tab.reviewedTourChapterIds ?? []), [tab.reviewedTourChapterIds]);
  const reviewedCount = tour ? tour.chapters.filter((chapter) => reviewedChapterIds.has(chapter.id)).length : 0;
  const toggleReviewed = (id: string): void => toggleTourChapterReviewed(tab.key, id);
  useEffect(() => {
    if (!active || !activeSearchMatch) {
      return;
    }
    diffFileRefs.current[activeSearchMatch.path]?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [active, activeSearchMatch]);
  // When the reviewer picks a chapter, jump the diff to that chapter's first
  // anchored region so the tour leads them straight to the relevant code.
  const firstAnchorPath = selectedChapter?.diffAnchors[0]?.path ?? chapterFiles[0]?.path ?? null;
  useEffect(() => {
    if (!active || auto.isGenerating || !firstAnchorPath) {
      return;
    }
    const handle = requestAnimationFrame(() => {
      diffFileRefs.current[firstAnchorPath]?.scrollIntoView({ block: "start", behavior: "auto" });
    });
    return () => cancelAnimationFrame(handle);
    // Re-run only when the chapter selection changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChapterId, active]);

  if (!tour) {
    return (
      <section className="tour-empty">
        <Bot size={22} aria-hidden="true" className={auto.isGenerating ? "spin" : undefined} />
        <h2>{auto.isGenerating ? "Generating AI tour" : auto.hasFailed ? "Tour generation failed" : "Preparing AI tour"}</h2>
        <p>{auto.message ?? "Reading the diff and timeline to organize this PR into chapters."}</p>
        <AgentActivityFeed entries={auto.activity} active={auto.isGenerating} />
        <div className="tour-empty-actions">
          {auto.isGenerating && auto.operationId ? (
            <button type="button" className="secondary-button" onClick={auto.cancel}>
              <Ban size={14} aria-hidden="true" />
              Cancel
            </button>
          ) : (
            <button type="button" className="primary-button" disabled={auto.isGenerating} onClick={auto.regenerate}>
              {auto.isGenerating ? <RefreshCw className="spin" size={14} aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />}
              {auto.hasFailed ? "Retry" : "Regenerate"}
            </button>
          )}
        </div>
        {typeof auto.percent === "number" ? <span className="tour-empty-status">{Math.round(auto.percent)}%</span> : null}
      </section>
    );
  }

  return (
    <section className="tour-shell">
      {watchingAgent && auto.isGenerating ? (
        <AgentWorkingOverlay
          title="Generating AI tour"
          message={auto.message}
          percent={auto.percent}
          activity={auto.activity}
          isGenerating={auto.isGenerating}
          canCancel={Boolean(auto.operationId)}
          onCancel={auto.cancel}
          onClose={() => setWatchingAgent(false)}
        />
      ) : null}
      <aside className="tour-chapter-rail" aria-label="Tour chapters">
        <div className="tour-rail-header">
          <span>Tour</span>
          <span className="tour-rail-counter">{reviewedCount}/{tour.chapters.length} reviewed</span>
        </div>
        <div className="tour-rail-list">
          {tour.chapters.map((chapter, index) => {
            const isReviewed = reviewedChapterIds.has(chapter.id);
            const isActive = chapter.id === selectedChapter?.id;
            return (
              <button
                className={isActive ? "tour-chapter is-active" : "tour-chapter"}
                key={chapter.id}
                type="button"
                onClick={() => setSelectedChapterId(chapter.id)}
              >
                <span
                  className={isReviewed ? "tour-chapter-check is-reviewed" : "tour-chapter-check"}
                  role="checkbox"
                  aria-checked={isReviewed}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleReviewed(chapter.id);
                  }}
                >
                  {isReviewed ? "✓" : ""}
                </span>
                <div className="tour-chapter-text">
                  <strong
                    className={isReviewed ? "is-done" : undefined}
                    dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(chapter.title) }}
                  />
                  <span>
                    {auto.isGenerating ? <span className="chapter-draft-pill">Draft</span> : null}
                    <span className="mono">{String(index + 1).padStart(2, "0")}</span> · {chapter.changeStats.files} files ·{" "}
                    <span className="diff-counts-add">+{chapter.changeStats.additions}</span>{" "}
                    <span className="diff-counts-del">−{chapter.changeStats.deletions}</span>
                  </span>
                </div>
              </button>
            );
          })}
          {auto.isGenerating ? (
            <div
              className="tour-chapter is-loading is-clickable"
              role="button"
              tabIndex={0}
              aria-label="Watch the agent work"
              title="Watch the agent work"
              onClick={() => setWatchingAgent(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setWatchingAgent(true);
                }
              }}
            >
              <span className="tour-chapter-check" aria-hidden="true" />
              <div className="tour-chapter-text">
                <span className="skeleton skeleton-line skeleton-line-wide" />
                <span className="skeleton skeleton-line skeleton-line-narrow" />
              </div>
            </div>
          ) : null}
        </div>
        <div className="tour-rail-footer">
          <button
            type="button"
            className="secondary-button"
            disabled={!selectedChapter}
            onClick={() => {
              if (!selectedChapter) {
                return;
              }
              const currentIndex = tour.chapters.findIndex((chapter) => chapter.id === selectedChapter.id);
              const previous = tour.chapters[Math.max(0, currentIndex - 1)];
              if (previous) {
                setSelectedChapterId(previous.id);
              }
            }}
          >
            Prev
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              if (!selectedChapter) {
                return;
              }
              toggleReviewed(selectedChapter.id);
              const currentIndex = tour.chapters.findIndex((chapter) => chapter.id === selectedChapter.id);
              const next = tour.chapters[currentIndex + 1];
              if (next) {
                setSelectedChapterId(next.id);
              }
            }}
          >
            {selectedChapter && reviewedChapterIds.has(selectedChapter.id) ? "Unmark" : "Mark reviewed"}
          </button>
        </div>
      </aside>
      <section className="tour-detail">
        {selectedChapter ? (
          <article className="tour-detail-card">
            <div className="tour-detail-eyebrow">
              <span>Chapter {tour.chapters.findIndex((chapter) => chapter.id === selectedChapter.id) + 1} of {tour.chapters.length}</span>
              {auto.isGenerating ? <span className="chapter-draft-pill">Draft</span> : null}
              <RiskLevelPill level={selectedChapter.riskLevel} />
            </div>
            <h2 dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(selectedChapter.title) }} />
            <div className="markdown tour-detail-summary" dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedChapter.summary) }} />
            <div className="file-pills">
              {selectedChapter.files.slice(0, 8).map((path) => (
                <button
                  type="button"
                  key={path}
                  onClick={() => {
                    openFileInTab(tab.key, path);
                    setTabViewMode(tab.key, "editor");
                  }}
                >
                  {path}
                </button>
              ))}
            </div>
            <ul className="checklist">
              {selectedChapter.reviewChecklist.map((item) => (
                <li key={item}>
                  <div className="markdown compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(item) }} />
                </li>
              ))}
            </ul>
          </article>
        ) : null}
        <section className="tour-diff" aria-label="Selected tour diff">
          <DiffSearchBar
            pullRequest={tab.bundle.detail}
            files={chapterFiles}
            active={active}
            onActiveMatch={setActiveSearchMatch}
          />
          {chapterFiles.map((file) => (
            <div
              key={file.path}
              className="tour-diff-file"
              ref={(el) => {
                diffFileRefs.current[file.path] = el;
              }}
            >
              <DiffPanel
                tabKey={tab.key}
                pullRequest={tab.bundle.detail}
                file={file}
                layout={layout}
                reviewThreads={tab.bundle.reviewThreads}
                tourChapters={selectedChapter ? [selectedChapter] : []}
                searchTarget={searchTargetForFile(activeSearchMatch, file.path)}
                enableLsp={tab.mode === "managed"}
                onOpenDefinition={(path, line) => {
                  openFileInTab(tab.key, path, line);
                  setTabViewMode(tab.key, "editor");
                }}
              />
            </div>
          ))}
        </section>
      </section>
    </section>
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

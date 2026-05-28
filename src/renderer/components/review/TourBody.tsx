import { Ban, Bot, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { relativeRiskClass } from "../../lib/format.js";
import { useAutoTour } from "../../hooks/useAutoTour.js";
import { DiffPanel } from "../diffs/DiffPanel.js";
import { resolveChapterFiles } from "./chapterFiles.js";
import type { PrTab } from "../../store/uiStore.js";
import { useUiStore } from "../../store/uiStore.js";

interface TourBodyProps {
  tab: PrTab;
  layout: "inline" | "split";
}

export function TourBody({ tab, layout }: TourBodyProps): React.JSX.Element {
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const openFileInTab = useUiStore((state) => state.openFileInTab);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(tab.tour?.chapters[0]?.id ?? null);
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const auto = useAutoTour(tab);

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
  const reviewedCount = tour ? tour.chapters.filter((chapter) => reviewed[chapter.id]).length : 0;
  const toggleReviewed = (id: string): void => setReviewed((prev) => ({ ...prev, [id]: !prev[id] }));

  if (!tour) {
    return (
      <section className="tour-empty">
        <Bot size={22} aria-hidden="true" className={auto.isGenerating ? "spin" : undefined} />
        <h2>{auto.isGenerating ? "Generating AI tour" : auto.hasFailed ? "Tour generation failed" : "Preparing AI tour"}</h2>
        <p>{auto.message ?? "Reading the diff and timeline to organize this PR into chapters."}</p>
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
      <aside className="tour-chapter-rail" aria-label="Tour chapters">
        <div className="tour-rail-header">
          <span>Tour</span>
          <span className="tour-rail-counter">{reviewedCount}/{tour.chapters.length} reviewed</span>
        </div>
        <div className="tour-rail-list">
          {tour.chapters.map((chapter, index) => {
            const isReviewed = Boolean(reviewed[chapter.id]);
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
                  <strong className={isReviewed ? "is-done" : undefined}>{chapter.title}</strong>
                  <span>
                    <span className="mono">{String(index + 1).padStart(2, "0")}</span> · {chapter.changeStats.files} files ·{" "}
                    <span className="diff-counts-add">+{chapter.changeStats.additions}</span>{" "}
                    <span className="diff-counts-del">−{chapter.changeStats.deletions}</span>
                  </span>
                </div>
              </button>
            );
          })}
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
            {selectedChapter && reviewed[selectedChapter.id] ? "Unmark" : "Mark reviewed"}
          </button>
        </div>
      </aside>
      <section className="tour-detail">
        {selectedChapter ? (
          <article className="tour-detail-card">
            <div className="tour-detail-eyebrow">
              <span>Chapter {tour.chapters.findIndex((chapter) => chapter.id === selectedChapter.id) + 1} of {tour.chapters.length}</span>
              <span className={relativeRiskClass(selectedChapter.riskLevel)}>{selectedChapter.riskLevel}</span>
            </div>
            <h2>{selectedChapter.title}</h2>
            <p>{selectedChapter.summary}</p>
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
              {selectedChapter.reviewChecklist.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </article>
        ) : null}
        <section className="tour-diff" aria-label="Selected tour diff">
          {chapterFiles.map((file) => (
            <DiffPanel
              key={file.path}
              tabKey={tab.key}
              pullRequest={tab.bundle.detail}
              file={file}
              layout={layout}
              reviewThreads={tab.bundle.reviewThreads}
              tourChapters={selectedChapter ? [selectedChapter] : []}
              enableLsp={tab.mode === "managed"}
              onOpenDefinition={(path, line) => {
                openFileInTab(tab.key, path, line);
                setTabViewMode(tab.key, "editor");
              }}
            />
          ))}
        </section>
      </section>
    </section>
  );
}

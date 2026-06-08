import { AlertTriangle, Ban, Bot, Check, FileIcon, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoTour } from "../../hooks/useAutoTour.js";
import { useStoryboardLayout } from "../../hooks/useStoryboardLayout.js";
import { DiffPanel } from "../diffs/DiffPanel.js";
import { DiffSearchBar, type DiffSearchMatch } from "../diffs/DiffSearchBar.js";
import { ChangedFileTree } from "../trees/ChangedFileTree.js";
import { renderMarkdown, renderInlineMarkdown, stripMarkdown } from "../../lib/markdown.js";
import type { PrTab } from "../../store/uiStore.js";
import { useUiStore } from "../../store/uiStore.js";
import type { ChapterKind, TourChapter, TourGraph } from "../../../shared/schemas.js";
import { AgentActivityFeed } from "./AgentActivityFeed.js";
import { AgentWorkingOverlay } from "./AgentWorkingOverlay.js";
import { resolveChapterFiles } from "./chapterFiles.js";
import { RiskLevelPill } from "./RiskLevelPill.js";

type Relation = TourGraph["edges"][number]["relation"];

interface RelationMeta {
  label: string;
  color: string;
  dash: string;
}

const RELATION_META: Record<Relation, RelationMeta> = {
  dependency: { label: "depends on", color: "oklch(0.5 0.02 270)", dash: "0" },
  extension: { label: "extends", color: "oklch(0.55 0.13 145)", dash: "0" },
  gating: { label: "gated by", color: "oklch(0.55 0.15 75)", dash: "5 4" },
  verification: { label: "verified by", color: "oklch(0.5 0.12 290)", dash: "2 3" },
  risk: { label: "risk to", color: "oklch(0.55 0.18 25)", dash: "5 4" }
};

type Kind = "foundation" | "replace" | "extend" | "glue" | "gate" | "verify";

interface KindMeta {
  label: string;
  color: string;
  bg: string;
}

const KIND_META: Record<Kind, KindMeta> = {
  foundation: { label: "Foundation", color: "oklch(0.55 0.15 250)", bg: "oklch(0.97 0.03 250)" },
  replace: { label: "Replace", color: "oklch(0.55 0.15 25)", bg: "oklch(0.97 0.03 25)" },
  extend: { label: "Extend", color: "oklch(0.55 0.13 145)", bg: "oklch(0.97 0.04 145)" },
  glue: { label: "Glue", color: "oklch(0.5 0.05 250)", bg: "oklch(0.97 0.01 250)" },
  gate: { label: "Gate", color: "oklch(0.55 0.15 75)", bg: "oklch(0.97 0.05 75)" },
  verify: { label: "Verify", color: "oklch(0.5 0.1 290)", bg: "oklch(0.97 0.04 290)" }
};

interface StoryboardBodyProps {
  tab: PrTab;
  layout: "inline" | "split";
  active?: boolean;
}

export function StoryboardBody({ tab, layout, active = true }: StoryboardBodyProps): React.JSX.Element {
  const tour = tab.tour;
  const auto = useAutoTour(tab);
  const { layout: graphLayout, isLayingOut } = useStoryboardLayout(tour);
  const openFileInTab = useUiStore((state) => state.openFileInTab);
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const toggleTourChapterReviewed = useUiStore((state) => state.toggleTourChapterReviewed);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    tour?.graph.nodes[0]?.id ?? tour?.chapters[0]?.id ?? null
  );
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [watchingAgent, setWatchingAgent] = useState(false);
  // Close the "watch the agent" overlay once generation finishes.
  useEffect(() => {
    if (!auto.isGenerating) {
      setWatchingAgent(false);
    }
  }, [auto.isGenerating]);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  const [activeSearchMatch, setActiveSearchMatch] = useState<DiffSearchMatch | null>(null);

  useEffect(() => {
    if (!tour) {
      setSelectedNodeId(null);
      return;
    }
    const hasSelected =
      tour.graph.nodes.some((node) => node.id === selectedNodeId) ||
      tour.chapters.some((chapter) => chapter.id === selectedNodeId);
    if (!hasSelected) {
      setSelectedNodeId(tour.graph.nodes[0]?.id ?? tour.chapters[0]?.id ?? null);
    }
  }, [selectedNodeId, tour]);

  const activeId = previewNodeId ?? selectedNodeId;
  const activeChapter = useMemo(
    () => tour?.chapters.find((chapter) => chapter.id === activeId) ?? null,
    [activeId, tour]
  );
  const chapterFiles = useMemo(
    () => resolveChapterFiles(activeChapter, tab.bundle.changedFiles),
    [activeChapter, tab.bundle.changedFiles]
  );
  const kindByNode = useMemo(() => (tour ? assignKinds(tour.graph, tour.chapters) : new Map<string, Kind>()), [tour]);

  const diffFileRefs = useRef<Record<string, HTMLElement | null>>({});
  const [diffSelectedPath, setDiffSelectedPath] = useState<string | null>(null);
  useEffect(() => {
    setDiffSelectedPath(chapterFiles[0]?.path ?? null);
  }, [chapterFiles]);
  const onSelectDiffFile = useCallback((path: string): void => {
    setDiffSelectedPath(path);
    diffFileRefs.current[path]?.scrollIntoView({ block: "start", behavior: "auto" });
  }, []);
  useEffect(() => {
    if (!active || !activeSearchMatch) {
      return;
    }
    setDiffSelectedPath(activeSearchMatch.path);
    diffFileRefs.current[activeSearchMatch.path]?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [active, activeSearchMatch]);

  if (!tour) {
    return (
      <section className="tour-empty">
        <Bot size={22} aria-hidden="true" className={auto.isGenerating ? "spin" : undefined} />
        <h2>{auto.isGenerating ? "Generating storyboard" : auto.hasFailed ? "Tour generation failed" : "Preparing storyboard"}</h2>
        <p>{auto.message ?? "Reading the diff and timeline to organize this PR into a dependency graph."}</p>
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
  if (!graphLayout) {
    return <StoryboardLoadingSkeleton message={isLayingOut ? "Preparing storyboard" : "Storyboard unavailable"} />;
  }

  const reviewedChapterIds = new Set(tab.reviewedTourChapterIds ?? []);
  const reviewedCount = tour.chapters.filter((chapter) => reviewedChapterIds.has(chapter.id)).length;
  const toggleReviewed = (id: string): void => toggleTourChapterReviewed(tab.key, id);

  const incomingFor = (id: string): typeof tour.graph.edges =>
    tour.graph.edges.filter((edge) => edge.to === id);
  const outgoingFor = (id: string): typeof tour.graph.edges =>
    tour.graph.edges.filter((edge) => edge.from === id);

  const edgeKey = (edge: typeof tour.graph.edges[number]): string => `${edge.from}|${edge.to}|${edge.relation}`;

  const renderableEdges = graphLayout.edges.map((edge) => {
    const isHovered = hoveredEdgeKey === edge.id || hoveredEdgeKey === `${edge.from}|${edge.to}|${edge.relation}`;
    const isHot = hoveredEdgeKey ? isHovered : activeId === edge.from || activeId === edge.to;
    const meta = RELATION_META[edge.relation];
    return { ...edge, isHovered, isHot, meta };
  });

  return (
    <section className="storyboard-v2">
      {watchingAgent && auto.isGenerating ? (
        <AgentWorkingOverlay
          title="Generating storyboard"
          message={auto.message}
          percent={auto.percent}
          activity={auto.activity}
          isGenerating={auto.isGenerating}
          canCancel={Boolean(auto.operationId)}
          onCancel={auto.cancel}
          onClose={() => setWatchingAgent(false)}
        />
      ) : null}
      <header className="storyboard-v2-head">
        <Sparkles size={13} aria-hidden="true" className="storyboard-v2-head-icon" />
        <span className="storyboard-v2-head-title">Storyboard</span>
        <span className="storyboard-v2-head-sub">· dependency flow</span>
        <span className="chip storyboard-v2-head-chip">
          {reviewedCount}/{tour.chapters.length} reviewed
        </span>
        <span className="storyboard-v2-head-spacer" />
        <div className="storyboard-v2-legend">
          {(Object.entries(RELATION_META) as Array<[Relation, RelationMeta]>).map(([key, meta]) => (
            <span className="storyboard-v2-legend-item" key={key}>
              <svg width="20" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="20" y2="3" stroke={meta.color} strokeWidth="1.6" strokeDasharray={meta.dash} />
              </svg>
              {meta.label}
            </span>
          ))}
        </div>
      </header>

      <div className="storyboard-v2-split">
        <FlowCanvas
          width={graphLayout.width + (auto.isGenerating ? (graphLayout.nodes[0]?.width ?? 180) + 40 : 0)}
          height={graphLayout.height}
        >
          <svg className="story-edges" width={graphLayout.width} height={graphLayout.height} aria-hidden="true">
            <defs>
              {(Object.keys(RELATION_META) as Relation[]).map((relation) => {
                const meta = RELATION_META[relation];
                return (
                  <marker
                    key={relation}
                    id={`story-arrow-${relation}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0 L10 5 L0 10 z" fill={meta.color} />
                  </marker>
                );
              })}
              <marker id="story-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)" />
              </marker>
            </defs>
            {renderableEdges.filter((edge) => !edge.isHot).map((edge) => (
              <g
                key={edge.id}
                className="story-edge"
                onMouseEnter={() => setHoveredEdgeKey(edge.id)}
                onMouseLeave={() => setHoveredEdgeKey(null)}
              >
                <path
                  d={edge.path}
                  stroke={edge.meta.color}
                  strokeWidth="1.5"
                  strokeDasharray={edge.meta.dash}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd={`url(#story-arrow-${edge.relation})`}
                  opacity={0.55}
                />
                <title>{edge.meta.label}</title>
              </g>
            ))}
            {renderableEdges.filter((edge) => edge.isHot).map((edge) => (
              <g
                key={edge.id}
                className="story-edge is-highlighted"
                onMouseEnter={() => setHoveredEdgeKey(edge.id)}
                onMouseLeave={() => setHoveredEdgeKey(null)}
              >
                <path d={edge.path} stroke="var(--accent)" strokeWidth="6" fill="none" opacity={0.12} strokeLinecap="round" strokeLinejoin="round" />
                <path
                  d={edge.path}
                  stroke="var(--accent)"
                  strokeWidth="2"
                  fill="none"
                  strokeDasharray={edge.meta.dash}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd="url(#story-arrow-hot)"
                />
                <title>{edge.meta.label}</title>
              </g>
            ))}
          </svg>
          {graphLayout.nodes.map((node, index) => {
            const chapter = tour.chapters.find((entry) => entry.id === node.id);
            const kind = kindByNode.get(node.id) ?? "glue";
            const kindMeta = KIND_META[kind];
            const isSelected = selectedNodeId === node.id;
            const isPreviewed = previewNodeId === node.id;
            const isActive = activeId === node.id;
            const isReviewed = reviewedChapterIds.has(node.id);
            return (
              <article
                key={node.id}
                className={cardClass({ active: isActive, previewed: isPreviewed && !isSelected, reviewed: isReviewed })}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height
                }}
                onMouseEnter={() => setPreviewNodeId(node.id)}
                onMouseLeave={() => setPreviewNodeId((prev) => (prev === node.id ? null : prev))}
                onClick={() => {
                  setSelectedNodeId(node.id);
                  setPreviewNodeId(null);
                }}
              >
                <div className="storyboard-v2-card-band" style={{ background: kindMeta.color }} aria-hidden="true" />
                <div className="storyboard-v2-card-head">
                  <span
                    className="storyboard-v2-kind"
                    style={{ background: kindMeta.bg, color: kindMeta.color }}
                  >
                    {kindMeta.label}
                  </span>
                  <span className="mono storyboard-v2-card-num">ch {String(index + 1).padStart(2, "0")}</span>
                  {auto.isGenerating ? <span className="chapter-draft-pill">Draft</span> : null}
                  <span className="storyboard-v2-card-spacer" />
                  <button
                    type="button"
                    className={isReviewed ? "storyboard-v2-check is-checked" : "storyboard-v2-check"}
                    aria-label={isReviewed ? "Mark unreviewed" : "Mark reviewed"}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleReviewed(node.id);
                    }}
                  >
                    {isReviewed ? <Check size={9} aria-hidden="true" /> : null}
                  </button>
                </div>
                <div className="storyboard-v2-card-title">
                  <strong
                    style={{ textDecoration: isReviewed ? "line-through" : undefined }}
                    dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(node.label) }}
                  />
                </div>
                {!graphLayout.simplified && chapter?.summary ? (
                  <p className="storyboard-v2-card-desc">{stripMarkdown(chapter.summary)}</p>
                ) : null}
                <div className="storyboard-v2-card-foot">
                  <span className="mono storyboard-v2-card-files">{node.files.length}f</span>
                  {chapter ? (
                    <>
                      <span className="mono diff-counts-add">+{chapter.changeStats.additions}</span>
                      <span className="mono diff-counts-del">−{chapter.changeStats.deletions}</span>
                    </>
                  ) : null}
                </div>
              </article>
            );
          })}
          {auto.isGenerating ? (
            <article
              className="storyboard-v2-card is-loading is-clickable"
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
              style={{
                left: graphLayout.width + 8,
                top: 28,
                width: graphLayout.nodes[0]?.width ?? 180,
                height: graphLayout.nodes[0]?.height ?? 162
              }}
            >
              <div className="storyboard-v2-card-band skeleton" aria-hidden="true" />
              <div className="storyboard-v2-card-head">
                <span className="skeleton skeleton-line skeleton-line-narrow" />
              </div>
              <div className="storyboard-v2-card-title">
                <span className="skeleton skeleton-line skeleton-line-wide" />
              </div>
              <div className="storyboard-v2-card-desc">
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line skeleton-line-narrow" />
              </div>
            </article>
          ) : null}
        </FlowCanvas>

        <aside className="storyboard-v2-detail" aria-label="Selected chapter">
          {activeChapter ? (
            <ChapterDetail
              chapter={activeChapter}
              chapters={tour.chapters}
              kind={kindByNode.get(activeChapter.id) ?? "glue"}
              incoming={incomingFor(activeChapter.id)}
              outgoing={outgoingFor(activeChapter.id)}
              hoveredEdgeKey={hoveredEdgeKey}
              onHoverEdge={(key) => setHoveredEdgeKey(key)}
              onSelectNode={(id) => setSelectedNodeId(id)}
              reviewed={reviewedChapterIds.has(activeChapter.id)}
              onToggleReviewed={() => toggleReviewed(activeChapter.id)}
              onOpenFile={(path) => {
                openFileInTab(tab.key, path);
                setTabViewMode(tab.key, "editor");
              }}
              edgeKeyOf={edgeKey}
            />
          ) : null}
        </aside>
      </div>

      {chapterFiles.length > 0 && activeChapter ? (
        <section className="storyboard-v2-diff" aria-label="Selected chapter diff">
          <div className="storyboard-v2-diff-head">
            <span className="storyboard-v2-diff-eyebrow">Diff</span>
            <span className="storyboard-v2-diff-dot">·</span>
            <span className="mono storyboard-v2-diff-path">
              {chapterFiles.length} {chapterFiles.length === 1 ? "file" : "files"}
            </span>
            <span className="mono storyboard-v2-diff-counts">
              <span className="diff-counts-add">+{activeChapter.changeStats.additions}</span>{" "}
              <span className="diff-counts-del">−{activeChapter.changeStats.deletions}</span>
            </span>
            <span className="storyboard-v2-diff-spacer" />
            <span className="storyboard-v2-diff-caption">
              chapter {tour.chapters.findIndex((entry) => entry.id === activeChapter.id) + 1} · {stripMarkdown(activeChapter.title)}
            </span>
          </div>
          <DiffSearchBar
            pullRequest={tab.bundle.detail}
            files={chapterFiles}
            active={active}
            onActiveMatch={setActiveSearchMatch}
          />
          <div className="storyboard-v2-diff-body">
            {chapterFiles.length > 1 ? (
              <aside className="storyboard-v2-diff-tree" aria-label="Chapter files">
                <ChangedFileTree files={chapterFiles} selectedPath={diffSelectedPath} onSelectPath={onSelectDiffFile} />
              </aside>
            ) : null}
            <div className="storyboard-v2-diff-stack">
              {chapterFiles.map((file) => (
                <div
                  key={file.path}
                  className="storyboard-v2-diff-file"
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
                    tourChapters={[activeChapter]}
                    searchTarget={searchTargetForFile(activeSearchMatch, file.path)}
                    enableLsp={tab.mode === "managed"}
                    onOpenDefinition={(path, line) => {
                      openFileInTab(tab.key, path, line);
                      setTabViewMode(tab.key, "editor");
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
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

interface ChapterDetailProps {
  chapter: TourChapter;
  chapters: TourChapter[];
  kind: Kind;
  incoming: TourGraph["edges"];
  outgoing: TourGraph["edges"];
  hoveredEdgeKey: string | null;
  onHoverEdge: (key: string | null) => void;
  onSelectNode: (id: string) => void;
  reviewed: boolean;
  onToggleReviewed: () => void;
  onOpenFile: (path: string) => void;
  edgeKeyOf: (edge: TourGraph["edges"][number]) => string;
}

function ChapterDetail({
  chapter,
  chapters,
  kind,
  incoming,
  outgoing,
  hoveredEdgeKey,
  onHoverEdge,
  onSelectNode,
  reviewed,
  onToggleReviewed,
  onOpenFile,
  edgeKeyOf
}: ChapterDetailProps): React.JSX.Element {
  const meta = KIND_META[kind];
  const idx = chapters.findIndex((entry) => entry.id === chapter.id);
  const isSensitive = chapter.riskLevel === "high" || (chapter.riskReasons && chapter.riskReasons.length > 0);

  return (
    <>
      <div className="storyboard-v2-detail-head">
        <span className="storyboard-v2-kind" style={{ background: meta.bg, color: meta.color }}>{meta.label}</span>
        <span className="mono storyboard-v2-detail-num">chapter {String(idx + 1).padStart(2, "0")}</span>
        <RiskLevelPill level={chapter.riskLevel} />
        {isSensitive ? <AlertTriangle size={12} aria-hidden="true" className="storyboard-v2-detail-warning" /> : null}
      </div>
      <h3 className="storyboard-v2-detail-title" dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(chapter.title) }} />
      {chapter.files.length > 0 ? (
        <div className="storyboard-v2-detail-files">
          {chapter.files.map((path) => (
            <button type="button" key={path} className="chip storyboard-v2-file-chip" onClick={() => onOpenFile(path)} title={path}>
              <FileIcon size={9} aria-hidden="true" />
              {path.split("/").pop()}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="storyboard-v2-detail-summary markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(chapter.summary) }}
      />

      {(incoming.length > 0 || outgoing.length > 0) ? (
        <div className="storyboard-v2-detail-block">
          <div className="storyboard-v2-detail-block-title">Connections</div>
          {incoming.map((edge) => {
            const source = chapters.find((entry) => entry.id === edge.from);
            const key = edgeKeyOf(edge);
            const isHovered = hoveredEdgeKey === edge.id || hoveredEdgeKey === key;
            return (
              <button
                type="button"
                key={"in-" + edge.id}
                className={isHovered ? "storyboard-v2-conn is-hover" : "storyboard-v2-conn"}
                onClick={() => onSelectNode(edge.from)}
                onMouseEnter={() => onHoverEdge(edge.id)}
                onMouseLeave={() => onHoverEdge(null)}
              >
                <span className="mono storyboard-v2-conn-tag">← {RELATION_META[edge.relation].label}</span>
                <span
                  className="storyboard-v2-conn-name"
                  dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(source?.title ?? edge.from) }}
                />
              </button>
            );
          })}
          {outgoing.map((edge) => {
            const target = chapters.find((entry) => entry.id === edge.to);
            const key = edgeKeyOf(edge);
            const isHovered = hoveredEdgeKey === edge.id || hoveredEdgeKey === key;
            return (
              <button
                type="button"
                key={"out-" + edge.id}
                className={isHovered ? "storyboard-v2-conn is-hover" : "storyboard-v2-conn"}
                onClick={() => onSelectNode(edge.to)}
                onMouseEnter={() => onHoverEdge(edge.id)}
                onMouseLeave={() => onHoverEdge(null)}
              >
                <span className="mono storyboard-v2-conn-tag">→ {RELATION_META[edge.relation].label}</span>
                <span
                  className="storyboard-v2-conn-name"
                  dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(target?.title ?? edge.to) }}
                />
              </button>
            );
          })}
        </div>
      ) : null}

      {chapter.reviewChecklist.length > 0 ? (
        <div className="storyboard-v2-detail-block">
          <div className="storyboard-v2-detail-block-title">Key points</div>
          <ul className="storyboard-v2-detail-list">
            {chapter.reviewChecklist.map((item) => (
              <li key={item}>
                <div className="markdown compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(item) }} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {isSensitive && chapter.riskReasons && chapter.riskReasons.length > 0 ? (
        <div className="storyboard-v2-detail-warning-card">
          <AlertTriangle size={12} aria-hidden="true" />
          <div>
            <strong>Rigorous review needed.</strong> {chapter.riskReasons[0]}
          </div>
        </div>
      ) : null}

      <div className="storyboard-v2-detail-footer">
        <button type="button" className="primary-button storyboard-v2-detail-mark" onClick={onToggleReviewed}>
          <Check size={11} aria-hidden="true" />
          {reviewed ? "Unmark" : "Mark reviewed"}
        </button>
      </div>
    </>
  );
}

interface FlowCanvasProps {
  width: number;
  height: number;
  children: React.ReactNode;
}

function FlowCanvas({ width, height, children }: FlowCanvasProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button") || target.closest("a") || target.closest("input") || target.closest("textarea")) {
      return;
    }
    const el = ref.current;
    if (!el) {
      return;
    }
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: el.scrollLeft,
      startTop: el.scrollTop
    };
    setGrabbing(true);
    event.preventDefault();
  };

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!drag.current) {
        return;
      }
      const el = ref.current;
      if (!el) {
        return;
      }
      const dx = event.clientX - drag.current.startX;
      const dy = event.clientY - drag.current.startY;
      el.scrollLeft = drag.current.startLeft - dx;
      el.scrollTop = drag.current.startTop - dy;
    };
    const onUp = (): void => {
      if (drag.current) {
        drag.current = null;
        setGrabbing(false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={grabbing ? "storyboard-canvas is-grabbing" : "storyboard-canvas"}
      onMouseDown={onMouseDown}
      aria-label="Tour dependency graph"
    >
      <div className="storyboard-surface" style={{ width: Math.max(width, 100), height: Math.max(height, 100) }}>
        {children}
      </div>
    </div>
  );
}

function StoryboardLoadingSkeleton({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="storyboard-v2-skeleton" aria-label={message}>
      <div className="storyboard-v2-skeleton-row">
        <div className="skeleton skeleton-line skeleton-line-narrow" />
        <div className="skeleton skeleton-line skeleton-line-wide" />
      </div>
      <div className="storyboard-v2-skeleton-grid">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="skeleton storyboard-v2-skeleton-card" key={index} />
        ))}
      </div>
    </div>
  );
}

function cardClass({
  active,
  previewed,
  reviewed
}: {
  active: boolean;
  previewed: boolean;
  reviewed: boolean;
}): string {
  const classes = ["storyboard-v2-card"];
  if (active) {
    classes.push("is-active");
  }
  if (previewed) {
    classes.push("is-previewed");
  }
  if (reviewed) {
    classes.push("is-reviewed");
  }
  return classes.join(" ");
}

// The agent may classify a chapter explicitly; map that to a storyboard badge.
// Kinds without a clean structural equivalent fall through to graph inference.
const CHAPTER_KIND_TO_NODE_KIND: Partial<Record<ChapterKind, Kind>> = {
  concept: "foundation",
  replacement: "replace",
  config: "gate",
  verification: "verify"
};

function assignKinds(graph: TourGraph, chapters: TourChapter[]): Map<string, Kind> {
  const explicit = new Map<string, Kind>();
  for (const chapter of chapters) {
    const mapped = chapter.kind ? CHAPTER_KIND_TO_NODE_KIND[chapter.kind] : undefined;
    if (mapped) {
      explicit.set(chapter.id, mapped);
    }
  }
  const incomingByTo = new Map<string, TourGraph["edges"]>();
  for (const edge of graph.edges) {
    const list = incomingByTo.get(edge.to) ?? [];
    list.push(edge);
    incomingByTo.set(edge.to, list);
  }
  const kinds = new Map<string, Kind>();
  for (const node of graph.nodes) {
    const explicitKind = explicit.get(node.id);
    if (explicitKind) {
      kinds.set(node.id, explicitKind);
      continue;
    }
    const incoming = incomingByTo.get(node.id) ?? [];
    if (incoming.length === 0) {
      kinds.set(node.id, "foundation");
      continue;
    }
    const relations = incoming.map((edge) => edge.relation);
    if (relations.includes("gating")) {
      kinds.set(node.id, "gate");
      continue;
    }
    if (relations.includes("verification")) {
      kinds.set(node.id, "verify");
      continue;
    }
    if (relations.includes("extension")) {
      kinds.set(node.id, "extend");
      continue;
    }
    if (relations.includes("risk")) {
      kinds.set(node.id, "replace");
      continue;
    }
    kinds.set(node.id, "glue");
  }
  return kinds;
}

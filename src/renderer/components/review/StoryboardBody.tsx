import { AlertTriangle, Ban, Bot, Check, FileIcon, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAutoTour } from "../../hooks/useAutoTour.js";
import { useStoryboardLayout } from "../../hooks/useStoryboardLayout.js";
import { DiffPanel } from "../diffs/DiffPanel.js";
import type { PrTab } from "../../store/uiStore.js";
import { useUiStore } from "../../store/uiStore.js";
import type { TourChapter, TourGraph } from "../../../shared/schemas.js";

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
}

export function StoryboardBody({ tab, layout }: StoryboardBodyProps): React.JSX.Element {
  const tour = tab.tour;
  const auto = useAutoTour(tab);
  const { layout: graphLayout, isLayingOut } = useStoryboardLayout(tour);
  const openFileInTab = useUiStore((state) => state.openFileInTab);
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    tour?.graph.nodes[0]?.id ?? tour?.chapters[0]?.id ?? null
  );
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});

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
  const selectedAnchorFile = useMemo(() => {
    const anchorPath = activeChapter?.diffAnchors[0]?.path ?? activeChapter?.files[0] ?? null;
    return anchorPath ? tab.bundle.changedFiles.find((file) => file.path === anchorPath) ?? null : null;
  }, [activeChapter, tab.bundle.changedFiles]);
  const kindByNode = useMemo(() => (tour ? assignKinds(tour.graph) : new Map<string, Kind>()), [tour]);

  if (!tour) {
    return (
      <section className="tour-empty">
        <Bot size={22} aria-hidden="true" className={auto.isGenerating ? "spin" : undefined} />
        <h2>{auto.isGenerating ? "Generating storyboard" : auto.hasFailed ? "Tour generation failed" : "Preparing storyboard"}</h2>
        <p>{auto.message ?? "Reading the diff and timeline to organize this PR into a dependency graph."}</p>
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

  const reviewedCount = tour.chapters.filter((chapter) => reviewed[chapter.id]).length;
  const toggleReviewed = (id: string): void =>
    setReviewed((prev) => ({ ...prev, [id]: !prev[id] }));

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
        <FlowCanvas width={graphLayout.width} height={graphLayout.height}>
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
            const isReviewed = Boolean(reviewed[node.id]);
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
                  <strong style={{ textDecoration: isReviewed ? "line-through" : undefined }}>{node.label}</strong>
                </div>
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
              reviewed={Boolean(reviewed[activeChapter.id])}
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

      {selectedAnchorFile && activeChapter ? (
        <section className="storyboard-v2-diff" aria-label="Selected chapter diff">
          <div className="storyboard-v2-diff-head">
            <span className="storyboard-v2-diff-eyebrow">Diff</span>
            <span className="storyboard-v2-diff-dot">·</span>
            <span className="mono storyboard-v2-diff-path">{selectedAnchorFile.path}</span>
            {activeChapter.files.length > 1 ? (
              <span className="chip storyboard-v2-diff-more">+{activeChapter.files.length - 1} more</span>
            ) : null}
            <span className="mono storyboard-v2-diff-counts">
              <span className="diff-counts-add">+{activeChapter.changeStats.additions}</span>{" "}
              <span className="diff-counts-del">−{activeChapter.changeStats.deletions}</span>
            </span>
            <span className="storyboard-v2-diff-spacer" />
            <span className="storyboard-v2-diff-caption">
              chapter {tour.chapters.findIndex((entry) => entry.id === activeChapter.id) + 1} · {activeChapter.title}
            </span>
          </div>
          <DiffPanel
            tabKey={tab.key}
            pullRequest={tab.bundle.detail}
            file={selectedAnchorFile}
            layout={layout}
            reviewThreads={tab.bundle.reviewThreads}
            tourChapters={[activeChapter]}
            headerless
            enableLsp={tab.mode === "managed"}
            onOpenDefinition={(path, line) => {
              openFileInTab(tab.key, path, line);
              setTabViewMode(tab.key, "editor");
            }}
          />
        </section>
      ) : null}
    </section>
  );
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
        {isSensitive ? <AlertTriangle size={12} aria-hidden="true" className="storyboard-v2-detail-warning" /> : null}
      </div>
      <h3 className="storyboard-v2-detail-title">{chapter.title}</h3>
      {chapter.files.length > 0 ? (
        <div className="storyboard-v2-detail-files">
          {chapter.files.map((path) => (
            <button type="button" key={path} className="chip storyboard-v2-file-chip" onClick={() => onOpenFile(path)}>
              <FileIcon size={9} aria-hidden="true" />
              {path.split("/").pop()}
            </button>
          ))}
        </div>
      ) : null}
      <p className="storyboard-v2-detail-summary">{chapter.summary}</p>

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
                <span className="storyboard-v2-conn-name">{source?.title ?? edge.from}</span>
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
                <span className="storyboard-v2-conn-name">{target?.title ?? edge.to}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {chapter.reviewChecklist.length > 0 ? (
        <div className="storyboard-v2-detail-block">
          <div className="storyboard-v2-detail-block-title">Key points</div>
          <ul className="storyboard-v2-detail-list">
            {chapter.reviewChecklist.map((item) => <li key={item}>{item}</li>)}
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

function assignKinds(graph: TourGraph): Map<string, Kind> {
  const incomingByTo = new Map<string, TourGraph["edges"]>();
  for (const edge of graph.edges) {
    const list = incomingByTo.get(edge.to) ?? [];
    list.push(edge);
    incomingByTo.set(edge.to, list);
  }
  const kinds = new Map<string, Kind>();
  for (const node of graph.nodes) {
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

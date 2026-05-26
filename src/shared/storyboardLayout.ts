import type { ReviewTour, RiskLevel, TourGraph } from "./schemas.js";

export interface StoryboardLayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  columnGap: number;
  rowGap: number;
  padding: number;
  maxDetailedNodes: number;
}

export interface StoryboardLayoutNode {
  id: string;
  label: string;
  riskLevel: RiskLevel;
  files: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  chapterId: string | null;
}

export interface StoryboardLayoutEdge {
  id: string;
  from: string;
  to: string;
  relation: TourGraph["edges"][number]["relation"];
  confidence: number;
  source: TourGraph["edges"][number]["source"];
  path: string;
  label: string;
}

export interface StoryboardLayout {
  nodes: StoryboardLayoutNode[];
  edges: StoryboardLayoutEdge[];
  width: number;
  height: number;
  simplified: boolean;
}

const defaultOptions: StoryboardLayoutOptions = {
  nodeWidth: 180,
  nodeHeight: 118,
  columnGap: 74,
  rowGap: 28,
  padding: 28,
  maxDetailedNodes: 60
};

export function buildStoryboardLayout(
  tour: ReviewTour,
  options: Partial<StoryboardLayoutOptions> = {}
): StoryboardLayout {
  const limits = { ...defaultOptions, ...options };
  const simplified = tour.graph.nodes.length > limits.maxDetailedNodes;
  const nodeWidth = simplified ? 136 : limits.nodeWidth;
  const nodeHeight = simplified ? 72 : limits.nodeHeight;
  const columnGap = simplified ? 38 : limits.columnGap;
  const rowGap = simplified ? 16 : limits.rowGap;
  const chapterIds = new Set(tour.chapters.map((chapter) => chapter.id));
  const graphNodes = tour.graph.nodes.length > 0 ? tour.graph.nodes : tour.chapters.map((chapter) => ({
    id: chapter.id,
    label: chapter.title,
    riskLevel: chapter.riskLevel,
    files: chapter.files
  }));
  const depthByNode = computeNodeDepths(
    graphNodes.map((node) => node.id),
    tour.graph.edges,
    tour.chapters.flatMap((chapter) => chapter.dependencies.map((dependency) => ({ from: dependency, to: chapter.id })))
  );
  const rowsByDepth = new Map<number, string[]>();
  for (const node of graphNodes) {
    const depth = depthByNode.get(node.id) ?? 0;
    const rows = rowsByDepth.get(depth) ?? [];
    rows.push(node.id);
    rowsByDepth.set(depth, rows);
  }

  const layoutNodes = graphNodes.map((node) => {
    const depth = depthByNode.get(node.id) ?? 0;
    const row = rowsByDepth.get(depth)?.indexOf(node.id) ?? 0;
    return {
      id: node.id,
      label: node.label,
      riskLevel: node.riskLevel,
      files: node.files,
      x: limits.padding + depth * (nodeWidth + columnGap),
      y: limits.padding + row * (nodeHeight + rowGap),
      width: nodeWidth,
      height: nodeHeight,
      chapterId: chapterIds.has(node.id) ? node.id : null
    };
  });
  const nodesById = new Map(layoutNodes.map((node) => [node.id, node]));
  const maxX = Math.max(0, ...layoutNodes.map((node) => node.x + node.width));
  const maxY = Math.max(0, ...layoutNodes.map((node) => node.y + node.height));

  return {
    nodes: layoutNodes,
    edges: tour.graph.edges
      .map((edge) => {
        const from = nodesById.get(edge.from);
        const to = nodesById.get(edge.to);
        if (!from || !to) {
          return null;
        }
        return {
          id: edge.id,
          from: edge.from,
          to: edge.to,
          relation: edge.relation,
          confidence: edge.confidence,
          source: edge.source,
          path: edgePath(from, to),
          label: edge.relation.replace(/_/g, " ")
        };
      })
      .filter((edge): edge is StoryboardLayoutEdge => Boolean(edge)),
    width: maxX + limits.padding,
    height: maxY + limits.padding,
    simplified
  };
}

function computeNodeDepths(
  nodeIds: string[],
  graphEdges: TourGraph["edges"],
  chapterDependencies: Array<{ from: string; to: string }>
): Map<string, number> {
  const nodeSet = new Set(nodeIds);
  const inbound = new Map<string, string[]>();
  for (const edge of graphEdges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) {
      continue;
    }
    const sources = inbound.get(edge.to) ?? [];
    sources.push(edge.from);
    inbound.set(edge.to, sources);
  }
  for (const dependency of chapterDependencies) {
    if (!nodeSet.has(dependency.from) || !nodeSet.has(dependency.to)) {
      continue;
    }
    const sources = inbound.get(dependency.to) ?? [];
    sources.push(dependency.from);
    inbound.set(dependency.to, sources);
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthFor = (nodeId: string): number => {
    const cached = depths.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(nodeId)) {
      return 0;
    }
    visiting.add(nodeId);
    const sources = inbound.get(nodeId) ?? [];
    const depth = sources.length === 0 ? 0 : Math.max(...sources.map((source) => depthFor(source) + 1));
    visiting.delete(nodeId);
    depths.set(nodeId, depth);
    return depth;
  };

  for (const nodeId of nodeIds) {
    depthFor(nodeId);
  }
  return depths;
}

function edgePath(from: StoryboardLayoutNode, to: StoryboardLayoutNode): string {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const midX = startX + Math.max(24, (endX - startX) / 2);
  return `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
}

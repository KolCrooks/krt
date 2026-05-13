/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Chapter, EdgeKind } from './krtTourTypes.js';

/**
 * Storyboard layout — pure function over `Chapter[]`. No DOM
 * imports. Renderer takes the result and absolutely-positions
 * cards + draws SVG edge paths.
 *
 * Layout strategy:
 *   - Tier = longest path from a chapter with no dependencies.
 *     Cycles (rare but possible if the model emits one) are
 *     broken by dropping the back-edge during DFS.
 *   - Within a tier, chapters are ordered by their first
 *     appearance in the input array (stable for re-renders).
 *   - Edges are routed Manhattan-style with rounded corners
 *     (right edge of source -> mid-channel between tiers ->
 *     left edge of target).
 *   - Multiple edges into / out of the same node are vertically
 *     staggered on its left/right edge so they don't overlap.
 */

export interface StoryboardNode {
	readonly id: string;
	readonly tier: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface StoryboardEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: EdgeKind;
	/** SVG path `d` attribute (Manhattan with rounded corners). */
	readonly path: string;
	/** Suggested label anchor (midpoint of vertical channel). */
	readonly labelX: number;
	readonly labelY: number;
}

export interface StoryboardLayout {
	readonly nodes: readonly StoryboardNode[];
	readonly edges: readonly StoryboardEdge[];
	readonly width: number;
	readonly height: number;
}

export interface StoryboardLayoutOptions {
	readonly nodeWidth: number;
	readonly nodeHeight: number;
	/**
	 * Per-chapter height override. Lets the renderer keep cards
	 * tall enough to show their full title without clipping while
	 * still letting the layout stack tier columns without overlap.
	 */
	readonly heights?: ReadonlyMap<string, number>;
	/** Horizontal gap between tier columns. */
	readonly columnGap: number;
	/** Vertical gap between rows within a tier. */
	readonly rowGap: number;
	/** Padding around the whole graph. */
	readonly padding: number;
	/** Corner radius for rounded Manhattan bends. */
	readonly cornerRadius: number;
}

export const DEFAULT_LAYOUT_OPTIONS: StoryboardLayoutOptions = {
	nodeWidth: 248,
	nodeHeight: 96,
	columnGap: 96,
	rowGap: 24,
	padding: 40,
	cornerRadius: 8,
};

export function layoutStoryboard(
	chapters: readonly Chapter[],
	options: StoryboardLayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): StoryboardLayout {
	const { nodeWidth, nodeHeight, columnGap, rowGap, padding, cornerRadius } = options;

	const ids = new Set(chapters.map(c => c.id));
	// Filter dependsOn to known ids (model occasionally references
	// nonexistent chapters or itself).
	const deps = new Map<string, { id: string; kind: EdgeKind }[]>();
	for (const c of chapters) {
		deps.set(c.id, c.dependsOn.filter(d => ids.has(d.id) && d.id !== c.id).map(d => ({ id: d.id, kind: d.kind })));
	}

	const tiers = assignTiers(chapters, deps);
	const tierCount = chapters.length === 0 ? 0 : Math.max(...tiers.values()) + 1;

	// Bucket nodes by tier in input order.
	const byTier: string[][] = Array.from({ length: tierCount }, () => []);
	for (const c of chapters) {
		byTier[tiers.get(c.id)!].push(c.id);
	}

	const heightFor = (id: string): number => options.heights?.get(id) ?? nodeHeight;
	const columnHeight = (col: readonly string[]): number =>
		col.reduce((sum, id) => sum + heightFor(id), 0) + Math.max(0, col.length - 1) * rowGap;
	const tallest = byTier.reduce((max, col) => Math.max(max, columnHeight(col)), 0);

	// Count multi-tier edges so we can reserve enough space above
	// the graph for their routing tracks. Each multi-tier edge gets
	// a unique horizontal channel above all node bodies — this is
	// what keeps long edges from cutting through intermediate nodes.
	let multiTierEdgeCount = 0;
	for (const c of chapters) {
		const targetTier = tiers.get(c.id) ?? 0;
		for (const dep of deps.get(c.id) ?? []) {
			const sourceTier = tiers.get(dep.id) ?? 0;
			if (targetTier - sourceTier >= 2) {
				multiTierEdgeCount++;
			}
		}
	}
	const trackSpacing = 14;
	const trackMargin = 16;
	const topRailHeight = multiTierEdgeCount > 0
		? trackMargin + multiTierEdgeCount * trackSpacing + trackMargin
		: 0;

	const nodes: StoryboardNode[] = [];
	const positions = new Map<string, StoryboardNode>();
	for (let t = 0; t < tierCount; t++) {
		const column = byTier[t];
		// Centre the column vertically against the tallest column,
		// shifted down by the reserved top-rail space.
		const yOffset = padding + topRailHeight + (tallest - columnHeight(column)) / 2;
		let cursorY = yOffset;
		for (let i = 0; i < column.length; i++) {
			const id = column[i];
			const h = heightFor(id);
			const node: StoryboardNode = {
				id,
				tier: t,
				x: padding + t * (nodeWidth + columnGap),
				y: cursorY,
				width: nodeWidth,
				height: h,
			};
			nodes.push(node);
			positions.set(id, node);
			cursorY += h + rowGap;
		}
	}

	const totalHeight = tallest + padding * 2 + topRailHeight;
	const totalWidth = tierCount === 0
		? padding * 2
		: padding * 2 + tierCount * nodeWidth + Math.max(0, tierCount - 1) * columnGap;

	const edges = routeEdges(
		chapters,
		deps,
		tiers,
		positions,
		cornerRadius,
		padding,
		trackMargin,
		trackSpacing,
		nodeWidth,
		columnGap,
	);
	return { nodes, edges, width: totalWidth, height: totalHeight };
}

/**
 * Assign each chapter a tier = longest dependency-path length.
 * Implemented via memoized DFS with a visiting-set to break
 * cycles (back-edges are ignored, treated as if they didn't
 * exist).
 */
function assignTiers(
	chapters: readonly Chapter[],
	deps: Map<string, { id: string; kind: EdgeKind }[]>,
): Map<string, number> {
	const tier = new Map<string, number>();
	const visiting = new Set<string>();
	const visit = (id: string): number => {
		const cached = tier.get(id);
		if (cached !== undefined) {
			return cached;
		}
		if (visiting.has(id)) {
			// Cycle — caller will treat the back-edge as missing.
			return 0;
		}
		visiting.add(id);
		const ds = deps.get(id) ?? [];
		let max = -1;
		for (const d of ds) {
			max = Math.max(max, visit(d.id));
		}
		visiting.delete(id);
		const t = max + 1;
		tier.set(id, t);
		return t;
	};
	for (const c of chapters) {
		visit(c.id);
	}
	return tier;
}

interface RoutingEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: EdgeKind;
	readonly sourceTier: number;
	readonly targetTier: number;
	readonly sx: number;
	readonly sy: number;
	readonly tx: number;
	readonly ty: number;
}

function routeEdges(
	chapters: readonly Chapter[],
	deps: Map<string, { id: string; kind: EdgeKind }[]>,
	tiers: Map<string, number>,
	positions: Map<string, StoryboardNode>,
	cornerRadius: number,
	padding: number,
	trackMargin: number,
	trackSpacing: number,
	nodeWidth: number,
	columnGap: number,
): StoryboardEdge[] {
	const incoming = new Map<string, { id: string; kind: EdgeKind }[]>();
	const outgoing = new Map<string, { id: string; kind: EdgeKind }[]>();
	const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
		const existing = map.get(key);
		if (existing) {
			existing.push(value);
		} else {
			map.set(key, [value]);
		}
	};
	for (const c of chapters) {
		for (const d of deps.get(c.id) ?? []) {
			push(incoming, c.id, { id: d.id, kind: d.kind });
			push(outgoing, d.id, { id: c.id, kind: d.kind });
		}
	}

	// Sort each node's outgoing/incoming edge list by the y the
	// wire actually heads toward as it leaves the node, NOT by the
	// raw target y. A multi-tier edge whose target sits low on the
	// canvas still routes UP to the top rail before going across,
	// so its source-port belongs at the top of the source. Sorting
	// by raw target-y would put it at the bottom and force its wire
	// to cross every adjacent edge that's actually going down.
	//
	// "Direction-y" for an outgoing edge:
	//   - multi-tier (over top rail):   FAR_TOP + target.y  (always top)
	//   - adjacent:                     target.y
	// And symmetrically on the incoming side.
	const FAR_TOP = -1e9;
	const centerY = (id: string): number => {
		const p = positions.get(id);
		return p ? p.y + p.height / 2 : 0;
	};
	const outDirectionY = (sourceId: string, targetId: string): number => {
		const span = (tiers.get(targetId) ?? 0) - (tiers.get(sourceId) ?? 0);
		const ty = centerY(targetId);
		// Multi-tier edges all anchor at FAR_TOP; the target's y is
		// added as a tiebreaker so multiple multi-tier edges from the
		// same source still have a stable, meaningful order among
		// themselves.
		return span >= 2 ? FAR_TOP + ty : ty;
	};
	const inDirectionY = (sourceId: string, targetId: string): number => {
		const span = (tiers.get(targetId) ?? 0) - (tiers.get(sourceId) ?? 0);
		const sy = centerY(sourceId);
		return span >= 2 ? FAR_TOP + sy : sy;
	};
	for (const [src, list] of outgoing) {
		list.sort((a, b) => outDirectionY(src, a.id) - outDirectionY(src, b.id));
	}
	for (const [tgt, list] of incoming) {
		list.sort((a, b) => inDirectionY(a.id, tgt) - inDirectionY(b.id, tgt));
	}

	const portY = (count: number, index: number, top: number, height: number): number => {
		// Distribute `count` ports along the node's vertical edge
		// using as much of the height as the corner radius allows.
		// Wide spread (15%-85%) so multiple edges leaving the same
		// node fan out clearly instead of crowding a thin central
		// band.
		if (count <= 1) {
			return top + height / 2;
		}
		return top + height * (0.15 + (index / Math.max(1, count - 1)) * 0.7);
	};

	// Pass 1 — collect every edge with its source/target ports.
	const routing: RoutingEdge[] = [];
	for (const c of chapters) {
		const ds = deps.get(c.id) ?? [];
		const inList = incoming.get(c.id) ?? [];
		const target = positions.get(c.id);
		if (!target) {
			continue;
		}
		const targetTier = tiers.get(c.id) ?? 0;
		for (const dep of ds) {
			const source = positions.get(dep.id);
			if (!source) {
				continue;
			}
			const sourceTier = tiers.get(dep.id) ?? 0;
			const outList = outgoing.get(dep.id) ?? [];
			const sourceIdx = outList.findIndex(o => o.id === c.id);
			const targetIdx = inList.findIndex(o => o.id === dep.id);
			const sx = source.x + source.width;
			const sy = portY(outList.length, sourceIdx, source.y, source.height);
			const tx = target.x;
			const ty = portY(inList.length, targetIdx, target.y, target.height);
			routing.push({ from: dep.id, to: c.id, kind: dep.kind, sourceTier, targetTier, sx, sy, tx, ty });
		}
	}

	// Pass 2 — assign each edge a unique sub-track x within every
	// vertical channel it traverses. This is the standard
	// "orthogonal connector routing with channel allocation" trick
	// (see Sugiyama 1981; Graphviz dot; ELK Layered): bucket edges
	// by gap, sort within the bucket, slot them into evenly-spaced
	// sub-track x's so two edges never share the same vertical
	// channel x for a long stretch.
	type ChannelMember = { edgeIdx: number; sortKey: number };
	const channelBuckets = new Map<number, ChannelMember[]>();
	for (let i = 0; i < routing.length; i++) {
		const e = routing[i];
		const span = e.targetTier - e.sourceTier;
		if (span >= 2) {
			// Multi-tier edges use both the channel right after the
			// source tier (entry, sorted by source-y) and the channel
			// right before the target tier (exit, sorted by target-y).
			push(channelBuckets, e.sourceTier, { edgeIdx: i, sortKey: e.sy });
			push(channelBuckets, e.targetTier - 1, { edgeIdx: i, sortKey: e.ty });
		} else if (span === 1) {
			// Adjacent-tier edges use the single gap they cross. Sort
			// by source-y so the channel reflects the order edges
			// leave the source — the source side is what the user
			// looks at first when many edges fan out.
			push(channelBuckets, e.sourceTier, { edgeIdx: i, sortKey: e.sy });
		}
	}

	const entryX: number[] = new Array(routing.length).fill(NaN);
	const exitX: number[] = new Array(routing.length).fill(NaN);
	for (const [gap, members] of channelBuckets) {
		members.sort((a, b) => a.sortKey - b.sortKey);
		const gapLeft = padding + (gap + 1) * nodeWidth + gap * columnGap;
		// Inset 14px on each side so sub-tracks never touch node edges.
		const usable = columnGap - 28;
		const N = members.length;
		for (let i = 0; i < N; i++) {
			const t = N === 1 ? 0.5 : i / (N - 1);
			const x = gapLeft + 14 + usable * t;
			const e = routing[members[i].edgeIdx];
			const span = e.targetTier - e.sourceTier;
			if (span >= 2) {
				if (gap === e.sourceTier) {
					entryX[members[i].edgeIdx] = x;
				} else {
					exitX[members[i].edgeIdx] = x;
				}
			} else {
				entryX[members[i].edgeIdx] = x;
			}
		}
	}

	// Pass 3 — build SVG paths using the assigned sub-track x's.
	// Multi-tier edges still ride the top rail; each gets its own
	// y-track in rail-order (top-to-bottom by source-y).
	const multiTierOrder = routing
		.map((e, i) => ({ e, i }))
		.filter(({ e }) => e.targetTier - e.sourceTier >= 2)
		.sort((a, b) => a.e.sy - b.e.sy);
	const railTrackY = new Map<number, number>();
	multiTierOrder.forEach(({ i }, k) => {
		railTrackY.set(i, trackMargin + k * trackSpacing);
	});

	const edges: StoryboardEdge[] = [];
	const r = cornerRadius;
	for (let i = 0; i < routing.length; i++) {
		const e = routing[i];
		const tierSpan = e.targetTier - e.sourceTier;
		let path: string;
		let labelX: number;
		let labelY: number;
		if (tierSpan >= 2) {
			const railY = railTrackY.get(i)!;
			const x1 = entryX[i];
			const x2 = exitX[i];
			path = buildRailPath(e.sx, e.sy, x1, x2, railY, e.tx, e.ty, r);
			labelX = (x1 + x2) / 2;
			labelY = railY - 8;
		} else {
			const midX = entryX[i];
			if (Math.abs(e.sy - e.ty) < 1) {
				path = `M ${e.sx} ${e.sy} L ${midX} ${e.sy} L ${e.tx} ${e.ty}`;
			} else if (e.ty > e.sy) {
				path = `M ${e.sx} ${e.sy} L ${midX - r} ${e.sy} Q ${midX} ${e.sy} ${midX} ${e.sy + r} L ${midX} ${e.ty - r} Q ${midX} ${e.ty} ${midX + r} ${e.ty} L ${e.tx} ${e.ty}`;
			} else {
				path = `M ${e.sx} ${e.sy} L ${midX - r} ${e.sy} Q ${midX} ${e.sy} ${midX} ${e.sy - r} L ${midX} ${e.ty + r} Q ${midX} ${e.ty} ${midX + r} ${e.ty} L ${e.tx} ${e.ty}`;
			}
			labelX = midX;
			labelY = Math.abs(e.sy - e.ty) < 1 ? e.sy - 8 : (e.sy + e.ty) / 2;
		}
		edges.push({ from: e.from, to: e.to, kind: e.kind, path, labelX, labelY });
	}
	return edges;
}

/**
 * Build the SVG `d` attribute for a multi-tier edge that goes:
 *   source.right -> up to railY -> across -> down to target.left
 * with rounded corners. Both vertical segments go upward (railY
 * sits above all node bodies) so the maths is symmetric.
 */
function buildRailPath(
	sx: number,
	sy: number,
	x1: number,
	x2: number,
	railY: number,
	tx: number,
	ty: number,
	r: number,
): string {
	// Direction from sy to railY is upward; from railY to ty is
	// downward. With rounded Q corners we step in the relevant
	// direction by r before/after the corner point.
	return [
		`M ${sx} ${sy}`,
		`L ${x1 - r} ${sy}`,
		`Q ${x1} ${sy} ${x1} ${sy - r}`,
		`L ${x1} ${railY + r}`,
		`Q ${x1} ${railY} ${x1 + r} ${railY}`,
		`L ${x2 - r} ${railY}`,
		`Q ${x2} ${railY} ${x2} ${railY + r}`,
		`L ${x2} ${ty - r}`,
		`Q ${x2} ${ty} ${x2 + r} ${ty}`,
		`L ${tx} ${ty}`,
	].join(' ');
}

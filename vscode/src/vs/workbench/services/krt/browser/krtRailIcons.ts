/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Inline SVG icons for the KRT left rail. Path data lifted verbatim from
// design/kol-s-review-tool/project/icons.jsx — single stroke, 16px box.
// Phase 11 swaps these for polished marks.

const SVG_NS = 'http://www.w3.org/2000/svg';

export type KrtRailIconName = 'search' | 'pr' | 'review' | 'code' | 'gear';

interface ShapeSpec {
	readonly tag: 'circle' | 'rect' | 'path';
	readonly attrs: Readonly<Record<string, string>>;
}

const KRT_RAIL_ICON_SHAPES: Readonly<Record<KrtRailIconName, ReadonlyArray<ShapeSpec>>> = {
	search: [
		{ tag: 'circle', attrs: { cx: '7', cy: '7', r: '4.5' } },
		{ tag: 'path', attrs: { d: 'm13.5 13.5-3-3' } },
	],
	pr: [
		{ tag: 'circle', attrs: { cx: '4', cy: '3.5', r: '1.5' } },
		{ tag: 'circle', attrs: { cx: '4', cy: '12.5', r: '1.5' } },
		{ tag: 'circle', attrs: { cx: '12', cy: '12.5', r: '1.5' } },
		{ tag: 'path', attrs: { d: 'M4 5v6' } },
		{ tag: 'path', attrs: { d: 'M12 11V8a2 2 0 0 0-2-2H7.5' } },
		{ tag: 'path', attrs: { d: 'm9.5 4 -2 2 2 2' } },
	],
	review: [
		{ tag: 'rect', attrs: { x: '2', y: '3', width: '12', height: '10', rx: '1.5' } },
		{ tag: 'path', attrs: { d: 'M5 6.5h3' } },
		{ tag: 'path', attrs: { d: 'M5 9.5h6' } },
		{ tag: 'path', attrs: { d: 'm9 11.5 1.5 1.5 2.5-3' } },
	],
	code: [
		{ tag: 'path', attrs: { d: 'm6 5-3 3 3 3' } },
		{ tag: 'path', attrs: { d: 'm10 5 3 3-3 3' } },
	],
	gear: [
		{ tag: 'circle', attrs: { cx: '8', cy: '8', r: '2' } },
		{ tag: 'path', attrs: { d: 'M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4' } },
	],
};

export function createKrtRailIcon(name: KrtRailIconName): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.5');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const shape of KRT_RAIL_ICON_SHAPES[name]) {
		const el = document.createElementNS(SVG_NS, shape.tag);
		for (const attr of Object.keys(shape.attrs)) {
			el.setAttribute(attr, shape.attrs[attr]);
		}
		svg.appendChild(el);
	}
	return svg;
}

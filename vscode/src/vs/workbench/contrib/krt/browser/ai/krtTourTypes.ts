/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Relationship kind on a chapter dependency edge. The Storyboard
 * view colour-codes and labels edges by kind so the reviewer can
 * see at a glance which dependencies are "this builds on that"
 * vs "this is gated by that" vs "this verifies that".
 *
 * - `depends`  — generic "needs to land first" dependency.
 * - `extends`  — the dependent chapter builds on a primitive the
 *                source chapter introduces.
 * - `gates`    — the dependent chapter is hidden behind a flag /
 *                config introduced by the source chapter.
 * - `verifies` — the dependent chapter is tests / observability
 *                covering the source chapter.
 */
export type EdgeKind = 'depends' | 'extends' | 'gates' | 'verifies';

export const EDGE_KINDS: readonly EdgeKind[] = ['depends', 'extends', 'gates', 'verifies'];

export interface DependsOnEdge {
	readonly id: string;
	readonly kind: EdgeKind;
}

/**
 * Semantic role of a chapter inside the PR. Drives the top-stripe
 * colour of a Storyboard card so the reviewer can see at a glance
 * which chapters are foundational primitives, which are gates,
 * which are verification-only, etc.
 *
 * - `foundation` — introduces a primitive / abstraction other
 *                  chapters build on (data structures, types).
 * - `replace`    — rewrites or replaces existing behaviour
 *                  (algorithm swap, large refactor of a single unit).
 * - `extend`     — extends a primitive a foundation chapter
 *                  introduces (additional methods, new variants).
 * - `glue`       — wiring / plumbing that connects the above
 *                  (call-site updates, dependency injection).
 * - `gate`       — config / feature flag / env that controls when
 *                  the new behaviour is active.
 * - `verify`     — tests, fixtures, observability, documentation.
 */
export type ChapterKind = 'foundation' | 'replace' | 'extend' | 'glue' | 'gate' | 'verify';

export const CHAPTER_KINDS: readonly ChapterKind[] = ['foundation', 'replace', 'extend', 'glue', 'gate', 'verify'];

/**
 * Severity of an AI-generated inline chip. Drives the chip's tint
 * inside the diff editor — `info` is muted (lightest), `note` is
 * slightly more emphatic, `warn` is the strongest (used for things
 * the reviewer should look at carefully, like edge cases or
 * subtle behaviour changes).
 */
export type ChipSeverity = 'info' | 'warn' | 'note';

export const CHIP_SEVERITIES: readonly ChipSeverity[] = ['info', 'warn', 'note'];

/**
 * AI-generated review nudge anchored at a single line on one side
 * of the diff. Rendered as a small pill inside `KrtPrFlatDiff` —
 * hover or click expands the body. Markdown allowed in `body`.
 */
export interface ChapterChip {
	readonly path: string;
	readonly line: number;
	readonly side: 'LEFT' | 'RIGHT';
	readonly body: string;
	readonly severity: ChipSeverity;
}

/**
 * AI-generated narrative chapter for the Tour view. Each chapter
 * groups one or more files into a unit the reviewer can absorb
 * at a glance.
 *
 * `dependsOn` is a list of typed edges to other chapters — the
 * Storyboard view walks this graph to lay out tier-by-tier
 * columns and colour-codes edges by `kind`.
 */
export interface Chapter {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly bullets: readonly string[];
	/** File paths covered by this chapter, in display order. */
	readonly files: readonly string[];
	readonly plus: number;
	readonly minus: number;
	readonly sensitive: boolean;
	/** Why the chapter is sensitive — short, reviewer-facing. */
	readonly sensitiveReason?: string;
	/**
	 * Path to the "main" file the Chapters variant focuses on when
	 * the chapter is selected. Falls back to `files[0]` if absent
	 * or unknown.
	 */
	readonly diffFile?: string;
	readonly dependsOn: readonly DependsOnEdge[];
	readonly kind: ChapterKind;
	/**
	 * Per-chapter inline chips rendered on top of the diff editors
	 * for the chapter's files. May be empty. Validated against the
	 * PR's actual files at parse time so phantom chips are dropped.
	 */
	readonly chips: readonly ChapterChip[];
	/**
	 * Marks chapters KRT generates locally rather than the model.
	 * The Coverage chapter (auto-appended by the Tour generator,
	 * walks files no other chapter touched) is the only synthetic
	 * value today.
	 */
	readonly synthetic?: 'coverage';
}

/** Stable id of the synthetic Coverage chapter. Underscored prefix avoids collisions with model-generated kebab-case ids. */
export const COVERAGE_CHAPTER_ID = '__krt-coverage';

export type TourVariant = 'chapters' | 'reading';

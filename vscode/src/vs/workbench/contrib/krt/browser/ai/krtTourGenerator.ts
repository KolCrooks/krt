/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IKrtAiClient, PullRequest, PullRequestFile } from '../../../../../platform/krt/common/krt.js';
import {
	readAnthropicKey,
	readBaseUrl,
	readModel,
	readPromptCaching,
} from './krtAiSettings.js';
import { Chapter, ChapterChip, ChapterKind, CHAPTER_KINDS, ChipSeverity, COVERAGE_CHAPTER_ID, DependsOnEdge, EdgeKind, EDGE_KINDS } from './krtTourTypes.js';
import { readCachedChapters, writeCachedChapters } from './krtTourCache.js';

/**
 * Phase 7 AI tour generator. The HTTP request itself is run in
 * the main process via `IKrtAiClient` so we bypass renderer CORS
 * — corporate Anthropic gateways (Datadog and friends) routinely
 * don't return permissive CORS headers, and the renderer fetch
 * fails before the response body is reachable.
 *
 * Result is cached by `{prId, headSha}` so reopening a PR doesn't
 * re-bill. Caller invalidates by passing `forceRefresh: true`.
 */
export const ITourGenerator = createDecorator<ITourGenerator>('krtTourGenerator');

export interface TourTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheCreationTokens?: number;
}

export interface TourGenerationResult {
	readonly chapters: readonly Chapter[];
	readonly model: string;
	readonly fromCache: boolean;
	/** Only present for live generations; cached chapters do not carry usage. */
	readonly usage?: TourTokenUsage;
}

export type TourGenerationStatus =
	| { readonly kind: 'ok'; readonly result: TourGenerationResult }
	| { readonly kind: 'no-key' }
	| { readonly kind: 'error'; readonly message: string };

export interface TourStreamUpdate {
	/** Validated chapters parsed from the in-flight response so far. */
	readonly chapters: readonly Chapter[];
	readonly usage?: TourTokenUsage;
}

export interface TourGenerateOptions {
	readonly forceRefresh?: boolean;
	/**
	 * Called whenever new chapters are completed inside the streaming
	 * JSON, or when the running token-usage roll-up changes. Safe to
	 * use for live UI updates.
	 */
	readonly onUpdate?: (update: TourStreamUpdate) => void;
}

export interface ITourGenerator {
	readonly _serviceBrand: undefined;
	hasApiKey(): Promise<boolean>;
	/** Returns cached chapters if available, otherwise null (so the caller can show a quick state). */
	readCached(pr: PullRequest): TourGenerationResult | undefined;
	generate(pr: PullRequest, files: readonly PullRequestFile[], options?: TourGenerateOptions): Promise<TourGenerationStatus>;
}

const ANTHROPIC_VERSION = '2023-06-01';

const MAX_FILES_INLINED = 60;
const MAX_PATCH_CHARS_PER_FILE = 8_000;
const MAX_TOTAL_PATCH_CHARS = 180_000;

export class TourGenerator implements ITourGenerator {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
		@IKrtAiClient private readonly aiClient: IKrtAiClient,
	) { }

	async hasApiKey(): Promise<boolean> {
		const k = await readAnthropicKey(this.secretStorageService);
		return Boolean(k);
	}

	readCached(pr: PullRequest): TourGenerationResult | undefined {
		const cached = readCachedChapters(this.storageService, pr.owner, pr.repo, pr.number, pr.head.sha);
		if (!cached) {
			return undefined;
		}
		return { chapters: cached.chapters, model: cached.model, fromCache: true };
	}

	async generate(pr: PullRequest, files: readonly PullRequestFile[], options?: TourGenerateOptions): Promise<TourGenerationStatus> {
		if (!options?.forceRefresh) {
			const cached = this.readCached(pr);
			if (cached) {
				return { kind: 'ok', result: cached };
			}
		}

		const apiKey = await readAnthropicKey(this.secretStorageService);
		if (!apiKey) {
			return { kind: 'no-key' };
		}
		const model = readModel(this.storageService);
		const promptCachingOn = readPromptCaching(this.storageService);
		const baseUrl = readBaseUrl(this.storageService);

		const userPayload = buildUserPrompt(pr, files);
		const body = JSON.stringify({
			model,
			max_tokens: 4096,
			system: promptCachingOn
				? [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]
				: SYSTEM_PROMPT,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: userPayload },
					],
				},
			],
		});

		const requestId = generateUuid();
		let accumulatedText = '';
		let liveUsage: TourTokenUsage | undefined;
		let lastEmittedCount = 0;
		let throttleTimer: ReturnType<typeof setTimeout> | undefined;

		const estimateOutputTokens = (): number => Math.max(0, Math.ceil(accumulatedText.length / 4));

		const fireUpdate = () => {
			if (throttleTimer) {
				clearTimeout(throttleTimer);
				throttleTimer = undefined;
			}
			if (!options?.onUpdate) {
				return;
			}
			const partial = parseChaptersStreaming(accumulatedText, files);
			lastEmittedCount = partial.length;
			options.onUpdate({ chapters: partial, usage: liveUsage });
		};

		const scheduleUpdate = () => {
			if (throttleTimer || !options?.onUpdate) {
				return;
			}
			throttleTimer = setTimeout(fireUpdate, 150);
		};

		const listener = this.aiClient.onStreamEvent(event => {
			if (event.requestId !== requestId) {
				return;
			}
			if (event.kind === 'text' && event.text) {
				accumulatedText += event.text;
				// Refine the running output-token estimate from the
				// streaming text. Anthropic only sends the authoritative
				// output_tokens in the final message_delta, so we
				// approximate at ~4 chars/token until then.
				if (liveUsage) {
					liveUsage = {
						...liveUsage,
						outputTokens: Math.max(liveUsage.outputTokens, estimateOutputTokens()),
					};
				}
				// Fast path: a new chapter just popped out of the JSON?
				// Fire immediately so the UI gets the chapter without
				// waiting for the throttle. Otherwise schedule.
				const partial = parseChaptersStreaming(accumulatedText, files);
				if (partial.length !== lastEmittedCount) {
					fireUpdate();
				} else {
					scheduleUpdate();
				}
			} else if (event.kind === 'usage') {
				liveUsage = {
					inputTokens: event.inputTokens ?? 0,
					outputTokens: Math.max(event.outputTokens ?? 0, estimateOutputTokens()),
					cacheReadTokens: event.cacheReadTokens,
					cacheCreationTokens: event.cacheCreationTokens,
				};
				scheduleUpdate();
			}
		});

		try {
			const response = await this.aiClient.postMessagesStream(requestId, {
				baseUrl,
				apiKey,
				anthropicVersion: ANTHROPIC_VERSION,
				body,
			});
			if (!response.ok) {
				this.logService.warn(`[krt] tour-generator HTTP ${response.status}: ${response.text}`);
				return { kind: 'error', message: localize('krt.tour.httpError', "Anthropic API error {0}: {1}", response.status, truncate(response.text, 240)) };
			}
			let json: unknown;
			try {
				json = JSON.parse(response.text);
			} catch (e) {
				this.logService.warn('[krt] tour-generator response was not JSON', response.text.slice(0, 600));
				return { kind: 'error', message: localize('krt.tour.invalidJson', "Anthropic API returned a non-JSON response.") };
			}
			const text = extractText(json);
			if (!text) {
				return { kind: 'error', message: localize('krt.tour.emptyResponse', "Empty response from Anthropic API.") };
			}
			const parsed = parseChaptersJson(text, files);
			if (!parsed || parsed.length === 0) {
				this.logService.warn('[krt] tour-generator could not parse chapters from response', text.slice(0, 600));
				return { kind: 'error', message: localize('krt.tour.parseError', "Couldn't parse chapters from the model response.") };
			}
			const chapters = wrapWithCoverage(parsed, files);
			writeCachedChapters(this.storageService, pr.owner, pr.repo, pr.number, pr.head.sha, chapters, model);
			const usage = extractUsage(json) ?? liveUsage;
			return { kind: 'ok', result: { chapters, model, fromCache: false, usage } };
		} catch (e) {
			this.logService.error('[krt] tour-generator request failed', e);
			return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
		} finally {
			if (throttleTimer) {
				clearTimeout(throttleTimer);
				throttleTimer = undefined;
			}
			listener.dispose();
		}
	}
}

const SYSTEM_PROMPT = [
	'You are KRT, a code-review companion that summarises pull requests as a sequence of narrative chapters.',
	'Each chapter groups related changes a reviewer should read together. Chapters should be ordered the way a human would naturally read the PR (entry points and types first; tests, fixtures, generated files last).',
	'',
	'Output format: respond with a single fenced code block containing JSON that matches this TypeScript shape exactly. Do not write any prose outside the fence.',
	'',
	'```json',
	'{',
	'  "chapters": [',
	'    {',
	'      "id": "kebab-case-id",            // unique within this PR',
	'      "title": "Short, human title",     // <= 70 chars',
	'      "summary": "One-paragraph overview", // 1-3 sentences',
	'      "bullets": ["Concrete change one", "Concrete change two"], // 0-6 entries, each <= 140 chars',
	'      "files": ["path/from/repo/root.ts"], // subset of the PR files; preserve repo paths exactly',
	'      "plus": 0, "minus": 0,             // additions / deletions across this chapter\'s files',
	'      "sensitive": false,                 // true for migrations, auth, secrets, money, deletions of safety code',
	'      "sensitiveReason": "",              // required when sensitive=true; otherwise empty string',
	'      "diffFile": "path/to/main.ts",     // the most representative file (must be in `files`)',
	'      "kind": "foundation",                // chapter role — see "kind" values below',
	'      "dependsOn": [                       // typed edges to other chapters this one follows',
	'        { "id": "earlier-chapter-id", "kind": "depends" }',
	'      ],',
	'      "chips": [                           // 0-2 short, line-anchored review nudges per chapter',
	'        {',
	'          "path": "path/to/file.ts",        // must be in this chapter\'s files',
	'          "line": 42,                       // 1-based line number on the chosen side',
	'          "side": "RIGHT",                  // "LEFT" (base) or "RIGHT" (head). Prefer RIGHT for added/modified lines.',
	'          "body": "Short reviewer hint…",   // <= 200 chars, plain markdown allowed',
	'          "severity": "info"                // "info" | "note" | "warn" — warn for must-look-at',
	'        }',
	'      ]',
	'    }',
	'  ]',
	'}',
	'```',
	'',
	'`kind` (chapter role — pick exactly one):',
	'- "foundation" — introduces a primitive / abstraction other chapters build on (new types, data structures, core algorithms).',
	'- "replace"    — rewrites or replaces existing behaviour (algorithm swap, large refactor of a single unit, migration of a function family).',
	'- "extend"     — extends a primitive that a foundation chapter introduces (additional methods, new variants on an existing type).',
	'- "glue"       — wiring / plumbing that connects the above (call-site updates, dependency injection, parameter threading, factories).',
	'- "gate"       — config / feature flag / env / Helm values / launch config that controls when new behaviour activates. ANY chapter whose files are predominantly config (\\*.yaml, \\*.toml, helm-values.\\*, *.env, settings.json) is "gate".',
	'- "verify"     — tests, fixtures, snapshots, observability, documentation. ANY chapter whose files are predominantly tests (\\*_test.\\*, \\*.spec.\\*, \\*_spec.\\*, tests/, __tests__/) or docs (README, CHANGELOG, docs/) is "verify".',
	'',
	'`dependsOn[].kind` (relationship to the other chapter — pick the most specific one):',
	'- "depends"   — generic "this needs to land first" with no more specific story.',
	'- "extends"   — this chapter builds on a primitive / abstraction the other chapter introduces. Use whenever the source chapter is `foundation` and this chapter uses its primitive.',
	'- "gates"     — this chapter is hidden behind a config / feature flag the other chapter sets up. Use whenever the source chapter is `gate` and this chapter changes behaviour the gate controls.',
	'- "verifies"  — this chapter is tests / observability that exercises the other chapter. Use whenever THIS chapter is `verify` and the source chapter is the unit under test.',
	'',
	'Rules:',
	'- Cover every changed file at least once across the chapters; do not invent files that are not in the input.',
	'- Aim for 3-8 chapters for a typical PR. Very small PRs may have 1-2 chapters; very large PRs should not exceed 12.',
	'- Be specific: prefer "Adds the `--retry` flag to `cli.ts`" over "Updates the CLI".',
	'- `sensitive` should be true sparingly — only for changes a reviewer must look at carefully (security, data migrations, money flows, destructive operations, removal of validation).',
	'- `dependsOn[].id` must reference another chapter id in this PR; "kind" must be one of the four edge values above.',
	'- BE AGGRESSIVE about labelling test-only chapters as kind="verify" with edges of kind="verifies" pointing at the chapters they exercise. Reviewers want to see the test-coverage edges as a distinct colour in the dependency graph.',
	'- BE AGGRESSIVE about labelling config / flag chapters as kind="gate" with edges of kind="gates" from chapters whose behaviour the flag controls. Reviewers want to see the gating relationship as a distinct colour.',
	'- Prefer many specific edges over one generic "depends". A test chapter exercising three units should emit three "verifies" edges, not one "depends".',
	'- `chips` are short, surgical nudges anchored to a single line: "this is the subtle bit", "watch for the off-by-one here", "this is the canonical example". 0-2 chips per chapter is the target — more clutters the diff. Use chips sparingly so they remain useful.',
].join('\n');

function buildUserPrompt(pr: PullRequest, files: readonly PullRequestFile[]): string {
	const trimmedFiles = files.slice(0, MAX_FILES_INLINED);
	const lines: string[] = [];
	lines.push(`# PR ${pr.owner}/${pr.repo} #${pr.number}`);
	lines.push(`Title: ${pr.title}`);
	lines.push(`Author: ${pr.author.login}`);
	lines.push(`Base: ${pr.base.label}  Head: ${pr.head.label}`);
	lines.push(`Stats: +${pr.stats.additions} -${pr.stats.deletions}, ${pr.stats.changedFiles} file(s)`);
	if (pr.body.trim()) {
		lines.push('');
		lines.push('## Description');
		lines.push(pr.body.trim());
	}
	lines.push('');
	lines.push('## Files and patches');

	let totalChars = 0;
	for (const f of trimmedFiles) {
		const head = `### ${f.path}  (status: ${f.status}, +${f.additions} -${f.deletions})`;
		lines.push('');
		lines.push(head);
		if (!f.patch) {
			lines.push('_(no patch — binary or too large)_');
			continue;
		}
		let patch = f.patch;
		if (patch.length > MAX_PATCH_CHARS_PER_FILE) {
			patch = patch.slice(0, MAX_PATCH_CHARS_PER_FILE) + `\n… (truncated ${patch.length - MAX_PATCH_CHARS_PER_FILE} chars)`;
		}
		if (totalChars + patch.length > MAX_TOTAL_PATCH_CHARS) {
			lines.push('_(patch elided — total budget exceeded)_');
			continue;
		}
		totalChars += patch.length;
		lines.push('```diff');
		lines.push(patch);
		lines.push('```');
	}
	if (files.length > trimmedFiles.length) {
		lines.push('');
		lines.push(`_(${files.length - trimmedFiles.length} additional file(s) omitted from this prompt)_`);
	}
	lines.push('');
	lines.push('Produce the chapters JSON now.');
	return lines.join('\n');
}

function extractUsage(json: unknown): TourTokenUsage | undefined {
	if (!json || typeof json !== 'object') {
		return undefined;
	}
	const usage = (json as { usage?: unknown }).usage;
	if (!usage || typeof usage !== 'object') {
		return undefined;
	}
	const u = usage as Record<string, unknown>;
	const num = (v: unknown): number | undefined =>
		typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : undefined;
	const inputTokens = num(u.input_tokens) ?? 0;
	const outputTokens = num(u.output_tokens) ?? 0;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens: num(u.cache_read_input_tokens),
		cacheCreationTokens: num(u.cache_creation_input_tokens),
	};
}

function extractText(json: unknown): string | undefined {
	if (!json || typeof json !== 'object') {
		return undefined;
	}
	const content = (json as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
			const text = (block as { text?: unknown }).text;
			if (typeof text === 'string') {
				parts.push(text);
			}
		}
	}
	return parts.length > 0 ? parts.join('\n') : undefined;
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;
const OPEN_FENCE_RE = /```(?:json)?\s*/;

/**
 * Pull the chapter JSON-array entries out of a possibly-incomplete
 * model response. Robust to:
 *   - prose before/after the JSON
 *   - opening fence without a closing fence (streaming or
 *     truncated-by-max_tokens responses)
 *   - the array still being open (no closing `]`)
 *   - a partial last object (we just stop at the first
 *     unbalanced `{`)
 *
 * Returns the raw object array (not validated `Chapter`s — the
 * caller normalises them).
 */
function extractChapterObjects(text: string): readonly Record<string, unknown>[] {
	// Prefer fenced content if a complete fence pair exists; fall
	// back to "after the opening fence" so we still find content
	// when the response was truncated mid-JSON.
	let body: string;
	const fenced = FENCE_RE.exec(text);
	if (fenced) {
		body = fenced[1];
	} else {
		const open = OPEN_FENCE_RE.exec(text);
		body = open ? text.slice(open.index + open[0].length) : text;
	}

	// Locate the chapters array opening, allowing whitespace.
	const arrayMatch = /"chapters"\s*:\s*\[/.exec(body);
	if (!arrayMatch) {
		return [];
	}
	let i = arrayMatch.index + arrayMatch[0].length;

	const chapters: Record<string, unknown>[] = [];
	while (i < body.length) {
		// Skip whitespace and commas between objects.
		while (i < body.length && /[\s,]/.test(body[i])) {
			i++;
		}
		if (i >= body.length || body[i] === ']') {
			break;
		}
		if (body[i] !== '{') {
			break;
		}
		// Brace-balanced scan, respecting strings + escapes, to find
		// the end of the next chapter object.
		const start = i;
		let depth = 0;
		let inString = false;
		let escaped = false;
		while (i < body.length) {
			const c = body[i];
			if (escaped) {
				escaped = false;
			} else if (inString) {
				if (c === '\\') {
					escaped = true;
				} else if (c === '"') {
					inString = false;
				}
			} else if (c === '"') {
				inString = true;
			} else if (c === '{') {
				depth++;
			} else if (c === '}') {
				depth--;
				if (depth === 0) {
					i++;
					break;
				}
			}
			i++;
		}
		if (depth !== 0) {
			// Last object is incomplete — bail. (We may have collected
			// earlier complete objects; return those.)
			break;
		}
		try {
			const obj = JSON.parse(body.slice(start, i)) as Record<string, unknown>;
			if (obj && typeof obj === 'object') {
				chapters.push(obj);
			}
		} catch {
			// Stop at the first unparseable object so we don't drift.
			break;
		}
	}
	return chapters;
}

function parseChaptersJson(text: string, files: readonly PullRequestFile[]): readonly Chapter[] | undefined {
	const result = parseChaptersStreaming(text, files);
	return result.length === 0 ? undefined : result;
}

/**
 * Same shape as `parseChaptersJson` but always returns an array
 * (possibly empty). Safe to call on partial / streaming text.
 */
export function parseChaptersStreaming(text: string, files: readonly PullRequestFile[]): readonly Chapter[] {
	const knownPaths = new Set(files.map(f => f.path));
	const chaptersIn = extractChapterObjects(text);
	const out: Chapter[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < chaptersIn.length; i++) {
		const c = chaptersIn[i];
		if (!c || typeof c !== 'object') {
			continue;
		}
		const obj = c as Record<string, unknown>;
		const title = typeof obj.title === 'string' ? obj.title.trim() : '';
		const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
		if (!title) {
			continue;
		}
		const filesArr = Array.isArray(obj.files)
			? obj.files.filter((p): p is string => typeof p === 'string').filter(p => knownPaths.has(p))
			: [];
		if (filesArr.length === 0) {
			continue;
		}
		const bullets = Array.isArray(obj.bullets)
			? obj.bullets.filter((b): b is string => typeof b === 'string').slice(0, 6)
			: [];
		let id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `chapter-${i + 1}`;
		while (seenIds.has(id)) {
			id = `${id}-${i + 1}`;
		}
		seenIds.add(id);
		const sensitive = obj.sensitive === true;
		const sensitiveReason = typeof obj.sensitiveReason === 'string' && obj.sensitiveReason.trim()
			? obj.sensitiveReason.trim()
			: undefined;
		const diffFile = typeof obj.diffFile === 'string' && knownPaths.has(obj.diffFile)
			? obj.diffFile
			: filesArr[0];
		const plus = typeof obj.plus === 'number' && Number.isFinite(obj.plus) ? Math.max(0, Math.trunc(obj.plus)) : 0;
		const minus = typeof obj.minus === 'number' && Number.isFinite(obj.minus) ? Math.max(0, Math.trunc(obj.minus)) : 0;
		const dependsOn = parseDependsOn(obj.dependsOn);
		const kind = parseChapterKind(obj.kind, filesArr);
		const chips = parseChips(obj.chips, filesArr);
		out.push({
			id,
			title,
			summary,
			bullets,
			files: filesArr,
			plus,
			minus,
			sensitive,
			sensitiveReason: sensitive ? sensitiveReason : undefined,
			diffFile,
			dependsOn,
			kind,
			chips,
		});
	}
	return out;
}

/**
 * Wrap the model's chapters with a synthetic Coverage chapter when
 * any PR files are uncovered. Covered = referenced by at least one
 * model-generated chapter's `files` list. Coverage is file-level
 * because chapters carry file-level membership; partial-line
 * coverage isn't a thing yet (would require a `lines` field per
 * chapter, plus the model returning per-chapter line ranges).
 *
 * Returns the input list when every PR file is covered. The
 * Coverage chapter is always appended last so the storytelling
 * order isn't disrupted.
 */
export function wrapWithCoverage(chapters: readonly Chapter[], files: readonly PullRequestFile[]): readonly Chapter[] {
	if (chapters.length === 0) {
		return chapters;
	}
	const covered = new Set<string>();
	for (const chapter of chapters) {
		if (chapter.synthetic === 'coverage') {
			// Already wrapped (e.g. on cache rehydration); don't double up.
			return chapters;
		}
		for (const path of chapter.files) {
			covered.add(path);
		}
	}
	const uncovered: PullRequestFile[] = [];
	for (const file of files) {
		if (!covered.has(file.path)) {
			uncovered.push(file);
		}
	}
	if (uncovered.length === 0) {
		return chapters;
	}
	const plus = uncovered.reduce((n, f) => n + f.additions, 0);
	const minus = uncovered.reduce((n, f) => n + f.deletions, 0);
	const coverage: Chapter = {
		id: COVERAGE_CHAPTER_ID,
		title: localize('krt.tour.coverage.title', "Coverage"),
		summary: localize('krt.tour.coverage.summary', "Lines the tour didn't otherwise touch."),
		bullets: [],
		files: uncovered.map(f => f.path),
		plus,
		minus,
		sensitive: false,
		diffFile: uncovered[0]?.path,
		dependsOn: [],
		kind: 'glue',
		chips: [],
		synthetic: 'coverage',
	};
	return [...chapters, coverage];
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n) + '…';
}

/**
 * Accept either the new typed shape `[{id, kind}]` or the older
 * string-array form (in case the model regresses, or we hit a v1
 * cache that somehow slipped through). Unknown kinds collapse to
 * `'depends'` so we never drop edges silently.
 */
/**
 * Read the model's `kind` value, falling back to a path-based
 * heuristic so older v2 chapters (or model regressions) still
 * get a reasonable colour.
 */
function parseChapterKind(value: unknown, files: readonly string[]): ChapterKind {
	if (typeof value === 'string') {
		const lower = value.toLowerCase() as ChapterKind;
		if ((CHAPTER_KINDS as readonly string[]).includes(lower)) {
			return lower;
		}
	}
	// Heuristic fallback. If most files look like tests, call it
	// 'verify'. If most look like config, call it 'gate'. Else
	// 'glue' (boring connective tissue is the safest default).
	const looksLikeTest = (p: string) =>
		/(^|\/)__tests__\//.test(p) || /(^|\/)tests?\//.test(p) ||
		/[._]spec\.[a-z]+$/i.test(p) || /[._]test\.[a-z]+$/i.test(p) ||
		/\.test\.[a-z]+$/i.test(p);
	const looksLikeConfig = (p: string) =>
		/\.(ya?ml|toml|env|ini|properties)$/i.test(p) ||
		/(^|\/)(helm|deploy|kustomize)\//i.test(p) ||
		/(^|\/)(values|config|settings)[._-][^/]*$/i.test(p);
	const tests = files.filter(looksLikeTest).length;
	const configs = files.filter(looksLikeConfig).length;
	if (tests > 0 && tests >= files.length / 2) {
		return 'verify';
	}
	if (configs > 0 && configs >= files.length / 2) {
		return 'gate';
	}
	return 'glue';
}

/**
 * Drop chips referencing paths not in the chapter's file list and
 * coerce the side / severity into the canonical strings. Lines that
 * aren't positive integers are filtered out; the body is trimmed
 * and bounded so a runaway chip can't dominate the diff editor.
 */
function parseChips(value: unknown, chapterFiles: readonly string[]): readonly ChapterChip[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const allowed = new Set(chapterFiles);
	const knownSeverities = new Set<string>(['info', 'note', 'warn']);
	const out: ChapterChip[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const e = entry as Record<string, unknown>;
		const path = typeof e.path === 'string' ? e.path : '';
		if (!allowed.has(path)) {
			continue;
		}
		const lineRaw = typeof e.line === 'number' ? e.line : Number(e.line);
		const line = Number.isFinite(lineRaw) ? Math.trunc(lineRaw) : NaN;
		if (!Number.isFinite(line) || line < 1) {
			continue;
		}
		const sideRaw = typeof e.side === 'string' ? e.side.toUpperCase() : 'RIGHT';
		const side: ChapterChip['side'] = sideRaw === 'LEFT' ? 'LEFT' : 'RIGHT';
		const body = typeof e.body === 'string' ? e.body.trim().slice(0, 600) : '';
		if (!body) {
			continue;
		}
		const sevRaw = typeof e.severity === 'string' ? e.severity.toLowerCase() : 'info';
		const severity: ChipSeverity = knownSeverities.has(sevRaw) ? (sevRaw as ChipSeverity) : 'info';
		out.push({ path, line, side, body, severity });
	}
	return out;
}

function parseDependsOn(value: unknown): readonly DependsOnEdge[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const knownKinds = new Set<string>(EDGE_KINDS);
	const out: DependsOnEdge[] = [];
	for (const entry of value) {
		if (typeof entry === 'string' && entry.trim()) {
			out.push({ id: entry.trim(), kind: 'depends' });
			continue;
		}
		if (entry && typeof entry === 'object') {
			const e = entry as { id?: unknown; kind?: unknown };
			const id = typeof e.id === 'string' ? e.id.trim() : '';
			if (!id) {
				continue;
			}
			const kind: EdgeKind = typeof e.kind === 'string' && knownKinds.has(e.kind)
				? e.kind as EdgeKind
				: 'depends';
			out.push({ id, kind });
		}
	}
	return out;
}

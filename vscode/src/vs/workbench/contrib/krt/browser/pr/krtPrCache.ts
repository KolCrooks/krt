/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AutomationEvent, Comment, PullRequest, PullRequestFile } from '../../../../../platform/krt/common/krt.js';

export type SubMode = 'pr' | 'diff' | 'tour' | 'storyboard';

/**
 * Session-scoped PR cache. Reopening a PR (closing + reopening the
 * editor, switching tabs, opening from Search again) shouldn't re-shell
 * `gh api` if we already have fresh data — the gh CLI calls dominate
 * perceived latency. Posting a comment invalidates the entry.
 *
 * Lives at module scope on purpose: the cache must outlive any single
 * `KrtPullRequestEditorPane` instance (panes are recreated on each
 * editor input). All entries are dropped when the renderer reloads.
 */
export interface CachedPr {
	readonly pr: PullRequest;
	readonly fetchedAt: number;
	files?: readonly PullRequestFile[];
	reviewComments?: readonly Comment[];
	activity?: readonly AutomationEvent[];
	/**
	 * Last sub-mode the user was viewing for this PR. Persists across
	 * tab switches so the user lands back where they left off, not
	 * always at the PR overview.
	 */
	subMode?: SubMode;
}

/**
 * In-flight fetch dedup. If the user opens a PR, switches tabs while
 * its `getPullRequest` is mid-air, then comes back, the second
 * setInput should JOIN the in-flight promise instead of firing a
 * duplicate `gh` call. Cleared in the `.finally` of the fetch.
 */
const inFlightFetches = new Map<string, Promise<PullRequest>>();

export function getInFlight(url: string): Promise<PullRequest> | undefined {
	return inFlightFetches.get(url);
}

export function trackFetch<T extends Promise<PullRequest>>(url: string, p: T): T {
	inFlightFetches.set(url, p);
	p.finally(() => {
		// Clear only if this is still the tracked promise — a refresh
		// might race-replace it; we don't want to clear the new one.
		if (inFlightFetches.get(url) === p) {
			inFlightFetches.delete(url);
		}
	});
	return p;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 20;

const cache = new Map<string, CachedPr>();

/**
 * Returns the cached entry for `url` if present and fresh. Stale and
 * missing entries both return `undefined`. Touches LRU order so hits
 * stay alive longer.
 */
export function getCached(url: string): CachedPr | undefined {
	const entry = cache.get(url);
	if (!entry) {
		return undefined;
	}
	if (Date.now() - entry.fetchedAt > TTL_MS) {
		cache.delete(url);
		return undefined;
	}
	// Touch — Map preserves insertion order, so re-setting bumps LRU.
	cache.delete(url);
	cache.set(url, entry);
	return entry;
}

/**
 * Replaces the entry for `url`. Drops sub-resources (files, comments,
 * activity) — they belong to the prior fetch. The caller should call
 * `set*` for any sub-resources it already has loaded.
 */
export function putPr(url: string, pr: PullRequest): void {
	const entry: CachedPr = { pr, fetchedAt: Date.now() };
	cache.delete(url);
	cache.set(url, entry);
	evictIfFull();
}

export function putFiles(url: string, files: readonly PullRequestFile[]): void {
	const entry = cache.get(url);
	if (entry) {
		entry.files = files;
	}
}

export function putReviewComments(url: string, comments: readonly Comment[]): void {
	const entry = cache.get(url);
	if (entry) {
		entry.reviewComments = comments;
	}
}

export function putActivity(url: string, activity: readonly AutomationEvent[]): void {
	const entry = cache.get(url);
	if (entry) {
		entry.activity = activity;
	}
}

export function putSubMode(url: string, subMode: SubMode): void {
	const entry = cache.get(url);
	if (entry) {
		entry.subMode = subMode;
	}
}

/** Drops the entry for `url`. Used by Refresh and after posting a comment. */
export function invalidate(url: string): void {
	cache.delete(url);
}

function evictIfFull(): void {
	while (cache.size > MAX_ENTRIES) {
		// Map.keys() iterates in insertion order — the oldest is first.
		const first = cache.keys().next().value;
		if (first === undefined) {
			break;
		}
		cache.delete(first);
	}
}

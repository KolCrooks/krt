/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Chapter } from './krtTourTypes.js';

/**
 * Per-PR Tour chapter cache. Keyed by `{owner, repo, number, headSha}`
 * so a force-push or new commit invalidates the cache automatically
 * (a new `headSha` produces a new key). Storage payload carries a
 * version tag so we can re-shape `Chapter` later without false
 * cache hits.
 *
 * APPLICATION/MACHINE scope — same axis as the rest of KRT
 * persistence; Tour output is user-specific and not portable.
 */

// v3: chapters now carry a `kind` ('foundation' | 'replace' | ...)
// driving Storyboard card colour. Old v2 caches are dropped.
const CACHE_VERSION = 3;

interface CacheEnvelope {
	readonly v: number;
	readonly chapters: readonly Chapter[];
	readonly model: string;
	readonly generatedAt: string;
}

export function chaptersKey(owner: string, repo: string, number: number, headSha: string): string {
	return `krt.tour.${owner}/${repo}#${number}.${headSha}`;
}

export function readCachedChapters(
	storageService: IStorageService,
	owner: string,
	repo: string,
	number: number,
	headSha: string,
): { chapters: readonly Chapter[]; model: string; generatedAt: string } | undefined {
	const raw = storageService.get(chaptersKey(owner, repo, number, headSha), StorageScope.APPLICATION);
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<CacheEnvelope>;
		if (parsed.v !== CACHE_VERSION || !Array.isArray(parsed.chapters)) {
			return undefined;
		}
		// Phase 11 added `chips` to each chapter and the synthetic
		// Coverage chapter. Older v3 caches predate both — rather than
		// invalidate (and re-bill the user), normalise on read: missing
		// chip arrays become empty, missing `synthetic` stays
		// undefined so `=== 'coverage'` checks behave correctly.
		const normalised: Chapter[] = parsed.chapters.map(c => ({
			...c,
			chips: Array.isArray(c.chips) ? c.chips : [],
		}));
		return {
			chapters: normalised,
			model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
			generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
		};
	} catch {
		return undefined;
	}
}

export function writeCachedChapters(
	storageService: IStorageService,
	owner: string,
	repo: string,
	number: number,
	headSha: string,
	chapters: readonly Chapter[],
	model: string,
): void {
	const envelope: CacheEnvelope = {
		v: CACHE_VERSION,
		chapters,
		model,
		generatedAt: new Date().toISOString(),
	};
	storageService.store(
		chaptersKey(owner, repo, number, headSha),
		JSON.stringify(envelope),
		StorageScope.APPLICATION,
		StorageTarget.MACHINE,
	);
}

export function clearCachedChapters(
	storageService: IStorageService,
	owner: string,
	repo: string,
	number: number,
	headSha: string,
): void {
	storageService.remove(chaptersKey(owner, repo, number, headSha), StorageScope.APPLICATION);
}

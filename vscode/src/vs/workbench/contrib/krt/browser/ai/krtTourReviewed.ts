/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TourVariant } from './krtTourTypes.js';

/**
 * Per-PR Tour state: which chapters the reviewer has marked
 * reviewed, and which variant (Chapters / Reading) they prefer.
 *
 * Reviewed-chapter ids are kept per-PR (they don't outlive a
 * `headSha` change in spirit, but ids are unique per generation
 * so a stale entry does no harm — the variant just won't render
 * a checkmark for it). Variant is per-PR too because a reader
 * may prefer Reading on long PRs and Chapters on small ones.
 */

export function reviewedChaptersKey(owner: string, repo: string, number: number): string {
	return `krt.tour.reviewed.${owner}/${repo}#${number}`;
}

export function variantKey(owner: string, repo: string, number: number): string {
	return `krt.tour.variant.${owner}/${repo}#${number}`;
}

export function readReviewedChapters(storageService: IStorageService, owner: string, repo: string, number: number): ReadonlySet<string> {
	const raw = storageService.get(reviewedChaptersKey(owner, repo, number), StorageScope.APPLICATION);
	if (!raw) {
		return new Set();
	}
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return new Set(parsed.filter((s): s is string => typeof s === 'string'));
		}
	} catch {
		// fall through
	}
	return new Set();
}

export function writeReviewedChapters(storageService: IStorageService, owner: string, repo: string, number: number, ids: ReadonlySet<string>): void {
	storageService.store(
		reviewedChaptersKey(owner, repo, number),
		JSON.stringify([...ids]),
		StorageScope.APPLICATION,
		StorageTarget.MACHINE,
	);
}

export function readVariant(storageService: IStorageService, owner: string, repo: string, number: number): TourVariant {
	const raw = storageService.get(variantKey(owner, repo, number), StorageScope.APPLICATION);
	return raw === 'reading' ? 'reading' : 'chapters';
}

export function writeVariant(storageService: IStorageService, owner: string, repo: string, number: number, variant: TourVariant): void {
	storageService.store(variantKey(owner, repo, number), variant, StorageScope.APPLICATION, StorageTarget.MACHINE);
}

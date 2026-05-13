/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

/**
 * Per-PR mark-reviewed persistence. APPLICATION/MACHINE scope to
 * match the recent-PRs store; KRT is single-window/single-user so
 * profiles aren't a meaningful axis. Stored as `string[]` of paths
 * keyed by `krt.reviewed.{owner}/{repo}#{number}`.
 */
export function reviewedKey(owner: string, repo: string, number: number): string {
	return `krt.reviewed.${owner}/${repo}#${number}`;
}

export function readReviewedPaths(storageService: IStorageService, owner: string, repo: string, number: number): ReadonlySet<string> {
	const raw = storageService.get(reviewedKey(owner, repo, number), StorageScope.APPLICATION);
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

export function writeReviewedPaths(storageService: IStorageService, owner: string, repo: string, number: number, paths: ReadonlySet<string>): void {
	storageService.store(
		reviewedKey(owner, repo, number),
		JSON.stringify([...paths]),
		StorageScope.APPLICATION,
		StorageTarget.MACHINE,
	);
}

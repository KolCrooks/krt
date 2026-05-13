/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequest, RecentPullRequest } from '../../../../platform/krt/common/krt.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * Recent-PRs persistence. APPLICATION/MACHINE scope: KRT is single-
 * window single-user, profiles aren't a meaningful axis here. Cap at
 * 20 entries — the Search overlay's recent grid never wants more.
 */
export const KRT_RECENT_PRS_KEY = 'krt.recentPRs';
export const KRT_RECENT_PRS_CAP = 20;

export function readRecentPullRequests(storageService: IStorageService): readonly RecentPullRequest[] {
	const raw = storageService.get(KRT_RECENT_PRS_KEY, StorageScope.APPLICATION);
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function recordRecentPullRequest(storageService: IStorageService, pr: PullRequest): void {
	const entry: RecentPullRequest = {
		url: pr.url,
		owner: pr.owner,
		repo: pr.repo,
		number: pr.number,
		title: pr.title,
		openedAt: new Date().toISOString(),
	};
	const existing = readRecentPullRequests(storageService).filter(r => r.url !== entry.url);
	const next = [entry, ...existing].slice(0, KRT_RECENT_PRS_CAP);
	storageService.store(KRT_RECENT_PRS_KEY, JSON.stringify(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
}

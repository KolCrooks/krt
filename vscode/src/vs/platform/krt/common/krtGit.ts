/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface GitInfo {
	readonly version: string;
}

export type KrtVcs = 'git' | 'jj';

export interface JjStatus {
	readonly changeId: string;
	readonly description: string;
}

export interface GitStatus {
	readonly branch: string;
	readonly dirtyFileCount: number;
}

/**
 * Git/JJ-aware service. Lives in the main process so the renderer
 * doesn't need shell access; the renderer talks to it via the
 * `krt:git` IPC channel.
 *
 * Phase 8.6 surface: VCS detection, remote-url lookup, `git show
 * <ref>:<path>`, HEAD SHA lookup.
 *
 * Phase 8.7 surface (auto-switch on review): jj / git stash / fetch /
 * checkout / op-log so the workspace can be flipped to a PR's head
 * commit and rolled back later.
 */
export interface IKrtGitService {
	readonly _serviceBrand: undefined;

	detect(): Promise<GitInfo>;
	detectVcs(folderPath: string): Promise<KrtVcs | null>;
	getRemoteUrl(folderPath: string, remoteName?: string): Promise<string>;
	getHeadSha(folderPath: string): Promise<string>;
	/**
	 * `git merge-base <a> <b>` — the common ancestor of two SHAs.
	 * Phase 10/B uses this to find the SHA GitHub shows the PR's diff
	 * *against*, which is the merge base of `pr.head.sha` and
	 * `pr.base.sha` rather than `pr.base.sha` directly. When the PR's
	 * target branch has moved forward since the PR was opened,
	 * `pr.base.sha` is the *current* target-branch tip (far past the
	 * merge base) and diffing against it shows every commit that
	 * landed on the target branch as a "reverted" change in the PR.
	 */
	getMergeBase(folderPath: string, a: string, b: string): Promise<string>;
	showFile(folderPath: string, ref: string, path: string): Promise<string>;

	// --- Phase 8.7: status -----------------------------------------------
	getJjStatus(folderPath: string): Promise<JjStatus>;
	getGitStatus(folderPath: string): Promise<GitStatus>;

	// --- Phase 8.7: switch ops -------------------------------------------
	jjNew(folderPath: string, rev: string): Promise<void>;
	jjEdit(folderPath: string, changeId: string): Promise<void>;
	jjGitImport(folderPath: string): Promise<void>;
	getJjOpHead(folderPath: string): Promise<string>;
	jjOpRestore(folderPath: string, opId: string): Promise<void>;
	gitStashPush(folderPath: string, message: string): Promise<string>;
	gitCheckout(folderPath: string, ref: string): Promise<void>;
	gitFetchPullRequest(folderPath: string, prNumber: number): Promise<void>;
}

export const IKrtGitService = createDecorator<IKrtGitService>('krtGitService');

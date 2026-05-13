/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKrtGitService } from '../../../../../platform/krt/common/krtGit.js';
import { PullRequest } from '../../../../../platform/krt/common/krt.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ResumeToken } from './krtSwitchResume.js';
import { KrtPreFlight } from './krtVcs.js';
import { KrtWorkspace } from './krtWorkspaceRegistry.js';

export interface ISwitchDeps {
	readonly gitService: IKrtGitService;
	readonly logService: ILogService;
}

/**
 * Switches the workspace's working tree to the PR's head commit and
 * returns a `ResumeToken` recording how to roll back later.
 *
 * jj path: capture `preSwitchOpId`, fetch the PR ref into a persistent
 * remote-tracking ref (jj's `git import` ignores `FETCH_HEAD`), import
 * into jj's index, then `jj new <prHead>`.
 *
 * git path: if dirty, `git stash push --include-untracked` first; then
 * `git checkout <prHead>` (detached HEAD to keep the user's branch
 * list clean). `gh pr checkout` is an alternative for named branches
 * but isn't needed when we already have the head SHA in hand.
 *
 * Failures bubble up as `KrtError`. On any failure mid-switch the
 * caller should leave the resume token unwritten — the workspace is
 * in whatever state the failing shell call left it; the user gets the
 * error and can recover manually.
 */
export async function switchTo(
	deps: ISwitchDeps,
	workspace: KrtWorkspace,
	pr: PullRequest,
	preFlight: KrtPreFlight,
): Promise<ResumeToken> {
	const { gitService, logService } = deps;
	const switchedAt = new Date().toISOString();

	if (preFlight.vcs === 'jj') {
		const preSwitchOpId = await gitService.getJjOpHead(workspace.folderPath);
		await gitService.gitFetchPullRequest(workspace.folderPath, pr.number);
		await gitService.jjGitImport(workspace.folderPath);
		await gitService.jjNew(workspace.folderPath, pr.head.sha);
		logService.info(`[krt] jj switch to PR #${pr.number} @ ${pr.head.sha} (preSwitchOp=${preSwitchOpId})`);
		return {
			vcs: 'jj',
			workspaceFolderUri: workspace.folderUri,
			prUrl: pr.url,
			prNumber: pr.number,
			previousChangeId: preFlight.status.changeId,
			previousDescription: preFlight.status.description,
			preSwitchOpId,
			switchedAt,
		};
	}

	// git path
	const previousSha = await gitService.getHeadSha(workspace.folderPath);
	const previousBranch = preFlight.status.branch;
	let stashRef: string | undefined;
	let stashMessage: string | undefined;
	if (preFlight.status.dirtyFileCount > 0) {
		stashMessage = `krt: PR #${pr.number} @ ${switchedAt}`;
		stashRef = await gitService.gitStashPush(workspace.folderPath, stashMessage);
		logService.info(`[krt] git stash captured (${stashRef}) before switching to PR #${pr.number}`);
	}
	await gitService.gitFetchPullRequest(workspace.folderPath, pr.number);
	await gitService.gitCheckout(workspace.folderPath, pr.head.sha);
	logService.info(`[krt] git switch to PR #${pr.number} @ ${pr.head.sha} (previousBranch=${previousBranch})`);
	return {
		vcs: 'git',
		workspaceFolderUri: workspace.folderUri,
		prUrl: pr.url,
		prNumber: pr.number,
		previousBranch,
		previousSha,
		stashRef,
		stashMessage,
		switchedAt,
	};
}

/**
 * Reverses a previous `switchTo` using the stored resume token.
 *
 * jj: `jj op restore <preSwitchOpId>` rewinds the entire state. Any
 * commits the user made while reviewing are lost — v1's contract is
 * "review and return without modifying."
 *
 * git: `git checkout <previousBranch>`. The stash is left in place
 * intentionally — auto-popping after a return is too surprising and
 * the cleanup notification names the stash ref so the user can pop
 * manually when they're ready.
 */
export async function returnFrom(
	deps: ISwitchDeps,
	workspace: KrtWorkspace,
	token: ResumeToken,
): Promise<void> {
	const { gitService, logService } = deps;
	if (token.vcs === 'jj') {
		await gitService.jjOpRestore(workspace.folderPath, token.preSwitchOpId);
		logService.info(`[krt] jj op restore to ${token.preSwitchOpId} for workspace ${workspace.folderPath}`);
		return;
	}
	await gitService.gitCheckout(workspace.folderPath, token.previousBranch);
	logService.info(`[krt] git checkout ${token.previousBranch} for workspace ${workspace.folderPath}`);
}

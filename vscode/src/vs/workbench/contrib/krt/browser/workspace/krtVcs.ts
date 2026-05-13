/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitStatus, IKrtGitService, JjStatus, KrtVcs } from '../../../../../platform/krt/common/krtGit.js';
import { KrtWorkspace } from './krtWorkspaceRegistry.js';

/**
 * Pre-flight snapshot of a workspace's working-copy state. Phase 8.7
 * uses this to (1) decide which switch path to take (jj vs git, with
 * an optional stash) and (2) describe the current state in the
 * confirmation dialog so the user knows exactly what's being set
 * aside.
 *
 * The shape is a discriminated union on `vcs` rather than separate
 * `jj?` / `git?` fields so callers can't forget which side to read.
 */
export type KrtPreFlight =
	| { readonly vcs: 'jj'; readonly status: JjStatus }
	| { readonly vcs: 'git'; readonly status: GitStatus };

/**
 * Detects the workspace's VCS and fetches a pre-flight status in one
 * call. Returns `undefined` if the folder is neither jj- nor git-
 * managed (rare — the workspace registry rejects non-git folders at
 * Add time, so this is mostly a guard against the user deleting `.git`
 * between sessions).
 */
export async function getWorkspacePreFlight(
	gitService: IKrtGitService,
	workspace: KrtWorkspace,
): Promise<KrtPreFlight | undefined> {
	const vcs = await gitService.detectVcs(workspace.folderPath);
	if (!vcs) {
		return undefined;
	}
	return loadPreFlightForVcs(gitService, workspace.folderPath, vcs);
}

async function loadPreFlightForVcs(
	gitService: IKrtGitService,
	folderPath: string,
	vcs: KrtVcs,
): Promise<KrtPreFlight> {
	if (vcs === 'jj') {
		const status = await gitService.getJjStatus(folderPath);
		return { vcs, status };
	}
	const status = await gitService.getGitStatus(folderPath);
	return { vcs, status };
}

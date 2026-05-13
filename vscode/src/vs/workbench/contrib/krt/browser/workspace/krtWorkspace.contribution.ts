/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { isKrtError } from '../../../../../platform/krt/common/errors.js';
import { IKrtGitService } from '../../../../../platform/krt/common/krtGit.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IKrtSwitchResumeService, KrtSwitchResumeService } from './krtSwitchResume.js';
import { IKrtWorkspaceRegistry, KrtWorkspaceRegistry, folderPathToUri, parseGithubRemoteUrl } from './krtWorkspaceRegistry.js';

import './krtGitContentProvider.js';

const KRT_CATEGORY = localize2('krt.category', "KRT");

registerSingleton(IKrtWorkspaceRegistry, KrtWorkspaceRegistry, InstantiationType.Eager);
registerSingleton(IKrtSwitchResumeService, KrtSwitchResumeService, InstantiationType.Delayed);

class KrtAddWorkspaceAction extends Action2 {
	static readonly ID = 'krt.workspace.add';

	constructor() {
		super({
			id: KrtAddWorkspaceAction.ID,
			title: localize2('krt.workspace.add.title', "Add Workspace…"),
			category: KRT_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialog = accessor.get(IFileDialogService);
		const gitService = accessor.get(IKrtGitService);
		const registry = accessor.get(IKrtWorkspaceRegistry);
		const notification = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);

		const picked = await fileDialog.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: localize('krt.workspace.add.openLabel', "Add Workspace"),
			title: localize('krt.workspace.add.title.dialog', "Add a local clone as a KRT workspace"),
		});
		if (!picked || picked.length === 0) {
			return;
		}
		const folderUri = picked[0];
		const folderPath = folderUri.fsPath;
		try {
			const remoteUrl = await gitService.getRemoteUrl(folderPath, 'origin');
			const parsed = parseGithubRemoteUrl(remoteUrl);
			if (!parsed) {
				notification.notify({
					severity: Severity.Warning,
					message: localize(
						'krt.workspace.add.notGithub',
						"`{0}` doesn't look like a GitHub remote — KRT only supports GitHub for now.",
						remoteUrl,
					),
				});
				return;
			}
			registry.add({
				folderUri: folderPathToUri(folderPath),
				folderPath,
				owner: parsed.owner,
				repo: parsed.repo,
				remoteUrl,
				addedAt: new Date().toISOString(),
			});
			notification.notify({
				severity: Severity.Info,
				message: localize(
					'krt.workspace.add.added',
					"Added {0}/{1} ({2}) to KRT workspaces.",
					parsed.owner,
					parsed.repo,
					folderPath,
				),
			});
		} catch (err) {
			logService.warn('[krt] add workspace failed', err);
			const message = isKrtError(err) ? `${err.message} — ${err.hint}` : String(err);
			notification.notify({ severity: Severity.Error, message });
		}
	}
}

class KrtRemoveWorkspaceAction extends Action2 {
	static readonly ID = 'krt.workspace.remove';

	constructor() {
		super({
			id: KrtRemoveWorkspaceAction.ID,
			title: localize2('krt.workspace.remove.title', "Remove Workspace…"),
			category: KRT_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const registry = accessor.get(IKrtWorkspaceRegistry);
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);

		const all = registry.getAll();
		if (all.length === 0) {
			notification.notify({
				severity: Severity.Info,
				message: localize('krt.workspace.remove.empty', "No KRT workspaces are registered."),
			});
			return;
		}
		const picked = await quickInput.pick(
			all.map(w => ({
				label: `${w.owner}/${w.repo}`,
				description: w.folderPath,
				workspace: w,
			})),
			{
				placeHolder: localize('krt.workspace.remove.placeholder', "Pick a workspace to remove"),
			},
		);
		if (!picked) {
			return;
		}
		registry.remove(picked.workspace.folderUri);
		notification.notify({
			severity: Severity.Info,
			message: localize(
				'krt.workspace.remove.removed',
				"Removed {0}/{1} from KRT workspaces.",
				picked.workspace.owner,
				picked.workspace.repo,
			),
		});
	}
}

/**
 * Phase 8.7 escape hatch — clears the resume token without flipping
 * the working copy. Use when an in-flight switch left state we can't
 * cleanly reverse, or when the persisted token shape predates a code
 * change. Doesn't run any shell calls.
 */
class KrtForgetSwitchAction extends Action2 {
	static readonly ID = 'krt.workspace.forgetSwitch';

	constructor() {
		super({
			id: KrtForgetSwitchAction.ID,
			title: localize2('krt.workspace.forgetSwitch.title', "Forget Active PR Switch"),
			category: KRT_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const resume = accessor.get(IKrtSwitchResumeService);
		const notification = accessor.get(INotificationService);
		const active = resume.getActive();
		if (!active) {
			notification.notify({
				severity: Severity.Info,
				message: localize('krt.workspace.forgetSwitch.none', "No active PR switch to forget."),
			});
			return;
		}
		resume.clear();
		notification.notify({
			severity: Severity.Info,
			message: localize(
				'krt.workspace.forgetSwitch.cleared',
				"Cleared switch token for PR #{0}. The working copy was NOT changed; you may need to clean up manually.",
				active.prNumber,
			),
		});
	}
}

registerAction2(KrtAddWorkspaceAction);
registerAction2(KrtRemoveWorkspaceAction);
registerAction2(KrtForgetSwitchAction);

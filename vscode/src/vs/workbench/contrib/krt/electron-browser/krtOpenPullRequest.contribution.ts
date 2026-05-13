/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { parsePullRequestUrl, RecentPullRequest } from '../../../../platform/krt/common/krt.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { KrtPullRequestEditorInput } from '../browser/pr/krtPullRequestEditorInput.js';
import { readRecentPullRequests } from '../browser/krtRecentPullRequests.js';

const KRT_CATEGORY = localize2('krt.category', "KRT");

interface RecentPickItem extends IQuickPickItem {
	readonly recent: RecentPullRequest;
}

class KrtOpenPullRequestAction extends Action2 {

	static readonly ID = 'krt.openPullRequest';

	constructor() {
		super({
			id: KrtOpenPullRequestAction.ID,
			title: localize2('krt.openPullRequest.title', "Open PR"),
			category: KRT_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const storageService = accessor.get(IStorageService);
		const editorService = accessor.get(IEditorService);
		const logService = accessor.get(ILogService);

		const url = await pickUrl(quickInputService, readRecentPullRequests(storageService));
		if (!url) {
			return;
		}

		const parsed = parsePullRequestUrl(url);
		if (!parsed) {
			logService.warn(`[krt] open-pr: not a recognised GitHub PR URL: ${url}`);
			await quickInputService.input({
				prompt: localize('krt.openPullRequest.badUrl', "Not a recognised GitHub PR URL. Expected https://github.com/owner/repo/pull/123"),
				value: url,
				ignoreFocusLost: true,
			});
			return;
		}

		const existingTitle = readRecentPullRequests(storageService).find(r => r.url === url)?.title;
		const input = new KrtPullRequestEditorInput(url, parsed.owner, parsed.repo, parsed.number, existingTitle);
		await editorService.openEditor(input, { pinned: true });
	}
}

async function pickUrl(quickInputService: IQuickInputService, recent: readonly RecentPullRequest[]): Promise<string | undefined> {
	if (recent.length === 0) {
		return quickInputService.input({
			prompt: localize('krt.openPullRequest.prompt', "Paste a GitHub PR URL"),
			placeHolder: 'https://github.com/owner/repo/pull/123',
			ignoreFocusLost: true,
		});
	}

	const items: (RecentPickItem | IQuickPickItem)[] = recent.map<RecentPickItem>(r => ({
		label: `$(git-pull-request) ${r.owner}/${r.repo}#${r.number}`,
		description: r.title,
		recent: r,
	}));
	items.push({ label: localize('krt.openPullRequest.enterUrl', "Enter PR URL…"), alwaysShow: true });

	const picked = await quickInputService.pick(items, {
		placeHolder: localize('krt.openPullRequest.recentPlaceholder', "Recent PRs — or pick 'Enter PR URL…'"),
		ignoreFocusLost: true,
	});
	if (!picked) {
		return undefined;
	}
	if (isRecentPick(picked)) {
		return picked.recent.url;
	}
	return quickInputService.input({
		prompt: localize('krt.openPullRequest.prompt', "Paste a GitHub PR URL"),
		placeHolder: 'https://github.com/owner/repo/pull/123',
		ignoreFocusLost: true,
	});
}

function isRecentPick(item: IQuickPickItem): item is RecentPickItem {
	return (item as RecentPickItem).recent !== undefined;
}

registerAction2(KrtOpenPullRequestAction);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

// KRT contribution sub-modules — each registers its own workbench contribution
// on import. Keep this list flat so each piece is easy to find.
import './theme/krtAccent.contribution.js';
import './chrome/krtChrome.contribution.js';
import './tabs/krtTabs.contribution.js';
import './pr/krtPullRequestEditor.contribution.js';
import './search/krtSearch.contribution.js';
import './ai/krtAi.contribution.js';
import './workspace/krtWorkspace.contribution.js';

class KrtStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.krt.statusBar';

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
	) {
		super();
		this._register(statusbarService.addEntry(
			{
				name: localize('krt.statusBar.name', "KRT"),
				text: 'KRT',
				ariaLabel: localize('krt.statusBar.ariaLabel', "KRT"),
			},
			KrtStatusBarContribution.ID,
			StatusbarAlignment.LEFT,
			1000,
		));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(KrtStatusBarContribution, LifecyclePhase.Restored);

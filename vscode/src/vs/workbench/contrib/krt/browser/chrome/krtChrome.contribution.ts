/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';

// KRT chrome defaults. Three groups:
//   1. Title-bar / menu chrome — strip the upstream menu/command-center
//      clutter so the title bar stays minimal. On macOS the OS draws
//      traffic lights regardless. Phase 3 swaps the centre region for a
//      `repo · branch` badge once there's PR data to drive it.
//   2. Density — compact tabs, smaller font in the editor, panel docked
//      vertically on the right (matches the demo's review-tool layout
//      where editor takes the centre and the terminal slides in from
//      the right rather than the bottom).
//   3. Disable AI feature surfaces inherited from upstream — KRT ships
//      with no Copilot UI; the AI features we do expose live under
//      `vs/workbench/contrib/krt/browser/ai/` behind their own settings.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		// Chrome
		'window.menuBarVisibility': 'hidden',
		'window.commandCenter': false,
		'workbench.layoutControl.enabled': false,
		// Density / layout — tracks the demo at design/kol-s-review-tool/
		'workbench.editor.tabSizing': 'compact',
		'workbench.panel.defaultLocation': 'right',
		'workbench.activityBar.location': 'default',
		'editor.fontSize': 13,
		'editor.lineHeight': 1.55,
		// AI / Copilot
		'chat.disableAIFeatures': true,
		'chat.agentsControl.enabled': 'hidden',
	},
}]);

// Unbind the upstream `Cmd+Shift+P` / `Ctrl+Shift+P` chord for the command
// palette. The action stays registered and F1 stays bound — power users
// keep a fallback during dogfooding. Phase 4 will rebind ⌘K to PR search;
// ⌘⇧P stays unclaimed in the meantime.
KeybindingsRegistry.registerKeybindingRule({
	id: '-workbench.action.showCommands',
	weight: KeybindingWeight.WorkbenchContrib + 1,
	when: undefined,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP,
});

// Phase 9 step 7 — ensure the Extensions view-container is pinned in
// the activity bar. Some KRT installs (and the demo Copilot strip
// before it) ended up with `workbench.activity.pinnedViewlets2` not
// containing Extensions, so the icon never appeared on the rail. We
// rewrite the cached state on each launch to add the entry if
// missing; existing entries are left alone.
const PINNED_VIEWLETS_KEY = 'workbench.activity.pinnedViewlets2';
const EXTENSIONS_VIEWLET_ID = 'workbench.view.extensions';

interface CachedPinnedViewContainer {
	id: string;
	pinned?: boolean;
	visible?: boolean;
	order?: number;
}

class KrtPinExtensionsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.krt.pinExtensions';

	constructor(
		@IStorageService storageService: IStorageService,
		@ILogService logService: ILogService,
	) {
		super();
		try {
			const raw = storageService.get(PINNED_VIEWLETS_KEY, StorageScope.PROFILE);
			const parsed: CachedPinnedViewContainer[] = raw ? JSON.parse(raw) : [];
			if (!Array.isArray(parsed)) {
				return;
			}
			const existing = parsed.find(p => p && p.id === EXTENSIONS_VIEWLET_ID);
			if (existing) {
				if (existing.pinned !== false && existing.visible !== false) {
					return;
				}
				existing.pinned = true;
				existing.visible = true;
			} else {
				parsed.push({
					id: EXTENSIONS_VIEWLET_ID,
					pinned: true,
					visible: true,
					order: parsed.length + 10,
				});
			}
			storageService.store(PINNED_VIEWLETS_KEY, JSON.stringify(parsed), StorageScope.PROFILE, StorageTarget.USER);
			logService.info('[krt] pinned Extensions view container in activity bar');
		} catch (err) {
			logService.warn('[krt] failed to ensure Extensions is pinned', err);
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(KrtPinExtensionsContribution, LifecyclePhase.Restored);

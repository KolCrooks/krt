/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';

// KRT design tokens — set on the workbench root so KRT-owned components
// (PR pane, search overlay, tabs, storyboard cards, …) can read them
// directly via `var(--krt-*)`. Mirrors `design/kol-s-review-tool/project/
// styles.css`.
const KRT_DESIGN_TOKENS: ReadonlyArray<readonly [string, string]> = [
	// Indigo accent.
	['--krt-accent', 'oklch(0.5 0.18 280)'],
	['--krt-accent-2', 'oklch(0.62 0.16 280)'],
	['--krt-accent-soft', 'oklch(0.96 0.03 280)'],
	['--krt-accent-line', 'oklch(0.85 0.07 280)'],
	// Compact density — row height + radii. Used inside KRT components
	// only; upstream config keys (`workbench.editor.tabSizing` etc.)
	// cover Monaco / activity-bar density.
	['--krt-row-h', '30px'],
	['--krt-radius', '8px'],
	['--krt-radius-sm', '6px'],
	// Add / del hues for diff chips + storyboard nodes.
	['--krt-add', 'oklch(0.55 0.13 145)'],
	['--krt-add-bg', 'oklch(0.96 0.04 145)'],
	['--krt-del', 'oklch(0.55 0.18 25)'],
	['--krt-del-bg', 'oklch(0.96 0.03 25)'],
];

class KrtAccentContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.krt.accent';

	constructor() {
		super();
		const root = mainWindow.document.documentElement;
		for (const [name, value] of KRT_DESIGN_TOKENS) {
			root.style.setProperty(name, value);
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(KrtAccentContribution, LifecyclePhase.Restored);

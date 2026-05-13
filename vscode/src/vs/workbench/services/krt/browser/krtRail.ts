/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './krtRail.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createKrtRailIcon, KrtRailIconName } from './krtRailIcons.js';

interface KrtRailButton {
	readonly key: 'search' | 'pr' | 'review' | 'editor' | 'gear';
	readonly icon: KrtRailIconName;
	readonly tooltip: string;
	readonly onClick: (commandService: ICommandService) => void;
}

const KRT_RAIL_BUTTONS: ReadonlyArray<KrtRailButton> = [
	{
		key: 'search',
		icon: 'search',
		tooltip: localize('krt.rail.search', "Search PRs"),
		// Opens the KRT search overlay (same as ⌘K).
		onClick: commandService => { commandService.executeCommand('krt.search'); },
	},
	{
		key: 'pr',
		icon: 'pr',
		tooltip: localize('krt.rail.pr', "PR view"),
		// Until Phase 5 can set the active tab's view mode, treat the PR
		// icon as "open a PR" — same action as F1 → KRT: Open PR.
		onClick: commandService => { commandService.executeCommand('krt.openPullRequest'); },
	},
	{
		key: 'review',
		icon: 'review',
		tooltip: localize('krt.rail.review', "Review"),
		// Phase 6 sets the active PR tab's view mode.
		onClick: () => { /* no-op until Phase 6 */ },
	},
	{
		key: 'editor',
		icon: 'code',
		tooltip: localize('krt.rail.editor', "Editor"),
		// Phase 9 sets the active PR tab's view mode.
		onClick: () => { /* no-op until Phase 9 */ },
	},
	{
		key: 'gear',
		icon: 'gear',
		tooltip: localize('krt.rail.settings', "Settings"),
		onClick: commandService => { commandService.executeCommand('workbench.action.openSettings2'); },
	},
];

/**
 * Renders the KRT 4-button left rail (Search / PR / Review / Editor) plus a
 * Settings gear pinned to the bottom. Owns its DOM and disposables; expects
 * to be the sole child renderer of the activity bar's content area.
 */
export class KrtRail extends Disposable {

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.render(parent);
	}

	private render(parent: HTMLElement): void {
		const root = append(parent, $('.krt-rail'));

		for (const btn of KRT_RAIL_BUTTONS) {
			if (btn.key === 'gear') {
				append(root, $('.krt-rail-spacer'));
			}
			this.appendButton(root, btn);
		}
	}

	private appendButton(parent: HTMLElement, btn: KrtRailButton): void {
		const el = append(parent, $('button.krt-rail-btn'));
		el.setAttribute('type', 'button');
		el.setAttribute('aria-label', btn.tooltip);
		el.dataset.krtRailKey = btn.key;
		el.appendChild(createKrtRailIcon(btn.icon));

		const tip = append(el, $('span.krt-rail-tooltip'));
		tip.textContent = btn.tooltip;

		this._register(addDisposableListener(el, EventType.CLICK, () => btn.onClick(this.commandService)));
	}
}

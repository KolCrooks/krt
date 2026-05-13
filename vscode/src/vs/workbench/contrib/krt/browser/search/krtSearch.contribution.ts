/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IKrtSearchService } from './krtSearchService.js';
import { KrtSearchService } from './krtSearchOverlay.js';

const KRT_CATEGORY = localize2('krt.category', "KRT");

registerSingleton(IKrtSearchService, KrtSearchService, InstantiationType.Delayed);

class KrtSearchAction extends Action2 {

	static readonly ID = 'krt.search';

	constructor() {
		super({
			id: KrtSearchAction.ID,
			title: localize2('krt.search.title', "Search PRs"),
			category: KRT_CATEGORY,
			f1: true,
			keybinding: {
				// Bumped above WorkbenchContrib so the resolver's "last match
				// wins" logic in `_findCommand` picks this single-key binding
				// over the upstream `cmd+K cmd+*` chord prefixes that would
				// otherwise force the dispatcher to wait for a second key.
				weight: KeybindingWeight.ExternalExtension + 1000,
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IKrtSearchService).toggle();
	}
}

registerAction2(KrtSearchAction);

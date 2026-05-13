/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IKrtSearchService = createDecorator<IKrtSearchService>('krtSearchService');

/**
 * Workbench-level service that owns the Search overlay. The overlay
 * is a singleton fixed-position modal lazily mounted into the
 * workbench root the first time `open()` is called. `close()` is a
 * no-op when the overlay is not shown.
 */
export interface IKrtSearchService {
	readonly _serviceBrand: undefined;
	open(): void;
	close(): void;
	toggle(): void;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IKrtAiClient } from '../../../../platform/krt/common/krt.js';

// @ts-expect-error: interface is implemented via proxy
class KrtAiClient implements IKrtAiClient {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		return ProxyChannel.toService<IKrtAiClient>(mainProcessService.getChannel('krt:ai'));
	}
}

registerSingleton(IKrtAiClient, KrtAiClient, InstantiationType.Delayed);

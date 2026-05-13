/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IKrtGitService } from '../../../../platform/krt/common/krtGit.js';

// @ts-expect-error: interface is implemented via proxy
class KrtGitClient implements IKrtGitService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		return ProxyChannel.toService<IKrtGitService>(mainProcessService.getChannel('krt:git'));
	}
}

registerSingleton(IKrtGitService, KrtGitClient, InstantiationType.Delayed);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import {
	clearAnthropicKey,
	DEFAULT_BASE_URL,
	readBaseUrl,
	readModel,
	readPromptCaching,
	SUPPORTED_MODELS,
	writeAnthropicKey,
	writeBaseUrl,
	writeModel,
	writePromptCaching,
} from './krtAiSettings.js';
import { ITourGenerator, TourGenerator } from './krtTourGenerator.js';

const KRT_CATEGORY = localize2('krt.category', "KRT");

registerSingleton(ITourGenerator, TourGenerator, InstantiationType.Delayed);

class KrtConfigureAnthropicKeyAction extends Action2 {
	static readonly ID = 'krt.configureAnthropicKey';

	constructor() {
		super({
			id: KrtConfigureAnthropicKeyAction.ID,
			title: localize2('krt.ai.configureKey.title', "Configure Anthropic API Key…"),
			category: KRT_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const secretStorageService = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);
		const openerService = accessor.get(IOpenerService);

		const box = quickInputService.createInputBox();
		box.title = localize('krt.ai.configureKey.inputTitle', "Anthropic API Key");
		box.prompt = localize('krt.ai.configureKey.inputPrompt', "Paste your Anthropic API key. Stored encrypted in the OS keychain. Leave blank to clear.");
		box.placeholder = 'sk-ant-…';
		box.password = true;
		box.ignoreFocusOut = true;
		box.buttons = [{
			iconClass: ThemeIcon.asClassName(Codicon.linkExternal),
			tooltip: localize('krt.ai.configureKey.getKey', "Get API Key"),
		}];

		const value = await new Promise<string | undefined>(resolve => {
			let accepted = false;
			const disposables = new DisposableStore();
			disposables.add(box.onDidTriggerButton(() => {
				openerService.open(URI.parse('https://platform.claude.com/settings/workspaces/default/keys'));
			}));
			disposables.add(box.onDidAccept(() => {
				accepted = true;
				resolve(box.value);
				box.hide();
			}));
			disposables.add(box.onDidHide(() => {
				if (!accepted) {
					resolve(undefined);
				}
				disposables.dispose();
				box.dispose();
			}));
			box.show();
		});

		if (value === undefined) {
			return;
		}
		try {
			if (value.trim() === '') {
				await clearAnthropicKey(secretStorageService);
				notificationService.info(localize('krt.ai.keyCleared', "Anthropic API key cleared."));
				return;
			}
			await writeAnthropicKey(secretStorageService, value);
			notificationService.info(localize('krt.ai.keySaved', "Anthropic API key saved."));
		} catch (e) {
			logService.error('[krt] failed to store Anthropic key', e);
			notificationService.error(localize('krt.ai.keySaveFailed', "Couldn't save the Anthropic API key."));
		}
	}
}

class KrtSelectAnthropicModelAction extends Action2 {
	static readonly ID = 'krt.selectAnthropicModel';

	constructor() {
		super({
			id: KrtSelectAnthropicModelAction.ID,
			title: localize2('krt.ai.selectModel.title', "Select Anthropic Model…"),
			category: KRT_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const storageService = accessor.get(IStorageService);
		const notificationService = accessor.get(INotificationService);

		const current = readModel(storageService);
		interface ModelItem extends IQuickPickItem {
			readonly id: string;
		}
		const items: ModelItem[] = SUPPORTED_MODELS.map(m => ({
			id: m.id,
			label: m.id === current ? `${m.label} ✓` : m.label,
			description: m.id,
			detail: m.description,
		}));
		const picked = await quickInputService.pick<ModelItem>(items, {
			title: localize('krt.ai.selectModel.pickTitle', "Anthropic Model"),
			placeHolder: localize('krt.ai.selectModel.pickPlaceholder', "Choose the model used for AI Tour generation"),
		});
		if (!picked) {
			return;
		}
		writeModel(storageService, picked.id);
		notificationService.info(localize('krt.ai.modelSet', "Model set to {0}.", picked.id));
	}
}

class KrtTogglePromptCachingAction extends Action2 {
	static readonly ID = 'krt.togglePromptCaching';

	constructor() {
		super({
			id: KrtTogglePromptCachingAction.ID,
			title: localize2('krt.ai.togglePromptCache.title', "Toggle Anthropic Prompt Caching"),
			category: KRT_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		const notificationService = accessor.get(INotificationService);
		const next = !readPromptCaching(storageService);
		writePromptCaching(storageService, next);
		notificationService.info(next
			? localize('krt.ai.promptCacheOn', "Prompt caching enabled.")
			: localize('krt.ai.promptCacheOff', "Prompt caching disabled."));
	}
}

class KrtConfigureAnthropicBaseUrlAction extends Action2 {
	static readonly ID = 'krt.configureAnthropicBaseUrl';

	constructor() {
		super({
			id: KrtConfigureAnthropicBaseUrlAction.ID,
			title: localize2('krt.ai.configureBaseUrl.title', "Configure Anthropic Base URL…"),
			category: KRT_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const storageService = accessor.get(IStorageService);
		const notificationService = accessor.get(INotificationService);

		const current = readBaseUrl(storageService);
		const value = await quickInputService.input({
			title: localize('krt.ai.configureBaseUrl.inputTitle', "Anthropic Base URL"),
			prompt: localize(
				'krt.ai.configureBaseUrl.inputPrompt',
				"Override the Anthropic API base URL for an org-specific endpoint or proxy. The generator appends /v1/messages. Leave blank to reset to the default ({0}).",
				DEFAULT_BASE_URL,
			),
			value: current,
			placeHolder: DEFAULT_BASE_URL,
			ignoreFocusLost: true,
			validateInput: async input => {
				const t = input.trim();
				if (t === '') {
					return undefined;
				}
				if (!/^https?:\/\//i.test(t)) {
					return { content: localize('krt.ai.configureBaseUrl.invalid', "Must be an http(s):// URL."), severity: 3 };
				}
				return undefined;
			},
		});
		if (value === undefined) {
			return;
		}
		writeBaseUrl(storageService, value);
		const effective = readBaseUrl(storageService);
		notificationService.info(effective === DEFAULT_BASE_URL
			? localize('krt.ai.baseUrlReset', "Anthropic base URL reset to default ({0}).", DEFAULT_BASE_URL)
			: localize('krt.ai.baseUrlSet', "Anthropic base URL set to {0}.", effective));
	}
}

registerAction2(KrtConfigureAnthropicKeyAction);
registerAction2(KrtConfigureAnthropicBaseUrlAction);
registerAction2(KrtSelectAnthropicModelAction);
registerAction2(KrtTogglePromptCachingAction);

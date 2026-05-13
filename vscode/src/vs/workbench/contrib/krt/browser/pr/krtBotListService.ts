/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

const STORAGE_KEY = 'krt.botList.v1';

/**
 * Per-workspace allowlist of GitHub usernames to treat as automation
 * (bots). Comments authored by a listed user route to the Automation
 * tab instead of Discussion. Scoped per workspace folder URI so a
 * user's "internal bots" stay tied to the repo they were declared for.
 */
export interface IKrtBotListService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<string>;

	/** Logins registered as bots for the given workspace. Empty array if no entry. */
	getBots(workspaceFolderUri: string): readonly string[];
	isBot(workspaceFolderUri: string, login: string): boolean;
	addBot(workspaceFolderUri: string, login: string): void;
	removeBot(workspaceFolderUri: string, login: string): void;
}

export const IKrtBotListService = createDecorator<IKrtBotListService>('krtBotListService');

interface PersistedEnvelope {
	readonly version: 1;
	readonly bots: { readonly [workspaceFolderUri: string]: readonly string[] };
}

export class KrtBotListService extends Disposable implements IKrtBotListService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	/** Workspace folder URI → set of lowercased logins. */
	private bots = new Map<string, Set<string>>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.bots = this.read();
	}

	getBots(workspaceFolderUri: string): readonly string[] {
		const set = this.bots.get(workspaceFolderUri);
		return set ? [...set].sort() : [];
	}

	isBot(workspaceFolderUri: string, login: string): boolean {
		const set = this.bots.get(workspaceFolderUri);
		if (!set) {
			return false;
		}
		return set.has(login.toLowerCase());
	}

	addBot(workspaceFolderUri: string, login: string): void {
		const normalized = login.trim().toLowerCase();
		if (!normalized) {
			return;
		}
		const set = this.bots.get(workspaceFolderUri) ?? new Set<string>();
		if (set.has(normalized)) {
			return;
		}
		set.add(normalized);
		this.bots.set(workspaceFolderUri, set);
		this.write();
		this._onDidChange.fire(workspaceFolderUri);
	}

	removeBot(workspaceFolderUri: string, login: string): void {
		const normalized = login.trim().toLowerCase();
		const set = this.bots.get(workspaceFolderUri);
		if (!set || !set.has(normalized)) {
			return;
		}
		set.delete(normalized);
		if (set.size === 0) {
			this.bots.delete(workspaceFolderUri);
		}
		this.write();
		this._onDidChange.fire(workspaceFolderUri);
	}

	private read(): Map<string, Set<string>> {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return new Map();
		}
		try {
			const parsed = JSON.parse(raw) as PersistedEnvelope;
			if (parsed.version !== 1 || !parsed.bots) {
				return new Map();
			}
			const out = new Map<string, Set<string>>();
			for (const [folderUri, logins] of Object.entries(parsed.bots)) {
				if (Array.isArray(logins)) {
					out.set(folderUri, new Set(logins.map(l => l.toLowerCase())));
				}
			}
			return out;
		} catch (err) {
			this.logService.warn('[krt] botListService: failed to parse storage envelope', err);
			return new Map();
		}
	}

	private write(): void {
		const out: { [folderUri: string]: string[] } = {};
		for (const [folderUri, set] of this.bots) {
			out[folderUri] = [...set].sort();
		}
		const envelope: PersistedEnvelope = {
			version: 1,
			bots: out,
		};
		this.storageService.store(
			STORAGE_KEY,
			JSON.stringify(envelope),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
	}
}

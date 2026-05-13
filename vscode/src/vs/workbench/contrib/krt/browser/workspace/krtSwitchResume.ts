/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

/**
 * Persisted state needed to roll a workspace back to where it was
 * before KRT switched it to a PR's head commit.
 *
 * Discriminated on `vcs` — jj path captures op-id (so a single
 * `jj op restore` rewinds the entire state), git path captures the
 * previous branch + optional stash ref so we can `git checkout` back
 * and surface the stash for manual `git stash pop`.
 */
export type ResumeToken =
	| {
		readonly vcs: 'jj';
		readonly workspaceFolderUri: string;
		readonly prUrl: string;
		readonly prNumber: number;
		readonly previousChangeId: string;
		readonly previousDescription: string;
		readonly preSwitchOpId: string;
		readonly switchedAt: string;
	}
	| {
		readonly vcs: 'git';
		readonly workspaceFolderUri: string;
		readonly prUrl: string;
		readonly prNumber: number;
		readonly previousBranch: string;
		readonly previousSha: string;
		readonly stashRef?: string;
		readonly stashMessage?: string;
		readonly switchedAt: string;
	};

export interface IKrtSwitchResumeService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	getActive(): ResumeToken | undefined;
	set(token: ResumeToken): void;
	clear(): void;
}

export const IKrtSwitchResumeService = createDecorator<IKrtSwitchResumeService>('krtSwitchResumeService');

const STORAGE_KEY = 'krt.switchResume.v1';

export class KrtSwitchResumeService extends Disposable implements IKrtSwitchResumeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private active: ResumeToken | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.active = this.read();
	}

	getActive(): ResumeToken | undefined {
		return this.active;
	}

	set(token: ResumeToken): void {
		this.active = token;
		this.storageService.store(STORAGE_KEY, JSON.stringify(token), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	clear(): void {
		if (!this.active) {
			return;
		}
		this.active = undefined;
		this.storageService.remove(STORAGE_KEY, StorageScope.APPLICATION);
		this._onDidChange.fire();
	}

	private read(): ResumeToken | undefined {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as ResumeToken;
			if (parsed && (parsed.vcs === 'jj' || parsed.vcs === 'git')) {
				return parsed;
			}
		} catch {
			// fall through
		}
		return undefined;
	}
}

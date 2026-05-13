/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

/**
 * A registered local clone of a GitHub repository. Phase 8.6 uses these
 * to (1) scope PR Search to repos the user actually cares about and
 * (2) feed real `file://` URIs into Monaco diff editors so language
 * extensions activate against them.
 *
 * `folderUri` is the local clone path. `owner`/`repo` come from the
 * `origin` remote URL parsed at Add time. `addedAt` is for a future
 * recents-style sort.
 */
export interface KrtWorkspace {
	readonly folderUri: string;
	readonly folderPath: string;
	readonly owner: string;
	readonly repo: string;
	readonly remoteUrl: string;
	readonly addedAt: string;
}

export interface IKrtWorkspaceRegistry {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	getAll(): readonly KrtWorkspace[];
	add(workspace: KrtWorkspace): void;
	remove(folderUri: string): void;
	findByOwnerRepo(owner: string, repo: string): KrtWorkspace | undefined;
	findByFolderUri(folderUri: string): KrtWorkspace | undefined;
}

export const IKrtWorkspaceRegistry = createDecorator<IKrtWorkspaceRegistry>('krtWorkspaceRegistry');

const STORAGE_KEY = 'krt.workspaces.v1';

interface StoredEnvelope {
	readonly version: 1;
	readonly workspaces: readonly KrtWorkspace[];
}

export class KrtWorkspaceRegistry extends Disposable implements IKrtWorkspaceRegistry {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private workspaces: KrtWorkspace[];

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.workspaces = this.read();
	}

	getAll(): readonly KrtWorkspace[] {
		return this.workspaces;
	}

	add(workspace: KrtWorkspace): void {
		// De-dupe on `folderUri` — re-adding the same clone updates the
		// metadata (owner/repo/remoteUrl) without producing a stale
		// duplicate entry.
		const filtered = this.workspaces.filter(w => w.folderUri !== workspace.folderUri);
		this.workspaces = [...filtered, workspace];
		this.write();
		this._onDidChange.fire();
	}

	remove(folderUri: string): void {
		const before = this.workspaces.length;
		this.workspaces = this.workspaces.filter(w => w.folderUri !== folderUri);
		if (this.workspaces.length !== before) {
			this.write();
			this._onDidChange.fire();
		}
	}

	findByOwnerRepo(owner: string, repo: string): KrtWorkspace | undefined {
		return this.workspaces.find(w =>
			w.owner.toLowerCase() === owner.toLowerCase() &&
			w.repo.toLowerCase() === repo.toLowerCase()
		);
	}

	findByFolderUri(folderUri: string): KrtWorkspace | undefined {
		return this.workspaces.find(w => w.folderUri === folderUri);
	}

	private read(): KrtWorkspace[] {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return [];
		}
		try {
			const envelope = JSON.parse(raw) as StoredEnvelope;
			if (envelope.version !== 1 || !Array.isArray(envelope.workspaces)) {
				return [];
			}
			return envelope.workspaces.filter(w =>
				typeof w.folderUri === 'string' &&
				typeof w.folderPath === 'string' &&
				typeof w.owner === 'string' &&
				typeof w.repo === 'string'
			);
		} catch {
			return [];
		}
	}

	private write(): void {
		const envelope: StoredEnvelope = { version: 1, workspaces: this.workspaces };
		this.storageService.store(STORAGE_KEY, JSON.stringify(envelope), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

/**
 * Parse a GitHub remote URL into `{ owner, repo }`. Handles:
 *   - `git@github.com:owner/repo.git`
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo`
 *   - `ssh://git@github.com/owner/repo.git`
 *
 * Returns `undefined` if the URL doesn't look like GitHub.
 */
export function parseGithubRemoteUrl(url: string): { owner: string; repo: string } | undefined {
	const trimmed = url.trim();
	// SSH form: git@github.com:owner/repo[.git]
	const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?\/?$/.exec(trimmed);
	if (ssh?.groups) {
		return { owner: ssh.groups.owner, repo: ssh.groups.repo };
	}
	// HTTPS form: https://github.com/owner/repo[.git]
	const https = /^https?:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?\/?$/.exec(trimmed);
	if (https?.groups) {
		return { owner: https.groups.owner, repo: https.groups.repo };
	}
	return undefined;
}

/**
 * Build a synthetic `folderUri` from a real folder path. Uses a real
 * `URI.file(...)` so storage round-trips cleanly.
 */
export function folderPathToUri(folderPath: string): string {
	return URI.file(folderPath).toString();
}

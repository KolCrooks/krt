/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../../common/editor.js';

export const KRT_PR_SCHEME = 'krt-pr';
export const krtPullRequestEditorInputTypeId = 'workbench.editors.krtPullRequestInput';

/**
 * One open PR is one editor input. The input carries enough metadata
 * to render a tab and address the PR (`url` is authoritative);
 * everything else (description, comments, reviews) is fetched lazily
 * by the pane via `IPullRequestProvider.getPullRequest(url)`.
 */
export class KrtPullRequestEditorInput extends EditorInput {

	static readonly ID = krtPullRequestEditorInputTypeId;

	private readonly _resource: URI;

	override get typeId(): string {
		return KrtPullRequestEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI {
		return this._resource;
	}

	constructor(
		readonly url: string,
		readonly owner: string,
		readonly repo: string,
		readonly number: number,
		private _title: string | undefined,
	) {
		super();
		this._resource = URI.from({ scheme: KRT_PR_SCHEME, authority: owner, path: `/${repo}/${number}` });
	}

	override getName(): string {
		return `${this.owner}/${this.repo}#${this.number}`;
	}

	override getTitle(): string {
		return this._title ? `${this.getName()} — ${this._title}` : this.getName();
	}

	setTitle(title: string): void {
		if (title === this._title) {
			return;
		}
		this._title = title;
		this._onDidChangeLabel.fire();
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this._resource,
			options: { override: KrtPullRequestEditorInput.ID },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof KrtPullRequestEditorInput) {
			return other.url === this.url;
		}
		return false;
	}

	override getDescription(): string {
		return localize('krt.pullRequestInput.description', "Pull Request");
	}
}

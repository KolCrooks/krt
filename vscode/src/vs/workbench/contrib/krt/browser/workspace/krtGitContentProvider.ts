/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { IKrtGitService } from '../../../../../platform/krt/common/krtGit.js';
import { IPullRequestProvider } from '../../../../../platform/krt/common/krt.js';
import { IKrtWorkspaceRegistry } from './krtWorkspaceRegistry.js';

export const KRT_GIT_SCHEME = 'krt-git';

/**
 * Resolves `krt-git://<folderUri-encoded>/<ref>/<path>` URIs by
 * shelling `git show <ref>:<path>` in the registered workspace folder.
 *
 * Used as the *base* side of Monaco diffs when the workspace is
 * registered but the working tree isn't on the PR's base SHA. The head
 * side prefers `file://` (so language extensions activate); only when
 * the working tree's HEAD doesn't match does it also fall back here.
 *
 * Cached as plain Monaco text models — `IModelService.createModel` is
 * idempotent on URI, so re-requests within the same session reuse the
 * cached model and avoid re-shelling.
 */
class KrtGitContentProvider implements ITextModelContentProvider {

	constructor(
		@IKrtGitService private readonly gitService: IKrtGitService,
		@IKrtWorkspaceRegistry private readonly workspaceRegistry: IKrtWorkspaceRegistry,
		@IPullRequestProvider private readonly pullRequestProvider: IPullRequestProvider,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ILogService private readonly logService: ILogService,
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		if (resource.scheme !== KRT_GIT_SCHEME) {
			return null;
		}
		const existing = this.modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const decoded = decodeKrtGit(resource);
		if (!decoded) {
			this.logService.warn(`[krt] krt-git URI did not parse: ${resource.toString()}`);
			return null;
		}
		const workspace = this.workspaceRegistry.findByFolderUri(decoded.folderUri);
		if (!workspace) {
			this.logService.warn(`[krt] krt-git URI references unknown workspace: ${decoded.folderUri}`);
			return null;
		}
		// Try the local clone first — it's free if it works. If `git
		// show` fails (file genuinely not in that SHA according to the
		// local view, or local clone is partially fetched / missing
		// objects), fall back to the GitHub Contents API. GitHub's view
		// of the SHA is authoritative for what the PR diff displays.
		// On API failure too, the file truly doesn't exist at that ref
		// per GitHub either — return null and let the caller render the
		// affected side as empty (added/removed-style).
		let content: string | undefined;
		try {
			content = await this.gitService.showFile(workspace.folderPath, decoded.ref, decoded.path);
		} catch (gitErr) {
			try {
				content = await this.pullRequestProvider.getFileContent(
					workspace.owner,
					workspace.repo,
					decoded.ref,
					decoded.path,
				);
				this.logService.info(`[krt] krt-git: ${decoded.ref.slice(0, 7)}:${decoded.path} via gh API (local git show failed)`);
			} catch (apiErr) {
				this.logService.warn(
					`[krt] krt-git: ${decoded.ref.slice(0, 7)}:${decoded.path} not in local clone or GitHub — file will render as empty on this side`,
					gitErr,
				);
				return null;
			}
		}
		return this.modelService.createModel(
			content,
			this.languageService.createByFilepathOrFirstLine(URI.file(decoded.path)),
			resource,
			false,
		);
	}
}

/**
 * Encodes a workspace + ref + path tuple into a stable `krt-git://`
 * URI.
 *
 * The URI's **path** component matches the corresponding `file://`
 * URI's path (i.e. the file's absolute fs path inside the workspace).
 * `MultiDiffEditorItemTemplate` flags a file as renamed when
 * `original.path !== modified.path`; if we just put the repo-relative
 * path in the URI here, every modified file would render with a
 * spurious "R" badge.
 *
 * The workspace identity, ref, and the repo-relative path used by
 * `git show` all live in the URI's **query** as JSON. Both query and
 * path are case-preserved (unlike the authority, which `URI.from`
 * lowercases — that broke the registry lookup on `/Users/...` paths).
 */
interface KrtGitFields {
	readonly folderUri: string;
	readonly ref: string;
	/**
	 * Repo-relative path passed to `git show ref:path`. Stored here
	 * rather than derived from `URI.path` because the URI's path is
	 * the absolute fs path (see comment above) and reverse-deriving
	 * the relative form would require knowing the workspace's
	 * `folderPath`, which the decoder doesn't have at parse time.
	 */
	readonly path: string;
}

export function encodeKrtGit(folderUri: string, folderPath: string, ref: string, repoRelativePath: string): URI {
	const fields: KrtGitFields = { folderUri, ref, path: repoRelativePath };
	const absolute = URI.joinPath(URI.file(folderPath), repoRelativePath);
	return URI.from({
		scheme: KRT_GIT_SCHEME,
		path: absolute.path,
		query: JSON.stringify(fields),
	});
}

function decodeKrtGit(resource: URI): { folderUri: string; ref: string; path: string } | undefined {
	if (!resource.query) {
		return undefined;
	}
	let fields: KrtGitFields;
	try {
		fields = JSON.parse(resource.query) as KrtGitFields;
	} catch {
		return undefined;
	}
	if (typeof fields?.folderUri !== 'string' || typeof fields?.ref !== 'string' || typeof fields?.path !== 'string') {
		return undefined;
	}
	return {
		folderUri: fields.folderUri,
		ref: fields.ref,
		path: fields.path,
	};
}

/**
 * Wires the provider into the workbench's `ITextModelService` so
 * `createModelReference(krt-git://...)` resolves cleanly.
 */
export class KrtGitContentProviderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.krt.gitContentProvider';

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const provider = instantiationService.createInstance(KrtGitContentProvider);
		this._register(textModelService.registerTextModelContentProvider(KRT_GIT_SCHEME, provider));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(KrtGitContentProviderContribution, LifecyclePhase.Restored);

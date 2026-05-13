/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { CommentThread } from '../../../../../editor/common/languages.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { CommentContextKeys } from '../../../comments/common/commentContextKeys.js';
import './krtCommentsView.contribution.js';
import './krtBotList.contribution.js';
import { IKrtPrCommentController, KrtPrCommentController, KRT_PR_COMMENT_OWNER } from './krtPrCommentController.js';
import { IKrtReviewDraftService, KrtReviewDraftService } from './krtReviewDraftService.js';
import { KrtPullRequestEditorInput } from './krtPullRequestEditorInput.js';
import { KrtPullRequestEditorPane } from './krtPullRequestEditorPane.js';

interface SerializedKrtPullRequestEditorInput {
	readonly url: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly title?: string;
}

class KrtPullRequestEditorInputSerializer implements IEditorSerializer {

	canSerialize(_input: KrtPullRequestEditorInput): boolean {
		return true;
	}

	serialize(input: KrtPullRequestEditorInput): string {
		const data: SerializedKrtPullRequestEditorInput = {
			url: input.url,
			owner: input.owner,
			repo: input.repo,
			number: input.number,
			title: input.getTitle().includes('—') ? input.getTitle().split('—').slice(1).join('—').trim() : undefined,
		};
		return JSON.stringify(data);
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): KrtPullRequestEditorInput | undefined {
		try {
			const data = JSON.parse(raw) as SerializedKrtPullRequestEditorInput;
			return new KrtPullRequestEditorInput(data.url, data.owner, data.repo, data.number, data.title);
		} catch {
			return undefined;
		}
	}
}

// Phase 10 review draft service. The comment controller depends on it,
// so it must be registered before the controller. Eager so persisted
// drafts are available the moment the first PR opens.
registerSingleton(IKrtReviewDraftService, KrtReviewDraftService, InstantiationType.Eager);

// Register the native review-comments controller eagerly so it's
// already attached to `ICommentService` by the time the first PR
// diff editor mounts and asks for comments. Eager (not Delayed)
// because the workbench's editor-attach timing for the comment
// controller fires before our pane sets input.
registerSingleton(IKrtPrCommentController, KrtPrCommentController, InstantiationType.Eager);

/**
 * Submit/Reply action wired into the native comment thread widget's
 * action bar. The widget's `commentReply` invokes the menu's actions
 * with `{ thread, text, $mid: CommentThreadReply }` — pull `thread`
 * + `text` out of the args and route to the controller.
 *
 * Filtered to KRT threads via `commentController == 'krt-pr'` so it
 * doesn't appear on threads owned by other extensions.
 */
class KrtSubmitCommentAction extends Action2 {
	static readonly ID = 'krt.pr.submitComment';

	constructor() {
		super({
			id: KrtSubmitCommentAction.ID,
			title: localize2('krt.pr.submitComment', "Comment"),
			f1: false,
			menu: {
				id: MenuId.CommentThreadActions,
				when: ContextKeyExpr.equals(CommentContextKeys.commentControllerContext.key, KRT_PR_COMMENT_OWNER),
				group: 'inline',
				order: 1,
			},
		});
	}

	override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
		const a = args as { thread?: CommentThread<IRange>; text?: string } | undefined;
		if (!a?.thread || typeof a.text !== 'string') {
			return;
		}
		const controller = accessor.get(IKrtPrCommentController);
		await controller.submitNewComment(a.thread, a.text);
	}
}

registerAction2(KrtSubmitCommentAction);

// The Comments panel (the bottom-panel listing of all threads) is
// registered by `MainThreadComments` only when an extension
// declares the `comments` contribution. KRT routes review comments
// through `KrtPrCommentController` directly, with no extension in
// the loop, so we register the menu wiring ourselves to make the
// Submit button visible.
MenuRegistry.appendMenuItem(MenuId.CommentThreadActions, {
	command: { id: KrtSubmitCommentAction.ID, title: localize('krt.pr.submitComment.menu', "Comment") },
	when: ContextKeyExpr.equals(CommentContextKeys.commentControllerContext.key, KRT_PR_COMMENT_OWNER),
	group: 'inline',
	order: 1,
});

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(KrtPullRequestEditorInput.ID, KrtPullRequestEditorInputSerializer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
	.registerEditorPane(
		EditorPaneDescriptor.create(
			KrtPullRequestEditorPane,
			KrtPullRequestEditorPane.ID,
			localize('krt.pullRequestEditor.name', "KRT Pull Request"),
		),
		[new SyncDescriptor(KrtPullRequestEditorInput)],
	);

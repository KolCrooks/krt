/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
} from '../../../../common/views.js';
import { CommentsPanel } from '../../../comments/browser/commentsView.js';
import {
	COMMENTS_VIEW_ID,
	COMMENTS_VIEW_STORAGE_ID,
	COMMENTS_VIEW_TITLE,
} from '../../../comments/browser/commentsTreeViewer.js';

/**
 * Register the workbench's standard Comments view at boot. Upstream's
 * `MainThreadComments` is the only thing that normally registers
 * this view, and it only runs when an extension declares the
 * `comments` contribution. KRT has no such extension — its
 * review-comment data flows through `KrtPrCommentController`
 * directly — so without this contribution the Comments view never
 * appears in the panel and the user has no aggregated thread list.
 *
 * `hideIfEmpty: true` keeps the view out of the panel when there are
 * no threads anywhere; it appears as soon as `KrtPrCommentController`
 * pushes its first batch through `setWorkspaceComments`.
 */

const commentsViewIcon = registerIcon(
	'krt-comments-view-icon',
	Codicon.commentDiscussion,
	localize('krt.commentsViewIcon', "View icon of the comments view."),
);

const VIEW_CONTAINER = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: COMMENTS_VIEW_ID,
	title: COMMENTS_VIEW_TITLE,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [COMMENTS_VIEW_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: COMMENTS_VIEW_STORAGE_ID,
	hideIfEmpty: true,
	icon: commentsViewIcon,
	order: 10,
}, ViewContainerLocation.Panel);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: COMMENTS_VIEW_ID,
	name: COMMENTS_VIEW_TITLE,
	canToggleVisibility: false,
	ctorDescriptor: new SyncDescriptor(CommentsPanel),
	canMoveView: true,
	containerIcon: commentsViewIcon,
	focusCommand: {
		id: 'workbench.action.focusCommentsPanel',
	},
}], VIEW_CONTAINER);

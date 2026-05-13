/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import {
	Comment as LanguageComment,
	CommentReaction,
	CommentThread,
	CommentThreadCollapsibleState,
	CommentMode,
} from '../../../../../editor/common/languages.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Comment as KrtComment, IPullRequestProvider } from '../../../../../platform/krt/common/krt.js';
import {
	ICommentController,
	ICommentInfo,
	ICommentService,
	INotebookCommentInfo,
} from '../../../comments/browser/commentService.js';
import { IKrtReviewDraftService, KrtReviewDraftComment } from './krtReviewDraftService.js';
import { KrtPrCommentThread } from './krtPrCommentThread.js';

export const KRT_PR_COMMENT_OWNER = 'krt-pr';

/**
 * Per-URI metadata. Each diff editor side mounted by `KrtPrFlatDiff`
 * registers its URI here so the controller can:
 *   1. filter the PR's comment list to ones for this `(side, path)`,
 *   2. translate native gutter clicks into `(prUrl, side, path)` for
 *      `IPullRequestProvider.postReviewComment`.
 *
 * For renames, LEFT-side URIs use `previousPath` (the old name) and
 * RIGHT-side URIs use `path` (the new name). Comment matching follows
 * the same rule: GitHub anchors a `LEFT` comment at the old path and
 * a `RIGHT` comment at the new path.
 */
export interface IKrtPrUriMeta {
	readonly prUrl: string;
	readonly headSha: string;
	readonly side: 'LEFT' | 'RIGHT';
	readonly path: string;
}

export interface IKrtPrCommentController {
	readonly _serviceBrand: undefined;
	registerDiffUri(uri: URI, meta: IKrtPrUriMeta): IDisposable;
	setCommentsForPr(prUrl: string, comments: readonly KrtComment[]): void;
	clearCommentsForPr(prUrl: string): void;
	submitNewComment(thread: CommentThread<IRange>, text: string): Promise<void>;
	bumpDataProvider(): void;
}

export const IKrtPrCommentController = createDecorator<IKrtPrCommentController>('krtPrCommentController');

/**
 * Implements the workbench `ICommentController` so the standard comment
 * UI (native `+` glyph in the gutter, native thread widget, native
 * Comments panel) lights up against the diff editors KRT mounts.
 *
 * Single owner ID `'krt-pr'` for everything KRT touches — the
 * controller fans out internally per `(prUrl, uri, side, path)`.
 */
export class KrtPrCommentController extends Disposable implements ICommentController, IKrtPrCommentController {

	declare readonly _serviceBrand: undefined;

	readonly id = KRT_PR_COMMENT_OWNER;
	readonly label = 'KRT';
	readonly owner = KRT_PR_COMMENT_OWNER;
	readonly features = {};
	// `commentController == 'krt-pr'` powers the menu `when` clause for
	// our Submit action. Upstream's `MainThreadCommentController` derives
	// this from the controller `id` (see `mainThreadComments.ts`). Without
	// it, `commentThreadWidget.ts` never sets the context key and the
	// inline Comment button stays hidden, leaving the user no UI affordance
	// to submit a typed comment (the keyboard shortcut still works).
	readonly contextValue = KRT_PR_COMMENT_OWNER;
	activeComment: { thread: CommentThread; comment?: LanguageComment } | undefined;

	/** uri.toString() → metadata for the diff URI mounted there. */
	private readonly metadataByUri = new Map<string, IKrtPrUriMeta>();

	/** prUrl → the last KRT-side comment list for that PR. */
	private readonly commentsByPr = new Map<string, readonly KrtComment[]>();

	/** uri.toString() → owned threads currently published for that URI. */
	private readonly threadsByUri = new Map<string, KrtPrCommentThread[]>();

	private nextThreadHandle = 1;

	constructor(
		@ICommentService private readonly commentService: ICommentService,
		@IPullRequestProvider private readonly pullRequestProvider: IPullRequestProvider,
		@IKrtReviewDraftService private readonly reviewDraftService: IKrtReviewDraftService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.commentService.registerCommentController(KRT_PR_COMMENT_OWNER, this);
		this._register(toDisposable(() => this.commentService.unregisterCommentController(KRT_PR_COMMENT_OWNER)));
		// When a draft changes (comment added / discarded / submitted)
		// every URI registered for that PR needs to refresh so the
		// pending threads appear or disappear as appropriate.
		this._register(this.reviewDraftService.onDidChange(prUrl => {
			for (const [key, meta] of this.metadataByUri) {
				if (meta.prUrl === prUrl) {
					this.refreshUri(URI.parse(key), meta);
				}
			}
		}));
	}

	// ----- IKrtPrCommentController -----

	registerDiffUri(uri: URI, meta: IKrtPrUriMeta): IDisposable {
		const key = uri.toString();
		this.metadataByUri.set(key, meta);
		this.logService.info(`[krt] commentController: registered ${meta.side} ${meta.prUrl} ${meta.path} -> ${key}`);
		this.refreshUri(uri, meta);
		return toDisposable(() => {
			if (this.metadataByUri.get(key) === meta) {
				this.metadataByUri.delete(key);
				const owned = this.threadsByUri.get(key);
				if (owned && owned.length > 0) {
					this.threadsByUri.delete(key);
					this.commentService.updateComments(KRT_PR_COMMENT_OWNER, {
						added: [], removed: owned, changed: [], pending: [],
					});
					for (const t of owned) { t.dispose(); }
				}
				this.publishWorkspaceSnapshot();
			}
		});
	}

	setCommentsForPr(prUrl: string, comments: readonly KrtComment[]): void {
		this.commentsByPr.set(prUrl, comments);
		const reviewCount = comments.filter(c => c.location.kind === 'review').length;
		this.logService.info(`[krt] commentController: setCommentsForPr ${prUrl} -> ${comments.length} comments (${reviewCount} review)`);
		for (const [key, meta] of this.metadataByUri) {
			if (meta.prUrl === prUrl) {
				this.refreshUri(URI.parse(key), meta);
			}
		}
	}

	clearCommentsForPr(prUrl: string): void {
		this.commentsByPr.delete(prUrl);
		for (const [key, meta] of this.metadataByUri) {
			if (meta.prUrl === prUrl) {
				this.refreshUri(URI.parse(key), meta);
			}
		}
	}

	/**
	 * Re-fire `onDidSetDataProvider` so freshly-mounted code editors
	 * trigger their initial compute against this controller.
	 *
	 * The workbench's `editor.contrib.review` is `AfterFirstRender`
	 * (instantiated up to ~50ms after the inner editor's model
	 * attaches) and only computes via these events:
	 *   - `onDidSetDataProvider` (a controller registered)
	 *   - `onDidDeleteDataProvider` (a controller unregistered)
	 *   - `onDidUpdateCommentingRanges`
	 *   - `onDidSetResourceCommentInfos` (matching the editor's URI)
	 *   - `onDidUpdateCommentThreads` (after an initial compute)
	 *
	 * KRT registers this controller eagerly at singleton init time —
	 * before any KRT diff editor exists — so `onDidSetDataProvider`
	 * fires for nobody. After the multi-diff mounts and editors render,
	 * `KrtPrFlatDiff` calls this method to re-fire the event so any
	 * newly-listening `editor.contrib.review` triggers compute and
	 * picks up the threads we already published.
	 */
	bumpDataProvider(): void {
		this.commentService.unregisterCommentController(KRT_PR_COMMENT_OWNER);
		this.commentService.registerCommentController(KRT_PR_COMMENT_OWNER, this);
		// `unregisterCommentController` calls
		// `commentsModel.deleteCommentsByOwner(...)` which wipes our
		// thread set from the panel's data model. Re-publish the
		// snapshot so the bottom Comments view gets the threads back.
		this.publishWorkspaceSnapshot();
	}

	async submitNewComment(thread: CommentThread<IRange>, text: string): Promise<void> {
		const key = thread.resource;
		if (!key) { return; }
		const meta = this.metadataByUri.get(key);
		if (!meta) { return; }
		if (!thread.range) { return; }
		const trimmed = text.trim();
		if (!trimmed) { return; }
		const line = thread.range.startLineNumber;

		// Phase 10: when a review draft exists for this PR, route the
		// comment into the draft instead of posting immediately. The
		// `onDidChange` listener installed in the constructor refreshes
		// the URI so the pending thread renders in place. Submit posts
		// the whole batch at once.
		if (this.reviewDraftService.hasDraft(meta.prUrl)) {
			// Reply detection: if the user typed in the reply slot of
			// an existing real thread (non-template, with at least one
			// server-side comment on this line), pin the draft as a
			// reply to the earliest parent. New top-level comments and
			// follow-ups on a still-pending-only line route as new
			// threads.
			const inReplyTo = !thread.isTemplate
				? this.findReplyParentId(meta, line)
				: undefined;
			this.reviewDraftService.addComment({
				prUrl: meta.prUrl,
				path: meta.path,
				line,
				side: meta.side,
				body: trimmed,
				inReplyTo,
			});
			// `addComment` fires `onDidChange`, which rebuilds the URI's
			// thread set with a pending thread for this line. The
			// template thread that hosted the input still lives in the
			// thread set (carry-over preserves it) — drop it here so the
			// only widget on the line is the new pending thread.
			this.disposeTemplateForLine(key, meta, line);
			return;
		}

		try {
			const created = await this.pullRequestProvider.postReviewComment(meta.prUrl, {
				commitId: meta.headSha,
				path: meta.path,
				line,
				side: meta.side,
				body: trimmed,
			});
			// Append to the cached comment set, then re-render. This
			// drops the template thread and replaces it with a realised
			// one anchored at the same line.
			const existing = this.commentsByPr.get(meta.prUrl) ?? [];
			this.commentsByPr.set(meta.prUrl, [...existing, created]);
			this.refreshUri(URI.parse(key), meta);
			this.disposeTemplateForLine(key, meta, line);
		} catch (err) {
			this.logService.warn(`[krt] postReviewComment failed for ${meta.prUrl} ${meta.path}:${line}`, err);
			throw err;
		}
	}

	// ----- ICommentController -----

	async getDocumentComments(resource: URI, _token: CancellationToken): Promise<ICommentInfo<IRange>> {
		const info = this.commentInfoForUri(resource);
		const meta = this.metadataByUri.get(resource.toString());
		this.logService.info(`[krt] commentController: getDocumentComments ${resource.toString()} -> ${info.threads.length} threads, meta=${meta ? `${meta.side} ${meta.path}` : 'none'}`);
		return info;
	}

	async getNotebookComments(_resource: URI, _token: CancellationToken): Promise<INotebookCommentInfo> {
		return { uniqueOwner: KRT_PR_COMMENT_OWNER, label: this.label, threads: [] };
	}

	async createCommentThreadTemplate(resource: UriComponents, range: IRange | undefined, _editorId?: string): Promise<void> {
		const uri = URI.from(resource);
		const key = uri.toString();
		const meta = this.metadataByUri.get(key);
		if (!meta || !range) { return; }

		// Stable thread id for the template — keying off the line means
		// re-clicking the `+` on the same line replaces (not stacks) the
		// existing draft template.
		const threadId = `krt-pr|template|${meta.prUrl}|${meta.side}|${meta.path}|${range.startLineNumber}`;
		const previousThreads = this.threadsByUri.get(key) ?? [];
		const filteredPrevious = previousThreads.filter(t => t.threadId !== threadId);
		const removed = previousThreads.filter(t => t.threadId === threadId);

		const template = new KrtPrCommentThread({
			commentThreadHandle: this.nextThreadHandle++,
			controllerHandle: 0,
			threadId,
			resource: key,
			range,
			comments: [],
			canReply: true,
			isTemplate: true,
			collapsibleState: CommentThreadCollapsibleState.Expanded,
		});

		const next = [...filteredPrevious, template];
		this.threadsByUri.set(key, next);
		this.commentService.updateComments(KRT_PR_COMMENT_OWNER, {
			added: [template], removed, changed: [], pending: [],
		});
		// See `refreshUri` — `setDocumentComments` would re-mount the
		// widgets `editor.contrib.review` is about to create from this
		// `updateComments` delta.
		for (const t of removed) { t.dispose(); }
		this.publishWorkspaceSnapshot();
	}

	async updateCommentThreadTemplate(_threadHandle: number, _range: IRange): Promise<void> {
		// Phase E: drag-to-extend a template thread's range. Stub for now.
	}

	deleteCommentThreadMain(commentThreadId: string): void {
		// Workbench calls this when a thread widget hides with no
		// comments — typically a template thread the user clicked away
		// from without typing anything. Drop the thread from our state
		// so it doesn't re-render on the next refresh.
		for (const [key, threads] of this.threadsByUri) {
			const target = threads.find(t => t.threadId === commentThreadId);
			if (!target) { continue; }
			const remaining = threads.filter(t => t !== target);
			this.threadsByUri.set(key, remaining);
			this.commentService.updateComments(KRT_PR_COMMENT_OWNER, {
				added: [], removed: [target], changed: [], pending: [],
			});
			target.dispose();
			this.publishWorkspaceSnapshot();
			return;
		}
	}

	async toggleReaction(_uri: URI, _thread: CommentThread, _comment: LanguageComment, _reaction: CommentReaction, _token: CancellationToken): Promise<void> {
		// Phase E: reactions. Stub.
	}

	async setActiveCommentAndThread(commentInfo: { thread: CommentThread; comment?: LanguageComment } | undefined): Promise<void> {
		this.activeComment = commentInfo;
	}

	// ----- internals -----

	/**
	 * Recompute the thread set for a given URI from `commentsByPr` +
	 * `metadataByUri`. Reuses thread instances by `threadId` so the
	 * native widget doesn't recycle and lose its expanded state.
	 */
	private refreshUri(uri: URI, meta: IKrtPrUriMeta): void {
		const key = uri.toString();
		const previousThreads = this.threadsByUri.get(key) ?? [];
		const previousById = new Map(previousThreads.map(t => [t.threadId, t] as const));

		const comments = this.commentsByPr.get(meta.prUrl) ?? [];
		const matching = comments.filter(c =>
			c.location.kind === 'review' &&
			c.location.side === meta.side &&
			c.location.path === meta.path,
		);

		// Group real (server-side) comments by line so multi-comment
		// threads collapse to one widget.
		const byLine = new Map<number, KrtComment[]>();
		for (const c of matching) {
			if (c.location.kind !== 'review') { continue; }
			const arr = byLine.get(c.location.line);
			if (arr) { arr.push(c); } else { byLine.set(c.location.line, [c]); }
		}

		// Phase 10: pending draft comments (typed but not yet submitted)
		// for this `(side, path)`, grouped by line so they collapse into
		// any existing real-comment thread on the same line.
		const draft = this.reviewDraftService.getDraft(meta.prUrl);
		const draftByLine = new Map<number, KrtReviewDraftComment[]>();
		if (draft) {
			for (const dc of draft.comments) {
				if (dc.side !== meta.side || dc.path !== meta.path) { continue; }
				const arr = draftByLine.get(dc.line);
				if (arr) { arr.push(dc); } else { draftByLine.set(dc.line, [dc]); }
			}
		}

		const next: KrtPrCommentThread[] = [];
		const added: KrtPrCommentThread[] = [];
		const changed: KrtPrCommentThread[] = [];
		const allLines = new Set<number>([...byLine.keys(), ...draftByLine.keys()]);

		// Replies require an active draft (to land into) AND at least
		// one server-side parent comment on the line. The reply UI on a
		// thread is gated by `canReply` per-thread.
		const hasDraft = this.reviewDraftService.hasDraft(meta.prUrl);

		for (const line of allLines) {
			const realComments = byLine.get(line) ?? [];
			const draftComments = draftByLine.get(line) ?? [];
			const sortedReal = [...realComments].sort(
				(a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
			);
			const sortedDraft = [...draftComments].sort(
				(a, b) => a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0,
			);
			const range: IRange = { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 };
			const threadId = `krt-pr|${meta.prUrl}|${meta.side}|${meta.path}|${line}`;
			const langComments: LanguageComment[] = [];
			let i = 1;
			for (const c of sortedReal) { langComments.push(krtCommentToLanguageComment(c, i++)); }
			for (const dc of sortedDraft) { langComments.push(draftCommentToLanguageComment(dc, i++)); }

			// Allow replies on threads that have a real parent the
			// reply can target — and only while a review draft is open
			// to receive the typed body.
			const canReply = hasDraft && sortedReal.length > 0;

			const existing = previousById.get(threadId);
			if (existing) {
				existing.range = range;
				existing.comments = langComments;
				existing.canReply = canReply;
				next.push(existing);
				changed.push(existing);
				previousById.delete(threadId);
			} else {
				const fresh = new KrtPrCommentThread({
					commentThreadHandle: this.nextThreadHandle++,
					controllerHandle: 0,
					threadId,
					resource: key,
					range,
					comments: langComments,
					canReply,
					collapsibleState: CommentThreadCollapsibleState.Expanded,
				});
				next.push(fresh);
				added.push(fresh);
			}
		}

		// Carry over any non-matching threads that survived. Notable
		// case: in-flight template threads — those have a different
		// `threadId` prefix (`krt-pr|template|...`) and aren't
		// produced by the loop above, so they'd otherwise get dropped.
		for (const stale of previousById.values()) {
			if (stale.isTemplate) {
				next.push(stale);
				previousById.delete(stale.threadId);
			}
		}

		const removed = [...previousById.values()];
		this.threadsByUri.set(key, next);

		if (added.length > 0 || removed.length > 0 || changed.length > 0) {
			this.commentService.updateComments(KRT_PR_COMMENT_OWNER, {
				added, removed, changed, pending: [],
			});
		}
		// NB: deliberately not calling `setDocumentComments` here.
		// `updateComments` already fires deltas to every listening editor
		// (`editor.contrib.review` updates `_commentWidgets` against
		// `added` / `removed` / `changed`). `setDocumentComments` triggers
		// a wipe-and-re-add (`setComments` → `removeCommentWidgetsAndStoreCache`
		// then `displayCommentThread` per thread), which duplicates the
		// work and — critically — re-mounts widgets the diff handler
		// already created, leaving multiple `ReviewZoneWidget` viewzones
		// stacked on the same line.
		for (const t of removed) { t.dispose(); }
		this.publishWorkspaceSnapshot();
	}

	/**
	 * Earliest server-side comment id on `(prUrl, side, path, line)` —
	 * the parent GitHub picks for `in_reply_to` semantics. Returns
	 * `undefined` if the line has no real comments yet (e.g., the user
	 * is adding a follow-up to a draft-only thread, which we treat as a
	 * fresh top-level comment).
	 */
	private findReplyParentId(meta: IKrtPrUriMeta, line: number): number | undefined {
		const comments = this.commentsByPr.get(meta.prUrl) ?? [];
		const matching = comments
			.filter(c =>
				c.location.kind === 'review' &&
				c.location.side === meta.side &&
				c.location.path === meta.path &&
				c.location.line === line,
			)
			.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
		return matching[0]?.id;
	}

	/**
	 * Drop the template thread that hosted the input the user just
	 * submitted, so the line shows only the consumed thread (real or
	 * pending) afterwards.
	 */
	private disposeTemplateForLine(uriKey: string, meta: IKrtPrUriMeta, line: number): void {
		const templateId = `krt-pr|template|${meta.prUrl}|${meta.side}|${meta.path}|${line}`;
		const owned = this.threadsByUri.get(uriKey) ?? [];
		const template = owned.find(t => t.threadId === templateId);
		if (!template) { return; }
		const remaining = owned.filter(t => t !== template);
		this.threadsByUri.set(uriKey, remaining);
		this.commentService.updateComments(KRT_PR_COMMENT_OWNER, {
			added: [], removed: [template], changed: [], pending: [],
		});
		template.dispose();
		this.publishWorkspaceSnapshot();
	}

	private commentInfoForUri(uri: URI): ICommentInfo {
		const key = uri.toString();
		const meta = this.metadataByUri.get(key);
		const threads = this.threadsByUri.get(key) ?? [];
		// `commentingRanges` controls where the native `+` glyph
		// appears in the gutter. Both diff sides are fully commentable
		// (every line on the modified side; every line on the original
		// side as a deletion-anchored comment). We don't know the model's
		// line count from here, so quote a wide range — the workbench
		// truncates against the actual model when rendering.
		const ranges: IRange[] = meta
			? [{ startLineNumber: 1, startColumn: 1, endLineNumber: Number.MAX_SAFE_INTEGER, endColumn: 1 }]
			: [];
		return {
			uniqueOwner: KRT_PR_COMMENT_OWNER,
			label: this.label,
			threads,
			commentingRanges: { resource: uri, ranges, fileComments: false },
		};
	}

	/**
	 * Push the full thread snapshot through `setWorkspaceComments` so
	 * the workbench's Comments panel mirrors what's in the editors.
	 * Without this, `updateComments` only reaches inline widgets — the
	 * panel stays empty.
	 */
	private publishWorkspaceSnapshot(): void {
		const all: KrtPrCommentThread[] = [];
		for (const threads of this.threadsByUri.values()) {
			all.push(...threads);
		}
		this.commentService.setWorkspaceComments(KRT_PR_COMMENT_OWNER, all);
	}
}

function krtCommentToLanguageComment(c: KrtComment, uniqueIdInThread: number): LanguageComment {
	return {
		uniqueIdInThread,
		body: c.body,
		userName: c.author.login,
		userIconPath: c.author.avatarUrl ? URI.parse(c.author.avatarUrl) : undefined,
		timestamp: c.createdAt,
	};
}

/**
 * Renders a draft (pending) comment in the inline thread widget. The
 * `Pending` label distinguishes it from server-confirmed comments so a
 * reviewer scanning the diff knows which threads are still local.
 */
function draftCommentToLanguageComment(c: KrtReviewDraftComment, uniqueIdInThread: number): LanguageComment {
	return {
		uniqueIdInThread,
		body: c.body,
		userName: 'You (pending)',
		mode: CommentMode.Preview,
		timestamp: c.addedAt,
		label: 'Pending',
	};
}

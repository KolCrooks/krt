/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IPullRequestProvider, ReviewSubmissionEvent } from '../../../../../platform/krt/common/krt.js';

const STORAGE_KEY = 'krt.reviewDrafts.v1';

/**
 * One in-progress review on a PR. Comments accumulate locally and post
 * to GitHub in a single batch on `submit`. Multiple PRs can carry
 * concurrent drafts — they're keyed by `prUrl` in the storage envelope.
 *
 * `headSha` is captured at draft start so submit can pin every comment
 * to the SHA that was current when the user wrote it (matches GitHub's
 * `commit_id` requirement for inline comments).
 */
export interface KrtReviewDraft {
	readonly prUrl: string;
	readonly prNumber: number;
	readonly owner: string;
	readonly repo: string;
	readonly headSha: string;
	readonly startedAt: string;
	readonly comments: readonly KrtReviewDraftComment[];
}

export interface KrtReviewDraftComment {
	readonly id: string;
	readonly path: string;
	readonly line: number;
	readonly side: 'LEFT' | 'RIGHT';
	readonly body: string;
	/** Database id of the parent review comment for replies. New top-level threads omit this. */
	readonly inReplyTo?: number;
	readonly addedAt: string;
}

export interface IStartReviewArgs {
	readonly prUrl: string;
	readonly prNumber: number;
	readonly owner: string;
	readonly repo: string;
	readonly headSha: string;
}

export interface IAddDraftCommentArgs {
	readonly prUrl: string;
	readonly path: string;
	readonly line: number;
	readonly side: 'LEFT' | 'RIGHT';
	readonly body: string;
	readonly inReplyTo?: number;
}

export interface ISubmitArgs {
	readonly prUrl: string;
	readonly event: ReviewSubmissionEvent;
	readonly body?: string;
}

export interface IKrtReviewDraftService {
	readonly _serviceBrand: undefined;

	/** Fires whenever any draft state changes; payload is the affected `prUrl`. */
	readonly onDidChange: Event<string>;

	getDraft(prUrl: string): KrtReviewDraft | undefined;
	hasDraft(prUrl: string): boolean;
	startReview(args: IStartReviewArgs): KrtReviewDraft;
	discard(prUrl: string): void;
	addComment(args: IAddDraftCommentArgs): KrtReviewDraftComment;
	removeComment(prUrl: string, commentId: string): void;
	/** Posts every draft comment as a single GitHub review. Drops the draft on success. */
	submit(args: ISubmitArgs): Promise<void>;
}

export const IKrtReviewDraftService = createDecorator<IKrtReviewDraftService>('krtReviewDraftService');

interface PersistedEnvelope {
	readonly version: 1;
	readonly drafts: { readonly [prUrl: string]: KrtReviewDraft };
}

export class KrtReviewDraftService extends Disposable implements IKrtReviewDraftService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private drafts = new Map<string, KrtReviewDraft>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IPullRequestProvider private readonly pullRequestProvider: IPullRequestProvider,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.drafts = this.read();
	}

	getDraft(prUrl: string): KrtReviewDraft | undefined {
		return this.drafts.get(prUrl);
	}

	hasDraft(prUrl: string): boolean {
		return this.drafts.has(prUrl);
	}

	startReview(args: IStartReviewArgs): KrtReviewDraft {
		const existing = this.drafts.get(args.prUrl);
		if (existing) {
			// Re-entering review mode for a PR with a paused draft is a
			// no-op on the persisted state. The headSha may have advanced
			// since the draft was started; we leave the original SHA in
			// place so already-typed comments still anchor to the commit
			// they were written against.
			return existing;
		}
		const draft: KrtReviewDraft = {
			prUrl: args.prUrl,
			prNumber: args.prNumber,
			owner: args.owner,
			repo: args.repo,
			headSha: args.headSha,
			startedAt: new Date().toISOString(),
			comments: [],
		};
		this.drafts.set(args.prUrl, draft);
		this.write();
		this._onDidChange.fire(args.prUrl);
		return draft;
	}

	discard(prUrl: string): void {
		if (!this.drafts.has(prUrl)) {
			return;
		}
		this.drafts.delete(prUrl);
		this.write();
		this._onDidChange.fire(prUrl);
	}

	addComment(args: IAddDraftCommentArgs): KrtReviewDraftComment {
		const draft = this.drafts.get(args.prUrl);
		if (!draft) {
			throw new Error(`No active review draft for ${args.prUrl}`);
		}
		const comment: KrtReviewDraftComment = {
			id: generateUuid(),
			path: args.path,
			line: args.line,
			side: args.side,
			body: args.body,
			inReplyTo: args.inReplyTo,
			addedAt: new Date().toISOString(),
		};
		const next: KrtReviewDraft = { ...draft, comments: [...draft.comments, comment] };
		this.drafts.set(args.prUrl, next);
		this.write();
		this._onDidChange.fire(args.prUrl);
		return comment;
	}

	removeComment(prUrl: string, commentId: string): void {
		const draft = this.drafts.get(prUrl);
		if (!draft) {
			return;
		}
		const filtered = draft.comments.filter(c => c.id !== commentId);
		if (filtered.length === draft.comments.length) {
			return;
		}
		this.drafts.set(prUrl, { ...draft, comments: filtered });
		this.write();
		this._onDidChange.fire(prUrl);
	}

	async submit(args: ISubmitArgs): Promise<void> {
		const draft = this.drafts.get(args.prUrl);
		if (!draft) {
			throw new Error(`No active review draft for ${args.prUrl}`);
		}
		// Replies go to a separate endpoint and don't carry path/line/
		// side; new top-level threads ride the batch-review endpoint.
		const newThreads = draft.comments.filter(c => c.inReplyTo === undefined);
		const replies = draft.comments.filter((c): c is KrtReviewDraftComment & { inReplyTo: number } => c.inReplyTo !== undefined);
		const submission = {
			commitId: draft.headSha,
			event: args.event,
			body: args.body,
			comments: newThreads.map(c => ({
				path: c.path,
				line: c.line,
				side: c.side,
				body: c.body,
			})),
			replies: replies.map(c => ({
				inReplyTo: c.inReplyTo,
				body: c.body,
			})),
		};
		this.logService.info(`[krt] submitReview ${args.prUrl} event=${args.event} new=${newThreads.length} replies=${replies.length}`);
		await this.pullRequestProvider.submitReview(args.prUrl, submission);
		this.drafts.delete(args.prUrl);
		this.write();
		this._onDidChange.fire(args.prUrl);
	}

	private read(): Map<string, KrtReviewDraft> {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return new Map();
		}
		try {
			const parsed = JSON.parse(raw) as PersistedEnvelope;
			if (parsed.version !== 1 || !parsed.drafts) {
				return new Map();
			}
			const out = new Map<string, KrtReviewDraft>();
			for (const [url, draft] of Object.entries(parsed.drafts)) {
				if (draft && Array.isArray(draft.comments)) {
					out.set(url, draft);
				}
			}
			return out;
		} catch (err) {
			this.logService.warn('[krt] reviewDraftService: failed to parse storage envelope', err);
			return new Map();
		}
	}

	private write(): void {
		const envelope: PersistedEnvelope = {
			version: 1,
			drafts: Object.fromEntries(this.drafts.entries()),
		};
		this.storageService.store(
			STORAGE_KEY,
			JSON.stringify(envelope),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
	}
}

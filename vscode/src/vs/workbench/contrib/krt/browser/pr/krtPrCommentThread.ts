/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import {
	Comment,
	CommentAuthorInformation,
	CommentInput,
	CommentThread,
	CommentThreadApplicability,
	CommentThreadCollapsibleState,
	CommentThreadState,
} from '../../../../../editor/common/languages.js';

/**
 * Minimal `CommentThread<IRange>` implementation used by
 * `KrtPrCommentController`. Mirrors `MainThreadCommentThread` (the
 * extension-host plumbing shape) but skipping the RPC surface — KRT's
 * comment data comes from GitHub via `gh`, not from an extension RPC.
 *
 * The thread's `range` is in real file line numbers (1..N). Phase 10's
 * URI strategy means model lines == real file lines on both sides
 * (file:// for modified, krt-git:// for original — both full content),
 * so no translation map is needed. That's a big simplification over
 * the Phase 9.5 attempt.
 */
export class KrtPrCommentThread implements CommentThread<IRange> {

	readonly commentThreadHandle: number;
	readonly controllerHandle: number;
	readonly threadId: string;
	readonly resource: string;
	extensionId?: string;

	private _range: IRange | undefined;
	get range(): IRange | undefined { return this._range; }
	set range(value: IRange | undefined) { this._range = value; }

	private _comments: ReadonlyArray<Comment> | undefined;
	get comments(): ReadonlyArray<Comment> | undefined { return this._comments; }
	set comments(value: ReadonlyArray<Comment> | undefined) {
		this._comments = value;
		this._onDidChangeComments.fire(value);
	}

	private readonly _onDidChangeComments = new Emitter<readonly Comment[] | undefined>();
	readonly onDidChangeComments: Event<readonly Comment[] | undefined> = this._onDidChangeComments.event;

	private _label: string | undefined;
	get label(): string | undefined { return this._label; }
	set label(value: string | undefined) {
		this._label = value;
		this._onDidChangeLabel.fire(value);
	}

	private readonly _onDidChangeLabel = new Emitter<string | undefined>();
	readonly onDidChangeLabel: Event<string | undefined> = this._onDidChangeLabel.event;

	contextValue: string | undefined;

	private _collapsibleState: CommentThreadCollapsibleState | undefined;
	get collapsibleState(): CommentThreadCollapsibleState | undefined { return this._collapsibleState; }
	set collapsibleState(value: CommentThreadCollapsibleState | undefined) {
		// Latch the initial value the first time it's set so the
		// workbench's `initialCollapsibleState` autorun (which reads
		// from `_initialCollapsibleState` on first fire) sees a sane
		// value rather than `undefined`.
		if (this._initialCollapsibleState === undefined) {
			this._initialCollapsibleState = value;
			this._onDidChangeInitialCollapsibleState.fire(value);
		}
		if (value !== this._collapsibleState) {
			this._collapsibleState = value;
			this._onDidChangeCollapsibleState.fire(value);
		}
	}
	private readonly _onDidChangeCollapsibleState = new Emitter<CommentThreadCollapsibleState | undefined>();
	readonly onDidChangeCollapsibleState: Event<CommentThreadCollapsibleState | undefined> = this._onDidChangeCollapsibleState.event;

	private _initialCollapsibleState: CommentThreadCollapsibleState | undefined;
	get initialCollapsibleState(): CommentThreadCollapsibleState | undefined { return this._initialCollapsibleState; }
	set initialCollapsibleState(value: CommentThreadCollapsibleState | undefined) {
		// `ReviewZoneWidget`'s constructor writes to this directly. The
		// upstream `CommentThread` interface declares it as a non-
		// readonly property, so implementers (us included) must allow
		// the assignment. Latching also fires the change event so
		// downstream listeners react.
		if (value !== this._initialCollapsibleState) {
			this._initialCollapsibleState = value;
			this._onDidChangeInitialCollapsibleState.fire(value);
		}
	}
	private readonly _onDidChangeInitialCollapsibleState = new Emitter<CommentThreadCollapsibleState | undefined>();
	readonly onDidChangeInitialCollapsibleState: Event<CommentThreadCollapsibleState | undefined> = this._onDidChangeInitialCollapsibleState.event;

	private _state: CommentThreadState | undefined;
	get state(): CommentThreadState | undefined { return this._state; }
	set state(value: CommentThreadState | undefined) {
		this._state = value;
		this._onDidChangeState.fire(value);
	}
	private readonly _onDidChangeState = new Emitter<CommentThreadState | undefined>();
	readonly onDidChangeState: Event<CommentThreadState | undefined> = this._onDidChangeState.event;

	applicability: CommentThreadApplicability | undefined;

	private _canReply: boolean | CommentAuthorInformation;
	get canReply(): boolean | CommentAuthorInformation { return this._canReply; }
	set canReply(value: boolean | CommentAuthorInformation) {
		this._canReply = value;
		this._onDidChangeCanReply.fire(!!value);
	}
	private readonly _onDidChangeCanReply = new Emitter<boolean>();
	readonly onDidChangeCanReply: Event<boolean> = this._onDidChangeCanReply.event;

	private _input: CommentInput | undefined;
	get input(): CommentInput | undefined { return this._input; }
	set input(value: CommentInput | undefined) {
		this._input = value;
		this._onDidChangeInput.fire(value);
	}
	private readonly _onDidChangeInput = new Emitter<CommentInput | undefined>();
	readonly onDidChangeInput: Event<CommentInput | undefined> = this._onDidChangeInput.event;

	isDisposed = false;
	isTemplate: boolean;

	constructor(args: {
		commentThreadHandle: number;
		controllerHandle: number;
		threadId: string;
		resource: string;
		range: IRange | undefined;
		comments: readonly Comment[];
		isTemplate?: boolean;
		canReply?: boolean | CommentAuthorInformation;
		state?: CommentThreadState;
		collapsibleState?: CommentThreadCollapsibleState;
	}) {
		this.commentThreadHandle = args.commentThreadHandle;
		this.controllerHandle = args.controllerHandle;
		this.threadId = args.threadId;
		this.resource = args.resource;
		this._range = args.range;
		this._comments = args.comments;
		this.isTemplate = args.isTemplate ?? false;
		this._canReply = args.canReply ?? false;
		this._state = args.state ?? CommentThreadState.Unresolved;
		this._collapsibleState = args.collapsibleState ?? CommentThreadCollapsibleState.Expanded;
		this._initialCollapsibleState = this._collapsibleState;
	}

	isDocumentCommentThread(): this is CommentThread<IRange> {
		return true;
	}

	dispose(): void {
		this.isDisposed = true;
		this._onDidChangeComments.dispose();
		this._onDidChangeLabel.dispose();
		this._onDidChangeCollapsibleState.dispose();
		this._onDidChangeInitialCollapsibleState.dispose();
		this._onDidChangeState.dispose();
		this._onDidChangeCanReply.dispose();
		this._onDidChangeInput.dispose();
	}
}

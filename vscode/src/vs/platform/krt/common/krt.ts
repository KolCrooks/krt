/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Core PR data shapes. Renderer-safe — no Node imports in this file.
 * These are the types every KRT view consumes; field set is the
 * minimum required across Phases 3-9 plus a few well-known optionals.
 *
 * Wire-format note: instances cross the main↔renderer IPC boundary
 * via `ProxyChannel`, which JSON-serializes. Keep the shape strictly
 * data — no methods, no Date objects (use ISO-8601 strings), no
 * Maps/Sets.
 */

export type PullRequestState = 'open' | 'closed' | 'merged' | 'draft';

export interface PullRequestRef {
	readonly sha: string;
	readonly ref: string;
	readonly label: string;
}

export interface PullRequestUser {
	readonly login: string;
	readonly avatarUrl?: string;
}

export interface PullRequestStats {
	readonly additions: number;
	readonly deletions: number;
	readonly changedFiles: number;
}

export interface PullRequest {
	readonly url: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly state: PullRequestState;
	readonly author: PullRequestUser;
	readonly head: PullRequestRef;
	readonly base: PullRequestRef;
	readonly stats: PullRequestStats;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly mergedAt?: string;
	readonly closedAt?: string;
	readonly labels: readonly string[];
	readonly reviewers: readonly Reviewer[];
	readonly checks: readonly CheckRun[];
	readonly comments: readonly Comment[];
}

export type ReviewerState = 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface Reviewer {
	readonly user: PullRequestUser;
	readonly state: ReviewerState;
	readonly submittedAt?: string;
}

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | 'stale' | 'pending';

export interface CheckRun {
	readonly name: string;
	readonly conclusion: CheckConclusion;
	readonly detailsUrl?: string;
	readonly startedAt?: string;
	readonly completedAt?: string;
}

export type CommentLocation =
	| { readonly kind: 'issue' }
	| { readonly kind: 'review'; readonly path: string; readonly line: number; readonly side: 'LEFT' | 'RIGHT' };

export interface Comment {
	readonly id: number;
	readonly author: PullRequestUser;
	readonly body: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly location: CommentLocation;
}

export interface PullRequestFile {
	readonly path: string;
	readonly previousPath?: string;
	readonly status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
	readonly additions: number;
	readonly deletions: number;
	readonly patch?: string;
}

/**
 * Discriminator on the Activity feed (Discussion / Automation tabs).
 * Discussion items are `Comment`; Automation items land here.
 */
export interface AutomationEvent {
	readonly id: string;
	readonly kind: 'commit' | 'review_requested' | 'label_added' | 'label_removed' | 'merge' | 'close' | 'reopen' | 'check_run' | 'force_push';
	readonly actor: PullRequestUser;
	readonly at: string;
	readonly summary: string;
}

/**
 * Recent-PR record persisted to `IStorageService`. Kept tiny on
 * purpose — full `PullRequest` objects are re-fetched on open.
 */
export interface RecentPullRequest {
	readonly url: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly openedAt: string;
}

/**
 * Lighter-than-`PullRequest` shape the Search overlay renders one
 * row per. Only the fields the row actually needs.
 */
export interface PullRequestSummary {
	readonly url: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly state: PullRequestState;
	readonly author: PullRequestUser;
	readonly updatedAt: string;
}

/**
 * Search scope tabs in the overlay. Server-side query qualifiers
 * are appended in the provider implementation.
 */
export type SearchScope = 'all-open' | 'reviewed' | 'awaiting-review';

const PULL_REQUEST_URL_RE = /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>\d+)/;

/**
 * Pure client-side parse of a GitHub PR URL. Returns `undefined`
 * for malformed input — callers decide whether to throw a typed
 * `KrtError` or surface the error inline. Lives in `common/` so
 * renderer + main share the regex.
 */
export function parsePullRequestUrl(url: string): { readonly owner: string; readonly repo: string; readonly number: number } | undefined {
	const match = PULL_REQUEST_URL_RE.exec(url);
	if (!match?.groups) {
		return undefined;
	}
	return {
		owner: match.groups.owner,
		repo: match.groups.repo,
		number: Number(match.groups.number),
	};
}

// ---------- Service decorators ----------

export const IGhClient = createDecorator<IGhClient>('krtGhClient');

/**
 * Thin shell-out wrapper around the user's `gh` CLI. All KRT GitHub
 * access funnels through this one service. Implementations live in
 * `electron-main/`; the renderer binds via `ProxyChannel`.
 */
export interface IGhClient {
	readonly _serviceBrand: undefined;
	/** Resolves once per process; caches result. Throws GhMissingError if not on PATH. */
	detect(): Promise<GhInfo>;
	/** `gh api <path>` — accumulates stdout, JSON-parses. */
	apiJson<T = unknown>(path: string): Promise<T>;
	/**
	 * `gh api <path> -X POST --input -` with the JSON-encoded body on
	 * stdin. Used for create-comment / approve-review / etc. — any
	 * write endpoint where the gh CLI's `-f key=val` form encoding is
	 * the wrong shape.
	 */
	apiPostJson<T = unknown>(path: string, body: object): Promise<T>;
	/**
	 * `gh api <path> -H 'Accept: <accept>'` — returns the response body
	 * as a string without JSON-parsing. For the file-content API
	 * (`/repos/.../contents/...`), pass
	 * `application/vnd.github.raw` so GitHub returns the raw bytes
	 * instead of a base64-wrapped JSON envelope.
	 */
	apiRaw(path: string, accept: string): Promise<string>;
}

export interface GhInfo {
	readonly version: string;
	readonly path: string;
}

export const IPullRequestProvider = createDecorator<IPullRequestProvider>('krtPullRequestProvider');

export interface IPullRequestProvider {
	readonly _serviceBrand: undefined;
	getPullRequest(url: string): Promise<PullRequest>;
	/**
	 * Server-side PR search via the GitHub `search/issues` endpoint
	 * (filtered to PRs by `is:pr`). Up to 25 results, sorted by
	 * `updated` desc. Throws `KrtError` on auth/rate-limit failures
	 * (see `errors.ts`).
	 *
	 * `repos` (Phase 8.6) restricts the search to the listed
	 * `owner/repo` pairs. When non-empty, the search becomes
	 * `(repo:o/n OR repo:o/n …) <existing query>` so results never
	 * include PRs from repos the user hasn't registered. Empty array
	 * (or omitted) is unrestricted.
	 */
	search(query: string, scope: SearchScope, repos?: readonly { owner: string; repo: string }[]): Promise<readonly PullRequestSummary[]>;
	/**
	 * Lazy fetch of the PR's automation events (commits, label
	 * changes, review requests, merges, force pushes …) — Phase 5
	 * Activity feed's `Automation` tab. Discussion comments live on
	 * `PullRequest.comments` from `getPullRequest`.
	 */
	getActivity(url: string): Promise<readonly AutomationEvent[]>;
	/**
	 * Post a top-level discussion comment on the PR (issue comment,
	 * not a review comment anchored to a line). Returns the new
	 * `Comment` so the pane can append it without a re-fetch.
	 */
	postIssueComment(url: string, body: string): Promise<Comment>;
	/**
	 * Phase 6: list of files changed by the PR with their unified
	 * `patch` text. Calls `repos/{o}/{r}/pulls/{n}/files`.
	 */
	getFiles(url: string): Promise<readonly PullRequestFile[]>;
	/**
	 * Phase 6: read existing inline review comments on the PR. Each
	 * `Comment` has `location.kind === 'review'` with `path`, `line`,
	 * and `side`. Calls `repos/{o}/{r}/pulls/{n}/comments`.
	 */
	getReviewComments(url: string): Promise<readonly Comment[]>;
	/**
	 * Phase 6: create a single-line review comment anchored to a
	 * file/line. POSTs to `repos/{o}/{r}/pulls/{n}/comments`. Returns
	 * the new `Comment` so the pane can append without a re-fetch.
	 */
	postReviewComment(url: string, draft: ReviewCommentDraft): Promise<Comment>;
	/**
	 * Phase 10 review-mode submit. POSTs every accumulated draft comment
	 * to `repos/{o}/{r}/pulls/{n}/reviews` in a single request along with
	 * the review event (Comment / Approve / Request Changes) and an
	 * optional summary body. GitHub returns the review record; callers
	 * are expected to refetch the PR's review-comment list afterwards.
	 */
	submitReview(url: string, submission: ReviewSubmission): Promise<void>;
	/**
	 * Phase 10/B fallback: fetch the raw text of a file at a specific
	 * SHA via `gh api repos/{o}/{r}/contents/{path}?ref={sha}` with
	 * `Accept: application/vnd.github.raw`. Used when the local clone's
	 * `git show` can't satisfy the lookup — usually because the local
	 * view of the SHA doesn't have the file even though GitHub's view
	 * does.
	 *
	 * Throws `KrtError` on auth/rate-limit/404 — callers should treat
	 * the error as "file not in ref" and fall back to "added"
	 * rendering (no original side).
	 */
	getFileContent(owner: string, repo: string, ref: string, path: string): Promise<string>;
}

// ---------- AI client ----------

export const IKrtAiClient = createDecorator<IKrtAiClient>('krtAiClient');

/**
 * Main-process Anthropic client. The renderer would normally call
 * `api.anthropic.com` directly, but custom Anthropic-compatible
 * endpoints (corporate gateways, proxies) often don't return CORS
 * headers and the renderer can't reach them. Routing the call
 * through the main process bypasses CORS entirely — the same
 * pattern we already use for `gh`.
 */
export interface IKrtAiClient {
	readonly _serviceBrand: undefined;
	postMessages(request: AnthropicMessagesRequest): Promise<AnthropicMessagesResponse>;
	/**
	 * Same Anthropic call but with `stream: true` injected; main
	 * parses the SSE event stream and emits incremental events on
	 * `onStreamEvent`. The Promise resolves once the full stream is
	 * consumed and carries a synthesised non-streaming response shape
	 * (i.e. the same `{status,ok,text}` envelope as `postMessages`,
	 * with `text` containing a JSON envelope `{ content, usage }`)
	 * so existing parsers keep working.
	 */
	postMessagesStream(requestId: string, request: AnthropicMessagesRequest): Promise<AnthropicMessagesResponse>;
	readonly onStreamEvent: Event<AnthropicStreamEvent>;
}

export interface AnthropicMessagesRequest {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly anthropicVersion: string;
	/** Pre-serialised JSON body so the main side doesn't second-guess the shape. */
	readonly body: string;
}

export interface AnthropicMessagesResponse {
	readonly status: number;
	readonly ok: boolean;
	readonly text: string;
}

/**
 * Incremental event from a streaming `postMessagesStream` call.
 * Multiple in-flight streams are correlated by `requestId`.
 */
export interface AnthropicStreamEvent {
	readonly requestId: string;
	readonly kind: 'text' | 'usage' | 'done' | 'error';
	/** Present for `kind === 'text'`: the new delta text. */
	readonly text?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheCreationTokens?: number;
	readonly errorMessage?: string;
}

/**
 * Payload for `IPullRequestProvider.postReviewComment`. Single-line
 * comment only in v1 — multi-line ranges and reply threads come
 * later. `commitId` is the head SHA at the time of comment so
 * GitHub can detect outdated lines.
 */
export interface ReviewCommentDraft {
	readonly commitId: string;
	readonly path: string;
	readonly line: number;
	readonly side: 'LEFT' | 'RIGHT';
	readonly body: string;
}

/**
 * Phase 10 batch review submission. Maps to GitHub's
 * `POST /repos/{o}/{r}/pulls/{n}/reviews` endpoint, which accepts an
 * overall review event (Comment / Approve / Request Changes), an
 * optional summary body, and an array of inline comments. Inline
 * comments without a `commit_id` inherit the review's `commitId`.
 */
export type ReviewSubmissionEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewSubmissionComment {
	readonly path: string;
	readonly line: number;
	readonly side: 'LEFT' | 'RIGHT';
	readonly body: string;
}

/**
 * Reply to an existing review comment thread. GitHub's batch-review
 * endpoint doesn't accept `in_reply_to`, so replies are POSTed
 * individually to `/repos/{o}/{r}/pulls/{n}/comments` after the batch
 * lands.
 */
export interface ReviewSubmissionReply {
	readonly inReplyTo: number;
	readonly body: string;
}

export interface ReviewSubmission {
	readonly commitId: string;
	readonly event: ReviewSubmissionEvent;
	readonly body?: string;
	readonly comments: readonly ReviewSubmissionComment[];
	readonly replies: readonly ReviewSubmissionReply[];
}

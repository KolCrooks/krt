/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AutomationEvent,
	CheckConclusion,
	CheckRun,
	Comment,
	IGhClient,
	IPullRequestProvider,
	parsePullRequestUrl,
	PullRequest,
	PullRequestFile,
	PullRequestState,
	PullRequestSummary,
	Reviewer,
	ReviewerState,
	ReviewCommentDraft,
	ReviewSubmission,
	SearchScope,
} from '../common/krt.js';
import { badPullRequestUrl } from '../common/errors.js';

interface GhUser {
	login: string;
	avatar_url?: string;
}

interface GhRef {
	sha: string;
	ref: string;
	label: string;
}

interface GhPullRequest {
	html_url: string;
	number: number;
	title: string;
	body: string | null;
	state: 'open' | 'closed';
	draft: boolean;
	merged: boolean;
	user: GhUser;
	head: GhRef;
	base: GhRef;
	additions: number;
	deletions: number;
	changed_files: number;
	created_at: string;
	updated_at: string;
	merged_at: string | null;
	closed_at: string | null;
	labels: ReadonlyArray<{ name: string }>;
	requested_reviewers: ReadonlyArray<GhUser>;
}

const ISSUE_HTML_URL_RE = /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?:pull|issues)\/(?<number>\d+)/;
const SEARCH_PER_PAGE = 25;

interface GhSearchResponse {
	items: GhSearchItem[];
}

interface GhSearchItem {
	html_url: string;
	number: number;
	title: string;
	state: 'open' | 'closed';
	draft?: boolean;
	updated_at: string;
	user: GhUser;
	pull_request?: { merged_at: string | null };
}

interface GhIssueComment {
	id: number;
	user: GhUser;
	body: string;
	created_at: string;
	updated_at: string;
}

interface GhReview {
	id: number;
	user: GhUser;
	state: 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
	submitted_at: string | null;
}

interface GhCheckRun {
	name: string;
	status: 'queued' | 'in_progress' | 'completed';
	conclusion: string | null;
	details_url?: string;
	started_at?: string;
	completed_at?: string;
}

interface GhChecksResponse {
	check_runs: GhCheckRun[];
}

interface GhPullRequestFile {
	filename: string;
	previous_filename?: string;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
	additions: number;
	deletions: number;
	patch?: string;
}

interface GhReviewComment {
	id: number;
	user: GhUser;
	body: string;
	created_at: string;
	updated_at: string;
	path: string;
	line: number | null;
	original_line?: number | null;
	side?: 'LEFT' | 'RIGHT' | null;
}

interface GhTimelineEvent {
	id?: number;
	node_id?: string;
	event: string;
	created_at?: string;
	actor?: GhUser;
	user?: GhUser;
	committer?: GhUser;
	label?: { name: string };
	requested_reviewer?: GhUser;
	sha?: string;
	commit_id?: string;
	message?: string;
	state?: string;
	check_suite?: { conclusion: string | null };
}

export class PullRequestProviderMainService implements IPullRequestProvider {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IGhClient private readonly ghClient: IGhClient,
	) { }

	async getPullRequest(url: string): Promise<PullRequest> {
		const parsed = parsePullRequestUrl(url);
		if (!parsed) {
			throw badPullRequestUrl(url);
		}
		const base = `repos/${parsed.owner}/${parsed.repo}`;
		const data = await this.ghClient.apiJson<GhPullRequest>(`${base}/pulls/${parsed.number}`);
		const emptyChecks: GhChecksResponse = { check_runs: [] };
		const [issueComments, reviews, checks] = await Promise.all([
			this.ghClient.apiJson<GhIssueComment[]>(`${base}/issues/${parsed.number}/comments?per_page=100`).catch((): GhIssueComment[] => []),
			this.ghClient.apiJson<GhReview[]>(`${base}/pulls/${parsed.number}/reviews?per_page=100`).catch((): GhReview[] => []),
			this.ghClient.apiJson<GhChecksResponse>(`${base}/commits/${data.head.sha}/check-runs?per_page=100`).catch((): GhChecksResponse => emptyChecks),
		]);
		return mapPullRequest(parsed, data, issueComments, reviews, checks.check_runs ?? []);
	}

	async search(query: string, scope: SearchScope, repos?: readonly { owner: string; repo: string }[]): Promise<readonly PullRequestSummary[]> {
		const q = buildSearchQuery(query, scope, repos);
		const path = `search/issues?per_page=${SEARCH_PER_PAGE}&sort=updated&order=desc&q=${encodeURIComponent(q)}`;
		const data = await this.ghClient.apiJson<GhSearchResponse>(path);
		const items = Array.isArray(data?.items) ? data.items : [];
		const out: PullRequestSummary[] = [];
		for (const item of items) {
			if (!item.pull_request) {
				continue;
			}
			const parsed = ISSUE_HTML_URL_RE.exec(item.html_url);
			if (!parsed?.groups) {
				continue;
			}
			out.push({
				url: item.html_url,
				owner: parsed.groups.owner,
				repo: parsed.groups.repo,
				number: item.number,
				title: item.title,
				state: deriveSummaryState(item),
				author: { login: item.user.login, avatarUrl: item.user.avatar_url },
				updatedAt: item.updated_at,
			});
		}
		return out;
	}

	async getActivity(url: string): Promise<readonly AutomationEvent[]> {
		const parsed = parsePullRequestUrl(url);
		if (!parsed) {
			throw badPullRequestUrl(url);
		}
		const path = `repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/timeline?per_page=100`;
		const events = await this.ghClient.apiJson<GhTimelineEvent[]>(path).catch(() => [] as GhTimelineEvent[]);
		const out: AutomationEvent[] = [];
		for (const ev of events) {
			const mapped = mapTimelineEvent(ev);
			if (mapped) {
				out.push(mapped);
			}
		}
		return out;
	}

	async postIssueComment(url: string, body: string): Promise<Comment> {
		const parsed = parsePullRequestUrl(url);
		if (!parsed) {
			throw badPullRequestUrl(url);
		}
		const path = `repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments`;
		const created = await this.ghClient.apiPostJson<GhIssueComment>(path, { body });
		return mapIssueComment(created);
	}

	async getFiles(url: string): Promise<readonly PullRequestFile[]> {
		const parsed = parsePullRequestUrl(url);
		if (!parsed) {
			throw badPullRequestUrl(url);
		}
		const path = `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/files?per_page=100`;
		const files = await this.ghClient.apiJson<GhPullRequestFile[]>(path);
		return files.map(mapPullRequestFile);
	}

	async getReviewComments(url: string): Promise<readonly Comment[]> {
		const parsed = parsePullRequestUrl(url);
		if (!parsed) {
			throw badPullRequestUrl(url);
		}
		const path = `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments?per_page=100`;
		const comments = await this.ghClient.apiJson<GhReviewComment[]>(path);
		const out: Comment[] = [];
		for (const c of comments) {
			const mapped = mapReviewComment(c);
			if (mapped) {
				out.push(mapped);
			}
		}
		return out;
	}

	async postReviewComment(url: string, draft: ReviewCommentDraft): Promise<Comment> {
		const parsed = parsePullRequestUrl(url);
		if (!parsed) {
			throw badPullRequestUrl(url);
		}
		const path = `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`;
		const created = await this.ghClient.apiPostJson<GhReviewComment>(path, {
			body: draft.body,
			commit_id: draft.commitId,
			path: draft.path,
			line: draft.line,
			side: draft.side,
		});
		const mapped = mapReviewComment(created);
		if (!mapped) {
			// GitHub always returns path+line for a successfully posted single-line
			// comment; falling back to issue location keeps the type total.
			return mapIssueComment({
				id: created.id,
				user: created.user,
				body: created.body,
				created_at: created.created_at,
				updated_at: created.updated_at,
			});
		}
		return mapped;
	}

	async submitReview(url: string, submission: ReviewSubmission): Promise<void> {
		const parsed = parsePullRequestUrl(url);
		if (!parsed) {
			throw badPullRequestUrl(url);
		}
		// Two endpoints: top-level review (batches new threads + the
		// approve / request-changes verdict) and per-reply POSTs (GitHub
		// rejects `in_reply_to` inside the review-batch shape).
		const hasReviewPayload = submission.comments.length > 0 || (submission.body?.length ?? 0) > 0 || submission.event !== 'COMMENT';
		if (hasReviewPayload) {
			const reviewsPath = `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/reviews`;
			await this.ghClient.apiPostJson(reviewsPath, {
				commit_id: submission.commitId,
				event: submission.event,
				body: submission.body ?? '',
				comments: submission.comments.map(c => ({
					path: c.path,
					line: c.line,
					side: c.side,
					body: c.body,
				})),
			});
		}
		if (submission.replies.length > 0) {
			const commentsPath = `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`;
			for (const reply of submission.replies) {
				await this.ghClient.apiPostJson(commentsPath, {
					body: reply.body,
					in_reply_to: reply.inReplyTo,
				});
			}
		}
	}

	async getFileContent(owner: string, repo: string, ref: string, path: string): Promise<string> {
		const encodedPath = path.split('/').map(encodeURIComponent).join('/');
		const url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
		return await this.ghClient.apiRaw(url, 'application/vnd.github.raw');
	}
}

function buildSearchQuery(query: string, scope: SearchScope, repos?: readonly { owner: string; repo: string }[]): string {
	const trimmed = query.trim();
	const qualifiers: string[] = ['is:pr', 'archived:false'];
	switch (scope) {
		case 'all-open':
			qualifiers.push('is:open');
			if (!trimmed) {
				qualifiers.push('author:@me');
			}
			break;
		case 'reviewed':
			qualifiers.push('reviewed-by:@me');
			break;
		case 'awaiting-review':
			qualifiers.push('review-requested:@me');
			break;
	}
	// Workspace filter — restrict to the listed repos. GitHub search
	// supports OR with parens, so multiple workspaces become
	// `(repo:o/n OR repo:o/n …)`. The qualifiers/text follow.
	const repoFilter = (repos && repos.length > 0)
		? `(${repos.map(r => `repo:${r.owner}/${r.repo}`).join(' OR ')})`
		: '';
	const parts = [repoFilter, trimmed, qualifiers.join(' ')].filter(s => s.length > 0);
	return parts.join(' ');
}

function deriveSummaryState(item: GhSearchItem): PullRequestState {
	if (item.pull_request?.merged_at) {
		return 'merged';
	}
	if (item.state === 'closed') {
		return 'closed';
	}
	if (item.draft) {
		return 'draft';
	}
	return 'open';
}

function mapPullRequest(
	parsed: { owner: string; repo: string; number: number },
	data: GhPullRequest,
	issueComments: readonly GhIssueComment[],
	reviews: readonly GhReview[],
	checks: readonly GhCheckRun[],
): PullRequest {
	return {
		url: data.html_url,
		owner: parsed.owner,
		repo: parsed.repo,
		number: data.number,
		title: data.title,
		body: data.body ?? '',
		state: deriveState(data),
		author: { login: data.user.login, avatarUrl: data.user.avatar_url },
		head: { sha: data.head.sha, ref: data.head.ref, label: data.head.label },
		base: { sha: data.base.sha, ref: data.base.ref, label: data.base.label },
		stats: { additions: data.additions, deletions: data.deletions, changedFiles: data.changed_files },
		createdAt: data.created_at,
		updatedAt: data.updated_at,
		mergedAt: data.merged_at ?? undefined,
		closedAt: data.closed_at ?? undefined,
		labels: data.labels.map(l => l.name),
		reviewers: mapReviewers(data.requested_reviewers ?? [], reviews),
		checks: checks.map(mapCheckRun),
		comments: issueComments.map(mapIssueComment),
	};
}

function mapReviewers(requested: readonly GhUser[], reviews: readonly GhReview[]): Reviewer[] {
	const byLogin = new Map<string, Reviewer>();
	// Latest review per login wins.
	const sortedReviews = [...reviews].sort((a, b) => {
		const aT = a.submitted_at ?? '';
		const bT = b.submitted_at ?? '';
		return aT < bT ? -1 : aT > bT ? 1 : 0;
	});
	for (const r of sortedReviews) {
		if (!r.user) {
			continue;
		}
		byLogin.set(r.user.login, {
			user: { login: r.user.login, avatarUrl: r.user.avatar_url },
			state: mapReviewerState(r.state),
			submittedAt: r.submitted_at ?? undefined,
		});
	}
	for (const u of requested) {
		if (!byLogin.has(u.login)) {
			byLogin.set(u.login, {
				user: { login: u.login, avatarUrl: u.avatar_url },
				state: 'pending',
			});
		}
	}
	return [...byLogin.values()];
}

function mapReviewerState(state: GhReview['state']): ReviewerState {
	switch (state) {
		case 'APPROVED': return 'approved';
		case 'CHANGES_REQUESTED': return 'changes_requested';
		case 'COMMENTED': return 'commented';
		case 'DISMISSED': return 'dismissed';
		case 'PENDING':
		default:
			return 'pending';
	}
}

function mapCheckRun(c: GhCheckRun): CheckRun {
	return {
		name: c.name,
		conclusion: deriveCheckConclusion(c),
		detailsUrl: c.details_url,
		startedAt: c.started_at,
		completedAt: c.completed_at,
	};
}

function deriveCheckConclusion(c: GhCheckRun): CheckConclusion {
	if (c.status !== 'completed') {
		return 'pending';
	}
	const concluded = (c.conclusion ?? '') as CheckConclusion;
	switch (concluded) {
		case 'success':
		case 'failure':
		case 'neutral':
		case 'cancelled':
		case 'timed_out':
		case 'action_required':
		case 'skipped':
		case 'stale':
			return concluded;
		default:
			return 'pending';
	}
}

function mapIssueComment(c: GhIssueComment): Comment {
	return {
		id: c.id,
		author: { login: c.user.login, avatarUrl: c.user.avatar_url },
		body: c.body,
		createdAt: c.created_at,
		updatedAt: c.updated_at,
		location: { kind: 'issue' },
	};
}

function mapTimelineEvent(ev: GhTimelineEvent): AutomationEvent | undefined {
	const at = ev.created_at ?? '';
	const actor = ev.actor ?? ev.user ?? ev.committer ?? { login: 'github' };
	const id = ev.id !== undefined ? String(ev.id) : (ev.node_id ?? `${ev.event}-${at}`);
	const baseUser = { login: actor.login, avatarUrl: actor.avatar_url };
	switch (ev.event) {
		case 'committed':
			return {
				id,
				kind: 'commit',
				actor: baseUser,
				at: at || '',
				summary: trimMessage(ev.message ?? ev.sha ?? 'commit'),
			};
		case 'review_requested':
			return {
				id,
				kind: 'review_requested',
				actor: baseUser,
				at,
				summary: ev.requested_reviewer?.login ? `requested review from ${ev.requested_reviewer.login}` : 'requested a review',
			};
		case 'labeled':
			return {
				id,
				kind: 'label_added',
				actor: baseUser,
				at,
				summary: ev.label ? `added label "${ev.label.name}"` : 'added a label',
			};
		case 'unlabeled':
			return {
				id,
				kind: 'label_removed',
				actor: baseUser,
				at,
				summary: ev.label ? `removed label "${ev.label.name}"` : 'removed a label',
			};
		case 'merged':
			return { id, kind: 'merge', actor: baseUser, at, summary: 'merged the pull request' };
		case 'closed':
			return { id, kind: 'close', actor: baseUser, at, summary: 'closed the pull request' };
		case 'reopened':
			return { id, kind: 'reopen', actor: baseUser, at, summary: 'reopened the pull request' };
		case 'head_ref_force_pushed':
			return { id, kind: 'force_push', actor: baseUser, at, summary: 'force-pushed the head branch' };
		default:
			return undefined;
	}
}

function trimMessage(s: string): string {
	const firstLine = s.split('\n', 1)[0] ?? s;
	return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
}

function mapPullRequestFile(f: GhPullRequestFile): PullRequestFile {
	return {
		path: f.filename,
		previousPath: f.previous_filename,
		status: f.status,
		additions: f.additions,
		deletions: f.deletions,
		patch: f.patch,
	};
}

function mapReviewComment(c: GhReviewComment): Comment | undefined {
	const line = c.line ?? c.original_line ?? undefined;
	if (!c.path || line === undefined || line === null) {
		return undefined;
	}
	return {
		id: c.id,
		author: { login: c.user.login, avatarUrl: c.user.avatar_url },
		body: c.body,
		createdAt: c.created_at,
		updatedAt: c.updated_at,
		location: { kind: 'review', path: c.path, line, side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT' },
	};
}

function deriveState(data: GhPullRequest): PullRequestState {
	if (data.merged) {
		return 'merged';
	}
	if (data.state === 'closed') {
		return 'closed';
	}
	if (data.draft) {
		return 'draft';
	}
	return 'open';
}

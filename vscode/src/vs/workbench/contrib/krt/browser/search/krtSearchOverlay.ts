/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './krtSearchOverlay.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { localize } from '../../../../../nls.js';
import { isKrtError } from '../../../../../platform/krt/common/errors.js';
import { IGhClient, IPullRequestProvider, parsePullRequestUrl, PullRequestSummary, RecentPullRequest, SearchScope } from '../../../../../platform/krt/common/krt.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { readRecentPullRequests } from '../krtRecentPullRequests.js';
import { IKrtWorkspaceRegistry } from '../workspace/krtWorkspaceRegistry.js';
import { KrtPullRequestEditorInput } from '../pr/krtPullRequestEditorInput.js';
import { IKrtSearchService } from './krtSearchService.js';

const SEARCH_DEBOUNCE_MS = 250;
const RECENTS_GRID_LIMIT = 6;

interface ScopeTab {
	readonly scope: SearchScope;
	readonly label: string;
}

const SCOPE_TABS: readonly ScopeTab[] = [
	{ scope: 'all-open', label: localize('krt.search.scope.allOpen', "All open") },
	{ scope: 'reviewed', label: localize('krt.search.scope.reviewed', "You've reviewed") },
	{ scope: 'awaiting-review', label: localize('krt.search.scope.awaiting', "Awaiting your review") },
];

export class KrtSearchService extends Disposable implements IKrtSearchService {

	declare readonly _serviceBrand: undefined;

	private overlay: KrtSearchOverlay | undefined;

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IPullRequestProvider private readonly pullRequestProvider: IPullRequestProvider,
		@IGhClient private readonly ghClient: IGhClient,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IKrtWorkspaceRegistry private readonly workspaceRegistry: IKrtWorkspaceRegistry,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	open(): void {
		this.ensureOverlay().open();
	}

	close(): void {
		this.overlay?.close();
	}

	toggle(): void {
		this.ensureOverlay().toggle();
	}

	private ensureOverlay(): KrtSearchOverlay {
		if (!this.overlay) {
			this.overlay = this._register(new KrtSearchOverlay(
				this.layoutService.mainContainer,
				this.pullRequestProvider,
				this.ghClient,
				this.editorService,
				this.storageService,
				this.logService,
				this.workspaceRegistry,
				this.commandService,
			));
		}
		return this.overlay;
	}
}

class KrtSearchOverlay extends Disposable {

	private readonly root: HTMLElement;
	private readonly inputElement: HTMLInputElement;
	private readonly tabsElement: HTMLElement;
	private readonly resultsElement: HTMLElement;
	private readonly recentsContainer: HTMLElement;
	private readonly recentsGrid: HTMLElement;

	private isOpen = false;
	private scope: SearchScope = 'all-open';
	private query = '';
	private debounceHandle: ReturnType<typeof setTimeout> | undefined;
	private inflight: CancellationTokenSource | undefined;
	private results: readonly PullRequestSummary[] = [];
	private resultRowElements: HTMLElement[] = [];
	private selectedIndex = 0;
	private gh: { ok: true } | { ok: false; kind: string; message: string; hint: string } | undefined;

	private readonly listeners = this._register(new DisposableStore());

	constructor(
		host: HTMLElement,
		private readonly pullRequestProvider: IPullRequestProvider,
		private readonly ghClient: IGhClient,
		private readonly editorService: IEditorService,
		private readonly storageService: IStorageService,
		private readonly logService: ILogService,
		private readonly workspaceRegistry: IKrtWorkspaceRegistry,
		private readonly commandService: ICommandService,
	) {
		super();
		this.root = DOM.append(host, DOM.$('.krt-search-overlay'));
		this.root.hidden = true;
		this.root.setAttribute('role', 'dialog');
		this.root.setAttribute('aria-label', localize('krt.search.dialogLabel', "KRT Search"));

		const card = DOM.append(this.root, DOM.$('.krt-search-card'));
		const inputRow = DOM.append(card, DOM.$('.krt-search-input-row'));
		const icon = DOM.append(inputRow, DOM.$('span.krt-search-icon')) as HTMLSpanElement;
		// allow-any-unicode-next-line
		icon.textContent = '⌕';
		this.inputElement = DOM.append(inputRow, DOM.$('input.krt-search-input')) as HTMLInputElement;
		this.inputElement.type = 'text';
		this.inputElement.placeholder = localize('krt.search.placeholder', "Search PRs by #number, repo, author, or title…");
		this.inputElement.spellcheck = false;
		const shortcut = DOM.append(inputRow, DOM.$('span.krt-search-shortcut'));
		shortcut.textContent = 'Esc';

		this.tabsElement = DOM.append(card, DOM.$('.krt-search-tabs'));
		this.renderTabs();

		this.resultsElement = DOM.append(card, DOM.$('.krt-search-results'));
		this.recentsContainer = DOM.append(card, DOM.$('.krt-search-recents'));
		const recentsHeader = DOM.append(this.recentsContainer, DOM.$('.krt-search-recents-header'));
		recentsHeader.textContent = localize('krt.search.recents', "Recent PRs");
		this.recentsGrid = DOM.append(this.recentsContainer, DOM.$('.krt-search-recents-grid'));

		this.attachEventListeners();
		this.renderResults();
	}

	open(): void {
		if (this.isOpen) {
			this.inputElement.focus();
			this.inputElement.select();
			return;
		}
		this.isOpen = true;
		this.root.hidden = false;
		this.refreshGh();
		this.refreshRecents();
		// Re-run when the registry changes (user adds a workspace from
		// the empty-state CTA), so results update without closing the
		// overlay. Listener is `_register`'d on the overlay instance,
		// but we attach lazily on open + clear on close so we don't
		// keep firing while hidden.
		this.listeners.add(this.workspaceRegistry.onDidChange(() => {
			if (this.isOpen) {
				void this.runSearch();
			}
		}));
		this.renderResults();
		this.inputElement.focus();
		this.inputElement.select();
	}

	close(): void {
		if (!this.isOpen) {
			return;
		}
		this.isOpen = false;
		this.root.hidden = true;
		this.cancelInflight();
	}

	toggle(): void {
		if (this.isOpen) {
			this.close();
		} else {
			this.open();
		}
	}

	private attachEventListeners(): void {
		this.listeners.add(DOM.addDisposableListener(this.inputElement, 'input', () => {
			this.query = this.inputElement.value;
			this.refreshRecents();
			this.scheduleSearch();
		}));
		this.listeners.add(DOM.addDisposableListener(this.inputElement, 'keydown', (raw) => {
			const e = new StandardKeyboardEvent(raw);
			if (e.keyCode === KeyCode.Escape) {
				e.preventDefault();
				this.close();
				return;
			}
			if (e.keyCode === KeyCode.Enter) {
				e.preventDefault();
				this.openSelected();
				return;
			}
			if (e.keyCode === KeyCode.UpArrow) {
				e.preventDefault();
				this.moveSelection(-1);
				return;
			}
			if (e.keyCode === KeyCode.DownArrow) {
				e.preventDefault();
				this.moveSelection(1);
				return;
			}
		}));
		this.listeners.add(DOM.addDisposableListener(this.root, 'click', e => {
			if (e.target === this.root) {
				this.close();
			}
		}));
	}

	private renderTabs(): void {
		DOM.clearNode(this.tabsElement);
		for (const tab of SCOPE_TABS) {
			const btn = DOM.append(this.tabsElement, DOM.$('button.krt-search-tab')) as HTMLButtonElement;
			btn.textContent = tab.label;
			if (this.scope === tab.scope) {
				btn.classList.add('active');
			}
			this.listeners.add(DOM.addDisposableListener(btn, 'click', () => {
				if (this.scope === tab.scope) {
					return;
				}
				this.scope = tab.scope;
				this.renderTabs();
				this.scheduleSearch(0);
				this.inputElement.focus();
			}));
		}
	}

	private scheduleSearch(delay = SEARCH_DEBOUNCE_MS): void {
		if (this.debounceHandle !== undefined) {
			clearTimeout(this.debounceHandle);
		}
		this.debounceHandle = setTimeout(() => {
			this.debounceHandle = undefined;
			void this.runSearch();
		}, delay);
	}

	private async runSearch(): Promise<void> {
		if (this.gh && !this.gh.ok) {
			this.renderResults();
			return;
		}
		const repos = this.workspaceRegistry.getAll().map(w => ({ owner: w.owner, repo: w.repo }));
		if (repos.length === 0) {
			// No workspaces → no scope to search. Show the add-workspace
			// CTA instead of issuing a wide-open `gh` search.
			this.results = [];
			this.selectedIndex = -1;
			this.renderResults();
			return;
		}
		this.cancelInflight();
		const cts = new CancellationTokenSource();
		this.inflight = cts;
		this.renderResults({ loading: true });
		try {
			const items = await this.pullRequestProvider.search(this.query, this.scope, repos);
			if (cts.token.isCancellationRequested) {
				return;
			}
			this.results = items;
			this.selectedIndex = items.length > 0 ? 0 : -1;
			this.renderResults();
		} catch (err) {
			if (cts.token.isCancellationRequested) {
				return;
			}
			if (isKrtError(err)) {
				this.logService.warn(`[krt] search failed (${err.kind}): ${err.message}`);
				this.gh = { ok: false, kind: err.kind, message: err.message, hint: err.hint };
				this.renderResults();
				return;
			}
			this.logService.error('[krt] search failed', err);
			this.results = [];
			this.renderResults({ error: String(err) });
		} finally {
			if (this.inflight === cts) {
				this.inflight = undefined;
			}
		}
	}

	private cancelInflight(): void {
		this.inflight?.cancel();
		this.inflight?.dispose();
		this.inflight = undefined;
	}

	private renderResults(opts: { loading?: boolean; error?: string } = {}): void {
		DOM.clearNode(this.resultsElement);
		if (this.gh && !this.gh.ok) {
			this.renderOnboarding(this.gh.kind, this.gh.message, this.gh.hint);
			return;
		}
		if (opts.loading) {
			const el = DOM.append(this.resultsElement, DOM.$('.krt-search-loading'));
			el.textContent = localize('krt.search.loading', "Searching GitHub via gh CLI…");
			return;
		}
		if (opts.error) {
			const el = DOM.append(this.resultsElement, DOM.$('.krt-search-error'));
			el.textContent = opts.error;
			return;
		}
		if (this.results.length === 0) {
			const hasWorkspaces = this.workspaceRegistry.getAll().length > 0;
			if (!hasWorkspaces) {
				// Empty registry → results would have to be unrestricted
				// (which we deliberately don't do — KRT's search is
				// always workspace-scoped). Instead, prompt to add one.
				const empty = DOM.append(this.resultsElement, DOM.$('.krt-search-empty'));
				empty.textContent = localize(
					'krt.search.noWorkspaces',
					"No workspaces yet — add one to start finding PRs.",
				);
				const addBtn = DOM.append(this.resultsElement, DOM.$('button.krt-search-add-workspace')) as HTMLButtonElement;
				addBtn.type = 'button';
				addBtn.textContent = localize('krt.search.addWorkspace', "Add a workspace");
				this.listeners.add(DOM.addDisposableListener(addBtn, 'click', () => {
					void this.commandService.executeCommand('krt.workspace.add');
				}));
				return;
			}
			const el = DOM.append(this.resultsElement, DOM.$('.krt-search-empty'));
			if (this.query) {
				el.textContent = localize('krt.search.noMatches', "No PRs match.");
			} else {
				if (this.scope === 'all-open') {
					el.textContent = localize('krt.search.emptyAllOpen', "You have no open PRs. Type to search across GitHub.");
				} else if (this.scope === 'reviewed') {
					el.textContent = localize('krt.search.emptyReviewed', "You haven't reviewed any PRs. Type to search across GitHub.");
				} else if (this.scope === 'awaiting-review') {
					el.textContent = localize('krt.search.emptyAwaiting', "No PRs are awaiting your review. Type to search across GitHub.");
				}
			}
			return;
		}
		this.resultRowElements = [];
		this.results.forEach((pr, index) => {
			const row = DOM.append(this.resultsElement, DOM.$('.krt-search-row')) as HTMLElement;
			row.setAttribute('role', 'option');
			row.dataset.index = String(index);
			this.resultRowElements.push(row);
			if (index === this.selectedIndex) {
				row.classList.add('selected');
			}
			const main = DOM.append(row, DOM.$('.krt-search-row-main'));
			const titleLine = DOM.append(main, DOM.$('.krt-search-row-title-line'));
			const num = DOM.append(titleLine, DOM.$('span.krt-search-row-number'));
			num.textContent = `${pr.owner}/${pr.repo}#${pr.number}`;
			const title = DOM.append(titleLine, DOM.$('span.krt-search-row-title'));
			title.textContent = pr.title;
			const meta = DOM.append(main, DOM.$('.krt-search-row-meta'));
			const by = DOM.append(meta, DOM.$('span'));
			by.textContent = localize('krt.search.byAuthor', "by {0}", pr.author.login);
			const sep = DOM.append(meta, DOM.$('span.sep'));
			sep.textContent = '·';
			const updated = DOM.append(meta, DOM.$('span'));
			updated.textContent = relativeTime(pr.updatedAt);
			const state = DOM.append(row, DOM.$('span.krt-search-state'));
			state.classList.add(pr.state);
			state.textContent = pr.state;
			this.listeners.add(DOM.addDisposableListener(row, 'click', () => {
				this.selectedIndex = index;
				this.openSelected();
			}));
		});
	}

	private renderOnboarding(kind: string, message: string, hint: string): void {
		const el = DOM.append(this.resultsElement, DOM.$('.krt-search-onboarding')) as HTMLElement;
		const heading = DOM.append(el, DOM.$('h2'));
		heading.textContent = kind === 'gh-missing'
			? localize('krt.search.onboarding.missingHeading', "Install the GitHub CLI")
			: localize('krt.search.onboarding.authHeading', "Sign in with the GitHub CLI");
		const explain = DOM.append(el, DOM.$('p'));
		explain.textContent = message;
		const hintP = DOM.append(el, DOM.$('p'));
		hintP.textContent = hint;
		if (kind === 'gh-missing') {
			const installCmd = DOM.append(el, DOM.$('code'));
			installCmd.textContent = 'brew install gh';
			const loginCmd = DOM.append(el, DOM.$('code'));
			loginCmd.textContent = 'gh auth login';
		} else {
			const loginCmd = DOM.append(el, DOM.$('code'));
			loginCmd.textContent = 'gh auth login';
		}
		const actions = DOM.append(el, DOM.$('.krt-search-onboarding-actions'));
		const retry = DOM.append(actions, DOM.$('button')) as HTMLButtonElement;
		retry.textContent = localize('krt.search.retryGh', "Retry");
		this.listeners.add(DOM.addDisposableListener(retry, 'click', () => {
			this.gh = undefined;
			this.refreshGh();
		}));
	}

	private refreshRecents(): void {
		DOM.clearNode(this.recentsGrid);
		const recents = readRecentPullRequests(this.storageService).slice(0, RECENTS_GRID_LIMIT);
		if (recents.length === 0 || this.query.trim().length > 0) {
			this.recentsContainer.hidden = true;
			return;
		}
		this.recentsContainer.hidden = false;
		for (const r of recents) {
			const card = DOM.append(this.recentsGrid, DOM.$('.krt-search-recent-card')) as HTMLElement;
			const name = DOM.append(card, DOM.$('.krt-search-recent-card-name'));
			name.textContent = `${r.owner}/${r.repo}#${r.number}`;
			const title = DOM.append(card, DOM.$('.krt-search-recent-card-title'));
			title.textContent = r.title;
			this.listeners.add(DOM.addDisposableListener(card, 'click', () => {
				this.openRecent(r);
			}));
		}
	}

	private moveSelection(delta: number): void {
		if (this.results.length === 0) {
			return;
		}
		const next = Math.max(0, Math.min(this.results.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) {
			return;
		}
		this.selectedIndex = next;
		this.renderResults();
		this.resultRowElements[next]?.scrollIntoView({ block: 'nearest' });
	}

	private openSelected(): void {
		const pr = this.results[this.selectedIndex];
		if (!pr) {
			return;
		}
		const input = new KrtPullRequestEditorInput(pr.url, pr.owner, pr.repo, pr.number, pr.title);
		this.close();
		void this.editorService.openEditor(input, { pinned: true });
	}

	private openRecent(r: RecentPullRequest): void {
		const parsed = parsePullRequestUrl(r.url);
		if (!parsed) {
			return;
		}
		const input = new KrtPullRequestEditorInput(r.url, r.owner, r.repo, r.number, r.title);
		this.close();
		void this.editorService.openEditor(input, { pinned: true });
	}

	private async refreshGh(): Promise<void> {
		try {
			const info = await this.ghClient.detect();
			this.logService.info(`[krt] gh detected: ${info.version}`);
			this.gh = { ok: true };
			this.scheduleSearch(0);
		} catch (err) {
			if (isKrtError(err)) {
				this.gh = { ok: false, kind: err.kind, message: err.message, hint: err.hint };
				this.renderResults();
				return;
			}
			this.logService.error('[krt] gh detect failed', err);
			this.gh = { ok: false, kind: 'unknown', message: String(err), hint: localize('krt.search.unknownErrorHint', "Open the developer tools console for details.") };
			this.renderResults();
		}
	}

	override dispose(): void {
		this.cancelInflight();
		if (this.debounceHandle !== undefined) {
			clearTimeout(this.debounceHandle);
		}
		this.root.remove();
		super.dispose();
	}
}

function relativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return iso;
	}
	const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
	if (seconds < 60) {
		return localize('krt.search.timeSeconds', "{0}s ago", seconds);
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return localize('krt.search.timeMinutes', "{0}m ago", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize('krt.search.timeHours', "{0}h ago", hours);
	}
	const days = Math.floor(hours / 24);
	if (days < 30) {
		return localize('krt.search.timeDays', "{0}d ago", days);
	}
	const months = Math.floor(days / 30);
	if (months < 12) {
		return localize('krt.search.timeMonths', "{0}mo ago", months);
	}
	const years = Math.floor(days / 365);
	return localize('krt.search.timeYears', "{0}y ago", years);
}

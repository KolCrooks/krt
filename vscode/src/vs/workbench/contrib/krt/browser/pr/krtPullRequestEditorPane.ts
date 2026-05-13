/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './krtPullRequestEditorPane.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { fromNow } from '../../../../../base/common/date.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { toAction } from '../../../../../base/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IKrtWorkspaceRegistry, KrtWorkspace } from '../workspace/krtWorkspaceRegistry.js';
import { IKrtGitService } from '../../../../../platform/krt/common/krtGit.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { getWorkspacePreFlight, KrtPreFlight } from '../workspace/krtVcs.js';
import { returnFrom, switchTo } from '../workspace/krtSwitchOps.js';
import { IKrtSwitchResumeService, ResumeToken } from '../workspace/krtSwitchResume.js';
import { IKrtBotListService } from './krtBotListService.js';
import { IKrtReviewDraftService } from './krtReviewDraftService.js';
import { isKrtError } from '../../../../../platform/krt/common/errors.js';
import { Chapter, ChapterChip, EdgeKind, EDGE_KINDS, TourVariant } from '../ai/krtTourTypes.js';
import { expandEmojiShortcodes } from '../ai/krtEmoji.js';
import { ITourGenerator, TourGenerationStatus, TourTokenUsage } from '../ai/krtTourGenerator.js';
import { DEFAULT_LAYOUT_OPTIONS as DEFAULT_STORYBOARD_LAYOUT, layoutStoryboard } from '../ai/krtStoryboardLayout.js';
import {
	readReviewedChapters,
	readVariant,
	writeReviewedChapters,
	writeVariant,
} from '../ai/krtTourReviewed.js';
import {
	AutomationEvent,
	CheckConclusion,
	CheckRun,
	Comment,
	IPullRequestProvider,
	PullRequest,
	PullRequestFile,
	PullRequestState,
	Reviewer,
	ReviewerState,
	ReviewSubmissionEvent,
} from '../../../../../platform/krt/common/krt.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { recordRecentPullRequest } from '../krtRecentPullRequests.js';
import { KrtPullRequestEditorInput } from './krtPullRequestEditorInput.js';
import { getCached, getInFlight, invalidate as invalidatePrCache, putActivity, putFiles, putPr, putReviewComments, putSubMode, trackFetch } from './krtPrCache.js';
import { IKrtPrCommentController } from './krtPrCommentController.js';
import { KrtPrFlatDiff } from './krtPrFlatDiff.js';
import { KrtDiffFileTree } from './krtDiffFileTree.js';
import { readReviewedPaths, writeReviewedPaths } from './krtPrReviewed.js';
import { encodeKrtGit } from '../workspace/krtGitContentProvider.js';
import { IEditorService, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';

const DIFF_MODE_STORAGE_KEY = 'krt.pr.diffMode.v1';

function readDiffRenderMode(storageService: IStorageService): 'side-by-side' | 'inline' {
	const raw = storageService.get(DIFF_MODE_STORAGE_KEY, StorageScope.APPLICATION);
	return raw === 'inline' ? 'inline' : 'side-by-side';
}

function writeDiffRenderMode(storageService: IStorageService, mode: 'side-by-side' | 'inline'): void {
	storageService.store(DIFF_MODE_STORAGE_KEY, mode, StorageScope.APPLICATION, StorageTarget.MACHINE);
}

type ActivityTab = 'discussion' | 'automation';
type SubMode = 'pr' | 'diff' | 'tour' | 'storyboard';

interface TourState {
	readonly chapters: readonly Chapter[];
	readonly model: string;
	readonly fromCache: boolean;
	readonly usage?: TourTokenUsage;
}

/**
 * Phase 5 PR view. Two-column layout: main column (header,
 * description, activity, reply box) + sidebar (Reviewers, Checks,
 * Labels, Stats). Markdown renders via VS Code's base
 * `renderMarkdown`. Reply box posts via the provider and appends to
 * the discussion timeline. Phase 6 swaps the body for the Diff
 * sub-mode using the same input.
 */
export class KrtPullRequestEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.krtPullRequest';

	private root!: HTMLElement;
	private headerElement!: HTMLElement;
	private titleElement!: HTMLElement;
	private subtitleElement!: HTMLElement;
	private statePillElement!: HTMLElement;
	private headerActionsElement!: HTMLElement;
	private refreshBtnElement!: HTMLButtonElement;
	private openOnGithubBtnElement!: HTMLButtonElement;
	private reviewBtnElement!: HTMLButtonElement;
	private discardBtnElement!: HTMLButtonElement;
	private subModeBarElement!: HTMLElement;
	private bodyElement!: HTMLElement;

	private currentInput: KrtPullRequestEditorInput | undefined;
	private currentPr: PullRequest | undefined;
	private fetchToken = 0;

	private readonly bodyDisposables = this._register(new DisposableStore());
	private subMode: SubMode = 'pr';
	private activityTab: ActivityTab = 'discussion';
	private automationEvents: readonly AutomationEvent[] | undefined;
	private automationLoading = false;
	private automationError: string | undefined;
	private liveComments: Comment[] = [];

	// Diff sub-mode state
	private diffFiles: readonly PullRequestFile[] | undefined;
	private diffFilesLoading = false;
	private diffFilesError: string | undefined;
	private reviewedPaths: Set<string> = new Set();
	private diffRenderMode: 'side-by-side' | 'inline' = 'side-by-side';
	/**
	 * `true` when the registered workspace's current HEAD SHA matches
	 * `currentPr.head.sha` — i.e., the user has already checked the PR
	 * out (via KRT or manually). Drives the Check Out button's
	 * disabled state. Updated asynchronously on PR load + on
	 * `IKrtSwitchResumeService.onDidChange`.
	 */
	private isCheckedOut = false;
	private reviewComments: readonly Comment[] | undefined;
	private reviewCommentsLoading = false;
	private diffFileTree: KrtDiffFileTree | undefined;

	// Tour sub-mode state
	private tourState: TourState | undefined;
	private tourLoading = false;
	private tourStreaming = false;
	private tourError: string | undefined;
	private tourNoKey = false;
	private tourVariant: TourVariant = 'chapters';
	private tourSelectedChapterId: string | undefined;
	private reviewedChapters: Set<string> = new Set();
	private tourFetchToken = 0;
	private tourSubheadingEl: HTMLElement | undefined;
	private tourStreamingBadgeEl: HTMLElement | undefined;
	private storyboardSubheadingEl: HTMLElement | undefined;
	private storyboardStreamingBadgeEl: HTMLElement | undefined;
	private storyboardScrollerEl: HTMLElement | undefined;

	// Storyboard sub-mode state
	private storyboardSelectedId: string | undefined;
	private storyboardDiffPanelEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly krtStorageService: IStorageService,
		@IPullRequestProvider private readonly pullRequestProvider: IPullRequestProvider,
		@ILogService private readonly logService: ILogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ITourGenerator private readonly tourGenerator: ITourGenerator,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IKrtWorkspaceRegistry private readonly workspaceRegistry: IKrtWorkspaceRegistry,
		@IKrtGitService private readonly krtGitService: IKrtGitService,
		@IKrtSwitchResumeService private readonly switchResumeService: IKrtSwitchResumeService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
		@IKrtPrCommentController private readonly krtCommentController: IKrtPrCommentController,
		@IKrtReviewDraftService private readonly reviewDraftService: IKrtReviewDraftService,
		@IKrtBotListService private readonly botListService: IKrtBotListService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(KrtPullRequestEditorPane.ID, group, telemetryService, themeService, krtStorageService);
		// Re-check the workspace's HEAD whenever the resume token
		// changes (i.e., a switch happened) so the Check Out button
		// flips to "Checked out" / back without waiting for the user
		// to navigate elsewhere.
		this._register(this.switchResumeService.onDidChange(() => {
			void this.refreshCheckoutStatus();
		}));
		// Phase 10: when a draft for the active PR appears or
		// disappears, the header button label flips between
		// Start/Continue/Submit. `addComment` also fires here, so
		// guard the work to label-only updates.
		this._register(this.reviewDraftService.onDidChange(prUrl => {
			if (this.currentPr?.url === prUrl) {
				this.updateHeaderActionsEnablement();
			}
		}));
		// Phase 10 Batch 4: bot list changes for the current PR's
		// workspace re-bucket Discussion / Automation. Re-render the PR
		// view so the timeline reflects the new classification.
		this._register(this.botListService.onDidChange(folderUri => {
			const pr = this.currentPr;
			if (!pr || this.subMode !== 'pr') {
				return;
			}
			const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
			if (workspace?.folderUri === folderUri) {
				this.renderLoaded(pr);
			}
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = DOM.append(parent, DOM.$('.krt-pr-editor'));
		this.headerElement = DOM.append(this.root, DOM.$('.krt-pr-editor-header'));
		const headerText = DOM.append(this.headerElement, DOM.$('.krt-pr-editor-header-text'));
		this.subtitleElement = DOM.append(headerText, DOM.$('.krt-pr-editor-subtitle'));
		// Title row: H1 + state pill inline. Pill sits to the right of the
		// title (matches the demo's PR header where Draft / Open / Merged
		// reads as part of the title rather than a separate sidebar chip).
		const titleRow = DOM.append(headerText, DOM.$('.krt-pr-editor-title-row'));
		this.titleElement = DOM.append(titleRow, DOM.$('h1.krt-pr-editor-title'));
		this.statePillElement = DOM.append(titleRow, DOM.$('.krt-pr-editor-state-pill'));
		this.headerActionsElement = DOM.append(this.headerElement, DOM.$('.krt-pr-editor-header-actions'));
		this.refreshBtnElement = DOM.append(this.headerActionsElement, DOM.$('button.krt-pr-editor-header-btn')) as HTMLButtonElement;
		this.refreshBtnElement.type = 'button';
		this.refreshBtnElement.textContent = localize('krt.pr.refresh', "Refresh");
		this.refreshBtnElement.title = localize('krt.pr.refresh.tooltip', "Re-fetch this pull request from GitHub");
		this.refreshBtnElement.onclick = () => this.refreshCurrentPr();
		this.openOnGithubBtnElement = DOM.append(this.headerActionsElement, DOM.$('button.krt-pr-editor-header-btn')) as HTMLButtonElement;
		this.openOnGithubBtnElement.type = 'button';
		this.openOnGithubBtnElement.textContent = localize('krt.pr.openOnGithub', "Open on GitHub");
		this.openOnGithubBtnElement.title = localize('krt.pr.openOnGithub.tooltip', "Open this pull request on github.com");
		this.openOnGithubBtnElement.onclick = () => {
			if (this.currentPr) {
				this.openExternal(this.currentPr.url);
			}
		};
		// Discard sits to the left of the primary review button so the
		// destructive action is never the default. Hidden until a draft
		// exists for the active PR.
		this.discardBtnElement = DOM.append(this.headerActionsElement, DOM.$('button.krt-pr-editor-header-btn.danger')) as HTMLButtonElement;
		this.discardBtnElement.type = 'button';
		this.discardBtnElement.textContent = localize('krt.pr.review.discard', "Discard Review");
		this.discardBtnElement.title = localize('krt.pr.review.discard.tooltip', "Drop your in-progress review and return the workspace to its previous state");
		this.discardBtnElement.onclick = () => this.handleDiscardReview();
		// Single primary review button; label and behaviour flip across
		// Start Review / Continue Review / Submit Review based on draft
		// state and check-out status.
		this.reviewBtnElement = DOM.append(this.headerActionsElement, DOM.$('button.krt-pr-editor-header-btn.primary')) as HTMLButtonElement;
		this.reviewBtnElement.type = 'button';
		this.reviewBtnElement.textContent = localize('krt.pr.review.start', "Start Review");
		this.reviewBtnElement.title = localize('krt.pr.review.start.tooltip', "Check out this PR and start a new review");
		this.reviewBtnElement.onclick = () => this.handleReviewButton();
		this.subModeBarElement = DOM.append(this.root, DOM.$('.krt-pr-submode-bar'));
		this.bodyElement = DOM.append(this.root, DOM.$('.krt-pr-editor-body'));
		this.updateHeaderActionsEnablement();
	}

	private updateHeaderActionsEnablement(): void {
		const pr = this.currentPr;
		this.refreshBtnElement.disabled = !pr;
		this.openOnGithubBtnElement.disabled = !pr;
		const hasDraft = !!pr && this.reviewDraftService.hasDraft(pr.url);

		// Discard surfaces only while a draft exists. When no PR is
		// loaded yet (or the PR has no draft) the button is hidden so
		// the action area collapses to refresh / open / start review.
		this.discardBtnElement.hidden = !hasDraft;
		this.discardBtnElement.disabled = false;

		if (!pr) {
			this.reviewBtnElement.disabled = true;
			this.reviewBtnElement.textContent = localize('krt.pr.review.start', "Start Review");
			this.reviewBtnElement.title = '';
			return;
		}

		const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);

		// State machine:
		//   - no draft           → "Start Review" (fires checkout flow + creates draft)
		//   - draft + not on head → "Continue Review" (re-runs checkout if needed)
		//   - draft + on head    → "Submit Review" (posts the batch)
		if (!hasDraft) {
			this.reviewBtnElement.disabled = false;
			this.reviewBtnElement.textContent = localize('krt.pr.review.start', "Start Review");
			this.reviewBtnElement.title = workspace
				? localize('krt.pr.review.start.tooltip', "Check out this PR and start a new review")
				: localize('krt.pr.review.start.tooltip.noWorkspace', "No workspace is registered for this repo. Click to add one.");
			return;
		}

		const draft = this.reviewDraftService.getDraft(pr.url);
		const draftCount = draft?.comments.length ?? 0;

		if (!this.isCheckedOut) {
			this.reviewBtnElement.disabled = false;
			this.reviewBtnElement.textContent = localize('krt.pr.review.continue', "Continue Review");
			this.reviewBtnElement.title = localize(
				'krt.pr.review.continue.tooltip',
				"Re-check out this PR and resume the in-progress review ({0} comment(s) drafted)",
				draftCount,
			);
			return;
		}

		this.reviewBtnElement.disabled = false;
		this.reviewBtnElement.textContent = draftCount > 0
			? localize('krt.pr.review.submitWithCount', "Submit Review ({0})", draftCount)
			: localize('krt.pr.review.submit', "Submit Review");
		this.reviewBtnElement.title = localize(
			'krt.pr.review.submit.tooltip',
			"Post your in-progress review to GitHub as a single batch",
		);
	}

	/**
	 * Compare the workspace's HEAD SHA against the PR's head and update
	 * `isCheckedOut`. Async — re-runs `updateHeaderActionsEnablement`
	 * when finished. Triggered on PR load + on switch-resume changes.
	 * Failures are silent (no workspace → false; shell errors → false).
	 */
	private async refreshCheckoutStatus(): Promise<void> {
		const pr = this.currentPr;
		if (!pr) {
			if (this.isCheckedOut) {
				this.isCheckedOut = false;
				this.updateHeaderActionsEnablement();
			}
			return;
		}
		const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
		if (!workspace) {
			if (this.isCheckedOut) {
				this.isCheckedOut = false;
				this.updateHeaderActionsEnablement();
			}
			return;
		}
		try {
			const sha = await this.krtGitService.getHeadSha(workspace.folderPath);
			const matches = sha === pr.head.sha;
			// Don't fire updates if the active PR has changed under us
			// (user switched tabs while we were awaiting).
			if (this.currentPr?.url !== pr.url) {
				return;
			}
			if (this.isCheckedOut !== matches) {
				this.isCheckedOut = matches;
				this.updateHeaderActionsEnablement();
				// Phase 10/B — the Diff sub-mode's strict gate keys off
				// `isCheckedOut`. Flipping it from false to true (or back)
				// has to re-render so the gate either reveals the diff or
				// shows the Check Out CTA.
				if ((this.subMode === 'diff' || this.subMode === 'tour' || this.subMode === 'storyboard') && this.currentPr) {
					this.renderLoaded(this.currentPr);
				}
			}
		} catch (err) {
			// `getHeadSha` can fail if the folder isn't a git repo, etc.
			// Treat as "not checked out" — the button stays enabled and
			// the user can attempt a switch (which will surface the
			// underlying error if the workspace is genuinely broken).
			this.logService.debug?.('[krt] refreshCheckoutStatus failed', err);
			if (this.isCheckedOut) {
				this.isCheckedOut = false;
				this.updateHeaderActionsEnablement();
				if ((this.subMode === 'diff' || this.subMode === 'tour' || this.subMode === 'storyboard') && this.currentPr) {
					this.renderLoaded(this.currentPr);
				}
			}
		}
	}

	private async refreshCurrentPr(): Promise<void> {
		const input = this.currentInput;
		if (!input) {
			return;
		}
		// Refresh button forces a re-fetch — drop the cached entry first
		// so subsequent loaders (`loadDiffFiles`, `loadReviewComments`,
		// `loadAutomation`) fall through to gh as well.
		invalidatePrCache(input.url);
		this.fetchToken++;
		const myToken = this.fetchToken;
		const previousSha = this.currentPr?.head.sha;
		const previousPr = this.currentPr;
		this.currentPr = undefined;
		this.updateHeaderActionsEnablement();
		try {
			const pr = await this.pullRequestProvider.getPullRequest(input.url);
			if (this.currentInput !== input || this.fetchToken !== myToken) {
				return;
			}
			putPr(input.url, pr);
			input.setTitle(pr.title);
			this.currentPr = pr;
			this.liveComments = [...pr.comments];
			// Only bust tour state when new commits were pushed — the tour cache
			// is keyed by headSha, so a SHA change means a cache miss and
			// regeneration. If the SHA is unchanged, keep the existing tour.
			if (!previousSha || previousSha !== pr.head.sha) {
				this.tourFetchToken++;
				this.tourState = undefined;
				this.tourLoading = false;
				this.tourStreaming = false;
				this.tourError = undefined;
				this.tourNoKey = false;
				this.tourSelectedChapterId = undefined;
				this.storyboardSelectedId = undefined;
			}
			this.renderLoaded(pr);
		} catch (err) {
			if (this.currentInput !== input || this.fetchToken !== myToken) {
				return;
			}
			this.currentPr = previousPr;
			this.logService.error('[krt] PR refresh failed', err);
		} finally {
			if (this.currentInput === input && this.fetchToken === myToken) {
				this.updateHeaderActionsEnablement();
			}
		}
	}

	private async handleReviewButton(): Promise<void> {
		const pr = this.currentPr;
		if (!pr) {
			return;
		}
		const hasDraft = this.reviewDraftService.hasDraft(pr.url);
		if (hasDraft && this.isCheckedOut) {
			// In review mode, on PR head — primary action is Submit.
			await this.handleSubmitReview();
			return;
		}
		// Either no draft yet (Start Review) or draft exists but not on
		// head (Continue Review). Both run the checkout flow; only the
		// no-draft path opens a fresh draft afterwards.
		await this.handleStartOrContinueReview(pr, hasDraft);
	}

	private async handleStartOrContinueReview(pr: PullRequest, hasDraft: boolean): Promise<void> {
		const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
		if (!workspace) {
			// No matching workspace. Walk the user through adding one,
			// then they can click Start Review again.
			const result = await this.dialogService.confirm({
				type: 'info',
				message: localize(
					'krt.pr.checkout.noWorkspace.message',
					"No workspace registered for {0}/{1}.",
					pr.owner,
					pr.repo,
				),
				detail: localize(
					'krt.pr.checkout.noWorkspace.detail',
					"KRT needs a local clone of the repo to switch its working tree to this PR. Add one now?",
				),
				primaryButton: localize('krt.pr.checkout.noWorkspace.add', "Add Workspace…"),
				cancelButton: localize('krt.pr.checkout.noWorkspace.cancel', "Cancel"),
			});
			if (result.confirmed) {
				await this.commandService.executeCommand('krt.workspace.add');
			}
			return;
		}
		// Refuse a second concurrent switch — Phase 8.7 v1's contract
		// is single-active-switch. The user can clear via "KRT: Forget
		// Active PR Switch" and try again.
		const active = this.switchResumeService.getActive();
		if (active && active.prUrl !== pr.url) {
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'krt.pr.checkout.alreadyActive',
					"A PR switch is already active for #{0}. Use \"KRT: Return to Previous State\" before switching again.",
					active.prNumber,
				),
			});
			return;
		}
		try {
			this.reviewBtnElement.disabled = true;
			// Already on PR head — skip the switch dance and just open
			// the draft. Keeps "Start Review" cheap when the user
			// already has the working copy in the right place.
			if (this.isCheckedOut && !hasDraft) {
				this.reviewDraftService.startReview({
					prUrl: pr.url,
					prNumber: pr.number,
					owner: pr.owner,
					repo: pr.repo,
					headSha: pr.head.sha,
				});
				this.notificationService.notify({
					severity: Severity.Info,
					message: localize('krt.pr.review.started', "Review started for PR #{0}.", pr.number),
				});
				return;
			}
			const preFlight = await getWorkspacePreFlight(this.krtGitService, workspace);
			if (!preFlight) {
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize(
						'krt.pr.checkout.noVcs',
						"Workspace folder doesn't look like a git or jj repo: {0}",
						workspace.folderPath,
					),
				});
				return;
			}
			const confirm = await this.confirmSwitch(pr, workspace.folderPath, preFlight);
			if (!confirm) {
				return;
			}
			const token = await switchTo(
				{ gitService: this.krtGitService, logService: this.logService },
				workspace,
				pr,
				preFlight,
			);
			this.switchResumeService.set(token);
			if (!hasDraft) {
				this.reviewDraftService.startReview({
					prUrl: pr.url,
					prNumber: pr.number,
					owner: pr.owner,
					repo: pr.repo,
					headSha: pr.head.sha,
				});
			}
			// Nudge the workbench file explorer to re-read the workspace.
			void this.fileService.resolve(URI.parse(workspace.folderUri)).catch(() => undefined);
			const detail = preFlight.vcs === 'git' && preFlight.status.dirtyFileCount > 0
				? localize(
					'krt.pr.checkout.stashed',
					"Your changes were stashed as `{0}`. Run `git stash pop` when you're ready to restore.",
					token.vcs === 'git' ? token.stashMessage ?? 'krt' : 'krt',
				)
				: localize('krt.pr.review.checkout.success', "Reviewing PR #{0}. Add inline comments via the Diff view.", pr.number);
			this.notificationService.notify({ severity: Severity.Info, message: detail });
		} catch (err) {
			const message = isKrtError(err) ? `${err.message} — ${err.hint}` : String(err);
			this.notificationService.notify({ severity: Severity.Error, message });
			this.logService.warn('[krt] PR checkout failed', err);
		} finally {
			this.updateHeaderActionsEnablement();
		}
	}

	private async handleSubmitReview(): Promise<void> {
		const pr = this.currentPr;
		if (!pr) {
			return;
		}
		const draft = this.reviewDraftService.getDraft(pr.url);
		if (!draft) {
			return;
		}
		// Two-step submit dialog (the workbench's native dialog
		// primitives don't support an input + multi-button shape in a
		// single pass): first the verdict via a three-button prompt,
		// then an optional summary body via an input dialog.
		const eventPrompt = await this.dialogService.prompt<ReviewSubmissionEvent | undefined>({
			type: 'info',
			message: localize(
				'krt.pr.review.submit.confirm',
				"Submit your review on PR #{0}?",
				pr.number,
			),
			detail: localize(
				'krt.pr.review.submit.detail',
				"{0} inline comment(s) will post to GitHub. Pick a verdict — comment is the default.",
				draft.comments.length,
			),
			buttons: [
				{
					label: localize('krt.pr.review.submit.comment', "&&Comment"),
					run: () => 'COMMENT' as const,
				},
				{
					label: localize('krt.pr.review.submit.approve', "&&Approve"),
					run: () => 'APPROVE' as const,
				},
				{
					label: localize('krt.pr.review.submit.requestChanges', "Request &&changes"),
					run: () => 'REQUEST_CHANGES' as const,
				},
			],
			cancelButton: true,
		});
		const event = eventPrompt.result;
		if (!event) {
			return;
		}
		const bodyResult = await this.dialogService.input({
			type: 'info',
			message: this.submitBodyDialogMessage(event, pr.number),
			detail: localize(
				'krt.pr.review.submit.body.detail',
				"Add a brief summary if you want — the {0} inline comment(s) will post regardless.",
				draft.comments.length,
			),
			inputs: [{
				type: 'text',
				placeholder: localize('krt.pr.review.submit.bodyPlaceholder', "Optional summary (markdown)"),
			}],
			primaryButton: this.submitBodyPrimaryLabel(event),
			cancelButton: localize('krt.pr.review.submit.cancel', "Cancel"),
		});
		if (!bodyResult.confirmed) {
			return;
		}
		const summary = bodyResult.values?.[0]?.trim() ?? '';
		try {
			this.reviewBtnElement.disabled = true;
			this.discardBtnElement.disabled = true;
			await this.reviewDraftService.submit({
				prUrl: pr.url,
				event,
				body: summary.length > 0 ? summary : undefined,
			});
			// Refetch review comments so the freshly-posted batch
			// appears as native (non-pending) threads. The cache entry
			// is stale, so blow it away first.
			invalidatePrCache(pr.url);
			await this.loadReviewComments(pr);
			this.notificationService.notify({
				severity: Severity.Info,
				message: this.submitSuccessMessage(event, pr.number),
			});
		} catch (err) {
			const message = isKrtError(err) ? `${err.message} — ${err.hint}` : String(err);
			this.notificationService.notify({ severity: Severity.Error, message });
			this.logService.warn('[krt] PR review submit failed', err);
		} finally {
			this.updateHeaderActionsEnablement();
		}
	}

	private submitBodyDialogMessage(event: ReviewSubmissionEvent, prNumber: number): string {
		switch (event) {
			case 'APPROVE':
				return localize('krt.pr.review.submit.body.approve', "Approve PR #{0}?", prNumber);
			case 'REQUEST_CHANGES':
				return localize('krt.pr.review.submit.body.requestChanges', "Request changes on PR #{0}?", prNumber);
			case 'COMMENT':
			default:
				return localize('krt.pr.review.submit.body.comment', "Comment on PR #{0}?", prNumber);
		}
	}

	private submitBodyPrimaryLabel(event: ReviewSubmissionEvent): string {
		switch (event) {
			case 'APPROVE':
				return localize('krt.pr.review.submit.primary.approve', "Approve");
			case 'REQUEST_CHANGES':
				return localize('krt.pr.review.submit.primary.requestChanges', "Request Changes");
			case 'COMMENT':
			default:
				return localize('krt.pr.review.submit.primary.comment', "Submit Comment");
		}
	}

	private submitSuccessMessage(event: ReviewSubmissionEvent, prNumber: number): string {
		switch (event) {
			case 'APPROVE':
				return localize('krt.pr.review.submit.success.approve', "Approved PR #{0}.", prNumber);
			case 'REQUEST_CHANGES':
				return localize('krt.pr.review.submit.success.requestChanges', "Requested changes on PR #{0}.", prNumber);
			case 'COMMENT':
			default:
				return localize('krt.pr.review.submit.success.comment', "Review posted to PR #{0}.", prNumber);
		}
	}

	private async handleDiscardReview(): Promise<void> {
		const pr = this.currentPr;
		if (!pr) {
			return;
		}
		const draft = this.reviewDraftService.getDraft(pr.url);
		if (!draft) {
			return;
		}
		const detail = draft.comments.length > 0
			? localize(
				'krt.pr.review.discard.detail',
				"{0} drafted comment(s) will be lost. The workspace will be returned to its previous state.",
				draft.comments.length,
			)
			: localize(
				'krt.pr.review.discard.detail.empty',
				"The workspace will be returned to its previous state.",
			);
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localize('krt.pr.review.discard.confirm', "Discard review on PR #{0}?", pr.number),
			detail,
			primaryButton: localize('krt.pr.review.discard.primary', "Discard Review"),
			cancelButton: localize('krt.pr.review.discard.cancel', "Cancel"),
		});
		if (!result.confirmed) {
			return;
		}
		try {
			this.reviewBtnElement.disabled = true;
			this.discardBtnElement.disabled = true;
			this.reviewDraftService.discard(pr.url);
			// If KRT switched the workspace to this PR, return it to
			// where it was. Skipped when the user checked out manually
			// (no resume token for this PR) — there's nothing for KRT
			// to roll back in that case.
			const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
			const active = this.switchResumeService.getActive();
			if (workspace && active?.prUrl === pr.url) {
				await this.runReturnFlow(workspace, active);
			}
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize('krt.pr.review.discard.success', "Discarded review on PR #{0}.", pr.number),
			});
		} catch (err) {
			const message = isKrtError(err) ? `${err.message} — ${err.hint}` : String(err);
			this.notificationService.notify({ severity: Severity.Error, message });
			this.logService.warn('[krt] PR review discard failed', err);
		} finally {
			this.updateHeaderActionsEnablement();
		}
	}

	private async runReturnFlow(workspace: KrtWorkspace, token: ResumeToken): Promise<void> {
		await returnFrom(
			{ gitService: this.krtGitService, logService: this.logService },
			workspace,
			token,
		);
		this.switchResumeService.clear();
		void this.fileService.resolve(URI.parse(workspace.folderUri)).catch(() => undefined);
		// Force a HEAD-SHA re-read so `isCheckedOut` flips to false.
		void this.refreshCheckoutStatus();
	}

	private async confirmSwitch(
		pr: PullRequest,
		folderPath: string,
		pf: KrtPreFlight,
	): Promise<boolean> {
		// Phase 8.7 — three message variants keyed off VCS + dirty state.
		const message = localize('krt.pr.checkout.confirm.message', "Switch {0} to PR #{1}?", folderPath, pr.number);
		let detail: string;
		if (pf.vcs === 'jj') {
			detail = localize(
				'krt.pr.checkout.confirm.jj',
				"jj will move @ to the PR's head commit ({0}). Your current change ({1}) is preserved in the op log; \"KRT: Return to Previous State\" rolls it back.",
				pr.head.sha.slice(0, 7),
				pf.status.changeId.slice(0, 8),
			);
		} else if (pf.status.dirtyFileCount === 0) {
			detail = localize(
				'krt.pr.checkout.confirm.gitClean',
				"git will check out the PR's head ({0}). Your current branch ({1}) will be auto-restored when you close the PR.",
				pr.head.sha.slice(0, 7),
				pf.status.branch,
			);
		} else {
			detail = localize(
				'krt.pr.checkout.confirm.gitDirty',
				"You have {0} uncommitted file(s) on `{1}`. KRT will stash them first (you can `git stash pop` later), then check out the PR head ({2}).",
				pf.status.dirtyFileCount,
				pf.status.branch,
				pr.head.sha.slice(0, 7),
			);
		}
		const result = await this.dialogService.confirm({
			type: pf.vcs === 'git' && pf.status.dirtyFileCount > 0 ? 'warning' : 'info',
			message,
			detail,
			primaryButton: localize('krt.pr.checkout.confirm.switch', "Switch"),
			cancelButton: localize('krt.pr.checkout.confirm.cancel', "Cancel"),
		});
		return result.confirmed;
	}

	override async setInput(input: KrtPullRequestEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		// Drop any native review-comment threads owned by the PR we're
		// navigating away from — without this, the controller keeps
		// pointing them at the previous PR's URIs and the panel shows
		// stale entries.
		const previousPrUrl = this.currentInput?.url;
		if (previousPrUrl && previousPrUrl !== input.url) {
			this.krtCommentController.clearCommentsForPr(previousPrUrl);
		}
		this.currentInput = input;
		this.currentPr = undefined;
		this.automationEvents = undefined;
		this.automationLoading = false;
		this.automationError = undefined;
		this.liveComments = [];
		this.activityTab = 'discussion';
		this.subMode = 'pr';
		this.diffFiles = undefined;
		this.diffFilesLoading = false;
		this.diffFilesError = undefined;
		this.reviewComments = undefined;
		this.reviewCommentsLoading = false;
		this.reviewedPaths = new Set(readReviewedPaths(this.krtStorageService, input.owner, input.repo, input.number));
		this.diffRenderMode = readDiffRenderMode(this.krtStorageService);
		// Restore the previous sub-mode for this PR if we have one.
		// `setInput` resets `subMode` to 'pr' above, so cache hits here
		// override that default. Cache misses keep the 'pr' default.
		const cachedForSubMode = getCached(input.url);
		if (cachedForSubMode?.subMode) {
			this.subMode = cachedForSubMode.subMode;
		}
		this.tourState = undefined;
		this.tourLoading = false;
		this.tourStreaming = false;
		this.tourError = undefined;
		this.tourNoKey = false;
		this.tourSelectedChapterId = undefined;
		this.tourFetchToken++;
		this.storyboardSelectedId = undefined;
		this.tourVariant = readVariant(this.krtStorageService, input.owner, input.repo, input.number);
		this.reviewedChapters = new Set(readReviewedChapters(this.krtStorageService, input.owner, input.repo, input.number));
		this.fetchToken++;
		const myToken = this.fetchToken;

		// Cache hit (under 5 min old) skips the gh shell-out entirely.
		// Sub-resources (files / reviewComments / activity) are seeded
		// from the cache so the loaders short-circuit too.
		const cached = getCached(input.url);
		if (cached) {
			input.setTitle(cached.pr.title);
			this.currentPr = cached.pr;
			this.liveComments = [...cached.pr.comments];
			if (cached.files !== undefined) {
				this.diffFiles = cached.files;
			}
			if (cached.reviewComments !== undefined) {
				this.reviewComments = cached.reviewComments;
				this.krtCommentController.setCommentsForPr(input.url, cached.reviewComments);
			} else if (!this.reviewCommentsLoading) {
				// Cache hit on the PR metadata but the review-comments
				// sub-resource wasn't filled yet. Pre-fetch in the
				// background so the latency overlaps with the user
				// reading the PR sub-mode rather than waiting on a
				// cold `gh api` spawn the moment they click Diff.
				void this.loadReviewComments(cached.pr);
			}
			if (cached.activity !== undefined) {
				this.automationEvents = cached.activity;
			}
			this.renderLoaded(cached.pr);
			recordRecentPullRequest(this.krtStorageService, cached.pr);
			return;
		}

		this.renderPlaceholder(input);
		try {
			// Reuse an in-flight fetch for the same PR if one already
			// exists — switching tabs while a fetch is mid-air shouldn't
			// fire a second `gh` call.
			const existing = getInFlight(input.url);
			const fetchPromise = existing ?? trackFetch(input.url, this.pullRequestProvider.getPullRequest(input.url));
			const pr = await fetchPromise;
			// Cache the result unconditionally — if the user switched
			// tabs while we were fetching, the token check below skips
			// rendering, but the next setInput for this URL should still
			// hit the cache instead of refetching.
			putPr(input.url, pr);
			if (token.isCancellationRequested || this.currentInput !== input || this.fetchToken !== myToken) {
				return;
			}
			input.setTitle(pr.title);
			this.currentPr = pr;
			this.liveComments = [...pr.comments];
			this.renderLoaded(pr);
			recordRecentPullRequest(this.krtStorageService, pr);
			// Pre-fetch the review-comments sub-resource in the
			// background. The `gh api` call costs ~300-500ms (CLI
			// spawn + network), and lazy-loading on Diff entry made
			// the user wait that long before threads appeared. Firing
			// it here overlaps the latency with the user reading the
			// PR sub-mode. `loadReviewComments` is idempotent under
			// `reviewCommentsLoading` and pushes through the
			// controller on resolve, so by the time the user navigates
			// to Diff (or Tour / Storyboard) the threads are ready.
			if (this.reviewComments === undefined && !this.reviewCommentsLoading) {
				void this.loadReviewComments(pr);
			}
		} catch (err) {
			if (this.currentInput !== input || this.fetchToken !== myToken) {
				return;
			}
			if (isKrtError(err)) {
				this.logService.warn(`[krt] pr-pane load failed (${err.kind}): ${err.message}`);
				this.renderError(err.kind, err.message, err.hint);
				return;
			}
			this.logService.error('[krt] pr-pane load failed', err);
			this.renderError('unknown', String(err), localize('krt.pr.unknownErrorHint', "See the developer tools console for details."));
		}
	}

	override clearInput(): void {
		this.currentInput = undefined;
		this.currentPr = undefined;
		this.fetchToken++;
		this.diffFileTree = undefined;
		this.tourSubheadingEl = undefined;
		this.tourStreamingBadgeEl = undefined;
		this.storyboardSubheadingEl = undefined;
		this.storyboardStreamingBadgeEl = undefined;
		this.storyboardScrollerEl = undefined;
		this.storyboardDiffPanelEl = undefined;
		this.bodyDisposables.clear();
		super.clearInput();
	}

	override layout(dimension: DOM.Dimension): void {
		this.root.style.height = `${dimension.height}px`;
		this.root.style.width = `${dimension.width}px`;
	}

	override focus(): void {
		super.focus();
		this.root.focus();
	}

	private renderPlaceholder(input: KrtPullRequestEditorInput): void {
		this.subtitleElement.textContent = `${input.owner}/${input.repo} #${input.number}`;
		this.titleElement.textContent = localize('krt.pr.loading', "Loading…");
		this.statePillElement.textContent = '';
		this.statePillElement.className = 'krt-pr-editor-state-pill';
		this.updateHeaderActionsEnablement();
		this.bodyDisposables.clear();
		DOM.clearNode(this.subModeBarElement);
		DOM.clearNode(this.bodyElement);
		const skeleton = DOM.append(this.bodyElement, DOM.$('.krt-pr-editor-skeleton'));
		skeleton.textContent = localize('krt.pr.fetching', "Fetching pull request from GitHub via gh CLI…");
	}

	private renderLoaded(pr: PullRequest): void {
		this.subtitleElement.textContent = `${pr.owner}/${pr.repo} #${pr.number} · ${pr.author.login}`;
		this.titleElement.textContent = pr.title;
		this.applyStatePill(pr.state);
		this.updateHeaderActionsEnablement();
		// Async — kicks off a HEAD-SHA check that may flip the Check
		// Out button to "Checked out" if we're already on PR head.
		void this.refreshCheckoutStatus();
		this.bodyDisposables.clear();
		DOM.clearNode(this.subModeBarElement);
		DOM.clearNode(this.bodyElement);
		this.renderSubModeBar(pr);
		if (this.subMode === 'diff') {
			this.renderDiffView(pr);
		} else if (this.subMode === 'tour') {
			this.renderTourView(pr);
		} else if (this.subMode === 'storyboard') {
			this.renderStoryboardView(pr);
		} else {
			this.renderPrView(pr);
		}
	}

	private renderPrView(pr: PullRequest): void {
		this.bodyElement.classList.remove('diff', 'tour', 'storyboard');
		this.bodyElement.classList.add('pr');
		const grid = DOM.append(this.bodyElement, DOM.$('.krt-pr-grid'));
		const main = DOM.append(grid, DOM.$('.krt-pr-main'));
		const sidebar = DOM.append(grid, DOM.$('.krt-pr-sidebar'));

		this.renderRefsLine(main, pr);
		this.renderDescription(main, pr);
		this.renderActivitySection(main, pr);
		this.renderReplyBox(main, pr);

		this.renderReviewersCard(sidebar, pr.reviewers);
		this.renderChecksCard(sidebar, pr.checks);
		this.renderLabelsCard(sidebar, pr.labels);
		this.renderStatsCard(sidebar, pr);
	}

	private renderSubModeBar(pr: PullRequest): void {
		const segmented = DOM.append(this.subModeBarElement, DOM.$('.krt-pr-segmented'));
		const prBtn = this.makeSubModeButton(segmented, 'pr', localize('krt.pr.mode.pr', "PR view"));
		const diffBtn = this.makeSubModeButton(segmented, 'diff', localize('krt.pr.mode.diff', "Diff"));
		const tourBtn = this.makeSubModeButton(segmented, 'tour', localize('krt.pr.mode.tour', "Tour"));
		const storyboardBtn = this.makeSubModeButton(segmented, 'storyboard', localize('krt.pr.mode.storyboard', "Storyboard"));
		this.bodyDisposables.add(DOM.addDisposableListener(prBtn, 'click', () => this.switchSubMode('pr', pr)));
		this.bodyDisposables.add(DOM.addDisposableListener(diffBtn, 'click', () => this.switchSubMode('diff', pr)));
		this.bodyDisposables.add(DOM.addDisposableListener(tourBtn, 'click', () => this.switchSubMode('tour', pr)));
		this.bodyDisposables.add(DOM.addDisposableListener(storyboardBtn, 'click', () => this.switchSubMode('storyboard', pr)));
	}

	private makeSubModeButton(parent: HTMLElement, mode: SubMode, label: string): HTMLButtonElement {
		const btn = DOM.append(parent, DOM.$('button.krt-pr-segmented-btn')) as HTMLButtonElement;
		btn.type = 'button';
		btn.textContent = label;
		btn.setAttribute('data-mode', mode);
		if (this.subMode === mode) {
			btn.classList.add('active');
		}
		return btn;
	}

	private switchSubMode(mode: SubMode, pr: PullRequest): void {
		if (this.subMode === mode) {
			return;
		}
		this.subMode = mode;
		// Remember the user's choice so a tab switch doesn't reset
		// them back to PR overview.
		putSubMode(pr.url, mode);
		this.renderLoaded(pr);
	}

	private renderRefsLine(parent: HTMLElement, pr: PullRequest): void {
		const refs = DOM.append(parent, DOM.$('.krt-pr-refs'));
		const head = DOM.append(refs, DOM.$('span.krt-pr-ref'));
		head.textContent = pr.head.label;
		const arrow = DOM.append(refs, DOM.$('span.krt-pr-ref-arrow'));
		arrow.textContent = '->';
		const base = DOM.append(refs, DOM.$('span.krt-pr-ref'));
		base.textContent = pr.base.label;
		const spacer = DOM.append(refs, DOM.$('span.krt-pr-refs-spacer'));
		spacer.textContent = '';
		const stats = DOM.append(refs, DOM.$('span.krt-pr-refs-stats'));
		stats.textContent = `+${pr.stats.additions} -${pr.stats.deletions} · ${pr.stats.changedFiles} file(s)`;
	}

	private renderDescription(parent: HTMLElement, pr: PullRequest): void {
		const card = DOM.append(parent, DOM.$('.krt-pr-card'));
		const head = DOM.append(card, DOM.$('.krt-pr-card-head'));
		const title = DOM.append(head, DOM.$('span.krt-pr-card-title'));
		title.textContent = localize('krt.pr.description', "Description");
		const bodyEl = DOM.append(card, DOM.$('.krt-pr-description'));
		const trimmed = pr.body.trim();
		if (!trimmed) {
			bodyEl.classList.add('empty');
			bodyEl.textContent = localize('krt.pr.noDescription', "No description provided.");
			return;
		}
		const md = new MarkdownString(expandEmojiShortcodes(pr.body), { isTrusted: false, supportThemeIcons: false, supportHtml: true });
		const rendered = renderMarkdown(md, {
			actionHandler: (link) => this.openExternal(link),
		});
		this.bodyDisposables.add(rendered);
		bodyEl.appendChild(rendered.element);
	}

	private renderActivitySection(parent: HTMLElement, pr: PullRequest): void {
		const section = DOM.append(parent, DOM.$('.krt-pr-activity'));
		const tabs = DOM.append(section, DOM.$('.krt-pr-activity-tabs'));
		const heading = DOM.append(tabs, DOM.$('span.krt-pr-activity-heading'));
		heading.textContent = localize('krt.pr.activity', "Activity");

		const { discussionComments, botComments } = this.partitionCommentsByBot(pr);
		// Automation count: events + bot-routed comments. The events
		// list lazy-loads on tab open, so the count reflects whatever's
		// known so far.
		const automationCount = (this.automationEvents?.length ?? 0) + botComments.length;

		const discussion = this.makeTabButton(tabs, 'discussion',
			localize('krt.pr.activity.discussion', "Discussion"),
			discussionComments.length);
		const automation = this.makeTabButton(tabs, 'automation',
			localize('krt.pr.activity.automation', "Automation"),
			automationCount);

		const content = DOM.append(section, DOM.$('.krt-pr-activity-content'));

		const renderActiveTab = () => {
			DOM.clearNode(content);
			discussion.button.classList.toggle('active', this.activityTab === 'discussion');
			automation.button.classList.toggle('active', this.activityTab === 'automation');
			if (this.activityTab === 'discussion') {
				this.renderDiscussion(content, discussionComments);
			} else {
				this.renderAutomation(content, pr, botComments);
			}
		};

		this.bodyDisposables.add(DOM.addDisposableListener(discussion.button, 'click', () => {
			this.activityTab = 'discussion';
			renderActiveTab();
		}));
		this.bodyDisposables.add(DOM.addDisposableListener(automation.button, 'click', () => {
			this.activityTab = 'automation';
			renderActiveTab();
			if (this.automationEvents === undefined && !this.automationLoading) {
				this.loadAutomation(pr, () => {
					automation.count.textContent = countLabel((this.automationEvents?.length ?? 0) + botComments.length);
					if (this.activityTab === 'automation') {
						renderActiveTab();
					}
				});
			}
		}));

		renderActiveTab();
	}

	private makeTabButton(parent: HTMLElement, kind: ActivityTab, label: string, count: number | undefined): { button: HTMLButtonElement; count: HTMLElement } {
		const btn = DOM.append(parent, DOM.$('button.krt-pr-tab')) as HTMLButtonElement;
		btn.setAttribute('type', 'button');
		btn.setAttribute('data-tab', kind);
		const labelEl = DOM.append(btn, DOM.$('span.krt-pr-tab-label'));
		labelEl.textContent = label;
		const countEl = DOM.append(btn, DOM.$('span.krt-pr-tab-count'));
		countEl.textContent = countLabel(count);
		return { button: btn, count: countEl };
	}

	/**
	 * Splits `liveComments` into Discussion vs Automation buckets by
	 * looking up each author against the active workspace's bot list.
	 * No workspace registered → no bots → everyone lands in Discussion
	 * (preserves the pre-Phase-10 behaviour).
	 */
	private partitionCommentsByBot(pr: PullRequest): { discussionComments: Comment[]; botComments: Comment[] } {
		const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
		if (!workspace) {
			return { discussionComments: [...this.liveComments], botComments: [] };
		}
		const discussionComments: Comment[] = [];
		const botComments: Comment[] = [];
		for (const c of this.liveComments) {
			if (this.botListService.isBot(workspace.folderUri, c.author.login)) {
				botComments.push(c);
			} else {
				discussionComments.push(c);
			}
		}
		return { discussionComments, botComments };
	}

	private renderDiscussion(parent: HTMLElement, comments: readonly Comment[]): void {
		if (comments.length === 0) {
			const empty = DOM.append(parent, DOM.$('.krt-pr-empty'));
			empty.textContent = localize('krt.pr.noDiscussion', "No discussion yet. Be the first to comment.");
			return;
		}
		const timeline = DOM.append(parent, DOM.$('.krt-pr-timeline'));
		for (const comment of comments) {
			this.renderCommentCard(timeline, comment);
		}
	}

	private renderCommentCard(parent: HTMLElement, comment: Comment): void {
		const row = DOM.append(parent, DOM.$('.krt-pr-comment'));
		const head = DOM.append(row, DOM.$('.krt-pr-comment-head'));
		this.renderAvatar(head, comment.author);
		const author = DOM.append(head, DOM.$('span.krt-pr-comment-author'));
		author.textContent = comment.author.login;
		const verb = DOM.append(head, DOM.$('span.krt-pr-comment-verb'));
		verb.textContent = localize('krt.pr.commented', "commented");
		const sep = DOM.append(head, DOM.$('span.krt-pr-comment-sep'));
		sep.textContent = '·';
		const when = DOM.append(head, DOM.$('span.krt-pr-comment-when'));
		when.textContent = relativeTime(comment.createdAt);
		// Spacer pushes the kebab menu to the right edge of the head.
		DOM.append(head, DOM.$('span.krt-pr-comment-spacer'));
		this.renderCommentMenu(head, comment.author.login);
		const body = DOM.append(row, DOM.$('.krt-pr-comment-body'));
		if (comment.body.trim()) {
			const md = new MarkdownString(expandEmojiShortcodes(comment.body), { isTrusted: false, supportHtml: true });
			const rendered = renderMarkdown(md, {
				actionHandler: link => this.openExternal(link),
			});
			this.bodyDisposables.add(rendered);
			body.appendChild(rendered.element);
		} else {
			body.classList.add('empty');
			body.textContent = localize('krt.pr.commentEmpty', "(empty comment)");
		}
	}

	/**
	 * Kebab dropdown rendered at the right edge of every comment
	 * header. The single action today flips the author's bot status
	 * for the active workspace; the menu surface is the right shape
	 * for adding more per-comment actions (resolve, copy permalink,
	 * etc.) without re-plumbing the chrome each time.
	 *
	 * Renders nothing when no workspace is registered for the PR (the
	 * bot list has no scope to land in).
	 */
	private renderCommentMenu(parent: HTMLElement, login: string): void {
		const pr = this.currentPr;
		if (!pr) {
			return;
		}
		const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
		if (!workspace) {
			return;
		}
		const btn = DOM.append(parent, DOM.$('button.krt-pr-comment-menu-btn')) as HTMLButtonElement;
		btn.type = 'button';
		btn.title = localize('krt.pr.commentMenu.tooltip', "More actions");
		btn.setAttribute('aria-label', btn.title);
		DOM.append(btn, DOM.$('span.codicon.codicon-kebab-vertical'));

		this.bodyDisposables.add(DOM.addDisposableListener(btn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			const isBot = this.botListService.isBot(workspace.folderUri, login);
			this.contextMenuService.showContextMenu({
				getAnchor: () => btn,
				getActions: () => [
					toAction({
						id: isBot ? 'krt.pr.botList.unmark' : 'krt.pr.botList.mark',
						label: isBot
							? localize('krt.pr.botList.unmark', "Mark as Discussion")
							: localize('krt.pr.botList.mark', "Mark as Automation"),
						enabled: true,
						run: () => {
							if (isBot) {
								this.botListService.removeBot(workspace.folderUri, login);
							} else {
								this.botListService.addBot(workspace.folderUri, login);
							}
						},
					}),
				],
			});
		}));
	}

	/**
	 * Renders a comment author's avatar — `<img>` from the GitHub
	 * `avatarUrl` when present, otherwise a deterministic initial-letter
	 * chip coloured by the login. Mirrors the demo's avatar treatment
	 * (small disc next to the author name).
	 */
	private renderAvatar(parent: HTMLElement, user: { login: string; avatarUrl?: string }): void {
		if (user.avatarUrl) {
			const img = DOM.append(parent, DOM.$('img.krt-pr-comment-avatar')) as HTMLImageElement;
			// `s=40` is the smallest GitHub-served size that still looks
			// crisp on a 16-20px display target after device-pixel-ratio
			// scaling.
			img.src = appendSizeParam(user.avatarUrl, 40);
			img.alt = '';
			img.loading = 'lazy';
			return;
		}
		const fallback = DOM.append(parent, DOM.$('span.krt-pr-comment-avatar.fallback'));
		fallback.textContent = (user.login.charAt(0) || '?').toUpperCase();
		fallback.style.backgroundColor = colorFromLogin(user.login);
	}

	private renderAutomation(parent: HTMLElement, _pr: PullRequest, botComments: readonly Comment[]): void {
		if (this.automationLoading) {
			const loading = DOM.append(parent, DOM.$('.krt-pr-empty'));
			loading.textContent = localize('krt.pr.automationLoading', "Loading automation events…");
			return;
		}
		if (this.automationError) {
			const err = DOM.append(parent, DOM.$('.krt-pr-empty.error'));
			err.textContent = this.automationError;
			return;
		}
		const events = this.automationEvents ?? [];
		if (events.length === 0 && botComments.length === 0) {
			const empty = DOM.append(parent, DOM.$('.krt-pr-empty'));
			empty.textContent = localize('krt.pr.noAutomation', "No automation events.");
			return;
		}
		// Merge timeline events and bot-routed comments by timestamp so
		// the row order tracks chronology rather than separating bot
		// chatter into its own block.
		type Entry =
			| { readonly kind: 'event'; readonly ev: AutomationEvent; readonly at: string }
			| { readonly kind: 'comment'; readonly c: Comment; readonly at: string };
		const entries: Entry[] = [
			...events.map((ev): Entry => ({ kind: 'event', ev, at: ev.at })),
			...botComments.map((c): Entry => ({ kind: 'comment', c, at: c.createdAt })),
		].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

		const timeline = DOM.append(parent, DOM.$('.krt-pr-timeline'));
		for (const entry of entries) {
			if (entry.kind === 'event') {
				this.renderAutomationRow(timeline, entry.ev);
			} else {
				this.renderCommentCard(timeline, entry.c);
			}
		}
	}

	private renderAutomationRow(parent: HTMLElement, ev: AutomationEvent): void {
		const row = DOM.append(parent, DOM.$('.krt-pr-automation-row'));
		const kind = DOM.append(row, DOM.$('span.krt-pr-automation-kind'));
		kind.textContent = ev.kind;
		const actor = DOM.append(row, DOM.$('span.krt-pr-automation-actor'));
		actor.textContent = ev.actor.login;
		const summary = DOM.append(row, DOM.$('span.krt-pr-automation-summary'));
		summary.textContent = ev.summary;
		const when = DOM.append(row, DOM.$('span.krt-pr-automation-when'));
		when.textContent = ev.at ? relativeTime(ev.at) : '';
	}

	private async loadAutomation(pr: PullRequest, onDone: () => void): Promise<void> {
		this.automationLoading = true;
		try {
			const events = await this.pullRequestProvider.getActivity(pr.url);
			this.automationLoading = false;
			this.automationEvents = events;
			putActivity(pr.url, events);
		} catch (e) {
			this.automationLoading = false;
			this.automationEvents = [];
			this.automationError = isKrtError(e) ? e.message : String(e);
			this.logService.warn('[krt] pr-pane automation fetch failed', e);
		}
		onDone();
	}

	private renderReplyBox(parent: HTMLElement, pr: PullRequest): void {
		const card = DOM.append(parent, DOM.$('.krt-pr-reply'));
		const textarea = DOM.append(card, DOM.$('textarea.krt-pr-reply-input')) as HTMLTextAreaElement;
		textarea.placeholder = localize('krt.pr.replyPlaceholder', "Leave a comment…");
		textarea.rows = 3;
		const actions = DOM.append(card, DOM.$('.krt-pr-reply-actions'));
		const errorEl = DOM.append(card, DOM.$('.krt-pr-reply-error'));
		errorEl.hidden = true;
		const spacer = DOM.append(actions, DOM.$('span.krt-pr-reply-spacer'));
		spacer.textContent = '';
		const submit = DOM.append(actions, DOM.$('button.krt-pr-reply-submit')) as HTMLButtonElement;
		submit.type = 'button';
		submit.textContent = localize('krt.pr.replySubmit', "Comment");

		const setBusy = (busy: boolean) => {
			submit.disabled = busy;
			textarea.disabled = busy;
			submit.textContent = busy
				? localize('krt.pr.replyPosting', "Posting…")
				: localize('krt.pr.replySubmit', "Comment");
		};

		this.bodyDisposables.add(DOM.addDisposableListener(submit, 'click', async () => {
			const body = textarea.value.trim();
			if (!body) {
				return;
			}
			errorEl.hidden = true;
			errorEl.textContent = '';
			setBusy(true);
			try {
				const created = await this.pullRequestProvider.postIssueComment(pr.url, body);
				if (this.currentPr?.url !== pr.url) {
					return;
				}
				// Invalidate the cache so the next setInput re-fetches —
				// our `liveComments` reflects the new comment for the
				// rest of *this* session, but a subsequent reopen should
				// see the canonical server-side timeline.
				invalidatePrCache(pr.url);
				this.liveComments = [...this.liveComments, created];
				textarea.value = '';
				this.activityTab = 'discussion';
				this.renderLoaded(this.currentPr);
			} catch (e) {
				errorEl.hidden = false;
				errorEl.textContent = isKrtError(e) ? `${e.message} — ${e.hint}` : String(e);
				this.logService.warn('[krt] pr-pane post comment failed', e);
			} finally {
				setBusy(false);
			}
		}));
	}

	private renderReviewersCard(parent: HTMLElement, reviewers: readonly Reviewer[]): void {
		const card = this.makeSidebarCard(parent, localize('krt.pr.reviewers', "Reviewers"));
		if (reviewers.length === 0) {
			this.appendCardEmpty(card, localize('krt.pr.noReviewers', "No reviewers requested."));
			return;
		}
		for (const r of reviewers) {
			const row = DOM.append(card, DOM.$('.krt-pr-reviewer'));
			const login = DOM.append(row, DOM.$('span.krt-pr-reviewer-login'));
			login.textContent = r.user.login;
			const state = DOM.append(row, DOM.$('span.krt-pr-reviewer-state'));
			state.classList.add(r.state);
			state.textContent = reviewerStateLabel(r.state);
		}
	}

	private renderChecksCard(parent: HTMLElement, checks: readonly CheckRun[]): void {
		const card = this.makeSidebarCard(parent, localize('krt.pr.checks', "Checks"));
		const deduped = dedupeChecksByName(checks);
		if (deduped.length === 0) {
			this.appendCardEmpty(card, localize('krt.pr.noChecks', "No checks reported."));
			return;
		}
		for (const c of deduped) {
			const row = DOM.append(card, DOM.$('.krt-pr-check'));
			const status = DOM.append(row, DOM.$('span.krt-pr-check-status'));
			status.classList.add(c.conclusion);
			status.textContent = checkConclusionGlyph(c.conclusion);
			const name = DOM.append(row, DOM.$('span.krt-pr-check-name'));
			name.textContent = c.name;
			const meta = DOM.append(row, DOM.$('span.krt-pr-check-meta'));
			if (c.conclusion === 'pending') {
				meta.classList.add('pending');
				meta.textContent = localize('krt.pr.checkRunning', "running…");
			} else {
				const at = c.completedAt ?? c.startedAt;
				if (at) {
					meta.textContent = relativeTime(at);
				}
			}
			if (c.detailsUrl) {
				row.classList.add('clickable');
				row.setAttribute('role', 'link');
				row.setAttribute('tabindex', '0');
				row.title = c.detailsUrl;
				const click = () => this.openExternal(c.detailsUrl!);
				this.bodyDisposables.add(DOM.addDisposableListener(row, 'click', click));
				this.bodyDisposables.add(DOM.addDisposableListener(row, 'keydown', e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						click();
					}
				}));
				const arrow = DOM.append(row, DOM.$('span.krt-pr-check-arrow'));
				arrow.textContent = '>';
			}
		}
	}

	private renderLabelsCard(parent: HTMLElement, labels: readonly string[]): void {
		const card = this.makeSidebarCard(parent, localize('krt.pr.labels', "Labels"));
		if (labels.length === 0) {
			this.appendCardEmpty(card, localize('krt.pr.noLabels', "No labels."));
			return;
		}
		const wrap = DOM.append(card, DOM.$('.krt-pr-labels'));
		for (const l of labels) {
			const chip = DOM.append(wrap, DOM.$('span.krt-pr-label-chip'));
			chip.textContent = l;
		}
	}

	private renderStatsCard(parent: HTMLElement, pr: PullRequest): void {
		const card = this.makeSidebarCard(parent, localize('krt.pr.stats', "Stats"));
		this.appendStatRow(card, localize('krt.pr.stat.files', "Files"), String(pr.stats.changedFiles));
		this.appendStatRow(card, localize('krt.pr.stat.added', "Lines added"), `+${pr.stats.additions}`, 'add');
		this.appendStatRow(card, localize('krt.pr.stat.removed', "Lines removed"), `-${pr.stats.deletions}`, 'del');
		this.appendStatRow(card, localize('krt.pr.stat.updated', "Last updated"), relativeTime(pr.updatedAt));
	}

	private makeSidebarCard(parent: HTMLElement, title: string): HTMLElement {
		const card = DOM.append(parent, DOM.$('.krt-pr-side-card'));
		const head = DOM.append(card, DOM.$('.krt-pr-side-card-title'));
		head.textContent = title;
		return card;
	}

	private appendCardEmpty(card: HTMLElement, text: string): void {
		const empty = DOM.append(card, DOM.$('.krt-pr-side-empty'));
		empty.textContent = text;
	}

	private appendStatRow(card: HTMLElement, key: string, value: string, tone?: 'add' | 'del'): void {
		const row = DOM.append(card, DOM.$('.krt-pr-stat'));
		const k = DOM.append(row, DOM.$('span.krt-pr-stat-key'));
		k.textContent = key;
		const v = DOM.append(row, DOM.$('span.krt-pr-stat-value'));
		if (tone) {
			v.classList.add(tone);
		}
		v.textContent = value;
	}

	// ---------- Diff sub-mode ----------

	private renderDiffView(pr: PullRequest): void {
		this.bodyElement.classList.remove('pr', 'tour', 'storyboard');
		this.bodyElement.classList.add('diff');
		this.renderDiffTopBar(this.bodyElement, pr);
		const wrap = DOM.append(this.bodyElement, DOM.$('.krt-pr-diff'));
		const tree = DOM.append(wrap, DOM.$('.krt-pr-diff-tree'));
		const host = DOM.append(wrap, DOM.$('.krt-pr-multidiff-host'));

		if (this.diffFiles === undefined) {
			const empty = DOM.append(host, DOM.$('.krt-pr-empty'));
			empty.textContent = this.diffFilesLoading
				? localize('krt.pr.diffLoading', "Loading changed files…")
				: localize('krt.pr.diffPending', "Fetching changed files…");
			const treeEmpty = DOM.append(tree, DOM.$('.krt-pr-side-empty'));
			treeEmpty.textContent = localize('krt.pr.diffTreeLoading', "Loading…");
			if (!this.diffFilesLoading) {
				this.loadDiffFiles(pr);
			}
			return;
		}
		if (this.diffFilesError) {
			const err = DOM.append(host, DOM.$('.krt-pr-empty.error'));
			err.textContent = this.diffFilesError;
			const treeErr = DOM.append(tree, DOM.$('.krt-pr-side-empty'));
			treeErr.textContent = localize('krt.pr.diffTreeError', "Couldn't load files.");
			return;
		}
		if (this.diffFiles.length === 0) {
			const empty = DOM.append(host, DOM.$('.krt-pr-empty'));
			empty.textContent = localize('krt.pr.diffNoFiles', "This PR has no file changes.");
			return;
		}

		// Phase 10/B strict gate — the diff is a real Monaco multi-diff
		// editor backed by file:// (modified) + krt-git:// (original)
		// URIs. For the file:// URI to give the right content the
		// working tree must be on the PR's head SHA, which means a
		// workspace must be registered for the repo AND that workspace
		// must currently be checked out to the PR head. Without that we
		// can't honour requirement #1 (Monaco pane with LSP) — fall
		// through to a CTA that nudges the user toward the existing
		// Check Out button in the PR header.
		const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
		if (!workspace) {
			const treeEmpty = DOM.append(tree, DOM.$('.krt-pr-side-empty'));
			treeEmpty.textContent = localize('krt.pr.diffTreeNoWorkspace', "No workspace");
			const cta = DOM.append(host, DOM.$('.krt-pr-diff-cta'));
			const heading = DOM.append(cta, DOM.$('.krt-pr-diff-cta-heading'));
			heading.textContent = localize('krt.pr.diffCtaNoWorkspace.heading', "No workspace registered for {0}/{1}", pr.owner, pr.repo);
			const body = DOM.append(cta, DOM.$('.krt-pr-diff-cta-body'));
			body.textContent = localize(
				'krt.pr.diffCtaNoWorkspace.body',
				"KRT renders the diff using files from the local clone so language extensions (rust-analyzer, gopls, …) light up. Add a workspace for this repo to enable the diff view.",
			);
			const btn = DOM.append(cta, DOM.$('button.krt-pr-diff-cta-btn')) as HTMLButtonElement;
			btn.type = 'button';
			btn.textContent = localize('krt.pr.diffCtaNoWorkspace.add', "Add Workspace…");
			this.bodyDisposables.add(DOM.addDisposableListener(btn, 'click', () => {
				void this.commandService.executeCommand('krt.workspace.add');
			}));
			return;
		}
		if (!this.isCheckedOut) {
			const treeEmpty = DOM.append(tree, DOM.$('.krt-pr-side-empty'));
			treeEmpty.textContent = localize('krt.pr.diffTreeNeedsCheckout', "Check out PR");
			const cta = DOM.append(host, DOM.$('.krt-pr-diff-cta'));
			const heading = DOM.append(cta, DOM.$('.krt-pr-diff-cta-heading'));
			heading.textContent = localize('krt.pr.diffCtaCheckout.heading', "Check out PR #{0} to review the diff", pr.number);
			const body = DOM.append(cta, DOM.$('.krt-pr-diff-cta-body'));
			body.textContent = localize(
				'krt.pr.diffCtaCheckout.body',
				"KRT renders the diff against the working tree at the PR's head commit. Click Start Review in the header above; KRT switches the working tree non-destructively (jj op restore / git stash) and the diff appears here with full LSP support.",
			);
			return;
		}

		// Kick off review comments fetch lazily so Phase C has data
		// to push through the native Comments API once the controller
		// lands.
		if (this.reviewComments === undefined && !this.reviewCommentsLoading) {
			this.loadReviewComments(pr);
		}

		// Mount the flat-diff stack. Each file gets its own
		// `DiffEditorWidget` sized to fit its content; the outer pane
		// is the scroll surface, so the user scrolls naturally through
		// the whole PR. Flipping the side-by-side toggle re-runs
		// `renderLoaded` (see `renderDiffTopBar`) which rebuilds with
		// the new render mode.
		const flatDiff = this.instantiationService.createInstance(KrtPrFlatDiff, host);
		this.bodyDisposables.add(flatDiff);
		// Phase 11 — show every chapter's chips on the main Diff
		// surface; this view doesn't have a single "current chapter"
		// the way Tour does, so the union of all chips is the right
		// signal to surface here.
		const allChips = this.tourState
			? this.tourState.chapters.flatMap(c => c.chips)
			: [];
		void flatDiff.setPullRequest(pr, this.diffFiles, workspace, {
			renderSideBySide: this.diffRenderMode === 'side-by-side',
			chips: allChips,
		});

		// File tree on the left — folder-grouped with collapsible
		// folders and persistent expand state per PR. Filename click
		// hands off to the Code editor view (Phase 9). Per-file
		// scroll-to-card affordance + inline mark-reviewed checkbox
		// kept on each row.
		this.diffFileTree = this.bodyDisposables.add(new KrtDiffFileTree(
			tree,
			this.krtStorageService,
			pr.owner,
			pr.repo,
			pr.number,
			this.reviewedPaths,
			{
				onScrollToFile: path => flatDiff.scrollToFile(path),
				onOpenInEditor: path => this.openFileInEditor(pr, workspace, path),
				onToggleReviewed: (path, reviewed) => this.toggleFileReviewed(path, reviewed),
			},
		));
		this.diffFileTree.setFiles(this.diffFiles);
	}

	private openFileInEditor(pr: PullRequest, workspace: KrtWorkspace, path: string): void {
		// Prefer the workspace's real file:// URI when the working tree
		// is on the PR head — that's what Phase 9's Editor view expects
		// (live LSP, edits) and matches the diff's modified side. When
		// not checked out, fall back to a krt-git:// URI bound to the
		// PR head so the user still sees the PR's content (read-only).
		const resource = this.isCheckedOut
			? URI.joinPath(URI.file(workspace.folderPath), path)
			: encodeKrtGit(workspace.folderUri, workspace.folderPath, pr.head.sha, path);
		void this.editorService.openEditor(
			{ resource, options: { pinned: true, preserveFocus: false } },
			SIDE_GROUP,
		);
	}

	private toggleFileReviewed(path: string, reviewed: boolean): void {
		if (reviewed) {
			this.reviewedPaths.add(path);
		} else {
			this.reviewedPaths.delete(path);
		}
		const input = this.currentInput;
		if (input) {
			writeReviewedPaths(this.krtStorageService, input.owner, input.repo, input.number, this.reviewedPaths);
		}
	}

	private renderDiffTopBar(parent: HTMLElement, pr: PullRequest): void {
		const bar = DOM.append(parent, DOM.$('.krt-pr-diff-topbar'));
		const toggle = DOM.append(bar, DOM.$('.krt-pr-diff-mode-toggle'));
		const sideBySideBtn = DOM.append(toggle, DOM.$('button.krt-pr-diff-mode-btn')) as HTMLButtonElement;
		sideBySideBtn.type = 'button';
		sideBySideBtn.textContent = localize('krt.pr.diff.sideBySide', "Side-by-side");
		const inlineBtn = DOM.append(toggle, DOM.$('button.krt-pr-diff-mode-btn')) as HTMLButtonElement;
		inlineBtn.type = 'button';
		inlineBtn.textContent = localize('krt.pr.diff.inline', "Inline");
		const apply = () => {
			sideBySideBtn.classList.toggle('active', this.diffRenderMode === 'side-by-side');
			inlineBtn.classList.toggle('active', this.diffRenderMode === 'inline');
		};
		apply();
		this.bodyDisposables.add(DOM.addDisposableListener(sideBySideBtn, 'click', () => {
			if (this.diffRenderMode === 'side-by-side') {
				return;
			}
			this.diffRenderMode = 'side-by-side';
			writeDiffRenderMode(this.krtStorageService, this.diffRenderMode);
			this.renderLoaded(pr);
		}));
		this.bodyDisposables.add(DOM.addDisposableListener(inlineBtn, 'click', () => {
			if (this.diffRenderMode === 'inline') {
				return;
			}
			this.diffRenderMode = 'inline';
			writeDiffRenderMode(this.krtStorageService, this.diffRenderMode);
			this.renderLoaded(pr);
		}));
	}

	private async loadDiffFiles(pr: PullRequest): Promise<void> {
		this.diffFilesLoading = true;
		this.diffFilesError = undefined;
		try {
			const files = await this.pullRequestProvider.getFiles(pr.url);
			if (this.currentPr?.url !== pr.url) {
				return;
			}
			this.diffFiles = files;
			this.diffFilesLoading = false;
			putFiles(pr.url, files);
			if (this.subMode === 'diff') {
				this.renderLoaded(pr);
			}
		} catch (e) {
			this.diffFilesLoading = false;
			this.diffFiles = [];
			this.diffFilesError = isKrtError(e) ? e.message : String(e);
			this.logService.warn('[krt] pr-pane diff fetch failed', e);
			if (this.subMode === 'diff') {
				this.renderLoaded(pr);
			}
		}
	}

	private async loadReviewComments(pr: PullRequest): Promise<void> {
		this.reviewCommentsLoading = true;
		try {
			const comments = await this.pullRequestProvider.getReviewComments(pr.url);
			if (this.currentPr?.url !== pr.url) {
				return;
			}
			this.reviewComments = comments;
			this.reviewCommentsLoading = false;
			putReviewComments(pr.url, comments);
			this.krtCommentController.setCommentsForPr(pr.url, comments);
			if (this.subMode === 'diff') {
				this.renderLoaded(pr);
			}
		} catch (e) {
			this.reviewCommentsLoading = false;
			this.reviewComments = [];
			this.krtCommentController.setCommentsForPr(pr.url, []);
			this.logService.warn('[krt] pr-pane review-comments fetch failed', e);
		}
	}

	// ---------- Tour sub-mode ----------

	private renderTourView(pr: PullRequest): void {
		this.bodyElement.classList.remove('pr', 'diff', 'storyboard');
		this.bodyElement.classList.add('tour');

		// Header bar with variant toggle.
		const headerBar = DOM.append(this.bodyElement, DOM.$('.krt-pr-tour-header'));
		const heading = DOM.append(headerBar, DOM.$('.krt-pr-tour-heading'));
		heading.textContent = localize('krt.pr.tour.heading', "AI Tour");
		const subHeading = DOM.append(headerBar, DOM.$('.krt-pr-tour-subheading'));
		this.tourSubheadingEl = subHeading;
		const streamingBadge = DOM.append(headerBar, DOM.$('span.krt-pr-streaming-badge'));
		this.tourStreamingBadgeEl = streamingBadge;
		this.refreshTourSubheading();
		this.renderTourVariantToggle(headerBar, pr);

		const body = DOM.append(this.bodyElement, DOM.$('.krt-pr-tour-body'));

		if (this.tourNoKey) {
			this.renderTourEmptyNoKey(body);
			return;
		}
		if (this.tourLoading && !this.tourState) {
			renderTourLoadingState(body, localize('krt.pr.tour.loading', "Generating chapters with the Anthropic API…"));
			return;
		}
		if (this.tourError) {
			const err = DOM.append(body, DOM.$('.krt-pr-empty.error'));
			err.textContent = this.tourError;
			const retry = DOM.append(body, DOM.$('button.krt-pr-tour-retry')) as HTMLButtonElement;
			retry.type = 'button';
			retry.textContent = localize('krt.pr.tour.retry', "Try again");
			this.bodyDisposables.add(DOM.addDisposableListener(retry, 'click', () => {
				this.tourError = undefined;
				void this.loadTour(pr, /* forceRefresh */ true);
			}));
			return;
		}
		if (!this.tourState) {
			renderTourLoadingState(body, localize('krt.pr.tour.starting', "Preparing tour…"));
			void this.loadTour(pr, /* forceRefresh */ false);
			return;
		}
		if (this.tourState.chapters.length === 0) {
			const empty = DOM.append(body, DOM.$('.krt-pr-empty'));
			empty.textContent = localize('krt.pr.tour.noChapters', "The model returned no chapters for this PR.");
			return;
		}

		if (this.tourVariant === 'reading') {
			this.renderTourReading(body, pr, this.tourState.chapters);
		} else {
			this.renderTourChapters(body, pr, this.tourState.chapters);
		}
	}

	private renderTourEmptyNoKey(parent: HTMLElement): void {
		const card = DOM.append(parent, DOM.$('.krt-pr-tour-empty'));
		const heading = DOM.append(card, DOM.$('h2.krt-pr-tour-empty-heading'));
		heading.textContent = localize('krt.pr.tour.noKeyHeading', "Bring your own Anthropic key");
		const body = DOM.append(card, DOM.$('p.krt-pr-tour-empty-body'));
		body.textContent = localize(
			'krt.pr.tour.noKeyBody',
			"KRT generates the AI Tour by calling api.anthropic.com directly with your key. Nothing is proxied through a KRT-operated server. The key is stored in your OS keychain.",
		);
		const cta = DOM.append(card, DOM.$('button.krt-pr-tour-cta')) as HTMLButtonElement;
		cta.type = 'button';
		cta.textContent = localize('krt.pr.tour.configureCta', "Configure Anthropic API Key…");
		this.bodyDisposables.add(DOM.addDisposableListener(cta, 'click', async () => {
			await this.commandService.executeCommand('krt.configureAnthropicKey');
			// After the user completes the dialog, retry.
			if (this.currentPr) {
				this.tourNoKey = false;
				this.tourState = undefined;
				this.renderLoaded(this.currentPr);
			}
		}));
		const modelCta = DOM.append(card, DOM.$('button.krt-pr-tour-cta-secondary')) as HTMLButtonElement;
		modelCta.type = 'button';
		modelCta.textContent = localize('krt.pr.tour.modelCta', "Select model…");
		this.bodyDisposables.add(DOM.addDisposableListener(modelCta, 'click', () => {
			void this.commandService.executeCommand('krt.selectAnthropicModel');
		}));
	}

	private renderTourVariantToggle(parent: HTMLElement, pr: PullRequest): void {
		const toggle = DOM.append(parent, DOM.$('.krt-pr-tour-variant'));
		const chaptersBtn = DOM.append(toggle, DOM.$('button.krt-pr-tour-variant-btn')) as HTMLButtonElement;
		chaptersBtn.type = 'button';
		chaptersBtn.textContent = localize('krt.pr.tour.variantChapters', "Chapters");
		chaptersBtn.classList.toggle('active', this.tourVariant === 'chapters');
		const readingBtn = DOM.append(toggle, DOM.$('button.krt-pr-tour-variant-btn')) as HTMLButtonElement;
		readingBtn.type = 'button';
		readingBtn.textContent = localize('krt.pr.tour.variantReading', "Reading");
		readingBtn.classList.toggle('active', this.tourVariant === 'reading');
		const onSelect = (variant: TourVariant) => {
			if (this.tourVariant === variant || !this.currentInput) {
				return;
			}
			this.tourVariant = variant;
			writeVariant(this.krtStorageService, this.currentInput.owner, this.currentInput.repo, this.currentInput.number, variant);
			this.renderLoaded(pr);
		};
		this.bodyDisposables.add(DOM.addDisposableListener(chaptersBtn, 'click', () => onSelect('chapters')));
		this.bodyDisposables.add(DOM.addDisposableListener(readingBtn, 'click', () => onSelect('reading')));
	}

	private renderTourChapters(parent: HTMLElement, pr: PullRequest, chapters: readonly Chapter[]): void {
		const layout = DOM.append(parent, DOM.$('.krt-pr-tour-layout'));
		const rail = DOM.append(layout, DOM.$('.krt-pr-tour-rail'));
		const detail = DOM.append(layout, DOM.$('.krt-pr-tour-detail'));

		// Default selected chapter.
		const selectedId = this.tourSelectedChapterId
			&& chapters.some(c => c.id === this.tourSelectedChapterId)
			? this.tourSelectedChapterId
			: chapters[0].id;
		this.tourSelectedChapterId = selectedId;

		for (const chapter of chapters) {
			const card = DOM.append(rail, DOM.$('.krt-pr-tour-card'));
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			if (chapter.id === selectedId) {
				card.classList.add('selected');
			}
			if (this.reviewedChapters.has(chapter.id)) {
				card.classList.add('reviewed');
			}
			if (chapter.sensitive) {
				card.classList.add('sensitive');
			}

			const head = DOM.append(card, DOM.$('.krt-pr-tour-card-head'));
			const title = DOM.append(head, DOM.$('span.krt-pr-tour-card-title'));
			renderChapterMarkdown(title, chapter.title, this.bodyDisposables, { inline: true });
			if (chapter.sensitive) {
				const badge = DOM.append(head, DOM.$('span.krt-pr-tour-sensitive-badge'));
				badge.textContent = localize('krt.pr.tour.sensitiveBadge', "Caution");
				if (chapter.sensitiveReason) {
					badge.title = chapter.sensitiveReason;
				}
			}

			const summary = DOM.append(card, DOM.$('div.krt-pr-tour-card-summary'));
			renderChapterMarkdown(summary, chapter.summary, this.bodyDisposables);

			const meta = DOM.append(card, DOM.$('.krt-pr-tour-card-meta'));
			const filesCount = DOM.append(meta, DOM.$('span.krt-pr-tour-card-files'));
			filesCount.textContent = chapter.files.length === 1
				? localize('krt.pr.tour.oneFile', "1 file")
				: localize('krt.pr.tour.nFiles', "{0} files", chapter.files.length);
			const counts = DOM.append(meta, DOM.$('span.krt-pr-tour-card-counts'));
			const add = DOM.append(counts, DOM.$('span.add'));
			add.textContent = `+${chapter.plus}`;
			const del = DOM.append(counts, DOM.$('span.del'));
			del.textContent = `-${chapter.minus}`;

			const reviewedLbl = DOM.append(card, DOM.$('label.krt-pr-tour-reviewed'));
			const reviewedBox = DOM.append(reviewedLbl, DOM.$('input')) as HTMLInputElement;
			reviewedBox.type = 'checkbox';
			reviewedBox.checked = this.reviewedChapters.has(chapter.id);
			const reviewedTxt = DOM.append(reviewedLbl, DOM.$('span'));
			reviewedTxt.textContent = localize('krt.pr.tour.reviewedCheck', "Reviewed");
			this.bodyDisposables.add(DOM.addDisposableListener(reviewedBox, 'change', e => {
				e.stopPropagation();
				this.toggleChapterReviewed(chapter.id, reviewedBox.checked);
				card.classList.toggle('reviewed', reviewedBox.checked);
				this.refreshTourSubheading();
			}));
			// Prevent the label's click from also bubbling as a card click.
			this.bodyDisposables.add(DOM.addDisposableListener(reviewedLbl, 'click', e => e.stopPropagation()));

			const select = (fromKeyboard: boolean) => {
				// Don't steal the click when the user is selecting
				// text inside the card.
				if (!fromKeyboard && hasActiveSelection(card)) {
					return;
				}
				if (this.tourSelectedChapterId === chapter.id) {
					return;
				}
				this.tourSelectedChapterId = chapter.id;
				const rootScroll = this.captureRootScroll();
				this.renderLoaded(pr);
				this.restoreRootScroll(rootScroll);
			};
			this.bodyDisposables.add(DOM.addDisposableListener(card, 'click', () => select(false)));
			this.bodyDisposables.add(DOM.addDisposableListener(card, 'keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					select(true);
				}
			}));
		}

		// Detail pane shows the selected chapter's mini-diff(s).
		const selected = chapters.find(c => c.id === selectedId) ?? chapters[0];
		this.renderTourChapterDetail(detail, pr, selected);
	}

	private renderTourChapterDetail(parent: HTMLElement, pr: PullRequest, chapter: Chapter): void {
		const head = DOM.append(parent, DOM.$('.krt-pr-tour-detail-head'));
		const title = DOM.append(head, DOM.$('h2.krt-pr-tour-detail-title'));
		renderChapterMarkdown(title, chapter.title, this.bodyDisposables, { inline: true });
		if (chapter.sensitive && chapter.sensitiveReason) {
			const callout = DOM.append(parent, DOM.$('.krt-pr-tour-callout'));
			const heading = DOM.append(callout, DOM.$('span.krt-pr-tour-callout-heading'));
			heading.textContent = localize('krt.pr.tour.flaggedHeading', "Flagged by reviewer");
			const body = DOM.append(callout, DOM.$('span.krt-pr-tour-callout-body'));
			renderChapterMarkdown(body, chapter.sensitiveReason, this.bodyDisposables, { inline: true });
		}
		const summary = DOM.append(parent, DOM.$('div.krt-pr-tour-detail-summary'));
		renderChapterMarkdown(summary, chapter.summary, this.bodyDisposables);
		if (chapter.bullets.length > 0) {
			const list = DOM.append(parent, DOM.$('ul.krt-pr-tour-detail-bullets'));
			for (const b of chapter.bullets) {
				const li = DOM.append(list, DOM.$('li'));
				renderChapterMarkdown(li, b, this.bodyDisposables, { inline: true });
			}
		}
		const focusPath = chapter.diffFile && chapter.files.includes(chapter.diffFile)
			? chapter.diffFile
			: chapter.files[0];
		this.renderTourMiniDiffs(parent, pr, [focusPath, ...chapter.files.filter(p => p !== focusPath)], chapter.chips);
	}

	private renderTourReading(parent: HTMLElement, pr: PullRequest, chapters: readonly Chapter[]): void {
		const reading = DOM.append(parent, DOM.$('.krt-pr-tour-reading'));
		for (const chapter of chapters) {
			const block = DOM.append(reading, DOM.$('article.krt-pr-tour-chapter'));
			block.setAttribute('data-chapter', chapter.id);
			if (this.reviewedChapters.has(chapter.id)) {
				block.classList.add('reviewed');
			}
			if (chapter.sensitive) {
				block.classList.add('sensitive');
			}

			const head = DOM.append(block, DOM.$('.krt-pr-tour-chapter-head'));
			const title = DOM.append(head, DOM.$('h2.krt-pr-tour-chapter-title'));
			renderChapterMarkdown(title, chapter.title, this.bodyDisposables, { inline: true });
			const reviewedLbl = DOM.append(head, DOM.$('label.krt-pr-tour-reviewed'));
			const reviewedBox = DOM.append(reviewedLbl, DOM.$('input')) as HTMLInputElement;
			reviewedBox.type = 'checkbox';
			reviewedBox.checked = this.reviewedChapters.has(chapter.id);
			const reviewedTxt = DOM.append(reviewedLbl, DOM.$('span'));
			reviewedTxt.textContent = localize('krt.pr.tour.reviewedCheck', "Reviewed");
			this.bodyDisposables.add(DOM.addDisposableListener(reviewedBox, 'change', () => {
				this.toggleChapterReviewed(chapter.id, reviewedBox.checked);
				block.classList.toggle('reviewed', reviewedBox.checked);
				this.refreshTourSubheading();
			}));
			if (chapter.sensitive && chapter.sensitiveReason) {
				const callout = DOM.append(block, DOM.$('.krt-pr-tour-callout'));
				const calloutHead = DOM.append(callout, DOM.$('span.krt-pr-tour-callout-heading'));
				calloutHead.textContent = localize('krt.pr.tour.flaggedHeading', "Flagged by reviewer");
				const calloutBody = DOM.append(callout, DOM.$('span.krt-pr-tour-callout-body'));
				renderChapterMarkdown(calloutBody, chapter.sensitiveReason, this.bodyDisposables, { inline: true });
			}
			const summary = DOM.append(block, DOM.$('div.krt-pr-tour-chapter-summary'));
			renderChapterMarkdown(summary, chapter.summary, this.bodyDisposables);
			if (chapter.bullets.length > 0) {
				const list = DOM.append(block, DOM.$('ul.krt-pr-tour-chapter-bullets'));
				for (const b of chapter.bullets) {
					const li = DOM.append(list, DOM.$('li'));
					renderChapterMarkdown(li, b, this.bodyDisposables, { inline: true });
				}
			}
			this.renderTourMiniDiffs(block, pr, chapter.files, chapter.chips);
		}
	}

	private renderTourMiniDiffs(parent: HTMLElement, pr: PullRequest, paths: readonly string[], chips?: readonly ChapterChip[]): void {
		const wrap = DOM.append(parent, DOM.$('.krt-pr-tour-mini-diffs'));

		if (this.diffFiles === undefined) {
			const note = DOM.append(wrap, DOM.$('.krt-pr-empty'));
			note.textContent = localize('krt.pr.tour.diffPending', "Loading file patches…");
			if (!this.diffFilesLoading) {
				this.loadDiffFiles(pr);
			}
			return;
		}

		// Filter PR files to the chapter's paths, preserving the
		// chapter's order; phantom paths (rare, usually stale model
		// output) are dropped silently. Status badges per-file render
		// in a header strip above the multi-diff so the user still
		// sees +/- counts at a glance.
		const filesByPath = new Map<string, PullRequestFile>();
		for (const f of this.diffFiles) {
			filesByPath.set(f.path, f);
		}
		const orderedFiles = paths
			.map(p => filesByPath.get(p))
			.filter((f): f is PullRequestFile => !!f);

		if (orderedFiles.length === 0) {
			const empty = DOM.append(wrap, DOM.$('.krt-pr-tour-mini-empty'));
			empty.textContent = localize('krt.pr.tour.noFiles', "This chapter's files aren't in the PR's diff.");
			return;
		}

		// Strict gate, same shape as the main Diff sub-mode but in a
		// compact form so the rest of the tour UI keeps rendering.
		const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
		if (!workspace) {
			const cta = DOM.append(wrap, DOM.$('.krt-pr-tour-mini-cta'));
			cta.textContent = localize(
				'krt.pr.tour.workspaceHint',
				"Add a workspace for {0}/{1} to see chapter diffs with LSP support.",
				pr.owner,
				pr.repo,
			);
			return;
		}
		if (!this.isCheckedOut) {
			const cta = DOM.append(wrap, DOM.$('.krt-pr-tour-mini-cta'));
			cta.textContent = localize(
				'krt.pr.tour.checkoutHint',
				"Click Start Review in the header above to check out PR #{0} and see chapter diffs.",
				pr.number,
			);
			return;
		}

		// Lazy-load review comments so threads populate as they arrive.
		if (this.reviewComments === undefined && !this.reviewCommentsLoading) {
			this.loadReviewComments(pr);
		}

		const host = DOM.append(wrap, DOM.$('.krt-pr-tour-mini-host'));
		const flatDiff = this.instantiationService.createInstance(KrtPrFlatDiff, host);
		this.bodyDisposables.add(flatDiff);
		void flatDiff.setPullRequest(pr, orderedFiles, workspace, {
			renderSideBySide: this.diffRenderMode === 'side-by-side',
			chips,
		});
	}

	private refreshTourSubheading(): void {
		const sub = this.tourSubheadingEl;
		if (!sub) {
			return;
		}
		if (!this.tourState) {
			sub.textContent = '';
			return;
		}
		const reviewedCount = this.tourState.chapters.filter(c => this.reviewedChapters.has(c.id)).length;
		const total = this.tourState.chapters.length;
		const suffix = this.tourState.fromCache
			? localize('krt.pr.tour.cached', " · cached")
			: formatUsageSuffix(this.tourState.usage);
		sub.textContent = localize(
			'krt.pr.tour.progress',
			"{0}/{1} chapters reviewed · model {2}{3}",
			reviewedCount,
			total,
			this.tourState.model,
			suffix,
		);
		this.refreshStreamingBadges();
	}

	private refreshStoryboardSubheading(): void {
		const sub = this.storyboardSubheadingEl;
		if (!sub) {
			return;
		}
		if (!this.tourState) {
			sub.textContent = '';
			return;
		}
		const text = this.tourState.fromCache
			? localize('krt.pr.tour.cached', " · cached").trim()
			: formatUsageSuffix(this.tourState.usage).trim();
		sub.textContent = text;
		this.refreshStreamingBadges();
	}

	/**
	 * Show / hide the small "streaming…" spinner badge in both
	 * Tour and Storyboard headers depending on whether a stream
	 * is currently in flight.
	 */
	private refreshStreamingBadges(): void {
		const setBadge = (el: HTMLElement | undefined) => {
			if (!el) {
				return;
			}
			DOM.clearNode(el);
			if (this.tourStreaming) {
				el.classList.add('visible');
				appendSpinner(el);
				const text = DOM.append(el, DOM.$('span'));
				text.textContent = localize('krt.pr.tour.streaming', "streaming");
			} else {
				el.classList.remove('visible');
			}
		};
		setBadge(this.tourStreamingBadgeEl);
		setBadge(this.storyboardStreamingBadgeEl);
	}

	private toggleChapterReviewed(id: string, reviewed: boolean): void {
		if (reviewed) {
			this.reviewedChapters.add(id);
		} else {
			this.reviewedChapters.delete(id);
		}
		const input = this.currentInput;
		if (input) {
			writeReviewedChapters(this.krtStorageService, input.owner, input.repo, input.number, this.reviewedChapters);
		}
	}

	private async loadTour(pr: PullRequest, forceRefresh: boolean): Promise<void> {
		if (this.tourLoading || this.tourStreaming) {
			return;
		}
		this.tourLoading = true;
		this.tourStreaming = true;
		this.tourError = undefined;
		this.tourFetchToken++;
		const myToken = this.tourFetchToken;
		this.renderLoaded(pr);

		// Tour generation needs the PR file list; if not yet loaded, fetch it.
		let files = this.diffFiles;
		if (files === undefined) {
			try {
				files = await this.pullRequestProvider.getFiles(pr.url);
			} catch (e) {
				if (this.currentPr?.url !== pr.url || myToken !== this.tourFetchToken) {
					return;
				}
				this.tourLoading = false;
				this.tourStreaming = false;
				this.tourError = isKrtError(e) ? e.message : String(e);
				this.renderLoaded(pr);
				return;
			}
			if (this.currentPr?.url !== pr.url || myToken !== this.tourFetchToken) {
				return;
			}
			this.diffFiles = files;
		}

		const model = this.tourState?.model ?? localize('krt.pr.tour.streamingModel', "streaming…");
		let lastChapterCount = 0;
		const status: TourGenerationStatus = await this.tourGenerator.generate(pr, files, {
			forceRefresh,
			onUpdate: update => {
				if (this.currentPr?.url !== pr.url || myToken !== this.tourFetchToken) {
					return;
				}
				const chapterCountChanged = update.chapters.length !== lastChapterCount;
				lastChapterCount = update.chapters.length;
				const wasEmpty = !this.tourState || this.tourState.chapters.length === 0;
				this.tourState = {
					chapters: update.chapters,
					model,
					fromCache: false,
					usage: update.usage,
				};
				this.tourLoading = update.chapters.length === 0;
				if (!this.tourSelectedChapterId && update.chapters.length > 0) {
					this.tourSelectedChapterId = update.chapters[0].id;
				}
				if (chapterCountChanged || wasEmpty) {
					// Structural change: re-render but preserve scroll
					// position on both the editor root (Tour view
					// scrolls there) and the storyboard scroller so
					// the user's view stays put as new nodes appear.
					const scrollState = this.captureStoryboardScroll();
					const rootScroll = this.captureRootScroll();
					this.renderLoaded(pr);
					this.restoreRootScroll(rootScroll);
					this.restoreStoryboardScroll(scrollState);
				} else {
					// Soft update: usage / output-token estimate ticked
					// but chapter count is unchanged. Just refresh the
					// subheading text in place — don't rebuild the DOM
					// (would clobber selection, hover, scroll, focus).
					this.refreshTourSubheading();
					this.refreshStoryboardSubheading();
				}
			},
		});
		if (this.currentPr?.url !== pr.url || myToken !== this.tourFetchToken) {
			return;
		}
		this.tourLoading = false;
		this.tourStreaming = false;
		if (status.kind === 'no-key') {
			this.tourNoKey = true;
		} else if (status.kind === 'error') {
			this.tourError = status.message;
			this.tourState = undefined;
		} else {
			this.tourState = status.result;
			if (!this.tourSelectedChapterId) {
				this.tourSelectedChapterId = status.result.chapters[0]?.id;
			}
		}
		const scrollState = this.captureStoryboardScroll();
		const rootScroll = this.captureRootScroll();
		this.renderLoaded(pr);
		this.restoreRootScroll(rootScroll);
		this.restoreStoryboardScroll(scrollState);
	}

	private captureStoryboardScroll(): { left: number; top: number } | undefined {
		const s = this.storyboardScrollerEl;
		if (!s) {
			return undefined;
		}
		return { left: s.scrollLeft, top: s.scrollTop };
	}

	private restoreStoryboardScroll(state: { left: number; top: number } | undefined): void {
		if (!state) {
			return;
		}
		const s = this.storyboardScrollerEl;
		if (!s) {
			return;
		}
		s.scrollLeft = state.left;
		s.scrollTop = state.top;
	}

	/**
	 * Capture / restore the editor root's scroll position. Renders
	 * that rebuild the body from scratch (chapter click, streaming
	 * chunk arrival) would otherwise reset the user's scroll to the
	 * top of the page.
	 */
	private captureRootScroll(): number {
		return this.root?.scrollTop ?? 0;
	}

	private restoreRootScroll(top: number): void {
		if (this.root && top > 0) {
			this.root.scrollTop = top;
		}
	}

	// ---------- Storyboard sub-mode ----------

	private renderStoryboardView(pr: PullRequest): void {
		this.bodyElement.classList.remove('pr', 'diff', 'tour');
		this.bodyElement.classList.add('storyboard');

		const reviewedCount = this.tourState
			? this.tourState.chapters.filter(c => this.reviewedChapters.has(c.id)).length
			: 0;
		const totalChapters = this.tourState?.chapters.length ?? 0;

		const headerBar = DOM.append(this.bodyElement, DOM.$('.krt-pr-storyboard-header'));
		const heading = DOM.append(headerBar, DOM.$('.krt-pr-storyboard-heading'));
		heading.textContent = localize('krt.pr.storyboard.heading', "Storyboard");
		const subHeading = DOM.append(headerBar, DOM.$('.krt-pr-storyboard-subheading'));
		subHeading.textContent = localize('krt.pr.storyboard.flow', "· dependency flow");
		const streamingBadge = DOM.append(headerBar, DOM.$('span.krt-pr-streaming-badge'));
		this.storyboardStreamingBadgeEl = streamingBadge;
		if (this.tourState) {
			const chip = DOM.append(headerBar, DOM.$('span.krt-pr-storyboard-chip'));
			chip.textContent = localize('krt.pr.storyboard.reviewedChip', "{0}/{1} reviewed", reviewedCount, totalChapters);
		}
		const usageEl = DOM.append(headerBar, DOM.$('span.krt-pr-storyboard-subheading.usage'));
		this.storyboardSubheadingEl = usageEl;
		this.refreshStoryboardSubheading();
		this.refreshStreamingBadges();
		const spacer = DOM.append(headerBar, DOM.$('span.krt-pr-storyboard-spacer'));
		spacer.textContent = '';
		const legend = DOM.append(headerBar, DOM.$('.krt-pr-storyboard-legend'));
		for (const kind of EDGE_KINDS) {
			const item = DOM.append(legend, DOM.$('span.krt-pr-storyboard-legend-item'));
			item.setAttribute('data-kind', kind);
			const swatch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			swatch.setAttribute('width', '20');
			swatch.setAttribute('height', '6');
			swatch.setAttribute('class', 'krt-pr-storyboard-legend-swatch');
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', '0');
			line.setAttribute('y1', '3');
			line.setAttribute('x2', '20');
			line.setAttribute('y2', '3');
			line.setAttribute('stroke-width', '1.6');
			line.setAttribute('class', `krt-pr-storyboard-edge ${kind}`);
			const dash = edgeKindDash(kind);
			if (dash) {
				line.setAttribute('stroke-dasharray', dash);
			}
			swatch.appendChild(line);
			item.appendChild(swatch);
			const label = DOM.append(item, DOM.$('span'));
			label.textContent = edgeKindLabel(kind);
		}

		const body = DOM.append(this.bodyElement, DOM.$('.krt-pr-storyboard-body'));

		if (this.tourNoKey) {
			this.renderTourEmptyNoKey(body);
			return;
		}
		if (this.tourLoading && !this.tourState) {
			renderTourLoadingState(body, localize('krt.pr.storyboard.loading', "Generating chapters with the Anthropic API…"));
			return;
		}
		if (this.tourError) {
			const err = DOM.append(body, DOM.$('.krt-pr-empty.error'));
			err.textContent = this.tourError;
			const retry = DOM.append(body, DOM.$('button.krt-pr-tour-retry')) as HTMLButtonElement;
			retry.type = 'button';
			retry.textContent = localize('krt.pr.tour.retry', "Try again");
			this.bodyDisposables.add(DOM.addDisposableListener(retry, 'click', () => {
				this.tourError = undefined;
				void this.loadTour(pr, /* forceRefresh */ true);
			}));
			return;
		}
		if (!this.tourState) {
			renderTourLoadingState(body, localize('krt.pr.storyboard.starting', "Preparing storyboard…"));
			void this.loadTour(pr, /* forceRefresh */ false);
			return;
		}
		if (this.tourState.chapters.length === 0) {
			const empty = DOM.append(body, DOM.$('.krt-pr-empty'));
			empty.textContent = localize('krt.pr.storyboard.noChapters', "The model returned no chapters for this PR.");
			return;
		}

		// The synthetic Coverage chapter (Phase 11) is intentionally
		// excluded from the storyboard graph: it has no `dependsOn`
		// edges by design, so it renders as a free-floating card that
		// adds noise without adding meaning. It still appears in the
		// Tour Chapters / Reading variants, where the linear list
		// makes "files the tour didn't otherwise touch" the right
		// closing chapter.
		const graphChapters = this.tourState.chapters.filter(c => c.synthetic !== 'coverage');
		this.renderStoryboardGraph(body, pr, graphChapters);

		const diffPanel = DOM.append(this.bodyElement, DOM.$('.krt-pr-storyboard-diff'));
		this.storyboardDiffPanelEl = diffPanel;
		const initialId = this.storyboardSelectedId ?? graphChapters[0]?.id;
		if (initialId) {
			this.renderStoryboardDiffPanel(pr, initialId);
		}
	}

	/**
	 * Populate the diff panel below the storyboard with the
	 * selected chapter's full diff — same file-tree + stacked-
	 * sections layout the Diff sub-mode uses, just scoped to the
	 * chapter's `files`. The whole pane shares one scroll surface
	 * (the editor root), so the file tree sticks while the user
	 * scrolls through the diff sections.
	 */
	private renderStoryboardDiffPanel(pr: PullRequest, chapterId: string): void {
		const panel = this.storyboardDiffPanelEl;
		if (!panel) {
			return;
		}
		const chapter = this.tourState?.chapters.find(c => c.id === chapterId);
		DOM.clearNode(panel);
		if (!chapter) {
			return;
		}

		const head = DOM.append(panel, DOM.$('.krt-pr-storyboard-diff-head'));
		const heading = DOM.append(head, DOM.$('span.krt-pr-storyboard-diff-heading'));
		heading.textContent = localize('krt.pr.storyboard.diffHeading', "Diff for selected chapter");
		const title = DOM.append(head, DOM.$('span.krt-pr-storyboard-diff-title'));
		renderChapterMarkdown(title, chapter.title, this.bodyDisposables, { inline: true });

		const wrap = DOM.append(panel, DOM.$('.krt-pr-diff'));
		const tree = DOM.append(wrap, DOM.$('.krt-pr-diff-tree'));
		const stack = DOM.append(wrap, DOM.$('.krt-pr-diff-stack'));

		if (this.diffFiles === undefined) {
			const empty = DOM.append(stack, DOM.$('.krt-pr-empty'));
			empty.textContent = this.diffFilesLoading
				? localize('krt.pr.diffLoading', "Loading changed files…")
				: localize('krt.pr.diffPending', "Fetching changed files…");
			const treeEmpty = DOM.append(tree, DOM.$('.krt-pr-side-empty'));
			treeEmpty.textContent = localize('krt.pr.diffTreeLoading', "Loading…");
			if (!this.diffFilesLoading) {
				this.loadDiffFiles(pr);
			}
			return;
		}

		// Filter PR files to just the chapter's files, preserving the
		// chapter's order; missing files (rare, usually stale model
		// output) are skipped silently.
		const chapterPathSet = new Set(chapter.files);
		const orderedFiles = chapter.files
			.map(p => this.diffFiles!.find(f => f.path === p))
			.filter((f): f is PullRequestFile => !!f && chapterPathSet.has(f.path));

		if (orderedFiles.length === 0) {
			const empty = DOM.append(stack, DOM.$('.krt-pr-empty'));
			empty.textContent = localize('krt.pr.storyboard.diffNoFiles', "This chapter's files aren't in the PR's diff.");
			return;
		}

		// Lazy-load review comments the same way the Diff sub-mode
		// does, so existing inline comments populate when ready.
		if (this.reviewComments === undefined && !this.reviewCommentsLoading) {
			this.loadReviewComments(pr);
		}

		// Strict gate (same shape as the main Diff sub-mode): no
		// workspace registered for the repo → "Add Workspace" CTA;
		// not on PR head → Check Out CTA. Both fall through to a
		// banner where the diff would go, leaving the chapter graph
		// rendering above so the user keeps context.
		const workspace = this.workspaceRegistry.findByOwnerRepo(pr.owner, pr.repo);
		if (!workspace) {
			const cta = DOM.append(stack, DOM.$('.krt-pr-diff-cta'));
			const heading = DOM.append(cta, DOM.$('.krt-pr-diff-cta-heading'));
			heading.textContent = localize('krt.pr.storyboard.diffCtaNoWorkspace', "No workspace registered for {0}/{1}", pr.owner, pr.repo);
			const body = DOM.append(cta, DOM.$('.krt-pr-diff-cta-body'));
			body.textContent = localize(
				'krt.pr.storyboard.diffCtaNoWorkspace.body',
				"Add a local clone for this repo to render the chapter's diff with full LSP support.",
			);
			const btn = DOM.append(cta, DOM.$('button.krt-pr-diff-cta-btn')) as HTMLButtonElement;
			btn.type = 'button';
			btn.textContent = localize('krt.pr.diffCtaNoWorkspace.add', "Add Workspace…");
			this.bodyDisposables.add(DOM.addDisposableListener(btn, 'click', () => {
				void this.commandService.executeCommand('krt.workspace.add');
			}));
			return;
		}
		if (!this.isCheckedOut) {
			const cta = DOM.append(stack, DOM.$('.krt-pr-diff-cta'));
			const heading = DOM.append(cta, DOM.$('.krt-pr-diff-cta-heading'));
			heading.textContent = localize('krt.pr.storyboard.diffCtaCheckout', "Check out PR #{0} to review the chapter", pr.number);
			const body = DOM.append(cta, DOM.$('.krt-pr-diff-cta-body'));
			body.textContent = localize(
				'krt.pr.storyboard.diffCtaCheckout.body',
				"Click Start Review in the PR header. KRT switches the working tree non-destructively and the chapter's diff appears here with full LSP.",
			);
			return;
		}

		// Mount a chapter-scoped flat-diff. Same renderer the main Diff
		// sub-mode uses, just filtered to the chapter's files.
		const flatDiff = this.instantiationService.createInstance(KrtPrFlatDiff, stack);
		this.bodyDisposables.add(flatDiff);
		void flatDiff.setPullRequest(pr, orderedFiles, workspace, {
			renderSideBySide: this.diffRenderMode === 'side-by-side',
			chips: chapter.chips,
		});

		// Chapter-scoped file tree: same component as the main Diff
		// sub-mode, just initialised with the chapter's files. Filename
		// click hands off to the Editor view; the scroll-to-file
		// affordance reveals the file inside this chapter's stack.
		const chapterTree = this.bodyDisposables.add(new KrtDiffFileTree(
			tree,
			this.krtStorageService,
			pr.owner,
			pr.repo,
			pr.number,
			this.reviewedPaths,
			{
				onScrollToFile: path => flatDiff.scrollToFile(path),
				onOpenInEditor: path => this.openFileInEditor(pr, workspace, path),
				onToggleReviewed: (path, reviewed) => this.toggleFileReviewed(path, reviewed),
			},
		));
		chapterTree.setFiles(orderedFiles);
	}

	private renderStoryboardGraph(parent: HTMLElement, pr: PullRequest, chapters: readonly Chapter[]): void {
		// Pre-compute per-chapter card heights from title length so
		// long titles render in full without clipping. The layout
		// uses these to space columns correctly so cards never
		// overlap, even when one chapter has a multi-line title.
		const heights = new Map<string, number>();
		for (const c of chapters) {
			heights.set(c.id, estimateStoryboardCardHeight(c.title));
		}
		const layout = layoutStoryboard(chapters, { ...DEFAULT_STORYBOARD_LAYOUT, heights });

		const wrap = DOM.append(parent, DOM.$('.krt-pr-storyboard-layout'));
		const scroller = DOM.append(wrap, DOM.$('.krt-pr-storyboard-scroller'));
		this.storyboardScrollerEl = scroller;
		const canvas = DOM.append(scroller, DOM.$('.krt-pr-storyboard-canvas'));
		canvas.style.width = `${layout.width}px`;
		canvas.style.height = `${layout.height}px`;

		// Edges layer (SVG) drawn behind the node cards.
		const SVG_NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('class', 'krt-pr-storyboard-edges');
		svg.setAttribute('width', String(layout.width));
		svg.setAttribute('height', String(layout.height));
		svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
		const defs = document.createElementNS(SVG_NS, 'defs');
		const makeMarker = (id: string, cls: string): SVGMarkerElement => {
			const m = document.createElementNS(SVG_NS, 'marker');
			m.setAttribute('id', id);
			m.setAttribute('viewBox', '0 0 10 10');
			m.setAttribute('refX', '9');
			m.setAttribute('refY', '5');
			m.setAttribute('markerWidth', '5');
			m.setAttribute('markerHeight', '5');
			m.setAttribute('orient', 'auto');
			const p = document.createElementNS(SVG_NS, 'path');
			p.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
			p.setAttribute('class', cls);
			m.appendChild(p);
			return m;
		};
		// One arrowhead marker per edge kind so each inherits the
		// kind's stroke colour via CSS. Plus a 'hot' marker the
		// hover-spotlight swaps in.
		for (const kind of EDGE_KINDS) {
			defs.appendChild(makeMarker(`krt-storyboard-arrow-${kind}`, `krt-pr-storyboard-arrowhead ${kind}`));
		}
		defs.appendChild(makeMarker('krt-storyboard-arrow-hot', 'krt-pr-storyboard-arrowhead hot'));
		svg.appendChild(defs);

		const edgeEls = new Map<string, SVGPathElement>();
		const edgeLabelEls = new Map<string, SVGGElement>();
		const edgeKey = (from: string, to: string) => `${from}->${to}`;
		for (const edge of layout.edges) {
			const path = document.createElementNS(SVG_NS, 'path');
			path.setAttribute('class', `krt-pr-storyboard-edge ${edge.kind}`);
			path.setAttribute('d', edge.path);
			path.setAttribute('marker-end', `url(#krt-storyboard-arrow-${edge.kind})`);
			path.setAttribute('data-from', edge.from);
			path.setAttribute('data-to', edge.to);
			const dash = edgeKindDash(edge.kind);
			if (dash) {
				path.setAttribute('stroke-dasharray', dash);
			}
			svg.appendChild(path);
			edgeEls.set(edgeKey(edge.from, edge.to), path);
		}
		// Edge labels are intentionally not rendered. With overlapping
		// rounded paths and many edges per node they cluster too
		// densely to read; the colour-coded legend in the header
		// carries the same information without the visual noise.
		// `edgeLabelEls` is left as an empty map so the highlight
		// pass below stays a no-op for labels.
		canvas.appendChild(svg);

		const chaptersById = new Map(chapters.map(c => [c.id, c] as const));
		const indexById = new Map(chapters.map((c, i) => [c.id, i] as const));
		const nodeEls = new Map<string, HTMLElement>();
		const nodeReviewedBoxes = new Map<string, HTMLInputElement>();
		const incoming = new Map<string, { id: string; kind: EdgeKind }[]>();
		const outgoing = new Map<string, { id: string; kind: EdgeKind }[]>();
		const pushTo = <V>(map: Map<string, V[]>, key: string, value: V) => {
			const existing = map.get(key);
			if (existing) {
				existing.push(value);
			} else {
				map.set(key, [value]);
			}
		};
		for (const c of chapters) {
			for (const d of c.dependsOn) {
				if (!chaptersById.has(d.id) || d.id === c.id) {
					continue;
				}
				pushTo(incoming, c.id, { id: d.id, kind: d.kind });
				pushTo(outgoing, d.id, { id: c.id, kind: d.kind });
			}
		}

		const selectNodeRef: { fn: (id: string) => void } = { fn: () => { /* set below */ } };

		for (const node of layout.nodes) {
			const chapter = chaptersById.get(node.id);
			if (!chapter) {
				continue;
			}
			const card = DOM.append(canvas, DOM.$('.krt-pr-storyboard-node'));
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			card.setAttribute('data-node', node.id);
			card.setAttribute('data-tier', String(node.tier));
			card.setAttribute('data-kind', chapter.kind);
			card.style.left = `${node.x}px`;
			card.style.top = `${node.y}px`;
			card.style.width = `${node.width}px`;
			card.style.height = `${node.height}px`;
			if (chapter.sensitive) {
				card.classList.add('sensitive');
			}
			if (this.reviewedChapters.has(chapter.id)) {
				card.classList.add('reviewed');
			}

			DOM.append(card, DOM.$('.krt-pr-storyboard-node-stripe'));

			const head = DOM.append(card, DOM.$('.krt-pr-storyboard-node-head'));
			const chBadge = DOM.append(head, DOM.$('span.krt-pr-storyboard-node-ch'));
			const idx = indexById.get(node.id) ?? 0;
			chBadge.textContent = `ch ${String(idx + 1).padStart(2, '0')}`;
			const kindBadge = DOM.append(head, DOM.$('span.krt-pr-storyboard-node-kind'));
			kindBadge.setAttribute('data-kind', chapter.kind);
			kindBadge.textContent = chapter.kind;
			if (chapter.sensitive) {
				const caution = DOM.append(head, DOM.$('span.krt-pr-storyboard-node-caution'));
				caution.textContent = localize('krt.pr.storyboard.cautionGlyph', "!");
				if (chapter.sensitiveReason) {
					caution.title = chapter.sensitiveReason;
				}
			}
			const headSpacer = DOM.append(head, DOM.$('span.krt-pr-storyboard-node-head-spacer'));
			headSpacer.textContent = '';
			const reviewedLbl = DOM.append(head, DOM.$('label.krt-pr-storyboard-node-reviewed'));
			const reviewedBox = DOM.append(reviewedLbl, DOM.$('input')) as HTMLInputElement;
			reviewedBox.type = 'checkbox';
			reviewedBox.checked = this.reviewedChapters.has(chapter.id);
			this.bodyDisposables.add(DOM.addDisposableListener(reviewedBox, 'change', e => {
				e.stopPropagation();
				this.toggleChapterReviewed(chapter.id, reviewedBox.checked);
				card.classList.toggle('reviewed', reviewedBox.checked);
			}));
			this.bodyDisposables.add(DOM.addDisposableListener(reviewedLbl, 'click', e => e.stopPropagation()));
			nodeReviewedBoxes.set(chapter.id, reviewedBox);

			const titleEl = DOM.append(card, DOM.$('.krt-pr-storyboard-node-title'));
			renderChapterMarkdown(titleEl, chapter.title, this.bodyDisposables, { inline: true });

			const footer = DOM.append(card, DOM.$('.krt-pr-storyboard-node-footer'));
			const filesEl = DOM.append(footer, DOM.$('span.krt-pr-storyboard-node-files'));
			filesEl.textContent = `${chapter.files.length}f`;
			const addEl = DOM.append(footer, DOM.$('span.krt-pr-storyboard-node-add'));
			addEl.textContent = `+${chapter.plus}`;
			const delEl = DOM.append(footer, DOM.$('span.krt-pr-storyboard-node-del'));
			delEl.textContent = `-${chapter.minus}`;

			nodeEls.set(node.id, card);
		}

		const detail = DOM.append(wrap, DOM.$('.krt-pr-storyboard-detail'));
		const renderDetail = (id: string | undefined) => {
			DOM.clearNode(detail);
			const chapter = id ? chaptersById.get(id) : undefined;
			if (!chapter) {
				const empty = DOM.append(detail, DOM.$('.krt-pr-storyboard-detail-empty'));
				empty.textContent = localize('krt.pr.storyboard.detailEmpty', "Click a node to inspect its connections.");
				return;
			}
			const head = DOM.append(detail, DOM.$('.krt-pr-storyboard-detail-head'));
			const headTop = DOM.append(head, DOM.$('.krt-pr-storyboard-detail-head-top'));
			const chTag = DOM.append(headTop, DOM.$('span.krt-pr-storyboard-detail-ch'));
			const idx = indexById.get(chapter.id) ?? 0;
			chTag.textContent = localize('krt.pr.storyboard.chapterN', "chapter {0}", String(idx + 1).padStart(2, '0'));
			if (chapter.sensitive) {
				const caution = DOM.append(headTop, DOM.$('span.krt-pr-storyboard-detail-caution'));
				caution.textContent = localize('krt.pr.storyboard.cautionLabel', "Caution");
				if (chapter.sensitiveReason) {
					caution.title = chapter.sensitiveReason;
				}
			}
			const dTitle = DOM.append(head, DOM.$('h2.krt-pr-storyboard-detail-title'));
			renderChapterMarkdown(dTitle, chapter.title, this.bodyDisposables, { inline: true });
			if (chapter.files.length > 0) {
				const fileChips = DOM.append(head, DOM.$('.krt-pr-storyboard-detail-files'));
				for (const f of chapter.files) {
					const chip = DOM.append(fileChips, DOM.$('span.krt-pr-storyboard-detail-file-chip'));
					chip.textContent = f.split('/').pop() ?? f;
					chip.title = f;
				}
			}

			const scroll = DOM.append(detail, DOM.$('.krt-pr-storyboard-detail-scroll'));
			const summary = DOM.append(scroll, DOM.$('div.krt-pr-storyboard-detail-summary'));
			renderChapterMarkdown(summary, chapter.summary, this.bodyDisposables);

			const ins = incoming.get(chapter.id) ?? [];
			const outs = outgoing.get(chapter.id) ?? [];
			if (ins.length > 0 || outs.length > 0) {
				const section = DOM.append(scroll, DOM.$('.krt-pr-storyboard-connections'));
				const heading = DOM.append(section, DOM.$('span.krt-pr-storyboard-connections-heading'));
				heading.textContent = localize('krt.pr.storyboard.connections', "Connections");
				const renderRow = (arrow: string, other: { id: string; kind: EdgeKind }) => {
					const otherChapter = chaptersById.get(other.id);
					if (!otherChapter) {
						return;
					}
					const row = DOM.append(section, DOM.$('.krt-pr-storyboard-connection-row'));
					row.setAttribute('data-kind', other.kind);
					const arr = DOM.append(row, DOM.$('span.krt-pr-storyboard-connection-arrow'));
					arr.textContent = `${arrow} ${edgeKindLabel(other.kind)}`;
					const titleSpan = DOM.append(row, DOM.$('span.krt-pr-storyboard-connection-title'));
					renderChapterMarkdown(titleSpan, otherChapter.title, this.bodyDisposables, { inline: true });
					this.bodyDisposables.add(DOM.addDisposableListener(row, 'click', () => selectNodeRef.fn(other.id)));
				};
				for (const inEdge of ins) {
					renderRow('->', inEdge);
				}
				for (const outEdge of outs) {
					renderRow('<-', outEdge);
				}
			}

			if (chapter.bullets.length > 0) {
				const bHeading = DOM.append(scroll, DOM.$('span.krt-pr-storyboard-connections-heading'));
				bHeading.textContent = localize('krt.pr.storyboard.keyPoints', "Key points");
				const list = DOM.append(scroll, DOM.$('ul.krt-pr-storyboard-detail-bullets'));
				for (const b of chapter.bullets) {
					const li = DOM.append(list, DOM.$('li'));
					renderChapterMarkdown(li, b, this.bodyDisposables, { inline: true });
				}
			}

			if (chapter.sensitive && chapter.sensitiveReason) {
				const callout = DOM.append(scroll, DOM.$('.krt-pr-storyboard-detail-callout'));
				const calloutTitle = DOM.append(callout, DOM.$('strong'));
				calloutTitle.textContent = localize('krt.pr.storyboard.calloutTitle', "Rigorous review needed.");
				const calloutBody = DOM.append(callout, DOM.$('span'));
				calloutBody.appendChild(document.createTextNode(' '));
				const inner = DOM.append(calloutBody, DOM.$('span'));
				renderChapterMarkdown(inner, chapter.sensitiveReason, this.bodyDisposables, { inline: true });
			}

			const footer = DOM.append(detail, DOM.$('.krt-pr-storyboard-detail-footer'));
			const markBtn = DOM.append(footer, DOM.$('button.krt-pr-storyboard-mark-btn')) as HTMLButtonElement;
			markBtn.type = 'button';
			markBtn.textContent = this.reviewedChapters.has(chapter.id)
				? localize('krt.pr.storyboard.unmark', "Unmark reviewed")
				: localize('krt.pr.storyboard.mark', "Mark reviewed");
			this.bodyDisposables.add(DOM.addDisposableListener(markBtn, 'click', () => {
				const wasReviewed = this.reviewedChapters.has(chapter.id);
				this.toggleChapterReviewed(chapter.id, !wasReviewed);
				const card = nodeEls.get(chapter.id);
				if (card) {
					card.classList.toggle('reviewed', !wasReviewed);
				}
				const cb = nodeReviewedBoxes.get(chapter.id);
				if (cb) {
					cb.checked = !wasReviewed;
				}
				renderDetail(chapter.id);
			}));
		};

		// Map from edge key to its kind so the highlight pass can
		// restore the kind-specific arrowhead marker on un-hover.
		const edgeKindByKey = new Map<string, EdgeKind>();
		for (const edge of layout.edges) {
			edgeKindByKey.set(edgeKey(edge.from, edge.to), edge.kind);
		}
		const clearHighlight = () => {
			canvas.classList.remove('hovering');
			for (const el of nodeEls.values()) {
				el.classList.remove('highlight', 'dimmed');
			}
			for (const [k, el] of edgeEls) {
				el.classList.remove('highlight', 'dimmed');
				const kind = edgeKindByKey.get(k) ?? 'depends';
				el.setAttribute('marker-end', `url(#krt-storyboard-arrow-${kind})`);
			}
			for (const el of edgeLabelEls.values()) {
				el.classList.remove('highlight', 'dimmed');
			}
		};
		const highlightNode = (id: string) => {
			canvas.classList.add('hovering');
			const ins = incoming.get(id) ?? [];
			const outs = outgoing.get(id) ?? [];
			const related = new Set<string>([id, ...ins.map(e => e.id), ...outs.map(e => e.id)]);
			for (const [nid, el] of nodeEls) {
				el.classList.toggle('highlight', nid === id);
				el.classList.toggle('dimmed', !related.has(nid));
			}
			for (const [k, el] of edgeEls) {
				const [from, to] = k.split('->');
				const involved = from === id || to === id;
				const kind = edgeKindByKey.get(k) ?? 'depends';
				el.classList.toggle('highlight', involved);
				el.classList.toggle('dimmed', !involved);
				el.setAttribute('marker-end', involved ? 'url(#krt-storyboard-arrow-hot)' : `url(#krt-storyboard-arrow-${kind})`);
			}
			for (const [k, el] of edgeLabelEls) {
				const [from, to] = k.split('->');
				const involved = from === id || to === id;
				el.classList.toggle('highlight', involved);
				el.classList.toggle('dimmed', !involved);
			}
		};

		const focusOnNode = (id: string, smooth: boolean) => {
			const node = layout.nodes.find(n => n.id === id);
			if (!node || !this.root) {
				return;
			}
			// Horizontal: centre the node inside the scroller's
			// horizontal viewport.
			const targetLeft = Math.max(0, node.x + node.width / 2 - scroller.clientWidth / 2);
			scroller.scrollTo({ left: targetLeft, behavior: smooth ? 'smooth' : 'auto' });

			// Vertical: the editor root is the scroll container, not
			// the canvas. Compute the node's y-coordinate inside the
			// root's content via its bounding rect, then scroll the
			// root to centre it in the viewport.
			const canvasRect = canvas.getBoundingClientRect();
			const rootRect = this.root.getBoundingClientRect();
			const nodeYInRoot = (canvasRect.top - rootRect.top) + this.root.scrollTop + node.y;
			const targetTop = Math.max(0, nodeYInRoot + node.height / 2 - this.root.clientHeight / 2);
			this.root.scrollTo({ top: targetTop, behavior: smooth ? 'smooth' : 'auto' });
		};

		const selectNode = (id: string, options?: { focus?: boolean }) => {
			const wasSelected = this.storyboardSelectedId === id;
			this.storyboardSelectedId = id;
			for (const [nid, el] of nodeEls) {
				el.classList.toggle('selected', nid === id);
			}
			renderDetail(id);
			this.renderStoryboardDiffPanel(pr, id);
			if (options?.focus && !wasSelected) {
				focusOnNode(id, true);
			}
		};
		selectNodeRef.fn = (id: string) => selectNode(id, { focus: true });

		for (const [id, el] of nodeEls) {
			this.bodyDisposables.add(DOM.addDisposableListener(el, 'mouseenter', () => highlightNode(id)));
			this.bodyDisposables.add(DOM.addDisposableListener(el, 'mouseleave', clearHighlight));
			this.bodyDisposables.add(DOM.addDisposableListener(el, 'focus', () => highlightNode(id)));
			this.bodyDisposables.add(DOM.addDisposableListener(el, 'blur', clearHighlight));
			this.bodyDisposables.add(DOM.addDisposableListener(el, 'click', () => {
				if (hasActiveSelection(el)) {
					return;
				}
				selectNode(id);
			}));
			this.bodyDisposables.add(DOM.addDisposableListener(el, 'keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					selectNode(id);
				}
			}));
		}

		// Click-and-drag to scroll the canvas. Skip when the mousedown
		// originates inside a node, link, or input — those have their
		// own behavior.
		this.attachDragToScroll(scroller);

		const initial = this.storyboardSelectedId && chaptersById.has(this.storyboardSelectedId)
			? this.storyboardSelectedId
			: chapters[0]?.id;
		if (initial) {
			selectNode(initial);
		} else {
			renderDetail(undefined);
		}
	}

	private attachDragToScroll(scroller: HTMLElement): void {
		let dragging = false;
		let startX = 0;
		let startY = 0;
		let startScrollLeft = 0;
		let startScrollTop = 0;
		const isInteractive = (target: EventTarget | null): boolean => {
			if (!(target instanceof Element)) {
				return false;
			}
			return !!target.closest('.krt-pr-storyboard-node, a, input, button, label');
		};
		this.bodyDisposables.add(DOM.addDisposableListener(scroller, 'mousedown', (e: MouseEvent) => {
			if (e.button !== 0 || isInteractive(e.target)) {
				return;
			}
			dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			startScrollLeft = scroller.scrollLeft;
			startScrollTop = scroller.scrollTop;
			scroller.classList.add('dragging');
			e.preventDefault();
		}));
		this.bodyDisposables.add(DOM.addDisposableListener(scroller, 'mousemove', (e: MouseEvent) => {
			if (!dragging) {
				return;
			}
			scroller.scrollLeft = startScrollLeft - (e.clientX - startX);
			scroller.scrollTop = startScrollTop - (e.clientY - startY);
		}));
		const stop = () => {
			if (!dragging) {
				return;
			}
			dragging = false;
			scroller.classList.remove('dragging');
		};
		this.bodyDisposables.add(DOM.addDisposableListener(scroller, 'mouseup', stop));
		this.bodyDisposables.add(DOM.addDisposableListener(scroller, 'mouseleave', stop));
	}

	private renderError(kind: string, message: string, hint: string): void {
		this.titleElement.textContent = localize('krt.pr.errorTitle', "Couldn't load this PR");
		this.statePillElement.textContent = '';
		this.statePillElement.className = 'krt-pr-editor-state-pill';
		this.updateHeaderActionsEnablement();
		this.bodyDisposables.clear();
		DOM.clearNode(this.bodyElement);
		const errEl = DOM.append(this.bodyElement, DOM.$('.krt-pr-editor-error'));
		const kindEl = DOM.append(errEl, DOM.$('.krt-pr-editor-error-kind'));
		kindEl.textContent = kind;
		const msgEl = DOM.append(errEl, DOM.$('.krt-pr-editor-error-message'));
		msgEl.textContent = message;
		const hintEl = DOM.append(errEl, DOM.$('.krt-pr-editor-error-hint'));
		hintEl.textContent = hint;
	}

	private applyStatePill(state: PullRequestState): void {
		this.statePillElement.classList.remove('open', 'closed', 'merged', 'draft');
		this.statePillElement.classList.add(state);
		this.statePillElement.textContent = stateLabel(state);
	}

	private openExternal(link: string): void {
		try {
			this.openerService.open(URI.parse(link), { openExternal: true });
		} catch (e) {
			this.logService.warn('[krt] pr-pane external open failed', e);
		}
	}
}

function stateLabel(state: PullRequestState): string {
	switch (state) {
		case 'open': return localize('krt.pr.state.open', "Open");
		case 'closed': return localize('krt.pr.state.closed', "Closed");
		case 'merged': return localize('krt.pr.state.merged', "Merged");
		case 'draft': return localize('krt.pr.state.draft', "Draft");
	}
}

function reviewerStateLabel(state: ReviewerState): string {
	switch (state) {
		case 'approved': return localize('krt.pr.reviewer.approved', "Approved");
		case 'changes_requested': return localize('krt.pr.reviewer.changesRequested', "Changes requested");
		case 'commented': return localize('krt.pr.reviewer.commented', "Commented");
		case 'dismissed': return localize('krt.pr.reviewer.dismissed', "Dismissed");
		case 'pending':
		default: return localize('krt.pr.reviewer.pending', "Pending");
	}
}

function checkConclusionGlyph(c: CheckConclusion): string {
	switch (c) {
		case 'success': return 'OK';
		case 'failure':
		case 'timed_out':
		case 'action_required':
			return 'X';
		case 'cancelled':
		case 'stale':
			return '-';
		case 'neutral':
		case 'skipped':
			return '~';
		case 'pending':
		default: return '...';
	}
}

function countLabel(n: number | undefined): string {
	if (n === undefined) {
		return '…';
	}
	return String(n);
}

/**
 * Group check-runs by name and keep the freshest one per group. The
 * GitHub `commits/{sha}/check-runs` endpoint returns every run on the
 * commit including re-runs, so without dedup the user sees the same
 * `ci/lint` listed three times after a few retries. Sort by name so
 * the rendered order is stable across refreshes.
 */
function dedupeChecksByName(checks: readonly CheckRun[]): readonly CheckRun[] {
	const byName = new Map<string, CheckRun>();
	for (const c of checks) {
		const existing = byName.get(c.name);
		if (!existing) {
			byName.set(c.name, c);
			continue;
		}
		const existingAt = existing.completedAt ?? existing.startedAt ?? '';
		const candidateAt = c.completedAt ?? c.startedAt ?? '';
		if (candidateAt > existingAt) {
			byName.set(c.name, c);
		}
	}
	return [...byName.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * GitHub avatar URLs already accept a `s` query parameter for sizing.
 * Append (or override) it so we don't pull a 460×460 image into a 20px
 * chip. Idempotent for URLs that already have `?s=...`.
 */
function appendSizeParam(url: string, size: number): string {
	try {
		const u = new URL(url);
		u.searchParams.set('s', String(size));
		return u.toString();
	} catch {
		return url;
	}
}

/**
 * Stable colour from a GitHub login — same login always produces the
 * same hue. Uses the oklch palette KRT already defines for the chrome
 * accent so the fallback chip doesn't fight the rest of the UI.
 */
function colorFromLogin(login: string): string {
	let hash = 0;
	for (let i = 0; i < login.length; i++) {
		hash = (hash * 31 + login.charCodeAt(i)) >>> 0;
	}
	const hue = hash % 360;
	return `oklch(0.86 0.06 ${hue})`;
}

/**
 * Render a chapter snippet (title, summary, bullet, etc.) as
 * markdown into `parent`. Uses the workbench's standard
 * `renderMarkdown` so we get inline code (`like this`), bold,
 * italic, links, and lists for free; emoji shortcodes are
 * pre-expanded against the same table the git extension ships.
 *
 * For inline contexts (titles, single-line cells), call with
 * `inline: true` — the rendered block element gets a
 * `.krt-pr-md-inline` class that flattens the wrapping `<p>` to
 * an inline span via CSS. The disposable is appended to the
 * caller's store so the markdown renderer's listeners are
 * cleaned up on body refresh.
 */
/**
 * Returns true if the current document selection is non-empty —
 * use to suppress click handlers (e.g. card selection) when the
 * user is highlighting text inside the clickable region.
 */
function hasActiveSelection(target: Element): boolean {
	const sel = DOM.getActiveWindow().getSelection();
	return !!sel && sel.toString().length > 0 && sel.containsNode(target, true);
}

function renderChapterMarkdown(
	parent: HTMLElement,
	text: string,
	disposables: DisposableStore,
	options?: { inline?: boolean; onLink?: (link: string) => void },
): void {
	DOM.clearNode(parent);
	const trimmed = text?.trim();
	if (!trimmed) {
		return;
	}
	const expanded = expandEmojiShortcodes(trimmed);
	const md = new MarkdownString(expanded, {
		isTrusted: false,
		supportThemeIcons: false,
		supportHtml: false,
	});
	const rendered = renderMarkdown(md, options?.onLink ? { actionHandler: options.onLink } : undefined);
	disposables.add(rendered);
	rendered.element.classList.add(options?.inline ? 'krt-pr-md-inline' : 'krt-pr-md-block');
	parent.appendChild(rendered.element);
}

function formatUsageSuffix(usage: TourTokenUsage | undefined): string {
	if (!usage) {
		return '';
	}
	const inTotal = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
	return localize('krt.pr.tour.usageSuffix', " · {0} in / {1} out", inTotal.toLocaleString(), usage.outputTokens.toLocaleString());
}

function appendSpinner(parent: HTMLElement): SVGSVGElement {
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'krt-pr-spinner');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '20');
	svg.setAttribute('height', '20');
	const track = document.createElementNS(SVG_NS, 'circle');
	track.setAttribute('cx', '12');
	track.setAttribute('cy', '12');
	track.setAttribute('r', '9');
	track.setAttribute('class', 'krt-pr-spinner-track');
	const arc = document.createElementNS(SVG_NS, 'circle');
	arc.setAttribute('cx', '12');
	arc.setAttribute('cy', '12');
	arc.setAttribute('r', '9');
	arc.setAttribute('class', 'krt-pr-spinner-arc');
	svg.appendChild(track);
	svg.appendChild(arc);
	parent.appendChild(svg);
	return svg;
}

function renderTourLoadingState(parent: HTMLElement, text: string): void {
	const wrap = DOM.append(parent, DOM.$('.krt-pr-tour-loading'));
	appendSpinner(wrap);
	const label = DOM.append(wrap, DOM.$('span.krt-pr-tour-loading-text'));
	label.textContent = text;
}

/**
 * Estimate the rendered height of a Storyboard card from its
 * title length. Titles wrap inside the card body, so longer
 * titles need taller cards — without this, the layout would
 * use a single fixed height and either clip long titles or
 * waste space for short ones.
 *
 * Numbers are derived from the actual CSS:
 *   - 4px stripe + 28px head + 28px footer = 60px chrome
 *   - title font 13.5px / line-height 1.3 -> ~18px per line
 *   - title padding 8px top + 8px bottom -> 16px
 *   - usable title width 224px (248 card - 24 padding) at ~7.4
 *     px per char -> ~30 chars per line for 13.5px text
 */
function estimateStoryboardCardHeight(title: string): number {
	const charsPerLine = 28;
	const lines = Math.max(1, Math.ceil((title?.length ?? 0) / charsPerLine));
	const titleHeight = lines * 18 + 16;
	return Math.max(96, 60 + titleHeight);
}

function edgeKindLabel(kind: EdgeKind): string {
	switch (kind) {
		case 'extends': return localize('krt.pr.storyboard.kind.extends', "extends");
		case 'gates': return localize('krt.pr.storyboard.kind.gates', "gated by");
		case 'verifies': return localize('krt.pr.storyboard.kind.verifies', "verified by");
		case 'depends':
		default: return localize('krt.pr.storyboard.kind.depends', "depends on");
	}
}

function edgeKindDash(kind: EdgeKind): string | undefined {
	switch (kind) {
		case 'gates': return '5 4';
		case 'verifies': return '2 3';
		default: return undefined;
	}
}

function relativeTime(iso: string): string {
	if (!iso) {
		return '';
	}
	const t = Date.parse(iso);
	if (Number.isNaN(t)) {
		return iso;
	}
	return fromNow(t, true);
}


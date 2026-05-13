/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import { DiffEditorWidget } from '../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { RefCounted } from '../../../../../editor/browser/widget/diffEditor/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelDecorationOptions, ITextModel, TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKrtGitService } from '../../../../../platform/krt/common/krtGit.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { PullRequest, PullRequestFile } from '../../../../../platform/krt/common/krt.js';
import { ChapterChip } from '../ai/krtTourTypes.js';
import { encodeKrtGit } from '../workspace/krtGitContentProvider.js';
import { KrtWorkspace } from '../workspace/krtWorkspaceRegistry.js';
import { IKrtPrCommentController } from './krtPrCommentController.js';

/**
 * Phase 10/D — content-sized diff stack. One `DiffEditorWidget` per
 * file, each sized to its own `getContentHeight()`, stacked vertically
 * inside the host. The outer pane is the scroll surface — the user
 * scrolls naturally through the chapter (or the whole PR) without a
 * nested virtualised viewport.
 *
 * Why not `MultiDiffEditorWidget` here:
 *   - The widget self-virtualises and requires a fixed-size viewport
 *     (`min-height: 70vh` etc.). For the Tour and Storyboard chapter
 *     panels that meant a clipped, internally-scrolling card with
 *     limited height — visually small and broken in tall layouts.
 *   - Auto-sizing the widget to its total content isn't on its API
 *     surface (`_totalHeight` is private, `layout(dim)` overrides
 *     instead of follows). Bypassing it for our embedded use case
 *     gives the user the page-scrolling experience GitHub does in the
 *     browser.
 *
 * URI strategy: file:// for the modified side (real on-disk path so
 * language extensions activate), krt-git:// for the original side
 * (Phase 8.6's content provider, `git show baseSha:path`). Same URIs
 * the native Comments API anchors against, so LSP + inline comments
 * work through the standard workbench plumbing. URI metadata is
 * registered with `KrtPrCommentController` per-side per-file; the
 * controller's data-provider is bumped 150ms after the editors mount
 * so each editor's `editor.contrib.review` picks up the cached
 * threads.
 */
export class KrtPrFlatDiff extends Disposable {

	private renderStore = this._register(new DisposableStore());
	private cardsByPath = new Map<string, HTMLElement>();
	/**
	 * Per-file diff widgets, kept around so chip decorations can be
	 * (re-)applied without re-rendering the card. Cleared on
	 * `setPullRequest`.
	 */
	private widgetsByPath = new Map<string, DiffEditorWidget>();
	/**
	 * Decoration ids per side per file so subsequent `setChips`
	 * calls dispose the previous batch cleanly. Indexed
	 * `${path}#${side}` -> array of decoration ids on that side's
	 * editor.
	 */
	private chipDecorations = new Map<string, string[]>();
	/**
	 * Persists collapsed state across `setPullRequest` re-renders
	 * (e.g. when the user flips the side-by-side / inline toggle the
	 * pane re-renders, but a card the user collapsed should stay
	 * collapsed). Keyed on the file's path; cleared when the
	 * `KrtPrFlatDiff` itself disposes.
	 */
	private collapsedPaths = new Set<string>();

	constructor(
		private readonly container: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILogService private readonly logService: ILogService,
		@IKrtPrCommentController private readonly commentController: IKrtPrCommentController,
		@IKrtGitService private readonly gitService: IKrtGitService,
	) {
		super();
		this.container.classList.add('krt-pr-flat-diff');
	}

	async setPullRequest(pr: PullRequest, files: readonly PullRequestFile[], workspace: KrtWorkspace, opts: { renderSideBySide: boolean; chips?: readonly ChapterChip[] }): Promise<void> {
		// Tear down the previous render's widgets / refs / DOM. Each
		// `setPullRequest` is a fresh start — files might have changed,
		// the render-mode toggle might have flipped, etc.
		this.renderStore.clear();
		DOM.clearNode(this.container);
		this.cardsByPath.clear();
		this.widgetsByPath.clear();
		this.chipDecorations.clear();
		const localStore = new DisposableStore();
		this.renderStore.add(localStore);

		// `pr.base.sha` is the *current* tip of the target branch, but
		// GitHub diffs the PR against the merge base of the two refs.
		// When the target has moved forward since the PR was opened,
		// diffing against `pr.base.sha` includes every commit that
		// landed on target as a "reverted" change in the PR. Merge
		// base = common ancestor = the SHA the PR diff anchors on.
		let baseSha = pr.base.sha;
		try {
			baseSha = await this.gitService.getMergeBase(workspace.folderPath, pr.base.sha, pr.head.sha);
		} catch (err) {
			this.logService.warn(`[krt] flat-diff: getMergeBase failed, falling back to pr.base.sha`, err);
		}
		if (this._store.isDisposed) {
			return;
		}

		for (const file of files) {
			await this.appendFileCard(pr, file, workspace, baseSha, opts, localStore);
			if (this._store.isDisposed) {
				return;
			}
		}

		// Bump the comment controller so the freshly-mounted editors
		// (whose `editor.contrib.review` is `AfterFirstRender`) trigger
		// their initial compute against this controller. 150ms is past
		// the 50ms idle timeout that `AfterFirstRender` uses.
		setTimeout(() => {
			if (this._store.isDisposed) {
				return;
			}
			this.commentController.bumpDataProvider();
		}, 150);

		// Phase 11 — apply any chips the caller passed in. Decorations
		// land on the per-side text models, so they survive the side-
		// by-side / inline toggle re-renders (which create fresh
		// widgets but recreate the decorations from the same input).
		if (opts.chips && opts.chips.length > 0) {
			this.setChips(opts.chips);
		}
	}

	/**
	 * Replace all chip decorations on the currently-mounted file
	 * cards with this set. Chips that name a path we don't have a
	 * widget for are dropped silently (caller may pass a wider list
	 * than this view's files — e.g. all-PR chips fed into a
	 * chapter-scoped diff).
	 */
	setChips(chips: readonly ChapterChip[]): void {
		const grouped = new Map<string, ChapterChip[]>();
		for (const chip of chips) {
			if (!this.widgetsByPath.has(chip.path)) {
				continue;
			}
			const key = `${chip.path}#${chip.side}`;
			let bucket = grouped.get(key);
			if (!bucket) {
				bucket = [];
				grouped.set(key, bucket);
			}
			bucket.push(chip);
		}
		// First clear any stale decorations from a previous batch.
		for (const [key, ids] of this.chipDecorations) {
			const [path, side] = key.split('#');
			const widget = this.widgetsByPath.get(path);
			if (!widget) {
				continue;
			}
			const editor = side === 'LEFT' ? widget.getOriginalEditor() : widget.getModifiedEditor();
			editor.deltaDecorations(ids, []);
		}
		this.chipDecorations.clear();

		// Apply the new batch.
		for (const [key, bucket] of grouped) {
			const [path, side] = key.split('#');
			const widget = this.widgetsByPath.get(path);
			if (!widget) {
				continue;
			}
			const editor: ICodeEditor = side === 'LEFT' ? widget.getOriginalEditor() : widget.getModifiedEditor();
			const model = editor.getModel();
			if (!model) {
				continue;
			}
			const ids = editor.deltaDecorations([], bucket.map(chip => buildChipDecoration(model, chip)));
			this.chipDecorations.set(key, ids);
		}
	}

	private async appendFileCard(
		pr: PullRequest,
		file: PullRequestFile,
		workspace: KrtWorkspace,
		baseSha: string,
		opts: { renderSideBySide: boolean },
		store: DisposableStore,
	): Promise<void> {
		const previousPath = file.previousPath ?? file.path;
		const originalUri = file.status !== 'added'
			? encodeKrtGit(workspace.folderUri, workspace.folderPath, baseSha, previousPath)
			: undefined;
		const modifiedUri = file.status !== 'removed'
			? URI.joinPath(URI.file(workspace.folderPath), file.path)
			: undefined;

		// Per-side resolution via `Promise.allSettled` so a one-sided
		// failure (e.g. base SHA unfetched, file not in the local
		// view of the merge base) renders the file as added or
		// removed instead of dropping it entirely.
		const [originalSettled, modifiedSettled] = await Promise.allSettled([
			originalUri ? this.textModelService.createModelReference(originalUri) : Promise.resolve(undefined),
			modifiedUri ? this.textModelService.createModelReference(modifiedUri) : Promise.resolve(undefined),
		]);
		let original: IReference<IResolvedTextEditorModel> | undefined;
		let modified: IReference<IResolvedTextEditorModel> | undefined;
		if (originalSettled.status === 'fulfilled') {
			original = originalSettled.value;
		} else {
			this.logService.warn(`[krt] flat-diff: ${file.path} (base side) — ${originalSettled.reason instanceof Error ? originalSettled.reason.message : originalSettled.reason}`);
		}
		if (modifiedSettled.status === 'fulfilled') {
			modified = modifiedSettled.value;
		} else {
			this.logService.warn(`[krt] flat-diff: ${file.path} (head side) — ${modifiedSettled.reason instanceof Error ? modifiedSettled.reason.message : modifiedSettled.reason}`);
		}

		if (this._store.isDisposed) {
			original?.dispose();
			modified?.dispose();
			return;
		}
		if (!original && !modified) {
			return;
		}
		if (original) { store.add(original); }
		if (modified) { store.add(modified); }

		// Register URIs with the comment controller. Only sides that
		// resolved register — leaking unresolved URIs into the
		// commentService panel produces orphan threads.
		if (original && originalUri) {
			store.add(this.commentController.registerDiffUri(originalUri, {
				prUrl: pr.url,
				headSha: pr.head.sha,
				side: 'LEFT',
				path: previousPath,
			}));
		}
		if (modified && modifiedUri) {
			store.add(this.commentController.registerDiffUri(modifiedUri, {
				prUrl: pr.url,
				headSha: pr.head.sha,
				side: 'RIGHT',
				path: file.path,
			}));
		}

		// DOM: card with a header (caret / status / path / +- counts)
		// and an auto-sized editor body. Click the header (anywhere
		// except interactive children) to collapse / expand.
		const card = DOM.append(this.container, DOM.$('.krt-pr-flat-diff-card'));
		if (this.collapsedPaths.has(file.path)) {
			card.classList.add('collapsed');
		}
		const head = DOM.append(card, DOM.$('.krt-pr-flat-diff-head'));
		head.setAttribute('role', 'button');
		head.setAttribute('tabindex', '0');
		DOM.append(head, DOM.$('span.krt-pr-flat-diff-caret.codicon.codicon-chevron-down'));
		const status = DOM.append(head, DOM.$('span.krt-pr-flat-diff-status'));
		status.classList.add(file.status);
		status.textContent = statusGlyph(file.status);
		const path = DOM.append(head, DOM.$('span.krt-pr-flat-diff-path'));
		path.textContent = file.path;
		if (file.previousPath && file.previousPath !== file.path) {
			const renamed = DOM.append(head, DOM.$('span.krt-pr-flat-diff-renamed'));
			renamed.textContent = localize('krt.pr.renamedFrom', "from {0}", file.previousPath);
		}
		const counts = DOM.append(head, DOM.$('span.krt-pr-flat-diff-counts'));
		const add = DOM.append(counts, DOM.$('span.add'));
		add.textContent = `+${file.additions}`;
		const del = DOM.append(counts, DOM.$('span.del'));
		del.textContent = `-${file.deletions}`;

		// Click anywhere on the header (except interactive children)
		// toggles the card. Enter / Space activate too for keyboard
		// users since we set `role="button" tabindex="0"`.
		const toggleCollapsed = () => {
			const willCollapse = !card.classList.contains('collapsed');
			if (willCollapse) {
				this.collapsedPaths.add(file.path);
				card.classList.add('collapsed');
				// Anchor at the just-collapsed header *only* if the
				// card's header has scrolled out of view. Always
				// scrolling on collapse fights the user when the card
				// they're collapsing is already on-screen.
				const rect = card.getBoundingClientRect();
				const win = DOM.getWindow(card);
				const viewportHeight = win?.innerHeight ?? 0;
				const inViewport = rect.bottom > 0 && rect.top < viewportHeight;
				if (!inViewport) {
					card.scrollIntoView({ block: 'start' });
				}
			} else {
				this.collapsedPaths.delete(file.path);
				card.classList.remove('collapsed');
			}
		};
		store.add(DOM.addDisposableListener(head, 'click', e => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('label, input, button, a')) {
				return;
			}
			toggleCollapsed();
		}));
		store.add(DOM.addDisposableListener(head, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggleCollapsed();
			}
		}));

		const editorContainer = DOM.append(card, DOM.$('.krt-pr-flat-diff-editor'));

		// One DiffEditorWidget per file, default contributions so
		// hover / goto-def / peek / `editor.contrib.review` (native
		// comments) all activate.
		const widget = store.add(this.instantiationService.createInstance(
			DiffEditorWidget,
			editorContainer,
			{
				readOnly: true,
				originalEditable: false,
				renderSideBySide: opts.renderSideBySide,
				hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 },
				automaticLayout: true,
				scrollBeyondLastLine: false,
				renderOverviewRuler: false,
				minimap: { enabled: false },
				lineNumbersMinChars: 4,
				scrollbar: {
					alwaysConsumeMouseWheel: false,
					handleMouseWheel: true,
				},
			},
			{
				originalEditor: {},
				modifiedEditor: {},
			},
		));

		// Empty stand-ins for the missing side on added/removed files.
		// `createViewModel` requires both. The diff renders one side
		// against an empty model — same visual GitHub uses.
		const emptyModel = (uri: URI): ITextModel => {
			const existing = this.modelService.getModel(uri);
			if (existing) { return existing; }
			return this.modelService.createModel(
				'',
				this.languageService.createByFilepathOrFirstLine(uri),
				uri,
				false,
			);
		};
		const baseModel = original?.object.textEditorModel ?? emptyModel(URI.parse(`krt-pr-empty-base://${encodeURIComponent(file.path)}`));
		const headModel = modified?.object.textEditorModel ?? emptyModel(URI.parse(`krt-pr-empty-head://${encodeURIComponent(file.path)}`));

		const viewModel = widget.createViewModel({ original: baseModel, modified: headModel });
		const ref = RefCounted.create(viewModel);
		store.add(toDisposable(() => ref.dispose()));
		widget.setDiffModel(ref);

		// Auto-size the editor container to fit the diff's content
		// height. `getContentHeight` is reliable after `waitForDiff`
		// settles; subsequent content-size changes (folding, view
		// zones, etc.) come through `onDidContentSizeChange`.
		const minHeightPx = 80;
		const refit = () => {
			const h = Math.max(widget.getContentHeight(), minHeightPx);
			editorContainer.style.height = `${h}px`;
		};
		store.add(widget.onDidContentSizeChange(() => refit()));
		void widget.waitForDiff().then(() => {
			if (this._store.isDisposed) {
				return;
			}
			refit();
		});
		// Initial estimate so the layout doesn't briefly collapse to 0
		// before the diff settles.
		editorContainer.style.height = `${minHeightPx}px`;

		// Track the card so `scrollToFile` can find it without poking
		// at the DOM via `querySelector`.
		this.cardsByPath.set(file.path, card);
		// Track the widget so chip decorations can target the file's
		// per-side editor (Phase 11).
		this.widgetsByPath.set(file.path, widget);
	}

	/**
	 * Smooth-scroll the outer pane to bring this file's diff card to
	 * the top. Used by the file-tree row click handler.
	 */
	scrollToFile(path: string): void {
		this.cardsByPath.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
}

function statusGlyph(status: PullRequestFile['status']): string {
	switch (status) {
		case 'added': return 'A';
		case 'removed': return 'D';
		case 'renamed': return 'R';
		case 'copied': return 'C';
		default: return 'M';
	}
}

/**
 * Phase 11 — build a Monaco decoration for a single chip. The chip
 * is rendered as injected text after the line's last column. The
 * `inlineClassName` controls the pill's colour (per severity); the
 * `hoverMessage` is the chip body, rendered via Monaco's standard
 * hover system so we don't have to build our own popover.
 *
 * The line is clamped to the model's line count so chips that
 * reference an out-of-range line still render somewhere (last line)
 * rather than getting silently dropped.
 */
function buildChipDecoration(model: ITextModel, chip: ChapterChip): { range: Range; options: IModelDecorationOptions } {
	const line = Math.min(Math.max(1, chip.line), model.getLineCount());
	const col = model.getLineMaxColumn(line);
	const hoverBody = new MarkdownString(chip.body, true);
	hoverBody.supportThemeIcons = true;
	const severityClass = chip.severity === 'warn'
		? 'krt-tour-chip-warn'
		: chip.severity === 'note'
			? 'krt-tour-chip-note'
			: 'krt-tour-chip-info';
	return {
		range: new Range(line, col, line, col),
		options: {
			description: 'krt-tour-chip',
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			after: {
				// allow-any-unicode-next-line
				content: ` ▸ ${chip.body.length > 80 ? chip.body.slice(0, 78).trim() + '…' : chip.body}`,
				inlineClassName: `krt-tour-chip ${severityClass}`,
				inlineClassNameAffectsLetterSpacing: true,
			},
			hoverMessage: hoverBody,
			showIfCollapsed: true,
		},
	};
}

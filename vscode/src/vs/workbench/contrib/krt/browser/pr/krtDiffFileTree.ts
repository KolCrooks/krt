/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { PullRequestFile } from '../../../../../platform/krt/common/krt.js';

const COLLAPSED_KEY_PREFIX = 'krt.diff.tree.collapsed.';

function collapsedKey(owner: string, repo: string, number: number): string {
	return `${COLLAPSED_KEY_PREFIX}${owner}/${repo}#${number}`;
}

function readCollapsedFolders(storageService: IStorageService, owner: string, repo: string, number: number): Set<string> {
	const raw = storageService.get(collapsedKey(owner, repo, number), StorageScope.APPLICATION);
	if (!raw) {
		return new Set();
	}
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return new Set(parsed.filter((s): s is string => typeof s === 'string'));
		}
	} catch {
		// fall through
	}
	return new Set();
}

function writeCollapsedFolders(storageService: IStorageService, owner: string, repo: string, number: number, paths: ReadonlySet<string>): void {
	storageService.store(
		collapsedKey(owner, repo, number),
		JSON.stringify([...paths]),
		StorageScope.APPLICATION,
		StorageTarget.MACHINE,
	);
}

interface FileNode {
	readonly kind: 'file';
	readonly path: string;
	readonly file: PullRequestFile;
}

interface FolderNode {
	readonly kind: 'folder';
	readonly path: string;
	display: string;
	children: TreeNode[];
	fileCount: number;
	additions: number;
	deletions: number;
}

type TreeNode = FileNode | FolderNode;

/**
 * Build a folder tree from a flat list of PR files. Each file's path
 * is split on `/`; intermediate folders become `FolderNode`s. After
 * the initial build we run path-compression: any folder whose only
 * child is another folder collapses into one row (`a/b/c.rs` shows
 * as a single row when each intermediate folder has just one child),
 * mirroring the demo and the standard "compact folders" idiom.
 */
function buildTree(files: readonly PullRequestFile[]): FolderNode {
	const root: FolderNode = {
		kind: 'folder',
		path: '',
		display: '',
		children: [],
		fileCount: 0,
		additions: 0,
		deletions: 0,
	};
	for (const file of files) {
		const segments = file.path.split('/');
		let current = root;
		current.fileCount++;
		current.additions += file.additions;
		current.deletions += file.deletions;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			const folderPath = segments.slice(0, i + 1).join('/');
			let child = current.children.find((n): n is FolderNode => n.kind === 'folder' && n.path === folderPath);
			if (!child) {
				child = {
					kind: 'folder',
					path: folderPath,
					display: segment,
					children: [],
					fileCount: 0,
					additions: 0,
					deletions: 0,
				};
				current.children.push(child);
			}
			child.fileCount++;
			child.additions += file.additions;
			child.deletions += file.deletions;
			current = child;
		}
		current.children.push({ kind: 'file', path: file.path, file });
	}
	sortChildren(root);
	compactSingleChildFolders(root);
	return root;
}

function sortChildren(folder: FolderNode): void {
	folder.children.sort((a, b) => {
		if (a.kind !== b.kind) {
			return a.kind === 'folder' ? -1 : 1;
		}
		const aName = a.kind === 'folder' ? a.display : a.path;
		const bName = b.kind === 'folder' ? b.display : b.path;
		return aName.localeCompare(bName);
	});
	for (const child of folder.children) {
		if (child.kind === 'folder') {
			sortChildren(child);
		}
	}
}

/**
 * Walk the tree and merge any folder whose only child is another
 * folder with that child: `a/` containing only `b/` becomes a row
 * displayed as `a/b`. Continues recursively so chains of arbitrary
 * length compact into one row. Files always stay separate.
 */
function compactSingleChildFolders(folder: FolderNode): void {
	for (const child of folder.children) {
		if (child.kind === 'folder') {
			compactSingleChildFolders(child);
		}
	}
	for (let i = 0; i < folder.children.length; i++) {
		const child = folder.children[i];
		if (child.kind !== 'folder') {
			continue;
		}
		while (child.children.length === 1 && child.children[0].kind === 'folder') {
			const grand = child.children[0];
			child.display = `${child.display}/${grand.display}`;
			child.children = grand.children;
		}
	}
}

export interface KrtDiffFileTreeCallbacks {
	onScrollToFile(path: string): void;
	onOpenInEditor(path: string): void;
	onToggleReviewed(path: string, reviewed: boolean): void;
}

/**
 * Folder-tree file list for the Diff sub-mode. Phase 11 polish over
 * the prior flat list: collapsible folders with persistent state per
 * PR, per-folder counts, an inline mark-reviewed checkbox on each
 * file row, and a "open in Editor" affordance that hands off to the
 * Phase 9 Editor view.
 *
 * The tree is built once per `setFiles` call and re-rendered in
 * place. Toggling collapse mutates DOM display directly (no
 * re-render) so user state — focus, hover, scroll — survives the
 * interaction.
 */
export class KrtDiffFileTree extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());
	private readonly collapsed: Set<string>;
	private reviewedPaths: Set<string>;
	private currentRoot: FolderNode | undefined;
	private headCountEl: HTMLElement | undefined;
	private rowsByPath = new Map<string, HTMLElement>();
	private reviewedBoxesByPath = new Map<string, HTMLInputElement>();
	private filesCount = 0;

	constructor(
		private readonly container: HTMLElement,
		private readonly storageService: IStorageService,
		private readonly owner: string,
		private readonly repo: string,
		private readonly number: number,
		reviewedPaths: ReadonlySet<string>,
		private readonly callbacks: KrtDiffFileTreeCallbacks,
	) {
		super();
		this.collapsed = readCollapsedFolders(storageService, owner, repo, number);
		this.reviewedPaths = new Set(reviewedPaths);
		this.container.classList.add('krt-pr-diff-tree');
	}

	setFiles(files: readonly PullRequestFile[]): void {
		this.renderStore.clear();
		DOM.clearNode(this.container);
		this.rowsByPath.clear();
		this.reviewedBoxesByPath.clear();

		this.currentRoot = buildTree(files);
		this.filesCount = files.length;

		const head = DOM.append(this.container, DOM.$('.krt-pr-diff-tree-head'));
		const headTitle = DOM.append(head, DOM.$('span.krt-pr-diff-tree-title'));
		headTitle.textContent = localize('krt.pr.files', "Files");
		this.headCountEl = DOM.append(head, DOM.$('span.krt-pr-diff-tree-count'));
		this.refreshHeadCount();

		const list = DOM.append(this.container, DOM.$('.krt-pr-diff-tree-list'));
		for (const child of this.currentRoot.children) {
			this.renderNode(list, child, 0);
		}
	}

	/**
	 * Re-applies the `.reviewed` class for each file row to match a
	 * (possibly-changed) external set, e.g. when something other than
	 * a tree-row checkbox toggled state.
	 */
	syncReviewedPaths(reviewedPaths: ReadonlySet<string>): void {
		this.reviewedPaths = new Set(reviewedPaths);
		for (const [path, row] of this.rowsByPath) {
			const reviewed = this.reviewedPaths.has(path);
			row.classList.toggle('reviewed', reviewed);
			const box = this.reviewedBoxesByPath.get(path);
			if (box) {
				box.checked = reviewed;
			}
		}
		this.refreshHeadCount();
	}

	private renderNode(parent: HTMLElement, node: TreeNode, depth: number): void {
		if (node.kind === 'folder') {
			this.renderFolder(parent, node, depth);
		} else {
			this.renderFile(parent, node, depth);
		}
	}

	private renderFolder(parent: HTMLElement, node: FolderNode, depth: number): void {
		const row = DOM.append(parent, DOM.$('.krt-pr-diff-tree-folder-row'));
		row.style.paddingLeft = `${10 + depth * 12}px`;
		row.setAttribute('role', 'button');
		row.setAttribute('tabindex', '0');

		const isCollapsed = this.collapsed.has(node.path);
		const caret = DOM.append(row, DOM.$('span.codicon'));
		caret.classList.add(isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down');
		const folderIcon = DOM.append(row, DOM.$('span.codicon.codicon-folder.krt-pr-diff-tree-folder-icon'));
		folderIcon.style.marginRight = '4px';
		const name = DOM.append(row, DOM.$('span.krt-pr-diff-tree-folder-name'));
		name.textContent = node.display;
		const counts = DOM.append(row, DOM.$('span.krt-pr-diff-tree-folder-counts'));
		counts.textContent = formatFolderCounts(node);

		const childrenWrap = DOM.append(parent, DOM.$('.krt-pr-diff-tree-children'));
		if (isCollapsed) {
			childrenWrap.style.display = 'none';
		}
		for (const child of node.children) {
			this.renderNode(childrenWrap, child, depth + 1);
		}

		const toggle = () => {
			const willCollapse = !this.collapsed.has(node.path);
			if (willCollapse) {
				this.collapsed.add(node.path);
				caret.classList.remove('codicon-chevron-down');
				caret.classList.add('codicon-chevron-right');
				childrenWrap.style.display = 'none';
			} else {
				this.collapsed.delete(node.path);
				caret.classList.remove('codicon-chevron-right');
				caret.classList.add('codicon-chevron-down');
				childrenWrap.style.display = '';
			}
			writeCollapsedFolders(this.storageService, this.owner, this.repo, this.number, this.collapsed);
		};

		this.renderStore.add(DOM.addDisposableListener(row, 'click', () => toggle()));
		this.renderStore.add(DOM.addDisposableListener(row, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggle();
			}
		}));
	}

	private renderFile(parent: HTMLElement, node: FileNode, depth: number): void {
		const row = DOM.append(parent, DOM.$('.krt-pr-diff-tree-row'));
		row.style.paddingLeft = `${10 + depth * 12}px`;
		if (this.reviewedPaths.has(node.path)) {
			row.classList.add('reviewed');
		}
		this.rowsByPath.set(node.path, row);

		const reviewedBox = DOM.append(row, DOM.$('input.krt-pr-diff-tree-reviewed')) as HTMLInputElement;
		reviewedBox.type = 'checkbox';
		reviewedBox.checked = this.reviewedPaths.has(node.path);
		reviewedBox.title = localize('krt.pr.diffTree.markReviewed', "Mark as reviewed");
		this.reviewedBoxesByPath.set(node.path, reviewedBox);

		const dot = DOM.append(row, DOM.$('span.krt-pr-diff-status-dot'));
		dot.classList.add(node.file.status);
		dot.textContent = statusGlyph(node.file.status);

		const name = DOM.append(row, DOM.$('span.krt-pr-diff-tree-name'));
		const slash = node.path.lastIndexOf('/');
		name.textContent = slash >= 0 ? node.path.slice(slash + 1) : node.path;
		name.title = node.path;
		name.setAttribute('role', 'button');
		name.setAttribute('tabindex', '0');

		const counts = DOM.append(row, DOM.$('span.krt-pr-diff-tree-counts'));
		const add = DOM.append(counts, DOM.$('span.add'));
		add.textContent = `+${node.file.additions}`;
		const del = DOM.append(counts, DOM.$('span.del'));
		del.textContent = `-${node.file.deletions}`;

		const scrollBtn = DOM.append(row, DOM.$('button.krt-pr-diff-tree-scroll')) as HTMLButtonElement;
		scrollBtn.type = 'button';
		scrollBtn.title = localize('krt.pr.diffTree.scrollToFile', "Reveal in diff");
		scrollBtn.classList.add('codicon', 'codicon-arrow-right');

		this.renderStore.add(DOM.addDisposableListener(reviewedBox, 'change', e => {
			e.stopPropagation();
			const reviewed = reviewedBox.checked;
			if (reviewed) {
				this.reviewedPaths.add(node.path);
				row.classList.add('reviewed');
			} else {
				this.reviewedPaths.delete(node.path);
				row.classList.remove('reviewed');
			}
			this.refreshHeadCount();
			this.callbacks.onToggleReviewed(node.path, reviewed);
		}));

		const openInEditor = () => this.callbacks.onOpenInEditor(node.path);
		this.renderStore.add(DOM.addDisposableListener(name, 'click', e => {
			e.stopPropagation();
			openInEditor();
		}));
		this.renderStore.add(DOM.addDisposableListener(name, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				openInEditor();
			}
		}));

		this.renderStore.add(DOM.addDisposableListener(scrollBtn, 'click', e => {
			e.stopPropagation();
			this.callbacks.onScrollToFile(node.path);
		}));
	}

	private refreshHeadCount(): void {
		if (!this.headCountEl) {
			return;
		}
		let reviewed = 0;
		for (const path of this.rowsByPath.keys()) {
			if (this.reviewedPaths.has(path)) {
				reviewed++;
			}
		}
		this.headCountEl.textContent = `${reviewed}/${this.filesCount}`;
	}
}

function formatFolderCounts(node: FolderNode): string {
	return `${node.fileCount} · +${node.additions} -${node.deletions}`;
}

function statusGlyph(status: PullRequestFile['status']): string {
	switch (status) {
		case 'added': return 'A';
		case 'removed': return 'D';
		case 'modified': return 'M';
		case 'renamed': return 'R';
		case 'copied': return 'C';
		case 'changed': return 'M';
		case 'unchanged':
		default: return '·';
	}
}

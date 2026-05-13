/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import { join as pathJoin } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import {
	gitInvocation,
	gitMissing,
	gitNoRemote,
	gitNotARepo,
	jjInvocation,
	jjMissing,
} from '../common/errors.js';
import { GitInfo, GitStatus, IKrtGitService, JjStatus, KrtVcs } from '../common/krtGit.js';

interface SpawnResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export class KrtGitMainService implements IKrtGitService {

	declare readonly _serviceBrand: undefined;

	private detectPromise: Promise<GitInfo> | undefined;
	private jjDetectPromise: Promise<void> | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	detect(): Promise<GitInfo> {
		if (!this.detectPromise) {
			this.detectPromise = this.runDetect().catch(err => {
				this.detectPromise = undefined;
				throw err;
			});
		}
		return this.detectPromise;
	}

	async detectVcs(folderPath: string): Promise<KrtVcs | null> {
		// `.jj/` wins over `.git/` — jj-colocated repos have both, but
		// jj is the layer the user drives. `fs.access` is the cheapest
		// shape check; we don't need to spawn anything here.
		if (await pathExists(pathJoin(folderPath, '.jj'))) {
			return 'jj';
		}
		if (await pathExists(pathJoin(folderPath, '.git'))) {
			return 'git';
		}
		return null;
	}

	async getRemoteUrl(folderPath: string, remoteName: string = 'origin'): Promise<string> {
		await this.detect();
		const result = await this.spawnGit(folderPath, ['remote', 'get-url', remoteName]);
		if (result.code === 0) {
			return result.stdout.trim();
		}
		const stderr = result.stderr.toLowerCase();
		if (stderr.includes('not a git repository')) {
			throw gitNotARepo(folderPath);
		}
		if (stderr.includes('no such remote') || stderr.includes(`'${remoteName}'`)) {
			throw gitNoRemote(folderPath, remoteName);
		}
		throw gitInvocation(result.stderr || result.stdout);
	}

	async getHeadSha(folderPath: string): Promise<string> {
		await this.detect();
		const result = await this.spawnGit(folderPath, ['rev-parse', 'HEAD']);
		if (result.code === 0) {
			return result.stdout.trim();
		}
		throw gitInvocation(result.stderr || result.stdout);
	}

	async getMergeBase(folderPath: string, a: string, b: string): Promise<string> {
		await this.detect();
		const result = await this.spawnGit(folderPath, ['merge-base', a, b]);
		if (result.code === 0) {
			return result.stdout.trim();
		}
		throw gitInvocation(result.stderr || result.stdout);
	}

	async showFile(folderPath: string, ref: string, path: string): Promise<string> {
		await this.detect();
		const result = await this.spawnGit(folderPath, ['show', `${ref}:${path}`]);
		if (result.code === 0) {
			return result.stdout;
		}
		throw gitInvocation(result.stderr || result.stdout);
	}

	async getJjStatus(folderPath: string): Promise<JjStatus> {
		await this.detectJj();
		// `jj log -r @ --no-graph -T '<template>'` prints the two fields
		// newline-separated. `description.first_line()` strips embedded
		// newlines so the description side is single-line and safe to
		// split on `\n`.
		const template = 'change_id ++ "\\n" ++ description.first_line()';
		const result = await this.spawnJj(folderPath, [
			'log', '-r', '@', '--no-graph', '--no-pager', '-T', template,
		]);
		if (result.code !== 0) {
			throw jjInvocation(result.stderr || result.stdout);
		}
		const [changeId, description = ''] = result.stdout.split('\n');
		return { changeId: changeId.trim(), description: description.trim() };
	}

	async getGitStatus(folderPath: string): Promise<GitStatus> {
		await this.detect();
		const [branchResult, statusResult] = await Promise.all([
			this.spawnGit(folderPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
			this.spawnGit(folderPath, ['status', '--porcelain']),
		]);
		if (branchResult.code !== 0) {
			throw gitInvocation(branchResult.stderr || branchResult.stdout);
		}
		if (statusResult.code !== 0) {
			throw gitInvocation(statusResult.stderr || statusResult.stdout);
		}
		const branch = branchResult.stdout.trim();
		const dirtyFileCount = statusResult.stdout
			.split('\n')
			.filter(line => line.length > 0)
			.length;
		return { branch, dirtyFileCount };
	}

	async jjNew(folderPath: string, rev: string): Promise<void> {
		await this.detectJj();
		const result = await this.spawnJj(folderPath, ['new', rev]);
		if (result.code !== 0) {
			throw jjInvocation(result.stderr || result.stdout);
		}
	}

	async jjEdit(folderPath: string, changeId: string): Promise<void> {
		await this.detectJj();
		const result = await this.spawnJj(folderPath, ['edit', changeId]);
		if (result.code !== 0) {
			throw jjInvocation(result.stderr || result.stdout);
		}
	}

	async jjGitImport(folderPath: string): Promise<void> {
		await this.detectJj();
		const result = await this.spawnJj(folderPath, ['git', 'import']);
		if (result.code !== 0) {
			throw jjInvocation(result.stderr || result.stdout);
		}
	}

	async getJjOpHead(folderPath: string): Promise<string> {
		await this.detectJj();
		const result = await this.spawnJj(folderPath, [
			'op', 'log', '-n', '1', '--no-graph', '--no-pager', '-T', 'id',
		]);
		if (result.code !== 0) {
			throw jjInvocation(result.stderr || result.stdout);
		}
		return result.stdout.trim();
	}

	async jjOpRestore(folderPath: string, opId: string): Promise<void> {
		await this.detectJj();
		const result = await this.spawnJj(folderPath, ['op', 'restore', opId]);
		if (result.code !== 0) {
			throw jjInvocation(result.stderr || result.stdout);
		}
	}

	async gitStashPush(folderPath: string, message: string): Promise<string> {
		await this.detect();
		const result = await this.spawnGit(folderPath, [
			'stash', 'push', '--include-untracked', '-m', message,
		]);
		if (result.code !== 0) {
			throw gitInvocation(result.stderr || result.stdout);
		}
		// `git stash push` doesn't print the new ref. The newest entry
		// is always `stash@{0}` immediately after a successful push, so
		// we synthesize it. The user-facing message in `-m` disambiguates
		// entries in `git stash list`.
		return 'stash@{0}';
	}

	async gitCheckout(folderPath: string, ref: string): Promise<void> {
		await this.detect();
		const result = await this.spawnGit(folderPath, ['checkout', ref]);
		if (result.code !== 0) {
			throw gitInvocation(result.stderr || result.stdout);
		}
	}

	async gitFetchPullRequest(folderPath: string, prNumber: number): Promise<void> {
		await this.detect();
		// Fetch into a persistent remote-tracking ref under
		// `refs/remotes/origin/krt-pr/N` so jj's index has something to
		// import. A bare `fetch origin pull/N/head` only updates
		// FETCH_HEAD, which jj's `git import` ignores. The leading `+`
		// allows non-fast-forward updates so re-fetching a force-pushed
		// PR overwrites the prior ref cleanly.
		const result = await this.spawnGit(folderPath, [
			'fetch', 'origin',
			`+refs/pull/${prNumber}/head:refs/remotes/origin/krt-pr/${prNumber}`,
		]);
		if (result.code !== 0) {
			throw gitInvocation(result.stderr || result.stdout);
		}
	}

	private async runDetect(): Promise<GitInfo> {
		let result: SpawnResult;
		try {
			result = await this.spawnGit(undefined, ['--version']);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				throw gitMissing();
			}
			throw e;
		}
		if (result.code !== 0) {
			throw gitInvocation(result.stderr || result.stdout);
		}
		const match = /git version (?<v>\S+)/.exec(result.stdout);
		const version = match?.groups?.v ?? 'unknown';
		this.logService.info(`[krt] git detected: ${version}`);
		return { version };
	}

	private detectJj(): Promise<void> {
		if (!this.jjDetectPromise) {
			this.jjDetectPromise = this.runJjDetect().catch(err => {
				this.jjDetectPromise = undefined;
				throw err;
			});
		}
		return this.jjDetectPromise;
	}

	private async runJjDetect(): Promise<void> {
		let result: SpawnResult;
		try {
			result = await this.spawnJj(undefined, ['--version']);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				throw jjMissing();
			}
			throw e;
		}
		if (result.code !== 0) {
			throw jjInvocation(result.stderr || result.stdout);
		}
		this.logService.info(`[krt] jj detected: ${result.stdout.trim()}`);
	}

	private spawnGit(cwd: string | undefined, args: readonly string[]): Promise<SpawnResult> {
		return spawnTool('git', cwd, args);
	}

	private spawnJj(cwd: string | undefined, args: readonly string[]): Promise<SpawnResult> {
		return spawnTool('jj', cwd, args);
	}
}

function spawnTool(tool: string, cwd: string | undefined, args: readonly string[]): Promise<SpawnResult> {
	return new Promise<SpawnResult>((resolve, reject) => {
		const child = spawn(tool, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			cwd,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', chunk => stdout.push(chunk));
		child.stderr.on('data', chunk => stderr.push(chunk));
		child.on('error', err => reject(err));
		child.on('close', code => resolve({
			code,
			stdout: Buffer.concat(stdout).toString('utf8'),
			stderr: Buffer.concat(stderr).toString('utf8'),
		}));
	});
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

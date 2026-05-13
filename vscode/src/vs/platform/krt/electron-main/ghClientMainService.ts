/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { GhInfo, IGhClient } from '../common/krt.js';
import { ghAuthExpired, ghInvocation, ghMissing, ghRateLimit } from '../common/errors.js';
import { ILogService } from '../../log/common/log.js';

interface SpawnResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export class GhClientMainService implements IGhClient {

	declare readonly _serviceBrand: undefined;

	private detectPromise: Promise<GhInfo> | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	detect(): Promise<GhInfo> {
		if (!this.detectPromise) {
			this.detectPromise = this.runDetect().catch(err => {
				this.detectPromise = undefined;
				throw err;
			});
		}
		return this.detectPromise;
	}

	async apiJson<T = unknown>(path: string): Promise<T> {
		await this.detect();
		const result = await this.spawnGh(['api', path]);
		this.guardResult(result);

		try {
			return JSON.parse(result.stdout) as T;
		} catch (e) {
			this.logService.error('[krt] gh api stdout was not JSON', e);
			throw ghInvocation(`expected JSON from gh api ${path}, got ${result.stdout.slice(0, 120)}`);
		}
	}

	async apiPostJson<T = unknown>(path: string, body: object): Promise<T> {
		await this.detect();
		const json = JSON.stringify(body);
		const result = await this.spawnGh(['api', path, '-X', 'POST', '--input', '-'], json);
		this.guardResult(result);
		try {
			return JSON.parse(result.stdout) as T;
		} catch (e) {
			this.logService.error('[krt] gh api POST stdout was not JSON', e);
			throw ghInvocation(`expected JSON from gh api POST ${path}, got ${result.stdout.slice(0, 120)}`);
		}
	}

	async apiRaw(path: string, accept: string): Promise<string> {
		await this.detect();
		const result = await this.spawnGh(['api', path, '-H', `Accept: ${accept}`]);
		this.guardResult(result);
		return result.stdout;
	}

	private async runDetect(): Promise<GhInfo> {
		let result: SpawnResult;
		try {
			result = await this.spawnGh(['--version']);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				throw ghMissing();
			}
			throw e;
		}
		if (result.code !== 0) {
			throw ghInvocation(result.stderr || result.stdout);
		}
		// `gh --version` first line: "gh version 2.42.1 (2024-01-15)".
		const firstLine = result.stdout.split('\n', 1)[0] ?? '';
		const match = /gh version (?<v>\S+)/.exec(firstLine);
		const version = match?.groups?.v ?? 'unknown';
		this.logService.info(`[krt] gh detected: ${version}`);
		return { version, path: 'gh' };
	}

	private guardResult(result: SpawnResult): void {
		if (result.code === 0) {
			return;
		}
		const stderr = result.stderr.toLowerCase();
		// `gh` prompts to `auth login` when the token is missing or expired; it
		// also exits 4 in some auth paths but the stderr text is the most stable
		// signal across versions.
		if (stderr.includes('auth login') || stderr.includes('not authenticated')) {
			throw ghAuthExpired();
		}
		if (stderr.includes('rate limit')) {
			const reset = /resets? at (?<at>[^\n.]+)/i.exec(result.stderr)?.groups?.at?.trim();
			throw ghRateLimit(reset);
		}
		throw ghInvocation(result.stderr || result.stdout);
	}

	private spawnGh(args: readonly string[], stdin?: string): Promise<SpawnResult> {
		return new Promise<SpawnResult>((resolve, reject) => {
			const child = stdin === undefined
				? spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
				: spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
			if (stdin !== undefined) {
				child.stdin!.end(stdin);
			}
		});
	}
}

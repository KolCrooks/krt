/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Errors surfaced by the KRT GitHub data plane. `ProxyChannel` ships
 * thrown errors across IPC by serializing `name` + `message` + own
 * enumerable props, so the discriminator lives on `kind`. Consumers
 * branch on `kind`; never `instanceof` across the IPC boundary.
 */

export type GhErrorKind = 'gh-missing' | 'gh-auth-expired' | 'gh-rate-limit' | 'gh-invocation' | 'krt-bad-url' | 'git-missing' | 'git-invocation' | 'git-not-a-repo' | 'git-no-remote' | 'jj-missing' | 'jj-invocation';

export class KrtError extends Error {
	readonly kind: GhErrorKind;
	readonly hint: string;

	constructor(kind: GhErrorKind, message: string, hint: string) {
		super(message);
		this.name = 'KrtError';
		this.kind = kind;
		this.hint = hint;
	}
}

export function isKrtError(e: unknown): e is KrtError {
	return !!e && typeof e === 'object' && (e as { kind?: unknown }).kind !== undefined && typeof (e as { kind: unknown }).kind === 'string';
}

export function ghMissing(): KrtError {
	return new KrtError(
		'gh-missing',
		'gh CLI is not installed or not on PATH',
		'Install the GitHub CLI from https://cli.github.com and run `gh auth login`.',
	);
}

export function ghAuthExpired(): KrtError {
	return new KrtError(
		'gh-auth-expired',
		'gh CLI is not authenticated',
		'Run `gh auth login` in a terminal.',
	);
}

export function ghRateLimit(resetAt: string | undefined): KrtError {
	return new KrtError(
		'gh-rate-limit',
		'GitHub API rate limit hit',
		resetAt ? `Wait until ${resetAt} or switch tokens.` : 'Wait a minute and try again.',
	);
}

export function ghInvocation(stderr: string): KrtError {
	return new KrtError(
		'gh-invocation',
		`gh exited non-zero: ${stderr.trim().slice(0, 240)}`,
		'See the gh stderr message above.',
	);
}

export function badPullRequestUrl(url: string): KrtError {
	return new KrtError(
		'krt-bad-url',
		`Not a recognised GitHub PR URL: ${url}`,
		'Expected https://github.com/<owner>/<repo>/pull/<number>',
	);
}

export function gitMissing(): KrtError {
	return new KrtError(
		'git-missing',
		'git is not installed or not on PATH',
		'Install git and try again.',
	);
}

export function gitInvocation(stderr: string): KrtError {
	return new KrtError(
		'git-invocation',
		`git exited non-zero: ${stderr.trim().slice(0, 240)}`,
		'See the git stderr message above.',
	);
}

export function gitNotARepo(folderPath: string): KrtError {
	return new KrtError(
		'git-not-a-repo',
		`${folderPath} is not a git repository`,
		'Pick a folder that contains a .git/ directory.',
	);
}

export function gitNoRemote(folderPath: string, remoteName: string): KrtError {
	return new KrtError(
		'git-no-remote',
		`${folderPath} has no remote named "${remoteName}"`,
		`Run \`git remote -v\` in the folder and pick one whose URL is on github.com.`,
	);
}

export function jjMissing(): KrtError {
	return new KrtError(
		'jj-missing',
		'jj is not installed or not on PATH',
		'Install jj from https://martinvonz.github.io/jj/ and try again.',
	);
}

export function jjInvocation(stderr: string): KrtError {
	return new KrtError(
		'jj-invocation',
		`jj exited non-zero: ${stderr.trim().slice(0, 240)}`,
		'See the jj stderr message above.',
	);
}

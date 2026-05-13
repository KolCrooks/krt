/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

/**
 * BYOK Anthropic settings persisted across runs. The API key is stored via
 * ISecretStorageService, which uses the OS keychain when available and falls
 * back to in-memory storage otherwise. Model + prompt-caching toggle are plain
 * — they don't carry a secret.
 *
 * APPLICATION/MACHINE scope to match the recent-PRs and reviewed stores: KRT
 * is single-window/single-user, profiles aren't a meaningful axis here.
 */
export const ANTHROPIC_KEY_STORAGE = 'krt.ai.anthropicKey';
export const ANTHROPIC_MODEL_STORAGE = 'krt.ai.model';
export const ANTHROPIC_PROMPT_CACHE_STORAGE = 'krt.ai.promptCache';
export const ANTHROPIC_BASE_URL_STORAGE = 'krt.ai.baseUrl';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export const SUPPORTED_MODELS: readonly { id: string; label: string; description: string }[] = [
	{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Default. Fast + high quality for most PRs.' },
	{ id: 'claude-opus-4-7', label: 'Opus 4.7', description: 'Deeper reasoning for large or complex PRs.' },
	{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Cheapest. For very small PRs.' },
];

export async function readAnthropicKey(secretStorageService: ISecretStorageService): Promise<string | undefined> {
	return secretStorageService.get(ANTHROPIC_KEY_STORAGE);
}

export async function writeAnthropicKey(secretStorageService: ISecretStorageService, key: string): Promise<void> {
	const trimmed = key.trim();
	if (!trimmed) {
		await secretStorageService.delete(ANTHROPIC_KEY_STORAGE);
		return;
	}
	await secretStorageService.set(ANTHROPIC_KEY_STORAGE, trimmed);
}

export async function clearAnthropicKey(secretStorageService: ISecretStorageService): Promise<void> {
	await secretStorageService.delete(ANTHROPIC_KEY_STORAGE);
}

export function readModel(storageService: IStorageService): string {
	return storageService.get(ANTHROPIC_MODEL_STORAGE, StorageScope.APPLICATION) ?? DEFAULT_MODEL;
}

export function writeModel(storageService: IStorageService, model: string): void {
	storageService.store(ANTHROPIC_MODEL_STORAGE, model, StorageScope.APPLICATION, StorageTarget.MACHINE);
}

export function readPromptCaching(storageService: IStorageService): boolean {
	const raw = storageService.get(ANTHROPIC_PROMPT_CACHE_STORAGE, StorageScope.APPLICATION);
	if (raw === undefined) {
		return true;
	}
	return raw === 'true';
}

export function writePromptCaching(storageService: IStorageService, on: boolean): void {
	storageService.store(ANTHROPIC_PROMPT_CACHE_STORAGE, on ? 'true' : 'false', StorageScope.APPLICATION, StorageTarget.MACHINE);
}

/**
 * Anthropic-compatible base URL. Most users leave this as the default
 * `api.anthropic.com`. Stored without trailing slash; the generator appends
 * `/v1/messages` itself.
 */
export function readBaseUrl(storageService: IStorageService): string {
	const raw = storageService.get(ANTHROPIC_BASE_URL_STORAGE, StorageScope.APPLICATION);
	const trimmed = raw?.trim().replace(/\/+$/, '');
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_BASE_URL;
}

export function writeBaseUrl(storageService: IStorageService, url: string): void {
	const trimmed = url.trim().replace(/\/+$/, '');
	if (!trimmed || trimmed === DEFAULT_BASE_URL) {
		storageService.remove(ANTHROPIC_BASE_URL_STORAGE, StorageScope.APPLICATION);
		return;
	}
	storageService.store(ANTHROPIC_BASE_URL_STORAGE, trimmed, StorageScope.APPLICATION, StorageTarget.MACHINE);
}

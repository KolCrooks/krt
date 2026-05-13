/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import {
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicStreamEvent,
	IKrtAiClient,
} from '../common/krt.js';

/**
 * Main-process Anthropic POST. Uses Node's built-in `fetch`. The
 * non-streaming `postMessages` returns `{ status, ok, text }` so the
 * renderer can inspect HTTP status and JSON-parse the body itself —
 * matching how the gh client returns raw text and lets the provider
 * service map shapes.
 *
 * `postMessagesStream` flips `stream: true` in the body, parses the
 * SSE event stream, and fires `onStreamEvent` with text deltas + a
 * usage roll-up as the message progresses. The Promise resolves
 * once the stream is fully consumed, with a synthesised
 * non-streaming response so existing parsers keep working.
 */
export class KrtAiClientMainService implements IKrtAiClient {

	declare readonly _serviceBrand: undefined;

	private readonly _onStreamEvent = new Emitter<AnthropicStreamEvent>();
	readonly onStreamEvent: Event<AnthropicStreamEvent> = this._onStreamEvent.event;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	async postMessages(request: AnthropicMessagesRequest): Promise<AnthropicMessagesResponse> {
		const url = `${request.baseUrl.replace(/\/+$/, '')}/v1/messages`;
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': request.apiKey,
					'anthropic-version': request.anthropicVersion,
				},
				body: request.body,
			});
			const text = await response.text();
			return { status: response.status, ok: response.ok, text };
		} catch (e) {
			this.logService.warn('[krt] ai-client request failed', e);
			throw e;
		}
	}

	async postMessagesStream(requestId: string, request: AnthropicMessagesRequest): Promise<AnthropicMessagesResponse> {
		const url = `${request.baseUrl.replace(/\/+$/, '')}/v1/messages`;
		// Inject stream:true into the JSON body without forcing the
		// renderer to know about streaming.
		let bodyObj: Record<string, unknown>;
		try {
			bodyObj = JSON.parse(request.body) as Record<string, unknown>;
		} catch (e) {
			this._onStreamEvent.fire({ requestId, kind: 'error', errorMessage: `bad request body: ${e}` });
			throw e;
		}
		bodyObj.stream = true;
		const streamBody = JSON.stringify(bodyObj);

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': request.apiKey,
					'anthropic-version': request.anthropicVersion,
					'accept': 'text/event-stream',
				},
				body: streamBody,
			});
		} catch (e) {
			this.logService.warn('[krt] ai-client stream request failed', e);
			this._onStreamEvent.fire({ requestId, kind: 'error', errorMessage: e instanceof Error ? e.message : String(e) });
			throw e;
		}

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => '');
			this._onStreamEvent.fire({ requestId, kind: 'error', errorMessage: text });
			this._onStreamEvent.fire({ requestId, kind: 'done' });
			return { status: response.status, ok: false, text };
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let accumulatedText = '';
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheCreationTokens = 0;

		const fireUsage = () => {
			this._onStreamEvent.fire({
				requestId,
				kind: 'usage',
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreationTokens,
			});
		};

		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 2);
					const ev = parseSseBlock(block);
					if (!ev) {
						continue;
					}
					if (ev.type === 'message_start') {
						const u = (ev.message as { usage?: Record<string, unknown> } | undefined)?.usage;
						if (u) {
							inputTokens = numOr(u.input_tokens, 0);
							cacheReadTokens = numOr(u.cache_read_input_tokens, 0);
							cacheCreationTokens = numOr(u.cache_creation_input_tokens, 0);
							outputTokens = numOr(u.output_tokens, 0);
							fireUsage();
						}
					} else if (ev.type === 'content_block_delta') {
						const delta = ev.delta as { type?: string; text?: string } | undefined;
						if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
							accumulatedText += delta.text;
							this._onStreamEvent.fire({ requestId, kind: 'text', text: delta.text });
						}
					} else if (ev.type === 'message_delta') {
						const u = ev.usage as Record<string, unknown> | undefined;
						if (u) {
							outputTokens = numOr(u.output_tokens, outputTokens);
							fireUsage();
						}
					}
				}
			}
		} catch (e) {
			this.logService.warn('[krt] ai-client stream read failed', e);
			this._onStreamEvent.fire({ requestId, kind: 'error', errorMessage: e instanceof Error ? e.message : String(e) });
		} finally {
			this._onStreamEvent.fire({ requestId, kind: 'done' });
		}

		// Synthesise a non-streaming-shaped response so callers that
		// don't subscribe to the stream still get a parseable body.
		const finalBody = JSON.stringify({
			content: [{ type: 'text', text: accumulatedText }],
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: cacheReadTokens,
				cache_creation_input_tokens: cacheCreationTokens,
			},
		});
		return { status: response.status, ok: true, text: finalBody };
	}
}

function numOr(v: unknown, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : fallback;
}

interface SseEvent {
	readonly type?: string;
	readonly message?: unknown;
	readonly delta?: unknown;
	readonly usage?: unknown;
}

/**
 * Parse one SSE block (lines separated by \n, blocks separated by
 * \n\n). Anthropic puts the JSON payload on `data:` lines.
 */
function parseSseBlock(block: string): SseEvent | undefined {
	const lines = block.split('\n');
	let dataParts: string[] | undefined;
	for (const line of lines) {
		if (line.startsWith('data:')) {
			const piece = line.slice(5).replace(/^ /, '');
			(dataParts ?? (dataParts = [])).push(piece);
		}
	}
	if (!dataParts) {
		return undefined;
	}
	const joined = dataParts.join('\n');
	if (joined === '[DONE]' || joined.length === 0) {
		return undefined;
	}
	try {
		return JSON.parse(joined) as SseEvent;
	} catch {
		return undefined;
	}
}

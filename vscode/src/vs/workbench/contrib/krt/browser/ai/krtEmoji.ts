/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EMOJI_TABLE } from './krtEmojiTable.js';

/**
 * GitHub-style emoji shortcode -> emoji map. The table is the
 * same 1837-entry mapping the built-in git extension ships,
 * generated into a TS module so the renderer can `import` it
 * without going through a JSON-attribute import.
 *
 * Use `expandEmojiShortcodes(text)` to substitute every `:foo:`
 * occurrence inline. Unknown shortcodes are left untouched.
 */
const SHORTCODE_RE = /:([a-z0-9_+-]+):/gi;

const RESOLVED: Record<string, string> = Object.create(null);
function resolve(name: string): string | undefined {
	const cached = RESOLVED[name];
	if (cached !== undefined) {
		return cached;
	}
	const cps = EMOJI_TABLE[name];
	if (!cps) {
		return undefined;
	}
	const emoji = String.fromCodePoint(...cps);
	RESOLVED[name] = emoji;
	return emoji;
}

export function expandEmojiShortcodes(text: string): string {
	return text.replace(SHORTCODE_RE, (match, name: string) => resolve(name.toLowerCase()) ?? match);
}

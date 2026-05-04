#!/usr/bin/env node
// merge-product.mjs — shallow-merge an overlay product.json onto a base
// product.json and write the result. Used by prepare_vscode.sh.
//
// Usage: node merge-product.mjs <base> <overlay> <out>
//
// Shallow merge is intentional. For nested overrides (e.g. extensionsGallery),
// the overlay's full sub-object replaces the base's. That matches our needs:
// we want full control over each top-level key we touch and inheritance for
// the rest.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , basePath, overlayPath, outPath] = process.argv;
if (!basePath || !overlayPath || !outPath) {
	console.error('usage: merge-product.mjs <base> <overlay> <out>');
	process.exit(2);
}

const base = JSON.parse(readFileSync(basePath, 'utf8'));
const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
const merged = { ...base, ...overlay };

writeFileSync(outPath, JSON.stringify(merged, null, '\t') + '\n');

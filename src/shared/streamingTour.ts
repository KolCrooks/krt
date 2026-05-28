// Helpers for parsing a ReviewTour JSON object while it is still streaming in.
// The model emits one object like { "chapters": [ {...}, {...} ], "graph": ... }.
// As bytes arrive we want to surface each fully-formed chapter object without
// waiting for the whole document, so the UI can render the story incrementally.

/**
 * Extract every complete chapter object from a (possibly truncated) tour JSON
 * string. Returns the parsed objects for chapters whose closing brace has
 * already streamed in; an incomplete trailing chapter is ignored until it is
 * finished. Never throws — malformed slices are skipped.
 */
export function extractStreamedChapters(text: string): unknown[] {
  const slices = extractArrayObjectSlices(text, "chapters");
  const chapters: unknown[] = [];
  for (const slice of slices) {
    try {
      chapters.push(JSON.parse(slice));
    } catch {
      // A complete brace-balanced slice that still fails to parse is malformed;
      // skip it rather than aborting the whole partial render.
    }
  }
  return chapters;
}

/**
 * Scan `text` for the array value of `key` and return the raw source of each
 * brace-balanced object element that has fully arrived. String contents and
 * escapes are respected so braces inside strings do not confuse the scanner.
 */
function extractArrayObjectSlices(text: string, key: string): string[] {
  const keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex === -1) {
    return [];
  }
  const arrayStart = text.indexOf("[", keyIndex);
  if (arrayStart === -1) {
    return [];
  }

  const slices: string[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart + 1; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) {
        objectStart = index;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        slices.push(text.slice(objectStart, index + 1));
        objectStart = -1;
      }
    } else if (character === "]" && depth === 0) {
      // Reached the end of the chapters array.
      break;
    }
  }

  return slices;
}

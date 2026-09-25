// ==========================================================
// formats/json.js  (PLACEHOLDER — Stage 2 implements parsing)
// Responsibility: map structured JSON transcripts into
// canonical segments.
//
// Stage 2 contract:
//   - Use JSON.parse only (never eval). Invalid JSON -> "failed"
//     with a readable note.
//   - Map known shapes (e.g. arrays of {start, end, text, speaker})
//     into segments; source.sequence = record index.
//   - start/end.raw = the original value as a string (numbers keep
//     their original representation); seconds derived.
//   - Unknown fields are left in rawText; do not invent values.
// ==========================================================

import { createParseResult, PARSE_STATUS } from "../model.js";

export const formatId = "json";

/**
 * @param {string} rawText
 * @returns {{status:string, segments:Array, notes:string[]}}
 */
export function parse(rawText) {
    return createParseResult({
        status: PARSE_STATUS.NOT_IMPLEMENTED,
        notes: ["JSON transcript parser not implemented yet (Stage 2)."]
    });
}

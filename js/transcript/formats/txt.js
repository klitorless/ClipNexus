// ==========================================================
// formats/txt.js  (PLACEHOLDER — Stage 2 implements parsing)
// Responsibility: turn plain-text transcripts into canonical
// segments.
//
// Stage 2 contract:
//   - One segment per non-empty line (or per timestamped block).
//   - Leading timestamps like "[02:14:37]" or "02:14:37" ->
//     start.raw verbatim; seconds derived. No end times.
//   - "Name: text" prefixes -> speaker.raw ONLY when the pattern is
//     unambiguous; otherwise leave speaker unknown.
//   - text = the line as written (minus the recognized prefix, with
//     offsets recording exactly what was removed).
// ==========================================================

import { createParseResult, PARSE_STATUS } from "../model.js";

export const formatId = "txt";

/**
 * @param {string} rawText
 * @returns {{status:string, segments:Array, notes:string[]}}
 */
export function parse(rawText) {
    return createParseResult({
        status: PARSE_STATUS.NOT_IMPLEMENTED,
        notes: ["Plain-text parser not implemented yet (Stage 2)."]
    });
}

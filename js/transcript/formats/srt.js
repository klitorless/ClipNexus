// ==========================================================
// formats/srt.js  (PLACEHOLDER — Stage 2 implements parsing)
// Responsibility: turn SubRip text into canonical segments.
//
// Stage 2 contract:
//   - One segment per cue, in source order (source.sequence).
//   - cueId = the cue number line, verbatim (may be missing/wrong).
//   - start/end.raw = exact "HH:MM:SS,mmm" strings; seconds derived.
//   - text = cue text lines joined with "\n", NOT cleaned up.
//   - Keep line/offset ranges so every segment traces to rawText.
//   - Do not repair bad cues; mark timestamps "malformed" and let
//     the validator report them.
// ==========================================================

import { createParseResult, PARSE_STATUS } from "../model.js";

export const formatId = "srt";

/**
 * @param {string} rawText
 * @returns {{status:string, segments:Array, notes:string[]}}
 */
export function parse(rawText) {
    return createParseResult({
        status: PARSE_STATUS.NOT_IMPLEMENTED,
        notes: ["SRT parser not implemented yet (Stage 2)."]
    });
}

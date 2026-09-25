// ==========================================================
// formats/vtt.js  (PLACEHOLDER — Stage 2 implements parsing)
// Responsibility: turn WebVTT text into canonical segments.
//
// Stage 2 contract:
//   - Skip the WEBVTT header, NOTE, STYLE, and REGION blocks,
//     but keep line/offset positions accurate.
//   - cueId = optional cue identifier line, verbatim.
//   - start/end.raw = exact timestamp strings ("MM:SS.mmm" or
//     "HH:MM:SS.mmm"); seconds derived.
//   - <v Speaker> tags -> speaker.raw (source: "explicit").
//   - text = cue payload verbatim (tags kept; any stripped copy
//     belongs in segment.derived, never in text).
// ==========================================================

import { createParseResult, PARSE_STATUS } from "../model.js";

export const formatId = "vtt";

/**
 * @param {string} rawText
 * @returns {{status:string, segments:Array, notes:string[]}}
 */
export function parse(rawText) {
    return createParseResult({
        status: PARSE_STATUS.NOT_IMPLEMENTED,
        notes: ["WebVTT parser not implemented yet (Stage 2)."]
    });
}

// ==========================================================
// formats/srt.js  (Stage 5 — implemented)
// Responsibility: turn SubRip text into canonical segments.
//
// Implemented contract (from the Stage 2 placeholder):
//   - One segment per cue, in source order (source.sequence).
//   - cueId = the cue number line, verbatim (may be missing/wrong).
//   - start/end.raw = exact "HH:MM:SS,mmm" strings; seconds derived.
//   - text = cue text lines joined with "\n", NOT cleaned up.
//   - Keep line/offset ranges so every segment traces to rawText.
//   - Do not repair bad cues; mark timestamps "malformed" and let
//     the validator report them.
//
// Deliberate limits (Stage 5):
//   - A cue is recognized by a timing line containing "-->". The
//     cue number is optional (tolerated when missing or wrong).
//   - A block with no timing line is not a cue; it is skipped and
//     counted in a note, never silently dropped.
//   - Unparseable timing values are kept verbatim with status
//     "malformed" (never coerced to zero); the validator reports
//     them as TIMESTAMP_MALFORMED warnings.
//   - Overlapping cues are preserved as written. Overlap
//     detection belongs to validation/analysis semantics, not to
//     basic SRT parsing.
//   - Sequence numbers and cue ids never become canonical
//     segment ids; the model owns segment identity.
// ==========================================================

import { createParseResult, createSegment, createTimestamp, PARSE_STATUS, TIMESTAMP_STATUS } from "../model.js";
import { clockToSeconds } from "../clock.js";
import { splitSourceLines, groupIntoBlocks } from "../lines.js";

export const formatId = "srt";

const cueNumberPattern = /^\d+$/;
const timingSeparator = "-->";

function readCueTimestamp(piece) {
    const raw = piece.trim();
    const seconds = clockToSeconds(raw);
    return createTimestamp({
        raw,
        seconds,
        status: seconds === null ? TIMESTAMP_STATUS.MALFORMED : TIMESTAMP_STATUS.PARSED
    });
}

/**
 * Parse one block into a cue, or return null when the block is
 * not a recognizable cue. `onSkip` receives a human-readable
 * reason for the parse notes.
 */
function parseCueBlock(block, onSkip) {
    const lines = block.lines;
    let cursor = 0;

    // Optional cue number line, kept verbatim as the source cue id.
    let cueId = null;
    if (cueNumberPattern.test(lines[0].line.trim())) {
        cueId = lines[0].line.trim();
        cursor = 1;
    }

    if (cursor >= lines.length) {
        onSkip(`a block with only a cue number ("${cueId}") and no timing line`);
        return null;
    }

    const timingLine = lines[cursor].line;
    const separatorIndex = timingLine.indexOf(timingSeparator);
    if (separatorIndex === -1) {
        onSkip(`a block with no "${timingSeparator}" timing line`);
        return null;
    }

    const start = readCueTimestamp(timingLine.slice(0, separatorIndex));
    const end = readCueTimestamp(timingLine.slice(separatorIndex + timingSeparator.length));

    // Cue text: every remaining line, joined verbatim (no cleanup).
    const textLines = lines.slice(cursor + 1);
    const text = textLines.map((entry) => entry.line).join("\n");

    const first = lines[0];
    const last = lines[lines.length - 1];
    return {
        cueId,
        start,
        end,
        text,
        lines: { start: first.lineNumber, end: last.lineNumber },
        offsets: { start: first.start, end: last.end }
    };
}

/**
 * @param {string} rawText
 * @returns {{status:string, segments:Array, notes:string[]}}
 */
export function parse(rawText) {
    const entries = splitSourceLines(typeof rawText === "string" ? rawText : "");
    const blocks = groupIntoBlocks(entries);
    const segments = [];
    const notes = [];
    const skipped = [];

    for (const block of blocks) {
        const cue = parseCueBlock(block, (reason) => skipped.push(reason));
        if (!cue) continue;
        segments.push(createSegment({
            index: segments.length,
            format: formatId,
            sequence: segments.length,
            cueId: cue.cueId,
            lines: cue.lines,
            offsets: cue.offsets,
            start: cue.start,
            end: cue.end,
            text: cue.text
        }));
    }

    if (skipped.length > 0) {
        const summary = {};
        for (const reason of skipped) summary[reason] = (summary[reason] || 0) + 1;
        for (const [reason, count] of Object.entries(summary)) {
            notes.push(`${count} block(s) skipped: ${reason} (still present in the raw transcript).`);
        }
    }
    if (segments.length === 0) {
        return createParseResult({
            status: PARSE_STATUS.FAILED,
            notes: [...notes, "No SRT cues were found."]
        });
    }
    return createParseResult({ status: PARSE_STATUS.COMPLETE, segments, notes });
}

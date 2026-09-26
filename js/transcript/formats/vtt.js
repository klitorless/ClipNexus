// ==========================================================
// formats/vtt.js  (Stage 5 — implemented)
// Responsibility: turn WebVTT text into canonical segments.
//
// Implemented contract (from the Stage 2 placeholder):
//   - Skip the WEBVTT header, NOTE, STYLE, and REGION blocks,
//     but keep line/offset positions accurate (absolute line
//     numbers are recorded on every segment).
//   - cueId = optional cue identifier line, verbatim. It never
//     becomes the canonical segment id.
//   - start/end.raw = exact timestamp strings ("MM:SS.mmm" or
//     "HH:MM:SS.mmm"); seconds derived.
//   - <v Speaker> tags -> speaker.raw (source: "explicit").
//   - text = cue payload verbatim (tags kept; a copy with the
//     voice tags stripped is stored in segment.derived, never in
//     text).
//
// Deliberate limits (Stage 5):
//   - Cue settings after the end timestamp (e.g. "align:start
//     position:0%") are tolerated and ignored.
//   - Cue markup other than <v> voice tags (<b>, <i>, <c>,
//     timestamps like <00:00:01.000>) is kept verbatim in text;
//     no general HTML parsing is attempted.
//   - A block with no timing line is not a cue; it is skipped and
//     counted in a note, never silently dropped.
//   - Unparseable timing values are kept verbatim with status
//     "malformed" (never coerced); the validator reports them.
//   - Overlapping cues are preserved as written.
//   - Unsupported on purpose: nested cue structure beyond the
//     identifier/timing/payload shape, cue metadata beyond the
//     header line, and region/style semantics (their blocks are
//     skipped per the contract).
// ==========================================================

import { createParseResult, createSegment, createSpeaker, createTimestamp, PARSE_STATUS, TIMESTAMP_STATUS } from "../model.js";
import { clockToSeconds } from "../clock.js";
import { splitSourceLines, groupIntoBlocks } from "../lines.js";

export const formatId = "vtt";

const headerPattern = /^WEBVTT([ \t].*)?$/;
const notePattern = /^NOTE([ \t]|$)/;
const stylePattern = /^STYLE([ \t]|$)/;
const regionPattern = /^REGION([ \t]|$)/;
const timingSeparator = "-->";
// <v Speaker> or <v.class Speaker>; the voice name is the last token.
const voiceTagPattern = /^<v[.\s]([^<>]+?)>/;

function readCueTimestamp(piece) {
    const raw = piece.trim();
    const seconds = clockToSeconds(raw);
    return createTimestamp({
        raw,
        seconds,
        status: seconds === null ? TIMESTAMP_STATUS.MALFORMED : TIMESTAMP_STATUS.PARSED
    });
}

function readSpeaker(payload) {
    const match = voiceTagPattern.exec(payload);
    if (!match) return { speaker: undefined, stripped: payload };
    const name = match[1].trim().split(/\s+/).pop();
    const stripped = payload
        .replace(voiceTagPattern, "")
        .replace(/<\/v\s*>/g, "");
    const value = name.length > 0 ? name : null;
    return {
        // createSpeaker defaults source to "explicit" when raw is given.
        speaker: createSpeaker({ raw: match[0], value }),
        stripped
    };
}

/**
 * Parse one block into a cue, or return a skip reason when the
 * block is a known non-cue block or not a recognizable cue.
 */
function parseCueBlock(block) {
    const lines = block.lines;
    const first = lines[0].line;

    if (notePattern.test(first) || stylePattern.test(first) || regionPattern.test(first)) {
        return { skip: "header block", silent: true };
    }

    // The timing line is the first line containing "-->". Per the
    // WebVTT shape, at most one line may precede it (the optional
    // cue identifier). Extra lines before the timing line make the
    // cue unrecognizable rather than silently reinterpretable.
    let timingIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].line.includes(timingSeparator)) { timingIndex = i; break; }
    }
    if (timingIndex === -1) {
        return { skip: `a block with no "${timingSeparator}" timing line` };
    }
    if (timingIndex > 1) {
        return { skip: "a cue with more than one line before its timing line" };
    }

    const cueId = timingIndex === 1 ? lines[0].line : null;
    const timingLine = lines[timingIndex].line;
    const separatorIndex = timingLine.indexOf(timingSeparator);
    const start = readCueTimestamp(timingLine.slice(0, separatorIndex));
    // The end timestamp is the first token after "-->";
    // anything after it is cue settings, tolerated and ignored.
    const afterSeparator = timingLine.slice(separatorIndex + timingSeparator.length).trim();
    const endToken = afterSeparator.split(/\s+/, 1)[0] || "";
    const end = readCueTimestamp(endToken);

    const payload = lines.slice(timingIndex + 1).map((entry) => entry.line).join("\n");
    const { speaker, stripped } = readSpeaker(payload);

    const firstEntry = lines[0];
    const lastEntry = lines[lines.length - 1];
    return {
        cue: {
            cueId,
            start,
            end,
            speaker,
            text: payload,
            stripped,
            lines: { start: firstEntry.lineNumber, end: lastEntry.lineNumber },
            offsets: { start: firstEntry.start, end: lastEntry.end }
        }
    };
}

/**
 * @param {string} rawText
 * @returns {{status:string, segments:Array, notes:string[]}}
 */
export function parse(rawText) {
    const text = typeof rawText === "string" ? rawText.replace(/^\uFEFF/, "") : "";
    const entries = splitSourceLines(text);

    // The header must be the first non-blank line.
    const firstContent = entries.find((entry) => entry.line.trim().length > 0);
    if (!firstContent || !headerPattern.test(firstContent.line)) {
        return createParseResult({
            status: PARSE_STATUS.FAILED,
            notes: ["Missing WEBVTT header: the first non-blank line must start with \"WEBVTT\"."]
        });
    }

    // The header line itself is container syntax, not a cue. Removing
    // it before grouping keeps it out of the notes; every remaining
    // entry keeps its absolute line number and offsets.
    const bodyEntries = entries.filter((entry) => entry !== firstContent);
    const blocks = groupIntoBlocks(bodyEntries);
    const segments = [];
    const notes = [];
    const skipped = [];

    for (const block of blocks) {
        const result = parseCueBlock(block);
        if (result.skip) {
            if (!result.silent) skipped.push(result.skip);
            continue;
        }
        const cue = result.cue;
        const segment = createSegment({
            index: segments.length,
            format: formatId,
            sequence: segments.length,
            cueId: cue.cueId,
            lines: cue.lines,
            offsets: cue.offsets,
            start: cue.start,
            end: cue.end,
            speaker: cue.speaker,
            text: cue.text
        });
        if (cue.stripped !== cue.text) {
            segment.derived.strippedText = cue.stripped;
        }
        segments.push(segment);
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
            notes: [...notes, "No WebVTT cues were found."]
        });
    }
    return createParseResult({ status: PARSE_STATUS.COMPLETE, segments, notes });
}

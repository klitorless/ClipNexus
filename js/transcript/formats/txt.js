// ==========================================================
// formats/txt.js  (Stage 5 — implemented)
// Responsibility: turn plain-text transcripts into canonical
// segments.
//
// Implemented contract (from the Stage 2 placeholder):
//   - One segment per non-empty line (or per timestamped block).
//   - Leading timestamps like "[02:14:37]" or "02:14:37" ->
//     start.raw verbatim (the token exactly as written,
//     brackets included); seconds derived. No end times.
//   - "Name: text" prefixes -> speaker.raw ONLY when the pattern
//     is unambiguous (see below); otherwise leave speaker unknown.
//   - text = the line as written (minus the recognized prefix,
//     with the removed prefix recorded verbatim in
//     segment.derived.removedPrefix so the original line is
//     exactly reconstructible).
//
// Deliberate limits (Stage 5):
//   - No timestamps are invented. Lines without a leading
//     timestamp get start.status "missing" (the canonical
//     representation for unknown timing), exactly as the JSON
//     parser does for missing values.
//   - Speaker recognition is purely syntactic: one or two words,
//     each starting with an uppercase letter, up to 24 characters
//     per word, followed by ": ". Anything else ("hello: world",
//     "a very long label indeed: x", "Speaker1: x") is kept as
//     plain text. Speakers are never inferred from context.
//   - Timestamps are recognized ONLY as a leading prefix. A
//     timestamp embedded mid-line stays in the text untouched.
//   - Text is never cleaned up: no trimming beyond the recognized
//     prefix, no case/punctuation changes.
//   - A timestamp-shaped prefix that does not convert (e.g.
//     "[99:99:99]") is marked "malformed" and left for the
//     validator to report, never coerced to a number.
// ==========================================================

import { createParseResult, createSegment, createSpeaker, createTimestamp, PARSE_STATUS, TIMESTAMP_STATUS } from "../model.js";
import { clockToSeconds } from "../clock.js";
import { splitSourceLines } from "../lines.js";

export const formatId = "txt";

// HH:MM:SS with optional .mmm/,mmm fraction, optionally wrapped
// in square brackets. The token is captured verbatim (group 1 or 2).
const timestampPrefixPattern = /^\s*(?:\[(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\]|(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?))(?:\s+|$)/;

// Unambiguous speaker label: 1-2 words, each starting uppercase,
// letters/apostrophes/hyphens only, then ": " and real text.
const speakerPrefixPattern = /^([A-Z][A-Za-z'’\-]{0,23}(?:\s+[A-Z][A-Za-z'’\-]{0,23})?):\s+(\S[\s\S]*)$/;

function stripTimestampPrefix(line) {
    const match = timestampPrefixPattern.exec(line);
    if (!match) return null;
    const token = match[1] !== undefined ? match[1] : match[2];
    // The token as written, brackets included when present.
    const raw = match[1] !== undefined ? `[${token}]` : token;
    const seconds = clockToSeconds(token);
    return {
        raw,
        seconds,
        status: seconds === null ? TIMESTAMP_STATUS.MALFORMED : TIMESTAMP_STATUS.PARSED,
        removed: line.slice(0, match[0].length),
        rest: line.slice(match[0].length)
    };
}

function stripSpeakerPrefix(line) {
    const match = speakerPrefixPattern.exec(line);
    if (!match) return null;
    const [, label, rest] = match;
    return {
        label,
        removed: line.slice(0, match[0].length - rest.length),
        rest
    };
}

/**
 * @param {string} rawText
 * @returns {{status:string, segments:Array, notes:string[]}}
 */
export function parse(rawText) {
    const entries = splitSourceLines(typeof rawText === "string" ? rawText : "");
    const segments = [];
    const notes = [];
    let skippedEmpty = 0;

    for (const entry of entries) {
        if (entry.line.trim().length === 0) continue;

        let removedPrefix = "";
        let rest = entry.line;

        const timestamp = stripTimestampPrefix(rest);
        let start;
        if (timestamp) {
            start = createTimestamp({ raw: timestamp.raw, seconds: timestamp.seconds, status: timestamp.status });
            removedPrefix += timestamp.removed;
            rest = timestamp.rest;
        } else {
            start = createTimestamp(); // missing: unknown timing, never invented
        }

        const speakerMatch = stripSpeakerPrefix(rest);
        let speaker;
        if (speakerMatch) {
            removedPrefix += speakerMatch.removed;
            rest = speakerMatch.rest;
            speaker = createSpeaker({ raw: speakerMatch.label, value: speakerMatch.label });
        }

        if (rest.length === 0) {
            // A timestamp-only (or label-only) line carries no transcript
            // content; it is not a segment.
            skippedEmpty += 1;
            continue;
        }

        const segment = createSegment({
            index: segments.length,
            format: formatId,
            sequence: segments.length,
            lines: { start: entry.lineNumber, end: entry.lineNumber },
            offsets: { start: entry.start, end: entry.end },
            start,
            speaker,
            text: rest
        });
        if (removedPrefix.length > 0) {
            segment.derived.removedPrefix = removedPrefix;
        }
        segments.push(segment);
    }

    if (skippedEmpty > 0) {
        notes.push(`${skippedEmpty} line(s) carried no text and were skipped (still present in the raw transcript).`);
    }
    if (segments.length === 0) {
        return createParseResult({
            status: PARSE_STATUS.FAILED,
            notes: [...notes, "No transcript lines with text were found."]
        });
    }
    return createParseResult({ status: PARSE_STATUS.COMPLETE, segments, notes });
}

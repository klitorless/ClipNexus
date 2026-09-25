// ==========================================================
// formats/json.js  (Stage 2B — implemented)
// Responsibility: map structured JSON transcripts into
// canonical segments. Provider-agnostic: this module knows
// field names, never providers.
//
// Accepted shapes:
//   [ record, … ]                    or   { "segments": [ record, … ] }
//
// Record fields (all optional except text):
//   text        string, kept verbatim (no trimming/cleanup)
//   start | startMs          start time — seconds | milliseconds
//   end | endMs              end time
//   duration | durationMs    duration
//   speaker     string label  → speaker.source "explicit"
//   id          source cue id (string or number)
//   Time values: a number, a numeric string, or (seconds keys only)
//   a clock string such as "01:02:03.500". Unknown fields are ignored
//   here and remain in rawText.
//
// Provenance rules:
//   - JSON.parse only (never eval). Invalid JSON → "failed".
//   - timestamp.raw is the value exactly as written in the source
//     (numbers keep their representation, e.g. "1.0", via the
//     JSON.parse source-text reviver where the browser supports it).
//   - seconds is derived. Missing values stay missing (null), never 0.
//   - Invalid values are "malformed"; seconds and milliseconds both
//     given for the same time → "ambiguous" (seconds null).
//   - No end but start + duration → end.status "derived", raw null.
//   - Records without string text are skipped and counted in a note.
// ==========================================================

import {
    createParseResult, createSegment, createTimestamp, createSpeaker,
    PARSE_STATUS, TIMESTAMP_STATUS
} from "../model.js";

export const formatId = "json";

// Wrapper that carries a number's exact source text through JSON.parse.
const RAW = Symbol("raw");

function reviveNumbers(key, value, context) {
    if (typeof value === "number") {
        const source = context && typeof context.source === "string" ? context.source : null;
        return { [RAW]: source, value };
    }
    return value;
}

const isWrappedNumber = (value) => value !== null && typeof value === "object" && RAW in value;

function unwrap(value) {
    if (isWrappedNumber(value)) return value.value;
    if (Array.isArray(value)) return value.map(unwrap);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)]));
    }
    return value;
}

const has = (record, key) => Object.prototype.hasOwnProperty.call(record, key) && record[key] !== null;

const numericPattern = /^\d+(?:\.\d+)?$/;
const clockPattern = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:[.,]\d{1,3})?)$/;
const round = (seconds) => Math.round(seconds * 1e6) / 1e6;

// Returns { raw, seconds } where seconds is null when not interpretable.
function readValue(value, unit) {
    let raw;
    let number = null;
    if (isWrappedNumber(value)) {
        raw = value[RAW] !== null ? value[RAW] : String(value.value);
        number = Number.isFinite(value.value) ? value.value : null;
    } else if (typeof value === "string") {
        raw = value;
        const text = value.trim();
        if (numericPattern.test(text)) number = Number(text);
        else if (unit === "s") {
            const clock = clockPattern.exec(text);
            if (clock) {
                const [, hours = "0", minutes, rest] = clock;
                const secondsPart = Number(rest.replace(",", "."));
                const minutesValid = clock[1] === undefined || Number(minutes) < 60;
                if (secondsPart < 60 && minutesValid) {
                    number = Number(hours) * 3600 + Number(minutes) * 60 + secondsPart;
                }
            }
        }
    } else {
        raw = JSON.stringify(unwrap(value));
    }
    if (number === null || number < 0) return { raw, seconds: null };
    return { raw, seconds: round(unit === "ms" ? number / 1000 : number) };
}

function readTime(record, secondsKey, msKey) {
    const hasSeconds = has(record, secondsKey);
    const hasMs = has(record, msKey);
    if (!hasSeconds && !hasMs) return createTimestamp();
    if (hasSeconds && hasMs) {
        return createTimestamp({ raw: readValue(record[secondsKey], "s").raw, seconds: null,
            status: TIMESTAMP_STATUS.AMBIGUOUS });
    }
    const { raw, seconds } = hasSeconds ? readValue(record[secondsKey], "s") : readValue(record[msKey], "ms");
    return createTimestamp({ raw, seconds,
        status: seconds === null ? TIMESTAMP_STATUS.MALFORMED : TIMESTAMP_STATUS.PARSED });
}

function readEnd(record, start, duration) {
    const end = readTime(record, "end", "endMs");
    if (end.status !== TIMESTAMP_STATUS.MISSING) return end;
    if (start.status === TIMESTAMP_STATUS.PARSED && duration.status === TIMESTAMP_STATUS.PARSED) {
        return createTimestamp({ raw: null, seconds: round(start.seconds + duration.seconds),
            status: TIMESTAMP_STATUS.DERIVED });
    }
    return end;
}

function readCueId(record) {
    if (!has(record, "id")) return null;
    const value = record.id;
    if (isWrappedNumber(value)) return value[RAW] !== null ? value[RAW] : String(value.value);
    return typeof value === "string" ? value : null;
}

function readSpeaker(record) {
    if (typeof record.speaker !== "string") return createSpeaker();
    const value = record.speaker.trim();
    return createSpeaker({ raw: record.speaker, value: value.length ? value : null });
}

function getRecords(data) {
    if (Array.isArray(data)) return data;
    if (data !== null && typeof data === "object" && !isWrappedNumber(data) && Array.isArray(data.segments)) {
        return data.segments;
    }
    return null;
}

/**
 * @param {string} rawText
 * @returns {{status:string, segments:Array, notes:string[]}}
 */
export function parse(rawText) {
    let data;
    try {
        data = JSON.parse(rawText, reviveNumbers);
    } catch (cause) {
        return createParseResult({ status: PARSE_STATUS.FAILED,
            notes: [`Invalid JSON: ${cause && cause.message ? cause.message : "could not be read"}.`] });
    }

    const records = getRecords(data);
    if (!records) {
        return createParseResult({ status: PARSE_STATUS.FAILED,
            notes: ["Unrecognized JSON transcript shape (expected an array of records or { \"segments\": [...] })."] });
    }

    const segments = [];
    let skipped = 0;
    records.forEach((record, sequence) => {
        const isRecord = record !== null && typeof record === "object" && !Array.isArray(record) && !isWrappedNumber(record);
        if (!isRecord || typeof record.text !== "string") { skipped += 1; return; }
        const start = readTime(record, "start", "startMs");
        const duration = readTime(record, "duration", "durationMs");
        segments.push(createSegment({
            index: segments.length,
            format: formatId,
            sequence,
            cueId: readCueId(record),
            start,
            end: readEnd(record, start, duration),
            duration,
            speaker: readSpeaker(record),
            text: record.text
        }));
    });

    const notes = [];
    if (skipped > 0) notes.push(`${skipped} record(s) without text were skipped (still present in the raw transcript).`);
    if (segments.length === 0) {
        return createParseResult({ status: PARSE_STATUS.FAILED, notes: [...notes, "No transcript records with text were found."] });
    }
    return createParseResult({ status: PARSE_STATUS.COMPLETE, segments, notes });
}

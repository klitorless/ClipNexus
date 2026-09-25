// ==========================================================
// model.js
// Responsibility: define the CANONICAL TRANSCRIPT DATA MODEL.
// Factory functions only — no parsing, no validation logic.
// Every other module builds transcript objects through these
// factories so the schema lives in exactly one place.
//
// CORE RULE: never silently replace source evidence with
// normalized or corrected data.
//
//   SOURCE-OBSERVED  = what the file literally contained
//                      (rawText, *.raw fields, text, source.*)
//   DERIVED          = what the analyzer interpreted
//                      (*.seconds, status fields, segment.derived,
//                       validation, chunks)
//
// Derived layers are added as NEW properties/objects. They never
// overwrite source-observed values.
//
// MEMORY RULE: rawText is stored once, on the document.
// Segments point back into it with character offsets instead of
// copying it. Strings are shared by reference when documents are
// copied, so shallow copies are cheap.
// ==========================================================

export const TRANSCRIPT_SCHEMA_VERSION = 1;

// ---------- Small utilities ----------

function createDocumentId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return `tx-${globalThis.crypto.randomUUID()}`;
    }
    // Fallback for non-secure contexts (e.g. some file:// setups).
    const random = Math.random().toString(36).slice(2, 10);
    return `tx-${Date.now().toString(36)}-${random}`;
}

// Deterministic segment IDs: the same file parsed twice yields the
// same IDs, so evidence references stay stable across re-parses.
export function createSegmentId(index) {
    return `seg-${String(index).padStart(6, "0")}`;
}

// Recursively freeze plain objects/arrays so source layers cannot be
// mutated by later stages (validation, UI, console inspection).
export function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
    }
    return value;
}

// ---------- Timestamp ----------

// status values:
//   "parsed"    raw value was read and converted to seconds
//   "missing"   source had no timestamp for this position
//   "malformed" source had a value that could not be interpreted
//   "ambiguous" converted, but more than one reading was possible
export const TIMESTAMP_STATUS = Object.freeze({
    PARSED: "parsed",
    MISSING: "missing",
    MALFORMED: "malformed",
    AMBIGUOUS: "ambiguous"
});

export function createTimestamp({ raw = null, seconds = null, status } = {}) {
    return {
        raw,                                  // SOURCE: exact text, e.g. "01:23:45,500"
        seconds,                              // DERIVED: 5025.5, or null
        status: status || (raw === null ? TIMESTAMP_STATUS.MISSING : TIMESTAMP_STATUS.PARSED)
    };
}

// ---------- Speaker ----------

// source values describe HOW the speaker value was obtained:
//   "explicit"  the file labelled the speaker (e.g. <v Name>, "Name:")
//   "inferred"  the analyzer guessed it (must never look explicit)
//   "unknown"   no attribution available
export const SPEAKER_SOURCE = Object.freeze({
    EXPLICIT: "explicit",
    INFERRED: "inferred",
    UNKNOWN: "unknown"
});

export function createSpeaker({ raw = null, value = null, source } = {}) {
    return {
        raw,                                  // SOURCE: label exactly as written, or null
        value,                                // DERIVED: normalized name, or null
        source: source || (raw === null ? SPEAKER_SOURCE.UNKNOWN : SPEAKER_SOURCE.EXPLICIT)
    };
}

// ---------- Segment ----------

/**
 * One normalized unit of transcript (a cue, line, or record).
 *
 * @param {object} fields
 * @param {number} fields.index        Position in parsed order (0-based).
 * @param {string} fields.format       Source format id.
 * @param {number} fields.sequence     Order in which the unit appeared in the source (0-based).
 * @param {string|null} fields.cueId   Source's own identifier (SRT number, VTT cue id), verbatim.
 * @param {{start:number,end:number}} fields.lines    1-based source line range.
 * @param {{start:number,end:number}} fields.offsets  Character range in document.rawText.
 * @param {object} fields.start        createTimestamp() result.
 * @param {object} fields.end          createTimestamp() result.
 * @param {object} fields.speaker      createSpeaker() result.
 * @param {string} fields.text         Segment text exactly as in source (no cleanup).
 */
export function createSegment({
    index,
    format,
    sequence = index,
    cueId = null,
    lines = null,
    offsets = null,
    start = createTimestamp(),
    end = createTimestamp(),
    speaker = createSpeaker(),
    text = ""
}) {
    return {
        id: createSegmentId(index),
        index,
        source: {                             // SOURCE provenance
            format,
            sequence,
            cueId,
            lines,
            offsets
        },
        start,
        end,
        speaker,
        text,                                 // SOURCE: verbatim
        derived: {}                           // DERIVED: future normalizer output lives here
    };
}

// ---------- Processing / parse status ----------

// parse.status values:
//   "pending"          not attempted yet
//   "not_implemented"  format parser is still a placeholder (Stage 1.5)
//   "complete"         parser ran and produced segments
//   "failed"           parser ran and could not read the file
export const PARSE_STATUS = Object.freeze({
    PENDING: "pending",
    NOT_IMPLEMENTED: "not_implemented",
    COMPLETE: "complete",
    FAILED: "failed"
});

/**
 * The contract every format module returns from parse().
 * parser.js turns this into the document's parse/segments layers.
 */
export function createParseResult({ status, segments = [], notes = [] }) {
    return { status, segments, notes };
}

// validation.status values:
//   "unvalidated"      validator has not run
//   "not_implemented"  validator ran but has no checks yet (Stage 1.5)
//   "passed" | "issues_found"  future results
export const VALIDATION_STATUS = Object.freeze({
    UNVALIDATED: "unvalidated",
    NOT_IMPLEMENTED: "not_implemented",
    PASSED: "passed",
    ISSUES_FOUND: "issues_found"
});

// ---------- Transcript document ----------

/**
 * Create the canonical TranscriptDocument shell for a loaded file.
 * Segments, validation, and chunks are filled by later layers.
 */
export function createTranscriptDocument({ filename, format, size, lastModified = null, rawText }) {
    return {
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        id: createDocumentId(),

        source: {                             // SOURCE: file facts
            filename,
            format,
            size,
            lastModified,
            encoding: "utf-8",                // File.text() always decodes as UTF-8
            loadedAt: new Date().toISOString()
        },

        rawText,                              // SOURCE EVIDENCE: never modified

        parse: {                              // DERIVED: parser layer
            status: PARSE_STATUS.PENDING,
            parser: null,
            notes: []
        },

        segments: [],                         // DERIVED: parsed/normalized layer

        validation: {                         // DERIVED: observations about segments
            status: VALIDATION_STATUS.UNVALIDATED,
            validatedAt: null,
            checks: [],
            issues: []
        },

        chunks: [],                           // DERIVED: analysis windows (by segment id)

        processing: {
            parsed: false,
            validated: false,
            chunked: false
        }
    };
}

/**
 * Return a NEW document with extra/updated derived layers.
 * The original document is untouched; rawText and segments are
 * shared by reference, not copied.
 */
export function withDerivedLayer(document, changes) {
    return {
        ...document,
        ...changes,
        processing: { ...document.processing, ...(changes.processing || {}) }
    };
}

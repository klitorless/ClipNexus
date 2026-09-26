// ==========================================================
// validator.js  (Stage 6 — temporal semantic checks added)
// Responsibility: OBSERVE a TranscriptDocument and report
// source-quality issues. The validator never modifies the
// document or its segments; it only returns a report.
// pipeline.js attaches that report as a new derived layer.
//
// Stage 4 implemented the minimum structural layer:
//
//   document_structure  input is a TranscriptDocument whose
//                       segments have the shape downstream
//                       stages require (precondition; a
//                       violation is a validation failure and
//                       throws AppError("invalid_transcript_document"))
//   parse_complete      parser produced segments (warning when not)
//   segment_ids_unique  segment ids are unique (error on duplicates)
//   segment_text        segments carry text (warning when empty)
//   timestamps          malformed timestamps are surfaced (warning);
//                       missing timestamps are noted (info)
//
// Stage 6 adds the temporal semantic layer (check
// "temporal_semantics"), still observe-only:
//
//   end_before_start    a segment whose valid end precedes its
//                       valid start (warning, QUALITY_CONCERN)
//   ordering            consecutive segments whose valid starts
//                       move backward: a new minimum over all
//                       preceding valid starts is reported as
//                       TIMESTAMP_RESET, any other backward move
//                       as ORDER_SUSPICIOUS (warnings)
//   overlap             consecutive segments whose valid
//                       start/end intervals genuinely overlap
//                       (warning, TIMESTAMP_OVERLAP); touching
//                       exactly at the boundary is NOT overlap
//
// Temporal rules (all deterministic and read-only):
//   - Only timestamps with a valid numeric status (parsed,
//     derived) participate in temporal arithmetic. Missing
//     timestamps are unknown and never manufacture findings;
//     malformed timestamps are never coerced to a number and
//     never create findings involving the segments that carry
//     them, so they cannot cascade false errors.
//   - Zero-length segments (start === end) are valid; no issue.
//   - A missing end never participates in overlap detection,
//     and no end is ever manufactured.
//   - Gap detection is intentionally NOT implemented: the
//     repository defines no deterministic gap threshold, and
//     silence is not evidence of a bad transcript.
//   - Duplicate consecutive starts are not reported
//     (TIMESTAMP_DUPLICATE stays reserved).
//
// `valid` is false only when an ERROR-severity issue exists;
// warnings and info never reject a transcript.
//
// Explicitly NOT checked here (future work): timestamp gaps,
// jumps, duplicate timestamps, speaker inference, section
// structure. Their issue types stay reserved in the catalogue
// below.
// ==========================================================

import { AppError } from "../core/errors.js";
import { VALIDATION_STATUS, PARSE_STATUS, TIMESTAMP_STATUS } from "./model.js";

// Catalogue of issue types. Stage 4 checks emit:
//   QUALITY_CONCERN, SEGMENT_DUPLICATE, SEGMENT_EMPTY,
//   TIMESTAMP_MALFORMED, TIMESTAMP_MISSING.
// Stage 6 adds: QUALITY_CONCERN (end-before-start),
//   TIMESTAMP_RESET, ORDER_SUSPICIOUS, TIMESTAMP_OVERLAP.
// The rest remain reserved for future semantic checks.
export const ISSUE_TYPES = Object.freeze({
    TIMESTAMP_GAP: "timestamp_gap",
    TIMESTAMP_LARGE_GAP: "timestamp_large_gap",
    TIMESTAMP_OVERLAP: "timestamp_overlap",
    TIMESTAMP_RESET: "timestamp_reset",
    TIMESTAMP_JUMP: "timestamp_jump",
    TIMESTAMP_MALFORMED: "timestamp_malformed",
    TIMESTAMP_MISSING: "timestamp_missing",
    TIMESTAMP_DUPLICATE: "timestamp_duplicate",
    SPEAKER_MISSING: "speaker_missing",
    ORDER_SUSPICIOUS: "order_suspicious",
    SEGMENT_DUPLICATE: "segment_duplicate",
    SEGMENT_EMPTY: "segment_empty",
    SECTION_MISSING: "section_missing",
    QUALITY_CONCERN: "quality_concern"
});

export const SEVERITY = Object.freeze({
    INFO: "info",
    WARNING: "warning",
    ERROR: "error"
});

/**
 * Canonical validation issue. Issues REFERENCE segments by id and
 * quote short evidence; they never copy whole segments or rawText.
 *
 * @param {object} fields
 * @param {number} fields.index            Position in the report (for a stable id).
 * @param {string} fields.type             One of ISSUE_TYPES.
 * @param {string} fields.severity         One of SEVERITY.
 * @param {string} fields.message          Plain-language description.
 * @param {string[]} [fields.segmentIds]   Affected segment ids.
 * @param {number|null} [fields.startSeconds]
 * @param {number|null} [fields.endSeconds]
 * @param {string|null} [fields.evidence]  Short verbatim excerpt that shows the problem.
 * @param {{format:string, sequence:number}|null} [fields.source]  Where in the source.
 */
export function createValidationIssue({
    index,
    type,
    severity = SEVERITY.WARNING,
    message,
    segmentIds = [],
    startSeconds = null,
    endSeconds = null,
    evidence = null,
    source = null
}) {
    return {
        id: `issue-${String(index).padStart(6, "0")}`,
        type,
        severity,
        startSeconds,
        endSeconds,
        segmentIds,
        message,
        evidence,
        source
    };
}

/**
 * Validate a TranscriptDocument. Stage 4: runs the minimum
 * structural checks listed in the module header.
 *
 * The validator is read-only: it never mutates the document.
 * A structurally unusable input (not a TranscriptDocument, or
 * segments without the shape every downstream stage requires)
 * is a validation failure and throws
 * AppError("invalid_transcript_document") — the same contract
 * the chunker, exporter, and analyzer enforce.
 *
 * @param {object} transcript  TranscriptDocument (read-only).
 * @returns {{status:string, valid:boolean, validatedAt:string, checks:string[], issues:Array}}
 */
export function validateTranscript(transcript) {
    assertDocumentStructure(transcript);

    const checks = [];
    const issues = [];
    const emit = (fields) => {
        issues.push(createValidationIssue({ index: issues.length, ...fields }));
    };

    checkParseComplete(transcript, checks, emit);
    checkSegmentIdsUnique(transcript, checks, emit);
    checkSegmentText(transcript, checks, emit);
    checkTimestamps(transcript, checks, emit);
    checkTemporalSemantics(transcript, checks, emit);

    const hasError = issues.some((issue) => issue.severity === SEVERITY.ERROR);
    return {
        status: issues.length === 0 ? VALIDATION_STATUS.PASSED : VALIDATION_STATUS.ISSUES_FOUND,
        valid: !hasError,
        validatedAt: new Date().toISOString(),
        checks,
        issues
    };
}

// ---------- document_structure (precondition) ----------
//
// Every downstream stage (chunker, exporter, analyzer) requires
// a document with a string id and an array of segments whose
// entries carry a string id, string text, and start/end objects.
// Anything else cannot safely proceed, so it fails validation
// loudly instead of producing a misleading "passed" report.
function assertDocumentStructure(transcript) {
    const badDocument = !transcript || typeof transcript !== "object" ||
        typeof transcript.id !== "string" || transcript.id.length === 0 ||
        !Array.isArray(transcript.segments);
    if (badDocument) {
        throw new AppError("invalid_transcript_document",
            "Validation needs a TranscriptDocument.", {});
    }
    for (const segment of transcript.segments) {
        const badSegment = !segment || typeof segment !== "object" ||
            typeof segment.id !== "string" || segment.id.length === 0 ||
            typeof segment.text !== "string" ||
            !segment.start || typeof segment.start !== "object" ||
            !segment.end || typeof segment.end !== "object";
        if (badSegment) {
            throw new AppError("invalid_transcript_document",
                "Validation found a segment without the required structure.", { segment });
        }
    }
    return transcript;
}

// ---------- parse_complete ----------

function checkParseComplete(transcript, checks, emit) {
    checks.push("parse_complete");
    const status = transcript.parse ? transcript.parse.status : undefined;
    if (status !== PARSE_STATUS.COMPLETE) {
        emit({
            type: ISSUE_TYPES.QUALITY_CONCERN,
            severity: SEVERITY.WARNING,
            message: `The parser did not complete (status: "${status}"). ` +
                "No segments were produced, so there is no transcript content to analyze."
        });
    }
}

// ---------- segment_ids_unique ----------
//
// Duplicate ids break durable segment identity for chunking,
// evidence traceability, and analysis windows.
function checkSegmentIdsUnique(transcript, checks, emit) {
    checks.push("segment_ids_unique");
    const seen = new Set();
    const duplicates = [];
    for (const segment of transcript.segments) {
        if (seen.has(segment.id)) {
            if (!duplicates.includes(segment.id)) duplicates.push(segment.id);
        } else {
            seen.add(segment.id);
        }
    }
    if (duplicates.length > 0) {
        emit({
            type: ISSUE_TYPES.SEGMENT_DUPLICATE,
            severity: SEVERITY.ERROR,
            message: `${duplicates.length} segment id(s) appear more than once. ` +
                "Duplicate ids break segment identity for chunking and analysis.",
            segmentIds: duplicates
        });
    }
}

// ---------- segment_text ----------

function checkSegmentText(transcript, checks, emit) {
    checks.push("segment_text");
    const emptyIds = transcript.segments
        .filter((segment) => segment.text.trim().length === 0)
        .map((segment) => segment.id);
    if (emptyIds.length > 0) {
        emit({
            type: ISSUE_TYPES.SEGMENT_EMPTY,
            severity: SEVERITY.WARNING,
            message: `${emptyIds.length} segment(s) have no text.`,
            segmentIds: emptyIds
        });
    }
}

// ---------- timestamps ----------
//
// Surfaces what the parser already observed: malformed values
// are warnings worth attention; missing values are expected in
// many sources and reported as info only.
function checkTimestamps(transcript, checks, emit) {
    checks.push("timestamps");
    const malformedIds = [];
    let malformedEvidence = null;
    const missingIds = [];
    for (const segment of transcript.segments) {
        const malformed = [segment.start, segment.end]
            .find((timestamp) => timestamp.status === TIMESTAMP_STATUS.MALFORMED);
        if (malformed) {
            malformedIds.push(segment.id);
            if (malformedEvidence === null) malformedEvidence = malformed.raw;
            continue;
        }
        const missing = [segment.start, segment.end]
            .some((timestamp) => timestamp.status === TIMESTAMP_STATUS.MISSING);
        if (missing) missingIds.push(segment.id);
    }
    if (malformedIds.length > 0) {
        emit({
            type: ISSUE_TYPES.TIMESTAMP_MALFORMED,
            severity: SEVERITY.WARNING,
            message: `${malformedIds.length} segment(s) have timestamp values ` +
                "the parser could not interpret.",
            segmentIds: malformedIds,
            evidence: malformedEvidence
        });
    }
    if (missingIds.length > 0) {
        emit({
            type: ISSUE_TYPES.TIMESTAMP_MISSING,
            severity: SEVERITY.INFO,
            message: `${missingIds.length} segment(s) have no timestamp. ` +
                "Chunk windows fall back to neighboring segment times.",
            segmentIds: missingIds
        });
    }
}

// ---------- temporal_semantics (Stage 6) ----------
//
// A timestamp participates in temporal arithmetic only when
// the canonical model marks it as a valid numeric reading
// ("parsed" or "derived") and it carries a finite number.
// Missing, malformed, and ambiguous timestamps are unknown:
// never zero, never coerced, never compared.
function usableSeconds(timestamp) {
    if (!timestamp || typeof timestamp !== "object") return null;
    const numeric = timestamp.status === TIMESTAMP_STATUS.PARSED ||
        timestamp.status === TIMESTAMP_STATUS.DERIVED;
    return numeric && Number.isFinite(timestamp.seconds) ? timestamp.seconds : null;
}

// Deterministic seconds formatting for issue messages.
function formatSeconds(seconds) {
    return String(Math.round(seconds * 1000) / 1000);
}

function checkTemporalSemantics(transcript, checks, emit) {
    checks.push("temporal_semantics");
    const segments = transcript.segments;
    // Lowest valid start observed in segments before the current
    // one; drives the reset-vs-backward distinction.
    let minStart = null;
    for (let i = 0; i < segments.length; i++) {
        const current = segments[i];
        checkEndBeforeStart(current, emit);
        if (i > 0) {
            checkOrdering(segments[i - 1], current, minStart, emit);
            checkOverlap(segments[i - 1], current, emit);
        }
        const start = usableSeconds(current.start);
        if (start !== null && (minStart === null || start < minStart)) minStart = start;
    }
}

// A segment whose valid end precedes its valid start. Reported
// as observed; the values are never swapped or repaired.
function checkEndBeforeStart(segment, emit) {
    const start = usableSeconds(segment.start);
    const end = usableSeconds(segment.end);
    if (start === null || end === null || end >= start) return;
    emit({
        type: ISSUE_TYPES.QUALITY_CONCERN,
        severity: SEVERITY.WARNING,
        message: `Segment ${segment.id} ends at ${formatSeconds(end)}s, ` +
            `before it starts at ${formatSeconds(start)}s.`,
        segmentIds: [segment.id],
        startSeconds: start,
        endSeconds: end
    });
}

// Backward movement between consecutive valid starts. A start
// below every preceding valid start is a TIMESTAMP_RESET; any
// other backward move is ORDER_SUSPICIOUS. One issue per event,
// factual language only, no speculation about cause.
function checkOrdering(previous, current, minStart, emit) {
    const previousStart = usableSeconds(previous.start);
    const currentStart = usableSeconds(current.start);
    if (previousStart === null || currentStart === null) return;
    if (currentStart >= previousStart) return;
    const isReset = minStart !== null && currentStart < minStart;
    emit({
        type: isReset ? ISSUE_TYPES.TIMESTAMP_RESET : ISSUE_TYPES.ORDER_SUSPICIOUS,
        severity: SEVERITY.WARNING,
        message: isReset
            ? `Segment ${current.id} starts at ${formatSeconds(currentStart)}s, ` +
              "earlier than every preceding valid segment start " +
              `(earliest was ${formatSeconds(minStart)}s).`
            : `Segment ${current.id} starts at ${formatSeconds(currentStart)}s, ` +
              `earlier than the previous segment ${previous.id}'s valid start ` +
              `(${formatSeconds(previousStart)}s).`,
        segmentIds: [previous.id, current.id],
        startSeconds: currentStart,
        endSeconds: previousStart
    });
}

// Genuine interval overlap between consecutive segments. Both
// segments need valid starts AND valid ends; a missing end is
// never manufactured, and a segment whose own end precedes its
// start is reported by end_before_start instead — its interval
// cannot establish overlap. Strict comparison: touching
// exactly at the boundary is not overlap.
function checkOverlap(previous, current, emit) {
    const aStart = usableSeconds(previous.start);
    const aEnd = usableSeconds(previous.end);
    const bStart = usableSeconds(current.start);
    const bEnd = usableSeconds(current.end);
    if (aStart === null || aEnd === null || bStart === null || bEnd === null) return;
    if (aEnd < aStart || bEnd < bStart) return;
    const overlapStart = Math.max(aStart, bStart);
    const overlapEnd = Math.min(aEnd, bEnd);
    if (overlapStart >= overlapEnd) return;
    emit({
        type: ISSUE_TYPES.TIMESTAMP_OVERLAP,
        severity: SEVERITY.WARNING,
        message: `Segments ${previous.id} (${formatSeconds(aStart)}s → ` +
            `${formatSeconds(aEnd)}s) and ${current.id} ` +
            `(${formatSeconds(bStart)}s → ${formatSeconds(bEnd)}s) overlap.`,
        segmentIds: [previous.id, current.id],
        startSeconds: overlapStart,
        endSeconds: overlapEnd
    });
}

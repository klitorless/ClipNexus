// ==========================================================
// validator.js  (Stage 4 — minimum structural checks implemented)
// Responsibility: OBSERVE a TranscriptDocument and report
// source-quality issues. The validator never modifies the
// document or its segments; it only returns a report.
// pipeline.js attaches that report as a new derived layer.
//
// Stage 4 implements the minimum structural layer the
// application pipeline needs to proceed safely:
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
// Checks are deterministic and read-only. `valid` is false only
// when an ERROR-severity issue exists; warnings and info never
// reject a transcript.
//
// Explicitly NOT checked here (future work): timestamp gaps,
// overlaps, resets, jumps, duplicate timestamps, ordering,
// speaker inference, section structure. Their issue types stay
// reserved in the catalogue below.
// ==========================================================

import { AppError } from "../core/errors.js";
import { VALIDATION_STATUS, PARSE_STATUS, TIMESTAMP_STATUS } from "./model.js";

// Catalogue of issue types. Stage 4 checks emit:
//   QUALITY_CONCERN, SEGMENT_DUPLICATE, SEGMENT_EMPTY,
//   TIMESTAMP_MALFORMED, TIMESTAMP_MISSING.
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

// ==========================================================
// validator.js  (STRUCTURE ONLY — checks arrive in Stage 2)
// Responsibility: OBSERVE a TranscriptDocument and report
// source-quality issues. The validator never modifies the
// document or its segments; it only returns a report.
// app.js attaches that report as a new derived layer.
// ==========================================================

import { VALIDATION_STATUS } from "./model.js";

// Catalogue of issue types Stage 2 checks will emit.
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
 * Validate a TranscriptDocument. Stage 1.5: runs no checks.
 * Returns status "not_implemented" and valid: null, because
 * "no checks ran" is not the same thing as "passed".
 *
 * @param {object} transcript  TranscriptDocument (read-only).
 * @returns {{status:string, valid:(boolean|null), validatedAt:string, checks:string[], issues:Array}}
 */
export function validateTranscript(transcript) {
    return {
        status: VALIDATION_STATUS.NOT_IMPLEMENTED,
        valid: null,
        validatedAt: new Date().toISOString(),
        checks: [],
        issues: []
    };
}

// ==========================================================
// contracts.js
// Responsibility: define the STAGE 3 ANALYSIS CONTRACTS —
// AnalysisRequest, AnalysisResult, and Evidence. Factory
// functions only; no analysis logic, no AI.
//
// The analyzer READS TranscriptDocuments and PRODUCES
// AnalysisResults. Analysis never mutates the transcript.
//
// CORE RULE: evidence stays traceable to source. Every
// evidence item carries a sourceRef back to the canonical
// transcript (transcriptId + segmentIds), and provenance
// labels whether a claim was source-observed, derived, or
// inferred. Inference is never disguised as source fact.
// Segment IDs (never array indexes) are the durable
// transcript identity.
// ==========================================================

import { AppError } from "../core/errors.js";
import { createRandomId } from "../core/ids.js";
import { deepFreeze } from "../transcript/model.js";

export const ANALYSIS_SCHEMA_VERSION = 1;

// ---------- Enums ----------

export const ANALYSIS_SCOPE_TYPE = Object.freeze({
    FULL: "full",
    PARTIAL: "partial"
});

export const EVIDENCE_TYPE = Object.freeze({
    TEXT: "text",
    SPEAKER: "speaker",
    CONTEXT: "context",
    INTERPRETATION: "interpretation"
});

// source-observed: directly supported by the source/transcript.
// derived:        derived from source material without adding
//                 unsupported facts.
// inferred:      an interpretation beyond what the source states.
//                 Always labeled; never passed off as observed.
export const EVIDENCE_PROVENANCE = Object.freeze({
    SOURCE_OBSERVED: "source-observed",
    DERIVED: "derived",
    INFERRED: "inferred"
});

// Reliability describes how well the evidence is
// supported/usable — not a generic AI confidence score.
export const EVIDENCE_RELIABILITY = Object.freeze({
    HIGH: "high",
    MEDIUM: "medium",
    LOW: "low"
});

// ---------- Small validators ----------

function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}

function assertNonEmptyString(value, code, message) {
    if (!isNonEmptyString(value)) {
        throw new AppError(code, message, { value });
    }
    return value;
}

function assertIdArray(value, code, message) {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
        throw new AppError(code, message, { value });
    }
    return [...value]; // copy: the frozen contract must not alias caller arrays
}

function assertEnum(value, allowed, code, message) {
    if (!allowed.includes(value)) {
        throw new AppError(code, message, { value, allowed: [...allowed] });
    }
    return value;
}

function assertIsoTimestamp(value, code, message) {
    if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
        throw new AppError(code, message, { value });
    }
    return value;
}

function assertSchemaVersion(value, code) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new AppError(code, "schemaVersion must be a number.", { value });
    }
    return value;
}

// ---------- Scope ----------

function assertScope(scope) {
    if (!scope || typeof scope !== "object") {
        throw new AppError("invalid_scope", "AnalysisRequest needs a scope.", { scope });
    }
    if (scope.type === ANALYSIS_SCOPE_TYPE.FULL) {
        return { type: ANALYSIS_SCOPE_TYPE.FULL };
    }
    if (scope.type === ANALYSIS_SCOPE_TYPE.PARTIAL) {
        return {
            type: ANALYSIS_SCOPE_TYPE.PARTIAL,
            segmentIds: assertIdArray(scope.segmentIds, "invalid_scope",
                "Partial scope needs at least one segment id.")
        };
    }
    throw new AppError("invalid_scope", "Unknown analysis scope type.", { scope });
}

// ---------- AnalysisRequest ----------

/**
 * An analysis run over one transcript.
 *
 *   scope: { type: "full" }
 *        | { type: "partial", segmentIds: string[] }  (at least one)
 *
 * chunkId is reserved for a future chunking stage and omitted
 * until chunk-scoped analysis exists. Do not invent chunk behavior.
 */
export function createAnalysisRequest({
    id = createRandomId("areq"),
    transcriptId,
    scope,
    chunkId = null,
    schemaVersion = ANALYSIS_SCHEMA_VERSION
} = {}) {
    assertNonEmptyString(id, "invalid_analysis_request", "AnalysisRequest needs an id.");
    assertNonEmptyString(transcriptId, "invalid_analysis_request", "AnalysisRequest needs a transcriptId.");
    const validScope = assertScope(scope);
    if (chunkId !== null) {
        assertNonEmptyString(chunkId, "invalid_analysis_request",
            "chunkId must be a non-empty string when provided.");
    }
    assertSchemaVersion(schemaVersion, "invalid_analysis_request");

    const request = { id, transcriptId, scope: validScope, schemaVersion };
    if (chunkId !== null) request.chunkId = chunkId;
    return deepFreeze(request);
}

// ---------- Evidence ----------

function readEvidenceFields(input = {}) {
    const id = input.id === undefined ? createRandomId("ev") : input.id;
    assertNonEmptyString(id, "invalid_evidence", "Evidence needs an id.");

    const type = assertEnum(input.type, Object.values(EVIDENCE_TYPE),
        "invalid_evidence", "Evidence has an unknown type.");

    const sourceRef = input.sourceRef;
    if (!sourceRef || typeof sourceRef !== "object") {
        throw new AppError("invalid_evidence", "Evidence needs a sourceRef.", { sourceRef });
    }
    const transcriptId = assertNonEmptyString(sourceRef.transcriptId,
        "invalid_evidence", "Evidence sourceRef needs a transcriptId.");
    const segmentIds = assertIdArray(sourceRef.segmentIds, "invalid_evidence",
        "Evidence sourceRef needs at least one segment id.");

    if (input.content === undefined) {
        throw new AppError("invalid_evidence", "Evidence needs content.", {});
    }

    const provenance = assertEnum(input.provenance, Object.values(EVIDENCE_PROVENANCE),
        "invalid_evidence", "Evidence has an unknown provenance.");
    const reliability = assertEnum(input.reliability, Object.values(EVIDENCE_RELIABILITY),
        "invalid_evidence", "Evidence has an unknown reliability.");

    return {
        id,
        type,
        sourceRef: { transcriptId, segmentIds },
        content: input.content,
        provenance,
        reliability
    };
}

/** Build a frozen, validated evidence item. */
export function createEvidence(input) {
    return deepFreeze(readEvidenceFields(input));
}

/** Validate a candidate evidence object; returns it unchanged. */
export function assertEvidence(input) {
    readEvidenceFields(input); // throws on invalid; result discarded
    return input;
}

// ---------- AnalysisResult ----------

/**
 * The outcome of one analysis run. Plain record — no status
 * fields (pending/complete/failed); failures surface through
 * the existing error architecture instead.
 */
export function createAnalysisResult({
    id = createRandomId("ares"),
    requestId,
    createdAt = new Date().toISOString(),
    observations = [],
    evidence = [],
    warnings = [],
    limitations = [],
    schemaVersion = ANALYSIS_SCHEMA_VERSION
} = {}) {
    assertNonEmptyString(id, "invalid_analysis_result", "AnalysisResult needs an id.");
    assertNonEmptyString(requestId, "invalid_analysis_result", "AnalysisResult needs a requestId.");
    assertIsoTimestamp(createdAt, "invalid_analysis_result", "AnalysisResult needs an ISO-8601 createdAt.");
    for (const [name, list] of [["observations", observations], ["evidence", evidence],
                                ["warnings", warnings], ["limitations", limitations]]) {
        if (!Array.isArray(list)) {
            throw new AppError("invalid_analysis_result",
                `AnalysisResult.${name} must be an array.`, { [name]: list });
        }
    }
    assertSchemaVersion(schemaVersion, "invalid_analysis_result");

    return deepFreeze({
        id,
        requestId,
        createdAt,
        observations: [...observations],
        evidence: [...evidence],
        warnings: [...warnings],
        limitations: [...limitations],
        schemaVersion
    });
}

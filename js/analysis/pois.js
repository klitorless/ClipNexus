// ==========================================================
// pois.js
// Responsibility: define the CANONICAL POI (POINT OF
// INTEREST) DATA MODEL. Factory functions only — no
// extraction logic, no provider calls.
//
// A POI is DERIVED data: a normalized, immutable record of a
// moment worth reviewing, traced back to the canonical
// TranscriptDocument through segment ids. The transcript stays
// authoritative; POIs never copy transcript text and never
// replace evidence.
//
// CORE RULES (from the transcript model and Stage 3 contracts):
//   - segments are referenced by id, never by array index
//   - temporal values are validated, never coerced or repaired
//     (Stage 6 invariant: unknown stays unknown)
//   - every object is frozen; arrays are copied, never aliased
//   - provider-specific fields never reach the canonical POI;
//     they stop at the normalization boundary in
//     js/analysis/poi-providers/
//
// A POI answers: "why does this moment exist, and which
// transcript content supports it?" — via sourceRef, which
// reuses the Stage 3 Evidence reference shape
// ({ transcriptId, segmentIds }).
// ==========================================================

import { AppError } from "../core/errors.js";
import { createRandomId } from "../core/ids.js";
import { deepFreeze } from "../transcript/model.js";

export const POI_SCHEMA_VERSION = 1;

// POI categories. The set is intentionally small: providers
// classify candidates into one of these, and the domain rejects
// anything else. Future stages extend the enum; providers never
// invent their own.
export const POI_TYPE = Object.freeze({
    HIGHLIGHT: "highlight",        // a moment worth reviewing
    QUESTION: "question",          // a question was asked
    SPEAKER_CHANGE: "speaker_change", // the active speaker changed
    OTHER: "other"                 // worth reviewing; no specific category
});

// Deterministic POI ids: the same provider output normalized
// twice yields the same ids, so POI references stay stable
// across re-runs (mirrors seg-000000 / issue-000000).
export function createPoiId(index) {
    return `poi-${String(index).padStart(6, "0")}`;
}

// ---------- Small validators (mirrors analysis/contracts.js) ----------

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
    return [...value]; // copy: the frozen POI must not alias caller arrays
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

// A temporal anchor is a finite number of seconds >= 0, or null
// when the POI has no temporal anchor (it is located by evidence
// alone). Anything else is rejected, never coerced — a missing
// timestamp is unknown, never zero (Stage 6 invariant).
function assertSeconds(value, code, message) {
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new AppError(code, message, { value });
    }
    return value;
}

// ---------- Provenance ----------
//
// Fixed shape. providerId/providerName identify the extraction
// provider; extractedAt stamps the extraction run;
// candidateIndex is the candidate's position in the provider's
// output (deterministic ordering); providerRef is the provider's
// own label for the candidate, if it supplied one (a plain
// string — never an arbitrary object).
function readProvenance(input = {}) {
    const providerId = assertNonEmptyString(input.providerId,
        "invalid_poi_provenance", "POI provenance needs a providerId.");
    const providerName = input.providerName === undefined || input.providerName === null
        ? null
        : assertNonEmptyString(input.providerName,
            "invalid_poi_provenance", "POI providerName must be a non-empty string when provided.");
    const extractedAt = input.extractedAt === undefined
        ? new Date().toISOString()
        : assertIsoTimestamp(input.extractedAt,
            "invalid_poi_provenance", "POI provenance needs an ISO-8601 extractedAt.");
    const candidateIndex = input.candidateIndex === undefined ? 0 : input.candidateIndex;
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
        throw new AppError("invalid_poi_provenance",
            "POI candidateIndex must be a non-negative integer.", { candidateIndex });
    }
    const providerRef = input.providerRef === undefined || input.providerRef === null
        ? null
        : assertNonEmptyString(input.providerRef,
            "invalid_poi_provenance", "POI providerRef must be a non-empty string when provided.");
    return { providerId, providerName, extractedAt, candidateIndex, providerRef };
}

// ---------- POI ----------

function readPoiFields(input = {}) {
    const id = input.id === undefined ? createRandomId("poi") : input.id;
    assertNonEmptyString(id, "invalid_poi", "POI needs an id.");

    const transcriptId = assertNonEmptyString(input.transcriptId,
        "invalid_poi", "POI needs a transcriptId.");
    const type = assertEnum(input.type, Object.values(POI_TYPE),
        "invalid_poi", "POI has an unknown type.");
    const label = assertNonEmptyString(input.label,
        "invalid_poi", "POI needs a human-readable label.");

    const startSeconds = assertSeconds(input.startSeconds,
        "invalid_poi_time", "POI startSeconds must be a finite number >= 0, or null.");
    const endSeconds = assertSeconds(input.endSeconds,
        "invalid_poi_time", "POI endSeconds must be a finite number >= 0, or null.");
    if (startSeconds === null && endSeconds !== null) {
        throw new AppError("invalid_poi_time",
            "POI endSeconds without a startSeconds is not a temporal interval.", { endSeconds });
    }
    if (startSeconds !== null && endSeconds !== null && endSeconds < startSeconds) {
        throw new AppError("invalid_poi_time",
            "POI endSeconds precedes startSeconds; reversed ranges are rejected, never repaired.",
            { startSeconds, endSeconds });
    }
    // Zero-length (end === start) is valid, mirroring Stage 6.

    const sourceRef = input.sourceRef;
    if (!sourceRef || typeof sourceRef !== "object") {
        throw new AppError("invalid_poi", "POI needs a sourceRef.", { sourceRef });
    }
    const refTranscriptId = assertNonEmptyString(sourceRef.transcriptId,
        "invalid_poi", "POI sourceRef needs a transcriptId.");
    if (refTranscriptId !== transcriptId) {
        throw new AppError("invalid_poi",
            "POI sourceRef.transcriptId must match the POI transcriptId.", { sourceRef });
    }
    const segmentIds = assertIdArray(sourceRef.segmentIds, "invalid_poi",
        "POI sourceRef needs at least one segment id.");

    assertSchemaVersion(input.schemaVersion === undefined ? POI_SCHEMA_VERSION : input.schemaVersion,
        "invalid_poi");

    return {
        schemaVersion: POI_SCHEMA_VERSION,
        id,
        transcriptId,
        type,
        label,
        startSeconds,
        endSeconds,
        sourceRef: { transcriptId, segmentIds },
        provenance: readProvenance(input.provenance)
    };
}

/** Build a frozen, validated POI. */
export function createPoi(input) {
    return deepFreeze(readPoiFields(input));
}

/** Validate a candidate POI object; returns it unchanged. */
export function assertPoi(input) {
    readPoiFields(input); // throws on invalid; result discarded
    return input;
}

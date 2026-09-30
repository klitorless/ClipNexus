// ==========================================================
// clip-spec.js
// Responsibility: define the CANONICAL CLIPSPEC DATA MODEL.
// Factory functions only — no derivation logic, no deriver
// calls.
//
// A ClipSpec is DERIVED data: a normalized, immutable record
// describing a POTENTIAL clip — a structured specification of
// what a clip IS, never a judgment of whether it is GOOD.
// ClipSpecs are built from canonical Events. They never copy
// Events, never copy POIs, never copy transcript text, and
// never replace evidence. The traceability chain stays:
//
//   ClipSpec → eventId → Event.poiIds → POI.sourceRef
//     → segment ids → TranscriptDocument
//
// CORE RULES (from the POI/Event models and Stage 6–8
// contracts):
//   - Events and POIs are referenced by id, never by array index
//   - temporal values are validated, never coerced or repaired
//     (Stage 6 invariant: unknown stays unknown)
//   - every object is frozen; arrays are copied, never aliased
//   - deriver-specific fields never reach the canonical
//     ClipSpec; they stop at the normalization boundary in
//     js/analysis/clip-spec-derivers/
//
// A ClipSpec answers: "which Event does this potential clip
// describe, which POIs does it preserve, and over what time?"
// ==========================================================

import { AppError } from "../core/errors.js";
import { createRandomId } from "../core/ids.js";
import { deepFreeze } from "../transcript/model.js";

export const CLIP_SPEC_SCHEMA_VERSION = 1;

// Deterministic ClipSpec ids: the same deriver output
// normalized twice yields the same ids, so ClipSpec references
// stay stable across re-runs (mirrors event-000000 /
// poi-000000 / seg-000000).
export function createClipSpecId(index) {
    return `clip-${String(index).padStart(6, "0")}`;
}

// ---------- Small validators (mirrors events.js / pois.js) ----------

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
    const copy = [...value]; // copy: the frozen ClipSpec must not alias caller arrays
    if (new Set(copy).size !== copy.length) {
        throw new AppError(code, "ClipSpec POI references must not contain duplicates.", { value });
    }
    return copy;
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

// A temporal boundary is a finite number of seconds >= 0, or
// null when the ClipSpec has no temporal boundary (it is
// located by its Event's evidence alone). Anything else is
// rejected, never coerced — a missing timestamp is unknown,
// never zero (Stage 6 invariant).
function assertSeconds(value, code, message) {
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new AppError(code, message, { value });
    }
    return value;
}

// ---------- Derivation metadata ----------
//
// Fixed shape. deriverId/deriverName identify the ClipSpec
// deriver; derivedAt stamps the derivation run; candidateIndex
// is the candidate's position in the deriver's output
// (deterministic ordering); deriverRef is the deriver's own
// label for the candidate, if it supplied one (a plain
// string — never an arbitrary object).
function readDerivation(input = {}) {
    const deriverId = assertNonEmptyString(input.deriverId,
        "invalid_clip_spec_derivation", "ClipSpec derivation needs a deriverId.");
    const deriverName = input.deriverName === undefined || input.deriverName === null
        ? null
        : assertNonEmptyString(input.deriverName,
            "invalid_clip_spec_derivation", "ClipSpec deriverName must be a non-empty string when provided.");
    const derivedAt = input.derivedAt === undefined
        ? new Date().toISOString()
        : assertIsoTimestamp(input.derivedAt,
            "invalid_clip_spec_derivation", "ClipSpec derivation needs an ISO-8601 derivedAt.");
    const candidateIndex = input.candidateIndex === undefined ? 0 : input.candidateIndex;
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
        throw new AppError("invalid_clip_spec_derivation",
            "ClipSpec candidateIndex must be a non-negative integer.", { candidateIndex });
    }
    const deriverRef = input.deriverRef === undefined || input.deriverRef === null
        ? null
        : assertNonEmptyString(input.deriverRef,
            "invalid_clip_spec_derivation", "ClipSpec deriverRef must be a non-empty string when provided.");
    return { deriverId, deriverName, derivedAt, candidateIndex, deriverRef };
}

// ---------- ClipSpec ----------

function readClipSpecFields(input = {}) {
    const id = input.id === undefined ? createRandomId("clip") : input.id;
    assertNonEmptyString(id, "invalid_clip_spec", "ClipSpec needs an id.");

    const transcriptId = assertNonEmptyString(input.transcriptId,
        "invalid_clip_spec", "ClipSpec needs a transcriptId.");
    const eventId = assertNonEmptyString(input.eventId,
        "invalid_clip_spec", "ClipSpec needs an eventId.");

    // Explicit start/end semantics: start <= end. No invented
    // timestamps, no silent repair — malformed temporal data is
    // rejected. Null preserves the unknown (Stage 6 invariant).
    const startSeconds = assertSeconds(input.startSeconds,
        "invalid_clip_spec_time", "ClipSpec startSeconds must be a finite number >= 0, or null.");
    const endSeconds = assertSeconds(input.endSeconds,
        "invalid_clip_spec_time", "ClipSpec endSeconds must be a finite number >= 0, or null.");
    if (startSeconds === null && endSeconds !== null) {
        throw new AppError("invalid_clip_spec_time",
            "ClipSpec endSeconds without a startSeconds is not a temporal interval.", { endSeconds });
    }
    if (startSeconds !== null && endSeconds !== null && endSeconds < startSeconds) {
        throw new AppError("invalid_clip_spec_time",
            "ClipSpec endSeconds precedes startSeconds; reversed ranges are rejected, never repaired.",
            { startSeconds, endSeconds });
    }
    // Zero-length (end === start) is valid, mirroring Stage 6–8.

    // Source POI references: ids only, preserved from the
    // describing Event. The POIs themselves are never copied in,
    // and array indexes are never references.
    const poiIds = assertIdArray(input.poiIds, "invalid_clip_spec",
        "ClipSpec needs at least one source POI id.");

    assertSchemaVersion(input.schemaVersion === undefined ? CLIP_SPEC_SCHEMA_VERSION : input.schemaVersion,
        "invalid_clip_spec");

    return {
        schemaVersion: CLIP_SPEC_SCHEMA_VERSION,
        id,
        transcriptId,
        eventId,
        startSeconds,
        endSeconds,
        poiIds, // ids only — the Event and POIs themselves are never copied in
        derivation: readDerivation(input.derivation)
    };
}

/** Build a frozen, validated ClipSpec. */
export function createClipSpec(input) {
    return deepFreeze(readClipSpecFields(input));
}

/** Validate a candidate ClipSpec object; returns it unchanged. */
export function assertClipSpec(input) {
    readClipSpecFields(input); // throws on invalid; result discarded
    return input;
}

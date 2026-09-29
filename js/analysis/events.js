// ==========================================================
// events.js
// Responsibility: define the CANONICAL EVENT DATA MODEL.
// Factory functions only — no reconciliation logic, no
// reconciler calls.
//
// An Event is DERIVED data: a normalized, immutable record of
// a reconciled moment, built from canonical POIs. Events never
// copy POIs, never copy transcript text, and never replace
// evidence. The traceability chain stays:
//
//   Event → poiIds → POI.sourceRef → segment ids → TranscriptDocument
//
// CORE RULES (from the POI model and Stage 6/7 contracts):
//   - POIs are referenced by id, never by array index
//   - temporal values are validated, never coerced or repaired
//     (Stage 6 invariant: unknown stays unknown)
//   - every object is frozen; arrays are copied, never aliased
//   - reconciler-specific fields never reach the canonical
//     Event; they stop at the normalization boundary in
//     js/analysis/event-reconcilers/
//
// An Event answers: "which POIs were reconciled into one
// moment, by which deterministic rule, and over what time?"
// ==========================================================

import { AppError } from "../core/errors.js";
import { createRandomId } from "../core/ids.js";
import { deepFreeze } from "../transcript/model.js";

export const EVENT_SCHEMA_VERSION = 1;

// Event categories. The set is intentionally small: it records
// only what the reconciler observably did — a single POI that
// stands alone, or several POIs joined by a deterministic rule
// (recorded in derivation.rule). Reconcilers never invent
// categories; future stages extend the enum.
export const EVENT_TYPE = Object.freeze({
    SINGLE: "single",   // exactly one contributing POI
    GROUPED: "grouped"  // two or more POIs joined deterministically
});

// Deterministic rule vocabulary for derivation.rule: which
// observable relationship formed the event. "none" for single
// events (no relationship needed); "multiple" when a grouped
// event was formed by more than one distinct rule.
export const EVENT_RULE = Object.freeze({
    NONE: "none",
    TEMPORAL_OVERLAP: "temporal_overlap",
    TEMPORAL_ADJACENCY: "temporal_adjacency",
    SHARED_EVIDENCE: "shared_evidence",
    MULTIPLE: "multiple"
});

// Deterministic Event ids: the same reconciler output normalized
// twice yields the same ids, so Event references stay stable
// across re-runs (mirrors poi-000000 / seg-000000).
export function createEventId(index) {
    return `event-${String(index).padStart(6, "0")}`;
}

// ---------- Small validators (mirrors pois.js / analysis/contracts.js) ----------

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
    const copy = [...value]; // copy: the frozen Event must not alias caller arrays
    if (new Set(copy).size !== copy.length) {
        throw new AppError(code, "Event POI references must not contain duplicates.", { value });
    }
    return copy;
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
// when the Event has no temporal anchor (it is located by its
// POIs' evidence alone). Anything else is rejected, never
// coerced — a missing timestamp is unknown, never zero
// (Stage 6 invariant).
function assertSeconds(value, code, message) {
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new AppError(code, message, { value });
    }
    return value;
}

// ---------- Derivation metadata ----------
//
// Fixed shape. reconcilerId/reconcilerName identify the event
// reconciler; reconciledAt stamps the reconciliation run;
// candidateIndex is the candidate's position in the
// reconciler's output (deterministic ordering); reconcilerRef
// is the reconciler's own label for the candidate, if it
// supplied one (a plain string — never an arbitrary object);
// rule names the deterministic relationship that formed the
// event ("none" for single events, "multiple" when a grouped
// event was formed by more than one distinct rule).
function readDerivation(input = {}) {
    const reconcilerId = assertNonEmptyString(input.reconcilerId,
        "invalid_event_derivation", "Event derivation needs a reconcilerId.");
    const reconcilerName = input.reconcilerName === undefined || input.reconcilerName === null
        ? null
        : assertNonEmptyString(input.reconcilerName,
            "invalid_event_derivation", "Event reconcilerName must be a non-empty string when provided.");
    const reconciledAt = input.reconciledAt === undefined
        ? new Date().toISOString()
        : assertIsoTimestamp(input.reconciledAt,
            "invalid_event_derivation", "Event derivation needs an ISO-8601 reconciledAt.");
    const candidateIndex = input.candidateIndex === undefined ? 0 : input.candidateIndex;
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
        throw new AppError("invalid_event_derivation",
            "Event candidateIndex must be a non-negative integer.", { candidateIndex });
    }
    const reconcilerRef = input.reconcilerRef === undefined || input.reconcilerRef === null
        ? null
        : assertNonEmptyString(input.reconcilerRef,
            "invalid_event_derivation", "Event reconcilerRef must be a non-empty string when provided.");
    const rule = assertEnum(input.rule === undefined ? EVENT_RULE.NONE : input.rule,
        Object.values(EVENT_RULE),
        "invalid_event_derivation", "Event derivation.rule names a deterministic grouping relationship.");
    return { reconcilerId, reconcilerName, reconciledAt, candidateIndex, reconcilerRef, rule };
}

// ---------- Event ----------

function readEventFields(input = {}) {
    const id = input.id === undefined ? createRandomId("event") : input.id;
    assertNonEmptyString(id, "invalid_event", "Event needs an id.");

    const transcriptId = assertNonEmptyString(input.transcriptId,
        "invalid_event", "Event needs a transcriptId.");
    const type = assertEnum(input.type, Object.values(EVENT_TYPE),
        "invalid_event", "Event has an unknown type.");
    const label = assertNonEmptyString(input.label,
        "invalid_event", "Event needs a human-readable label.");

    const startSeconds = assertSeconds(input.startSeconds,
        "invalid_event_time", "Event startSeconds must be a finite number >= 0, or null.");
    const endSeconds = assertSeconds(input.endSeconds,
        "invalid_event_time", "Event endSeconds must be a finite number >= 0, or null.");
    if (startSeconds === null && endSeconds !== null) {
        throw new AppError("invalid_event_time",
            "Event endSeconds without a startSeconds is not a temporal interval.", { endSeconds });
    }
    if (startSeconds !== null && endSeconds !== null && endSeconds < startSeconds) {
        throw new AppError("invalid_event_time",
            "Event endSeconds precedes startSeconds; reversed ranges are rejected, never repaired.",
            { startSeconds, endSeconds });
    }
    // Zero-length (end === start) is valid, mirroring Stage 6/7.

    const poiIds = assertIdArray(input.poiIds, "invalid_event",
        "Event needs at least one contributing POI id.");
    if (type === EVENT_TYPE.SINGLE && poiIds.length !== 1) {
        throw new AppError("invalid_event",
            "A single event is built from exactly one POI.", { poiIds });
    }
    if (type === EVENT_TYPE.GROUPED && poiIds.length < 2) {
        throw new AppError("invalid_event",
            "A grouped event is built from two or more POIs.", { poiIds });
    }

    assertSchemaVersion(input.schemaVersion === undefined ? EVENT_SCHEMA_VERSION : input.schemaVersion,
        "invalid_event");

    return {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id,
        transcriptId,
        type,
        label,
        startSeconds,
        endSeconds,
        poiIds, // ids only — the POIs themselves are never copied in
        derivation: readDerivation(input.derivation)
    };
}

/** Build a frozen, validated Event. */
export function createEvent(input) {
    return deepFreeze(readEventFields(input));
}

/** Validate a candidate Event object; returns it unchanged. */
export function assertEvent(input) {
    readEventFields(input); // throws on invalid; result discarded
    return input;
}

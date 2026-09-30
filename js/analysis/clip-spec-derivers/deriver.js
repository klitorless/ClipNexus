// ==========================================================
// clip-spec-derivers/deriver.js
// Responsibility: the PROVIDER-NEUTRAL CLIPSPEC DERIVATION
// CONTRACT and the normalization boundary. Nothing outside
// js/analysis/clip-spec-derivers/ ever sees a
// deriver-specific response.
//
// The core application depends on this contract, never on a
// specific derivation implementation. Stage 9 describes what a
// potential clip IS, never whether it is GOOD: no ranking, no
// scoring, no virality detection, no semantic judgments —
// derivation is deterministic and evidence-preserving only.
//
// ---- What a deriver module defines (via defineClipSpecDeriver) ----
//   id, name, description        strings
//   status                       "available" | "not_implemented"
//   derive(derivationInput) → Promise<DeriverClipSpecResponse>
//       derivationInput: the curated, frozen view built by
//       buildDerivationInput() — transcriptId plus the
//       in-scope Events with their canonical ids, types,
//       temporal boundaries, and contributing POI ids. A
//       deriver never receives mutable Project internals,
//       DOM state, or credentials, and must never mutate its
//       input.
//
// ---- DeriverClipSpecResponse (what a deriver returns) ----
//   { success: true, clipSpecs: [ ... ] }
//   { success: false, error: { code: <CLIP_SPEC_DERIVATION_ERROR_CODES>,
//                              message?: string, detail?: {} } }
//
//   A candidate is a CLAIM, not a ClipSpec: the domain
//   validates and normalizes it. The candidate shape is:
//
//     { eventId: string,        // must resolve to a canonical
//                              // Event of this transcript
//       startSeconds: number|null, // finite >= 0, or null
//       endSeconds: number|null,   // null, or >= startSeconds
//       poiIds: string[],       // ≥1 id, preserved from the
//                              // Event's poiIds — never invented
//       deriverRef?: string }   // deriver's own label
//
//   Extra fields are dropped at the boundary — they never reach
//   the canonical ClipSpec.
//
// ---- DerivationOutcome (what the rest of the app sees) ----
//   see normalizeDeriverClipSpecs() below.
// ==========================================================

import { AppError } from "../../core/errors.js";
import { assertEvent } from "../events.js";
import { deepFreeze } from "../../transcript/model.js";
import { createClipSpec, createClipSpecId, CLIP_SPEC_SCHEMA_VERSION } from "../clip-spec.js";
import {
    createClipSpecDerivationFailure,
    isClipSpecDerivationErrorCode,
    CLIP_SPEC_DERIVATION_ERROR_CODES
} from "./errors.js";

export const DERIVER_STATUS = Object.freeze({
    AVAILABLE: "available",
    NOT_IMPLEMENTED: "not_implemented"
});

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

export function isValidClipSpecDeriver(deriver) {
    return Boolean(deriver) &&
        nonEmptyString(deriver.id) && /^[a-z0-9-]+$/.test(deriver.id) &&
        nonEmptyString(deriver.name) &&
        typeof deriver.description === "string" &&
        Object.values(DERIVER_STATUS).includes(deriver.status) &&
        typeof deriver.derive === "function";
}

/** Derivers call this so every ClipSpec deriver has the same frozen shape. */
export function defineClipSpecDeriver({ id, name, description = "", status, derive }) {
    return Object.freeze({ id, name, description, status, derive });
}

// UI-safe view of a deriver: data only, no functions.
export function describeClipSpecDeriver(deriver) {
    return deepFreeze({
        id: deriver.id,
        name: deriver.name,
        description: deriver.description,
        status: deriver.status
    });
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------- Derivation input ----------
//
// The documented view handed to a deriver's derive(). Curated
// from the canonical Events so a deriver never needs the
// Project's internal layout and can never observe anything
// outside the Event set under derivation. Only what
// deterministic description needs crosses the boundary: Event
// ids, types, labels, temporal boundaries, and contributing
// POI ids. Reconciler internals and provenance details stay
// behind. The input is frozen and built fresh on every
// deriveClipSpecs() call.

function eventView(event) {
    assertEvent(event);
    return {
        id: event.id,
        type: event.type,
        label: event.label,
        startSeconds: event.startSeconds,
        endSeconds: event.endSeconds,
        poiIds: [...event.poiIds]
    };
}

function assertEventList(events) {
    if (!Array.isArray(events)) {
        throw new AppError("invalid_events",
            "ClipSpec derivation needs an array of canonical Events.", { events });
    }
    return events.map(eventView);
}

export function buildDerivationInput({ transcriptId, events }) {
    if (!nonEmptyString(transcriptId)) {
        throw new AppError("invalid_transcript_id",
            "ClipSpec derivation needs a transcriptId.", { transcriptId });
    }
    const views = assertEventList(events);
    return deepFreeze({ transcriptId, events: views });
}

// Map canonical Event id → Event for reference resolution.
// Every Event must already be canonical (assertEvent); every
// Event must belong to the derivation transcript — an Event
// from the wrong transcript/project context is a contract
// violation, never silently accepted.
function indexEvents(events, transcriptId) {
    const byId = new Map();
    for (const event of events) {
        assertEvent(event);
        if (event.transcriptId !== transcriptId) {
            throw new AppError("wrong_transcript_context",
                "ClipSpec derivation needs Events from one transcript; an Event belongs to another.",
                { eventId: event.id, eventTranscriptId: event.transcriptId, transcriptId });
        }
        if (byId.has(event.id)) {
            throw new AppError("duplicate_event_id",
                "ClipSpec derivation needs distinct canonical Events.", { eventId: event.id });
        }
        byId.set(event.id, event);
    }
    return byId;
}

// ---------- Normalization boundary ----------
//
// Turn anything a deriver returned into a DerivationOutcome:
//
//   { success: true, clipSpecs: [ canonical, frozen ClipSpecs ] }
//   { success: false, error: { code, message, retryable,
//                              deriverId, detail } }
//
// deriverId/deriverName come from the deriver descriptor,
// never from the response, so a deriver cannot misattribute
// its output. Canonical ids are assigned deterministically
// (clip-000000, …) in candidate order. References are resolved
// against the canonical Event set: every candidate eventId must
// exist and belong to this transcript, and every candidate
// poiId must be preserved from that Event's poiIds — a
// deriver cannot invent evidence. Deriver-specific fields are
// dropped. A failed derivation never produces partial
// canonical ClipSpecs.

function normalizeCandidate(candidate, { index, deriver, transcriptId, byId, derivedAt }) {
    if (!isPlainObject(candidate)) {
        throw new AppError("malformed_deriver_clip_specs",
            "ClipSpec deriver returned a candidate that is not an object.", { index });
    }
    const eventId = candidate.eventId;
    if (!nonEmptyString(eventId)) {
        throw new AppError("malformed_deriver_clip_specs",
            "ClipSpec candidate needs an eventId.", { index });
    }
    if (!byId.has(eventId)) {
        throw new AppError("unknown_event_id",
            "ClipSpec candidate references an Event that does not exist in this derivation.",
            { index, eventId });
    }
    const event = byId.get(eventId);
    const eventPoiIds = new Set(event.poiIds);
    const poiIds = candidate.poiIds;
    if (!Array.isArray(poiIds) || poiIds.length === 0) {
        throw new AppError("malformed_deriver_clip_specs",
            "ClipSpec candidate needs at least one source POI id.", { index });
    }
    const seen = new Set();
    for (const poiId of poiIds) {
        if (typeof poiId !== "string" || poiId.length === 0 || seen.has(poiId)) {
            throw new AppError("invalid_poi_reference",
                "ClipSpec candidate has a malformed or duplicate POI reference.",
                { index, poiId });
        }
        seen.add(poiId);
        if (!eventPoiIds.has(poiId)) {
            throw new AppError("invalid_poi_reference",
                "ClipSpec candidate references a POI that is not preserved from its Event.",
                { index, poiId, eventId });
        }
    }
    // Only the documented candidate fields cross the boundary.
    // Everything else (scores, rankings, model output) is
    // dropped here.
    return createClipSpec({
        id: createClipSpecId(index),
        transcriptId,
        eventId,
        startSeconds: candidate.startSeconds === undefined ? null : candidate.startSeconds,
        endSeconds: candidate.endSeconds === undefined ? null : candidate.endSeconds,
        poiIds,
        derivation: {
            deriverId: deriver.id,
            deriverName: deriver.name,
            derivedAt,
            candidateIndex: index,
            deriverRef: typeof candidate.deriverRef === "string" &&
                candidate.deriverRef.length > 0 ? candidate.deriverRef : null
        },
        schemaVersion: CLIP_SPEC_SCHEMA_VERSION
    });
}

export function normalizeDeriverClipSpecs(response, { deriver, transcriptId, events }) {
    if (!isValidClipSpecDeriver(deriver)) {
        throw new AppError("invalid_clip_spec_deriver",
            "ClipSpec derivation needs a valid deriver.",
            { deriverId: deriver && deriver.id });
    }
    if (!nonEmptyString(transcriptId)) {
        throw new AppError("invalid_transcript_id",
            "ClipSpec derivation needs a transcriptId.", { transcriptId });
    }
    const byId = indexEvents(events, transcriptId);
    const context = (detail) => ({ deriverId: deriver.id, detail });

    if (!isPlainObject(response) || typeof response.success !== "boolean") {
        return createClipSpecDerivationFailure(CLIP_SPEC_DERIVATION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "response is not a DeriverClipSpecResponse" }));
    }

    if (response.success === false) {
        const error = isPlainObject(response.error) ? response.error : {};
        const code = isClipSpecDerivationErrorCode(error.code)
            ? error.code : CLIP_SPEC_DERIVATION_ERROR_CODES.UNKNOWN_ERROR;
        const detail = { ...(isPlainObject(error.detail) ? error.detail : {}) };
        if (!isClipSpecDerivationErrorCode(error.code)) detail.originalCode = String(error.code);
        return createClipSpecDerivationFailure(code, context(detail));
    }

    const candidates = response.clipSpecs;
    if (!Array.isArray(candidates)) {
        return createClipSpecDerivationFailure(CLIP_SPEC_DERIVATION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "missing clipSpecs array" }));
    }

    const derivedAt = new Date().toISOString();
    const clipSpecs = candidates.map((candidate, index) =>
        normalizeCandidate(candidate, {
            index, deriver, transcriptId, byId, derivedAt
        }));
    return deepFreeze({ success: true, clipSpecs });
}

/**
 * Run one ClipSpec derivation: validate the Event set, build
 * the deriver input, call the deriver, normalize the result.
 * A deriver that throws is reported as PROVIDER_ERROR —
 * failures never propagate as raw exceptions and never produce
 * partial ClipSpec lists.
 *
 * @param {object} deriver  defineClipSpecDeriver() result
 * @param {{transcriptId:string, events:Array}} context  canonical Events (read-only)
 * @returns {Promise<{success:true, clipSpecs:Array}|{success:false, error:Object}>}
 */
export async function deriveClipSpecs(deriver, { transcriptId, events }) {
    if (!isValidClipSpecDeriver(deriver)) {
        throw new AppError("invalid_clip_spec_deriver",
            "ClipSpec derivation needs a valid deriver.",
            { deriverId: deriver && deriver.id });
    }
    if (!nonEmptyString(transcriptId)) {
        throw new AppError("invalid_transcript_id",
            "ClipSpec derivation needs a transcriptId.", { transcriptId });
    }
    if (!Array.isArray(events)) {
        throw new AppError("invalid_events",
            "ClipSpec derivation needs an array of canonical Events.", { events });
    }
    const input = buildDerivationInput({ transcriptId, events });
    let response;
    try {
        response = await deriver.derive(input);
    } catch (error) {
        return createClipSpecDerivationFailure(CLIP_SPEC_DERIVATION_ERROR_CODES.PROVIDER_ERROR, {
            deriverId: deriver.id,
            detail: { causeMessage: error instanceof Error ? error.message : String(error) }
        });
    }
    return normalizeDeriverClipSpecs(response, { deriver, transcriptId, events });
}

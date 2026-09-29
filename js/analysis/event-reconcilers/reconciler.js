// ==========================================================
// event-reconcilers/reconciler.js
// Responsibility: the PROVIDER-NEUTRAL EVENT RECONCILIATION
// CONTRACT and the normalization boundary. Nothing outside
// js/analysis/event-reconcilers/ ever sees a
// reconciler-specific response.
//
// The core application depends on this contract, never on a
// specific reconciliation implementation. Stage 8 is
// reconciliation, not interpretation: only deterministic
// relationships (temporal overlap, temporal adjacency,
// shared evidence) may join POIs into Events.
//
// ---- What a reconciler module defines (via defineEventReconciler) ----
//   id, name, description        strings
//   status                       "available" | "not_implemented"
//   reconcile(reconciliationInput) → Promise<ReconcilerEventResponse>
//       reconciliationInput: the curated, frozen view built by
//       buildReconciliationInput() — transcriptId plus the
//       in-scope POIs with their canonical ids, types,
//       temporal anchors, and evidence segment ids. A
//       reconciler never receives mutable Project internals,
//       DOM state, or credentials, and must never mutate its
//       input.
//
// ---- ReconcilerEventResponse (what a reconciler returns) ----
//   { success: true, events: [ ... ] }
//   { success: false, error: { code: <EVENT_RECONCILIATION_ERROR_CODES>,
//                              message?: string, detail?: {} } }
//
//   A candidate is a CLAIM, not an Event: the domain validates
//   and normalizes it. The candidate shape is:
//
//     { type: "single"|"grouped",   // observable derivation
//       label: string,              // human-readable
//       startSeconds: number|null,  // finite >= 0, or null
//       endSeconds: number|null,    // null, or >= startSeconds
//       poiIds: string[],           // ≥1 id, must resolve
//       rule?: "none"|"temporal_overlap"|"temporal_adjacency"|
//              "shared_evidence"|"multiple",  // grouping rule
//       reconcilerRef?: string }    // reconciler's own label
//
//   Extra fields are dropped at the boundary — they never reach
//   the canonical Event.
//
// ---- ReconciliationOutcome (what the rest of the app sees) ----
//   see normalizeReconcilerEvents() below.
// ==========================================================

import { AppError } from "../../core/errors.js";
import { assertPoi } from "../pois.js";
import { deepFreeze } from "../../transcript/model.js";
import { createEvent, createEventId, EVENT_RULE, EVENT_SCHEMA_VERSION } from "../events.js";
import {
    createEventReconciliationFailure,
    isEventReconciliationErrorCode,
    EVENT_RECONCILIATION_ERROR_CODES
} from "./errors.js";

export const RECONCILER_STATUS = Object.freeze({
    AVAILABLE: "available",
    NOT_IMPLEMENTED: "not_implemented"
});

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

export function isValidEventReconciler(reconciler) {
    return Boolean(reconciler) &&
        nonEmptyString(reconciler.id) && /^[a-z0-9-]+$/.test(reconciler.id) &&
        nonEmptyString(reconciler.name) &&
        typeof reconciler.description === "string" &&
        Object.values(RECONCILER_STATUS).includes(reconciler.status) &&
        typeof reconciler.reconcile === "function";
}

/** Reconcilers call this so every event reconciler has the same frozen shape. */
export function defineEventReconciler({ id, name, description = "", status, reconcile }) {
    return Object.freeze({ id, name, description, status, reconcile });
}

// UI-safe view of a reconciler: data only, no functions.
export function describeEventReconciler(reconciler) {
    return deepFreeze({
        id: reconciler.id,
        name: reconciler.name,
        description: reconciler.description,
        status: reconciler.status
    });
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------- Reconciliation input ----------
//
// The documented view handed to a reconciler's reconcile().
// Curated from the canonical POIs so a reconciler never needs
// the Project's internal layout and can never observe anything
// outside the POI set under reconciliation. Only what
// deterministic grouping needs crosses the boundary: POI ids,
// types, labels, temporal anchors, and evidence segment ids.
// Provenance internals stay behind. The input is frozen and
// built fresh on every reconcilePois() call.

function poiView(poi) {
    assertPoi(poi);
    return {
        id: poi.id,
        type: poi.type,
        label: poi.label,
        startSeconds: poi.startSeconds,
        endSeconds: poi.endSeconds,
        segmentIds: [...poi.sourceRef.segmentIds]
    };
}

function assertPoiList(pois) {
    if (!Array.isArray(pois)) {
        throw new AppError("invalid_pois",
            "Event reconciliation needs an array of canonical POIs.", { pois });
    }
    return pois.map(poiView);
}

export function buildReconciliationInput({ transcriptId, pois }) {
    if (!nonEmptyString(transcriptId)) {
        throw new AppError("invalid_transcript_id",
            "Event reconciliation needs a transcriptId.", { transcriptId });
    }
    const views = assertPoiList(pois);
    return deepFreeze({ transcriptId, pois: views });
}

// Map canonical POI id → POI for reference resolution. Every POI
// must already be canonical (assertPoi); every POI must belong
// to the reconciliation transcript — a POI from the wrong
// transcript/project context is a contract violation, never
// silently accepted.
function indexPois(pois, transcriptId) {
    const byId = new Map();
    for (const poi of pois) {
        assertPoi(poi);
        if (poi.transcriptId !== transcriptId) {
            throw new AppError("wrong_transcript_context",
                "Event reconciliation needs POIs from one transcript; a POI belongs to another.",
                { poiId: poi.id, poiTranscriptId: poi.transcriptId, transcriptId });
        }
        if (byId.has(poi.id)) {
            throw new AppError("duplicate_poi_id",
                "Event reconciliation needs distinct canonical POIs.", { poiId: poi.id });
        }
        byId.set(poi.id, poi);
    }
    return byId;
}

// ---------- Normalization boundary ----------
//
// Turn anything a reconciler returned into a ReconciliationOutcome:
//
//   { success: true, events: [ canonical, frozen Events ] }
//   { success: false, error: { code, message, retryable,
//                              reconcilerId, detail } }
//
// reconcilerId/reconcilerName come from the reconciler
// descriptor, never from the response, so a reconciler cannot
// misattribute its output. Canonical ids are assigned
// deterministically (event-000000, …) in candidate order.
// References are resolved against the canonical POI set: every
// candidate poiId must exist, belong to this transcript, and
// appear at most once per event. Reconciler-specific fields are
// dropped. A failed reconciliation never produces partial
// canonical Events.

function normalizeCandidate(candidate, { index, reconciler, transcriptId, byId, reconciledAt }) {
    if (!isPlainObject(candidate)) {
        throw new AppError("malformed_reconciler_events",
            "Event reconciler returned a candidate that is not an object.", { index });
    }
    const poiIds = candidate.poiIds;
    if (!Array.isArray(poiIds) || poiIds.length === 0) {
        throw new AppError("malformed_reconciler_events",
            "Event candidate needs at least one POI id.", { index });
    }
    const seen = new Set();
    for (const poiId of poiIds) {
        if (typeof poiId !== "string" || poiId.length === 0 || seen.has(poiId)) {
            throw new AppError("invalid_poi_reference",
                "Event candidate has a malformed or duplicate POI reference.",
                { index, poiId });
        }
        seen.add(poiId);
        if (!byId.has(poiId)) {
            throw new AppError("unknown_poi_id",
                "Event candidate references a POI that does not exist in this reconciliation.",
                { index, poiId });
        }
    }
    // Only the documented candidate fields cross the boundary.
    // Everything else (scores, heuristics, model output) is
    // dropped here.
    return createEvent({
        id: createEventId(index),
        transcriptId,
        type: candidate.type,
        label: candidate.label,
        startSeconds: candidate.startSeconds === undefined ? null : candidate.startSeconds,
        endSeconds: candidate.endSeconds === undefined ? null : candidate.endSeconds,
        poiIds,
        derivation: {
            reconcilerId: reconciler.id,
            reconcilerName: reconciler.name,
            reconciledAt,
            candidateIndex: index,
            reconcilerRef: typeof candidate.reconcilerRef === "string" &&
                candidate.reconcilerRef.length > 0 ? candidate.reconcilerRef : null,
            rule: candidate.rule === undefined ? EVENT_RULE.NONE : candidate.rule
        },
        schemaVersion: EVENT_SCHEMA_VERSION
    });
}

export function normalizeReconcilerEvents(response, { reconciler, transcriptId, pois }) {
    if (!isValidEventReconciler(reconciler)) {
        throw new AppError("invalid_event_reconciler",
            "Event reconciliation needs a valid reconciler.",
            { reconcilerId: reconciler && reconciler.id });
    }
    if (!nonEmptyString(transcriptId)) {
        throw new AppError("invalid_transcript_id",
            "Event reconciliation needs a transcriptId.", { transcriptId });
    }
    const byId = indexPois(pois, transcriptId);
    const context = (detail) => ({ reconcilerId: reconciler.id, detail });

    if (!isPlainObject(response) || typeof response.success !== "boolean") {
        return createEventReconciliationFailure(EVENT_RECONCILIATION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "response is not a ReconcilerEventResponse" }));
    }

    if (response.success === false) {
        const error = isPlainObject(response.error) ? response.error : {};
        const code = isEventReconciliationErrorCode(error.code)
            ? error.code : EVENT_RECONCILIATION_ERROR_CODES.UNKNOWN_ERROR;
        const detail = { ...(isPlainObject(error.detail) ? error.detail : {}) };
        if (!isEventReconciliationErrorCode(error.code)) detail.originalCode = String(error.code);
        return createEventReconciliationFailure(code, context(detail));
    }

    const candidates = response.events;
    if (!Array.isArray(candidates)) {
        return createEventReconciliationFailure(EVENT_RECONCILIATION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "missing events array" }));
    }

    const reconciledAt = new Date().toISOString();
    const events = candidates.map((candidate, index) =>
        normalizeCandidate(candidate, {
            index, reconciler, transcriptId, byId, reconciledAt
        }));
    return deepFreeze({ success: true, events });
}

/**
 * Run one event reconciliation: validate the POI set, build the
 * reconciler input, call the reconciler, normalize the result.
 * A reconciler that throws is reported as PROVIDER_ERROR —
 * failures never propagate as raw exceptions and never produce
 * partial Event lists.
 *
 * @param {object} reconciler  defineEventReconciler() result
 * @param {{transcriptId:string, pois:Array}} context  canonical POIs (read-only)
 * @returns {Promise<{success:true, events:Array}|{success:false, error:Object}>}
 */
export async function reconcilePois(reconciler, { transcriptId, pois }) {
    if (!isValidEventReconciler(reconciler)) {
        throw new AppError("invalid_event_reconciler",
            "Event reconciliation needs a valid reconciler.",
            { reconcilerId: reconciler && reconciler.id });
    }
    if (!nonEmptyString(transcriptId)) {
        throw new AppError("invalid_transcript_id",
            "Event reconciliation needs a transcriptId.", { transcriptId });
    }
    if (!Array.isArray(pois)) {
        throw new AppError("invalid_pois",
            "Event reconciliation needs an array of canonical POIs.", { pois });
    }
    const input = buildReconciliationInput({ transcriptId, pois });
    let response;
    try {
        response = await reconciler.reconcile(input);
    } catch (error) {
        return createEventReconciliationFailure(EVENT_RECONCILIATION_ERROR_CODES.PROVIDER_ERROR, {
            reconcilerId: reconciler.id,
            detail: { causeMessage: error instanceof Error ? error.message : String(error) }
        });
    }
    return normalizeReconcilerEvents(response, { reconciler, transcriptId, pois });
}

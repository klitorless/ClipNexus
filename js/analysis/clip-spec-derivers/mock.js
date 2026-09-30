// ==========================================================
// clip-spec-derivers/mock.js
// Responsibility: DETERMINISTIC mock ClipSpec derivers for
// self-tests. Never registered anywhere by default. No
// network, no AI, no randomness, no ranking, no scoring —
// every mock is named "Mock …" so its provenance is obvious.
//
// behavior:
//   "success"    one ClipSpec candidate per Event
//   "empty"      returns { success:true, clipSpecs: [] }
//   "fail"       returns { success:false, error:{ code: errorCode } }
//   "throw"      derive throws
//   "raw"        returns `response` verbatim (tests normalization)
//
// TEMPORAL DERIVATION (documented rule): a ClipSpec describes
// exactly the Event it was derived from, so it inherits the
// Event's startSeconds/endSeconds unchanged — including null
// (unknown stays unknown, Stage 6 invariant). Timestamps are
// never invented, never shifted, never padded. The deriver
// describes what a potential clip IS, not whether it is GOOD.
// ==========================================================

import { defineClipSpecDeriver, DERIVER_STATUS } from "./deriver.js";

function candidateFromEvent(event, candidateIndex) {
    return {
        eventId: event.id,
        startSeconds: event.startSeconds,
        endSeconds: event.endSeconds,
        poiIds: [...event.poiIds], // preserved from the Event — never invented
        deriverRef: `mock-clip-${candidateIndex}`
    };
}

export function createMockClipSpecDeriver({
    id = "mock-clip-spec-deriver",
    name = "Mock ClipSpec deriver",
    behavior = "success",
    errorCode = "PROVIDER_ERROR",
    response = null
} = {}) {
    async function derive(input) {
        if (behavior === "throw") throw new Error("mock ClipSpec deriver failure");
        if (behavior === "raw") return response;
        if (behavior === "fail") return { success: false, error: { code: errorCode } };
        if (behavior === "empty") return { success: true, clipSpecs: [] };
        return { success: true, clipSpecs: input.events.map(candidateFromEvent) };
    }
    return defineClipSpecDeriver({
        id,
        name,
        description: "Deterministic mock ClipSpec deriver (no network, no AI, no ranking, no scoring).",
        status: DERIVER_STATUS.AVAILABLE,
        derive
    });
}

// ==========================================================
// providers/acquisition-state.js
// Responsibility: the lightweight state of the CURRENT
// acquisition attempt, stored at state.ui.transcriptAcquisition.
// It describes an attempt; it is NEVER part of the project or
// the canonical transcript.
//
//   status     "idle" | "acquiring" | "success" | "error"
//   selection  { providerId, language, method }  what the user picked
//              (can change at any time, including after an error —
//              this is how the user switches providers)
//   attempt    null | { id, providerId, providerName, language, method,
//                       projectId, startedAt, finishedAt, error, source }
//
// All functions are pure and return new frozen objects.
// ==========================================================

import { deepFreeze } from "../model.js";
import { METHOD_PREFERENCE } from "./provider.js";

export const ACQUISITION_STATUS = Object.freeze({
    IDLE: "idle",
    ACQUIRING: "acquiring",
    SUCCESS: "success",
    ERROR: "error"
});

export function createAcquisitionState({ providerId = null, language = null, method = METHOD_PREFERENCE.ANY } = {}) {
    return deepFreeze({ status: ACQUISITION_STATUS.IDLE, selection: { providerId, language, method }, attempt: null });
}

export function withSelection(acquisition, changes) {
    return deepFreeze({ ...acquisition, selection: { ...acquisition.selection, ...changes } });
}

// Back to idle (e.g. the project changed) but keep the user's selection.
export function resetAttempt(acquisition) {
    return createAcquisitionState(acquisition.selection);
}

export function beginAttempt(acquisition, { id, providerName, projectId }) {
    const { providerId, language, method } = acquisition.selection;
    return deepFreeze({
        ...acquisition,
        status: ACQUISITION_STATUS.ACQUIRING,
        attempt: {
            id, providerId, providerName, language, method, projectId,
            startedAt: new Date().toISOString(), finishedAt: null, error: null, source: null
        }
    });
}

// Results for an attempt that is no longer current are ignored.
export function completeAttempt(acquisition, attemptId, { error = null, source = null }) {
    if (!acquisition.attempt || acquisition.attempt.id !== attemptId ||
        acquisition.status !== ACQUISITION_STATUS.ACQUIRING) return acquisition;
    return deepFreeze({
        ...acquisition,
        status: error ? ACQUISITION_STATUS.ERROR : ACQUISITION_STATUS.SUCCESS,
        attempt: { ...acquisition.attempt, finishedAt: new Date().toISOString(), error, source }
    });
}

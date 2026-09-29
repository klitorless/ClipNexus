// ==========================================================
// event-reconcilers/errors.js
// Responsibility: the ONE vocabulary of event-reconciliation
// errors. Every reconciler failure, whatever its origin,
// becomes one of these codes at the normalization boundary.
// The UI only reads { code, message, retryable } — never
// reconciler-specific error bodies.
//
// The shape and philosophy mirror the Stage 7 POI-extraction
// vocabulary (same code values, same retryable semantics);
// only the wording is reconciler-specific, so the two layers
// stay distinguishable in logs and detail views.
//
// message:   plain-language, fixed per code. Reconciler-
//            supplied messages are untrusted and
//            implementation-specific, so they are kept in
//            `detail` (console only).
// retryable: true when trying the SAME reconciler again may help.
// ==========================================================

import { deepFreeze } from "../../transcript/model.js";

const definitions = {
    PROVIDER_ERROR: { retryable: true, message: "The event reconciler reported an internal error." },
    MALFORMED_RESPONSE: { retryable: true, message: "The event reconciler returned data this app cannot read." },
    NOT_IMPLEMENTED: { retryable: false, message: "This event reconciler is not connected yet. It is a placeholder for a future stage." },
    UNKNOWN_ERROR: { retryable: true, message: "Event reconciliation failed for an unknown reason." }
};

export const EVENT_RECONCILIATION_ERROR_CODES = Object.freeze(
    Object.fromEntries(Object.keys(definitions).map((code) => [code, code]))
);

export function isEventReconciliationErrorCode(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(definitions, code);
}

/**
 * Build a standardized, frozen event-reconciliation error.
 * Unknown codes become UNKNOWN_ERROR (the original is kept in detail).
 *
 * @param {string} code
 * @param {{reconcilerId?:string|null, detail?:object}} [context]
 */
export function createEventReconciliationError(code, { reconcilerId = null, detail = {} } = {}) {
    const known = isEventReconciliationErrorCode(code);
    const finalCode = known ? code : EVENT_RECONCILIATION_ERROR_CODES.UNKNOWN_ERROR;
    const definition = definitions[finalCode];
    return deepFreeze({
        code: finalCode,
        message: definition.message,
        retryable: definition.retryable,
        reconcilerId,
        detail: known ? { ...detail } : { ...detail, originalCode: String(code) }   // developer-only
    });
}

export function createEventReconciliationFailure(code, context) {
    return deepFreeze({ success: false, error: createEventReconciliationError(code, context) });
}

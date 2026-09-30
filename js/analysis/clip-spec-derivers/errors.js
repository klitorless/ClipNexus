// ==========================================================
// clip-spec-derivers/errors.js
// Responsibility: the ONE vocabulary of ClipSpec-derivation
// errors. Every deriver failure, whatever its origin, becomes
// one of these codes at the normalization boundary. The UI
// only reads { code, message, retryable } — never
// deriver-specific error bodies.
//
// The shape and philosophy mirror the Stage 7 POI-extraction
// and Stage 8 event-reconciliation vocabularies (same code
// values, same retryable semantics); only the wording is
// deriver-specific, so the three layers stay distinguishable
// in logs and detail views.
//
// message:   plain-language, fixed per code. Deriver-
//            supplied messages are untrusted and
//            implementation-specific, so they are kept in
//            `detail` (console only).
// retryable: true when trying the SAME deriver again may help.
// ==========================================================

import { deepFreeze } from "../../transcript/model.js";

const definitions = {
    PROVIDER_ERROR: { retryable: true, message: "The ClipSpec deriver reported an internal error." },
    MALFORMED_RESPONSE: { retryable: true, message: "The ClipSpec deriver returned data this app cannot read." },
    NOT_IMPLEMENTED: { retryable: false, message: "This ClipSpec deriver is not connected yet. It is a placeholder for a future stage." },
    UNKNOWN_ERROR: { retryable: true, message: "ClipSpec derivation failed for an unknown reason." }
};

export const CLIP_SPEC_DERIVATION_ERROR_CODES = Object.freeze(
    Object.fromEntries(Object.keys(definitions).map((code) => [code, code]))
);

export function isClipSpecDerivationErrorCode(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(definitions, code);
}

/**
 * Build a standardized, frozen ClipSpec-derivation error.
 * Unknown codes become UNKNOWN_ERROR (the original is kept in detail).
 *
 * @param {string} code
 * @param {{deriverId?:string|null, detail?:object}} [context]
 */
export function createClipSpecDerivationError(code, { deriverId = null, detail = {} } = {}) {
    const known = isClipSpecDerivationErrorCode(code);
    const finalCode = known ? code : CLIP_SPEC_DERIVATION_ERROR_CODES.UNKNOWN_ERROR;
    const definition = definitions[finalCode];
    return deepFreeze({
        code: finalCode,
        message: definition.message,
        retryable: definition.retryable,
        deriverId,
        detail: known ? { ...detail } : { ...detail, originalCode: String(code) }   // developer-only
    });
}

export function createClipSpecDerivationFailure(code, context) {
    return deepFreeze({ success: false, error: createClipSpecDerivationError(code, context) });
}

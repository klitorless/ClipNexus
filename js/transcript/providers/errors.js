// ==========================================================
// providers/errors.js
// Responsibility: the ONE vocabulary of transcript-acquisition
// errors. Every provider failure, whatever its origin, becomes
// one of these codes at the provider boundary. The UI only
// reads { code, message, retryable } — never provider-specific
// error bodies.
//
// message:   plain-language, fixed per code. Provider-supplied
//            messages are untrusted and implementation-specific,
//            so they are kept in `detail` (console only).
// retryable: true when trying the SAME provider again may help.
//            Switching providers is always offered regardless.
// ==========================================================

import { deepFreeze } from "../model.js";

const definitions = {
    // --- Standard provider outcomes ---
    PROVIDER_UNAVAILABLE: { retryable: true, message: "The transcript provider is not reachable right now." },
    AUTHENTICATION_FAILED: { retryable: false, message: "The transcript provider rejected the credentials." },
    RATE_LIMITED: { retryable: true, message: "The transcript provider has temporarily limited requests." },
    VIDEO_UNAVAILABLE: { retryable: false, message: "The provider could not access this video (it may be private, removed, or region-locked)." },
    TRANSCRIPT_UNAVAILABLE: { retryable: false, message: "This provider has no transcript for this video." },
    LANGUAGE_UNAVAILABLE: { retryable: false, message: "No transcript is available in the requested language from this provider." },
    TRANSCRIPT_EMPTY: { retryable: false, message: "The provider returned an empty transcript." },
    PROVIDER_TIMEOUT: { retryable: true, message: "The transcript provider took too long to respond." },
    PROVIDER_ERROR: { retryable: true, message: "The transcript provider reported an internal error." },
    MALFORMED_RESPONSE: { retryable: true, message: "The transcript provider returned data this app cannot read." },
    NOT_IMPLEMENTED: { retryable: false, message: "This provider is not connected yet. It is a placeholder for a future stage." },
    UNKNOWN_ERROR: { retryable: true, message: "The transcript could not be retrieved for an unknown reason." },

    // --- Application-side request checks (raised before a provider is called) ---
    PROVIDER_NOT_FOUND: { retryable: false, message: "The selected transcript provider does not exist." },
    PROVIDER_DISABLED: { retryable: false, message: "The selected transcript provider is disabled." },
    UNSUPPORTED_VIDEO: { retryable: false, message: "This provider does not support videos from this platform." },
    UNSUPPORTED_OPTION: { retryable: false, message: "This provider does not support the selected language or acquisition option." },
    INVALID_REQUEST: { retryable: false, message: "The transcript request was incomplete. Link a video first." }
};

export const ACQUISITION_ERROR_CODES = Object.freeze(
    Object.fromEntries(Object.keys(definitions).map((code) => [code, code]))
);

export function isAcquisitionErrorCode(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(definitions, code);
}

/**
 * Build a standardized, frozen acquisition error.
 * Unknown codes become UNKNOWN_ERROR (the original is kept in detail).
 *
 * @param {string} code
 * @param {{providerId?:string|null, detail?:object}} [context]
 */
export function createAcquisitionError(code, { providerId = null, detail = {} } = {}) {
    const known = isAcquisitionErrorCode(code);
    const finalCode = known ? code : ACQUISITION_ERROR_CODES.UNKNOWN_ERROR;
    const definition = definitions[finalCode];
    return deepFreeze({
        code: finalCode,
        message: definition.message,
        retryable: definition.retryable,
        providerId,
        detail: known ? { ...detail } : { ...detail, originalCode: String(code) }   // developer-only
    });
}

export function createAcquisitionFailure(code, context) {
    return deepFreeze({ success: false, error: createAcquisitionError(code, context) });
}

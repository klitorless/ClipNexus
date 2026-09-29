// ==========================================================
// poi-providers/errors.js
// Responsibility: the ONE vocabulary of POI-extraction
// errors. Every provider failure, whatever its origin, becomes
// one of these codes at the normalization boundary. The UI
// only reads { code, message, retryable } — never
// provider-specific error bodies.
//
// message:   plain-language, fixed per code. Provider-supplied
//            messages are untrusted and implementation-specific,
//            so they are kept in `detail` (console only).
// retryable: true when trying the SAME provider again may help.
// ==========================================================

import { deepFreeze } from "../../transcript/model.js";

const definitions = {
    PROVIDER_ERROR: { retryable: true, message: "The POI provider reported an internal error." },
    MALFORMED_RESPONSE: { retryable: true, message: "The POI provider returned data this app cannot read." },
    NOT_IMPLEMENTED: { retryable: false, message: "This POI provider is not connected yet. It is a placeholder for a future stage." },
    UNKNOWN_ERROR: { retryable: true, message: "POI extraction failed for an unknown reason." }
};

export const POI_EXTRACTION_ERROR_CODES = Object.freeze(
    Object.fromEntries(Object.keys(definitions).map((code) => [code, code]))
);

export function isPoiExtractionErrorCode(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(definitions, code);
}

/**
 * Build a standardized, frozen POI extraction error.
 * Unknown codes become UNKNOWN_ERROR (the original is kept in detail).
 *
 * @param {string} code
 * @param {{providerId?:string|null, detail?:object}} [context]
 */
export function createPoiExtractionError(code, { providerId = null, detail = {} } = {}) {
    const known = isPoiExtractionErrorCode(code);
    const finalCode = known ? code : POI_EXTRACTION_ERROR_CODES.UNKNOWN_ERROR;
    const definition = definitions[finalCode];
    return deepFreeze({
        code: finalCode,
        message: definition.message,
        retryable: definition.retryable,
        providerId,
        detail: known ? { ...detail } : { ...detail, originalCode: String(code) }   // developer-only
    });
}

export function createPoiExtractionFailure(code, context) {
    return deepFreeze({ success: false, error: createPoiExtractionError(code, context) });
}

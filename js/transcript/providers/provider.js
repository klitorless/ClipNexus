// ==========================================================
// providers/provider.js
// Responsibility: the PROVIDER CONTRACT and the normalization
// boundary. Nothing outside js/transcript/providers/adapters/
// ever sees a provider-specific response.
//
// ---- What an adapter module defines (via defineProvider) ----
//   id, name, description        strings
//   status                       "available" | "not_implemented"
//   enabled                      boolean (false = listed, not selectable)
//   capabilities                 see createCapabilities()
//   credential                   null | { label, hint }  (Stage 2B, optional)
//                                The user must supply a credential (e.g. an
//                                API key) before this provider can run. Only
//                                the descriptor lives here — values are held
//                                in memory by credentials.js, never here.
//   getTranscript(video, options) → Promise<AdapterResponse>
//       video:   { platform, videoId, canonicalUrl }   (normalized, frozen;
//                never the raw user URL — adapters do not resolve URLs)
//       options: { language: string|null, method: "any"|"native"|"generated" }
//
// ---- AdapterResponse (what an adapter returns) ----
//   { success: true,
//     transcript: { rawText: string, format: "txt"|"srt"|"vtt"|"json" },
//     source: { method: "native"|"generated"|"unknown",
//               language: string|null, sourceId: string|null } }
//   { success: false, error: { code: <ACQUISITION_ERROR_CODES>, detail?: {} } }
//
//   rawText must carry the transcript text exactly as delivered, in a
//   format the app's parser registry supports. An adapter MAY re-envelope
//   a provider's structured response into a supported format (Stage 2B:
//   Supadata chunks → the generic JSON record shape), but must copy text
//   and timing values verbatim — never clean, merge, or re-time them.
//   Anything else (extra fields, raw response bodies) is dropped here.
//
// ---- AcquisitionResult (what the rest of the app sees) ----
//   see normalizeAdapterResponse() below.
// ==========================================================

import { getFormatById } from "../formats.js";
import { deepFreeze, ACQUISITION_METHOD, generatedFromMethod } from "../model.js";
import { isValidLanguageCode } from "../languages.js";
import { createAcquisitionFailure, isAcquisitionErrorCode, ACQUISITION_ERROR_CODES } from "./errors.js";

export const PROVIDER_STATUS = Object.freeze({
    AVAILABLE: "available",
    NOT_IMPLEMENTED: "not_implemented"
});

// What the user asks for. "any" = accept native or generated.
export const METHOD_PREFERENCE = Object.freeze({
    ANY: "any",
    NATIVE: "native",
    GENERATED: "generated"
});

export const METHOD_PREFERENCE_OPTIONS = Object.freeze([
    Object.freeze({ value: METHOD_PREFERENCE.ANY, label: "Automatic (native or generated)" }),
    Object.freeze({ value: METHOD_PREFERENCE.NATIVE, label: "Native captions only" }),
    Object.freeze({ value: METHOD_PREFERENCE.GENERATED, label: "Generated transcript only" })
]);

/**
 * Explicit capabilities. Nothing is assumed: an omitted flag is false.
 *   platforms            video platforms accepted, e.g. ["youtube"]
 *   nativeCaptions       can return captions published with the video
 *   generatedTranscript  can return machine-generated transcripts
 *   languageSelection    honours options.language
 */
export function createCapabilities({ platforms = [], nativeCaptions = false,
    generatedTranscript = false, languageSelection = false } = {}) {
    return deepFreeze({
        platforms: [...platforms],
        nativeCaptions: nativeCaptions === true,
        generatedTranscript: generatedTranscript === true,
        languageSelection: languageSelection === true
    });
}

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

export function isValidProvider(provider) {
    return Boolean(provider) &&
        nonEmptyString(provider.id) && /^[a-z0-9-]+$/.test(provider.id) &&
        nonEmptyString(provider.name) &&
        typeof provider.description === "string" &&
        Object.values(PROVIDER_STATUS).includes(provider.status) &&
        typeof provider.enabled === "boolean" &&
        provider.capabilities && Array.isArray(provider.capabilities.platforms) &&
        typeof provider.getTranscript === "function";
}

function createCredentialDescriptor(credential) {
    if (!credential) return null;
    return Object.freeze({
        label: nonEmptyString(credential.label) ? credential.label : "API key",
        hint: typeof credential.hint === "string" ? credential.hint : ""
    });
}

/** Adapters call this so every provider has the same frozen shape. */
export function defineProvider({ id, name, description = "", status, enabled = true, capabilities,
    credential = null, getTranscript }) {
    return Object.freeze({
        id, name, description, status, enabled,
        capabilities: createCapabilities(capabilities),
        credential: createCredentialDescriptor(credential),
        getTranscript
    });
}

// UI-safe view of a provider: data only, no functions.
export function describeProvider(provider) {
    return deepFreeze({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        status: provider.status,
        enabled: provider.enabled,
        capabilities: provider.capabilities,
        credential: provider.credential ?? null        // descriptor only — never a value
    });
}

// Only identity crosses into an adapter — no raw URL, hint, or metadata.
export function createProviderVideo(video) {
    const { platform, videoId, canonicalUrl } = video.identity;
    return Object.freeze({ platform, videoId, canonicalUrl });
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Turn anything an adapter returned into an AcquisitionResult.
 *
 *   { success: true,
 *     source: { providerId, providerName, method, generated, language,
 *               requestedLanguage, requestedMethod, retrievedAt, sourceId,
 *               video: { platform, videoId } },
 *     payload: { rawText, format } }
 *   { success: false, error: { code, message, retryable, providerId, detail } }
 *
 * providerId/providerName come from the registry entry, never from
 * the response, so an adapter cannot misattribute a transcript.
 */
export function normalizeAdapterResponse(response, { provider, video, options, retrievedAt }) {
    const context = (detail) => ({ providerId: provider.id, detail });

    if (!isPlainObject(response) || typeof response.success !== "boolean") {
        return createAcquisitionFailure(ACQUISITION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "response is not an AdapterResponse" }));
    }

    if (response.success === false) {
        const error = isPlainObject(response.error) ? response.error : {};
        const code = isAcquisitionErrorCode(error.code) ? error.code : ACQUISITION_ERROR_CODES.UNKNOWN_ERROR;
        const detail = { ...(isPlainObject(error.detail) ? error.detail : {}) };
        if (!isAcquisitionErrorCode(error.code)) detail.originalCode = String(error.code);
        return createAcquisitionFailure(code, context(detail));
    }

    const transcript = isPlainObject(response.transcript) ? response.transcript : null;
    if (!transcript || typeof transcript.rawText !== "string") {
        return createAcquisitionFailure(ACQUISITION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "missing transcript.rawText" }));
    }
    if (!getFormatById(transcript.format)) {
        return createAcquisitionFailure(ACQUISITION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "unsupported transcript.format", format: String(transcript.format) }));
    }
    if (transcript.rawText.trim().length === 0) {
        return createAcquisitionFailure(ACQUISITION_ERROR_CODES.TRANSCRIPT_EMPTY, context({}));
    }

    const source = isPlainObject(response.source) ? response.source : {};
    const method = Object.values(ACQUISITION_METHOD).includes(source.method)
        ? source.method : ACQUISITION_METHOD.UNKNOWN;
    const language = isValidLanguageCode(source.language) ? source.language : null;
    const sourceId = typeof source.sourceId === "string" && source.sourceId.length <= 200 ? source.sourceId : null;

    return deepFreeze({
        success: true,
        source: {
            providerId: provider.id,
            providerName: provider.name,
            method,
            generated: generatedFromMethod(method),
            language,
            requestedLanguage: options.language,
            requestedMethod: options.method,
            retrievedAt,
            sourceId,
            video: { platform: video.platform, videoId: video.videoId }
        },
        payload: { rawText: transcript.rawText, format: transcript.format }
    });
}

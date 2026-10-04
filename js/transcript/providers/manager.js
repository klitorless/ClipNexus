// ==========================================================
// providers/manager.js
// Responsibility: the TRANSCRIPT PROVIDER MANAGER. Runs ONE
// attempt against ONE provider the caller chose:
//
//   normalized VIDEO + providerId + options
//        ↓  request checks (provider exists, enabled, supports it)
//   adapter.getTranscript(video, options)   (with timeout)
//        ↓  normalizeAdapterResponse()
//   AcquisitionResult
//
// MANUAL SWITCHING ONLY: the manager never tries a second
// provider. On failure the caller (the user) picks the next one,
// so provenance always names the provider that actually supplied
// the transcript.
//
// The manager never touches application state. Applying a result
// to a project is a separate pure step: applyAcquisitionToProject().
// ==========================================================

import { withTranscript } from "../../core/project.js";
import { isSameVideo } from "../../video/video-model.js";
import { isValidLanguageCode } from "../languages.js";
import { normalizeAdapterResponse, createProviderVideo, METHOD_PREFERENCE } from "./provider.js";
import { createAcquisitionError, createAcquisitionFailure, ACQUISITION_ERROR_CODES as CODES } from "./errors.js";

export const DEFAULT_TIMEOUT_MS = 30000;

// Returns null when fine, or an error code.
function checkRequest(provider, video, options) {
    if (!provider.capabilities.platforms.includes(video.identity.platform)) return CODES.UNSUPPORTED_VIDEO;
    if (options.language !== null && !isValidLanguageCode(options.language)) return CODES.INVALID_REQUEST;
    if (!Object.values(METHOD_PREFERENCE).includes(options.method)) return CODES.INVALID_REQUEST;

    const { capabilities } = provider;
    if (options.language !== null && !capabilities.languageSelection) return CODES.UNSUPPORTED_OPTION;
    if (options.method === METHOD_PREFERENCE.NATIVE && !capabilities.nativeCaptions) return CODES.UNSUPPORTED_OPTION;
    if (options.method === METHOD_PREFERENCE.GENERATED && !capabilities.generatedTranscript) return CODES.UNSUPPORTED_OPTION;
    return null;
}

function withTimeout(promise, timeoutMs) {
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    return Promise.race([promise.then((value) => ({ value })), timeout])
        .finally(() => clearTimeout(timer));
}

/**
 * @param {object} request
 * @param {object} request.registry     from registry.js
 * @param {string} request.providerId
 * @param {object|null} request.video   project.video (Stage 1.6 Video)
 * @param {{language?:string|null, method?:string}} [request.options]
 * @param {number} [request.timeoutMs]
 * @returns {Promise<object>} frozen AcquisitionResult
 */
export async function acquireTranscript({ registry, providerId, video, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const found = registry.getSelectable(providerId);
    if (!found.success) return Object.freeze({ success: false, error: found.error });
    const { provider } = found;

    if (!video || !video.identity) {
        return createAcquisitionFailure(CODES.INVALID_REQUEST, { providerId, detail: { reason: "no video" } });
    }

    const request = Object.freeze({
        language: options.language ?? null,
        method: options.method ?? METHOD_PREFERENCE.ANY,
        // Optional progress callback for queue-backed providers
        // (e.g. youtube-native caption jobs). Not validated;
        // providers that do not understand it ignore it.
        onCaptionJobUpdate: options.onCaptionJobUpdate ?? null
    });
    const problem = checkRequest(provider, video, request);
    if (problem) return createAcquisitionFailure(problem, { providerId });

    const providerVideo = createProviderVideo(video);
    let outcome;
    try {
        outcome = await withTimeout(Promise.resolve().then(() => provider.getTranscript(providerVideo, request)), timeoutMs);
    } catch (cause) {
        return createAcquisitionFailure(CODES.PROVIDER_ERROR,
            { providerId, detail: { reason: cause && cause.message ? cause.message : String(cause) } });
    }
    if (outcome.timedOut) {
        return createAcquisitionFailure(CODES.PROVIDER_TIMEOUT, { providerId, detail: { timeoutMs } });
    }

    return normalizeAdapterResponse(outcome.value, {
        provider, video: providerVideo, options: request, retrievedAt: new Date().toISOString()
    });
}

/**
 * Try several providers in order and return the first success.
 * Unlike acquireTranscript (manual switching only), this is the
 * AUTOMATIC path: the Dashboard tries the no-key provider first
 * and falls back to the authenticated one. Provenance still names
 * the provider that actually supplied the transcript, because
 * each attempt is normalized independently.
 *
 * When every provider fails, the most recent failure from a provider
 * that actually ATTEMPTED the request is returned, annotated with
 * detail.attemptedProviders. A provider that fails only for lack of
 * a credential (CREDENTIAL_REQUIRED, raised before any network
 * request) never hides such a meaningful failure; the providers
 * that needed a key are listed in
 * detail.credentialRequiredProviders instead. When no provider
 * attempted (e.g. every provider needed a key), the last error is
 * returned as before. Nothing is retried and no state is touched
 * here; applying a result to a project stays with
 * applyAcquisitionToProject().
 *
 * @param {object} request
 * @param {object} request.registry     from registry.js
 * @param {string[]} request.providerIds  tried in order
 * @param {object|null} request.video   project.video (Stage 1.6 Video)
 * @param {{language?:string|null, method?:string}} [request.options]
 * @param {number} [request.timeoutMs]
 * @returns {Promise<object>} frozen AcquisitionResult
 */
export async function acquireTranscriptWithFallback({ registry, providerIds, video, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const ids = Array.isArray(providerIds) ? providerIds.filter((id) => typeof id === "string") : [];
    if (ids.length === 0) {
        return createAcquisitionFailure(CODES.INVALID_REQUEST,
            { providerId: null, detail: { reason: "no providers to try" } });
    }
    let last = null;
    let lastAttempted = null;      // most recent failure from a provider that actually tried
    const credentialRequired = []; // providers that failed only for lack of a credential
    for (const providerId of ids) {
        const result = await acquireTranscript({ registry, providerId, video, options, timeoutMs });
        if (result.success) return result;
        last = result;
        // CREDENTIAL_REQUIRED is raised before any network request, so a
        // provider failing only for a missing key must not hide the
        // meaningful failure of a provider that actually attempted.
        if (result.error && result.error.code === CODES.CREDENTIAL_REQUIRED) {
            credentialRequired.push(providerId);
        } else {
            lastAttempted = result;
        }
        // A missing video fails every provider the same way; stop early.
        if (result.error && result.error.code === CODES.INVALID_REQUEST) break;
    }
    const chosen = lastAttempted || last;
    const error = chosen.error;
    return createAcquisitionFailure(error.code, {
        providerId: error.providerId,
        detail: {
            ...error.detail,
            attemptedProviders: [...ids],
            ...(credentialRequired.length > 0 ? { credentialRequiredProviders: [...credentialRequired] } : {})
        }
    });
}

/**
 * Pure: decide the project after an attempt.
 *   failure            → the SAME project object (transcript untouched)
 *   result for a different video than the project's → unchanged + error
 *   success            → new project with the acquired transcript
 *                        (alignment reset to unverified by withTranscript)
 *
 * @param {object} project
 * @param {object} result          AcquisitionResult
 * @param {(result:object) => object} buildDocument   e.g. pipeline.buildAcquiredTranscript
 * @returns {{project:object, error:object|null}}
 */
export function applyAcquisitionToProject(project, result, buildDocument) {
    if (!result.success) return { project, error: result.error };

    const providerId = result.source.providerId;
    const target = { identity: result.source.video };
    if (!project || !project.video || !isSameVideo(project.video, target)) {
        return { project, error: createAcquisitionError(CODES.INVALID_REQUEST,
            { providerId, detail: { reason: "result is for a different video than the project" } }) };
    }

    let document;
    try {
        document = buildDocument(result);
    } catch (cause) {
        return { project, error: createAcquisitionError(CODES.MALFORMED_RESPONSE,
            { providerId, detail: { reason: cause && cause.message ? cause.message : String(cause) } }) };
    }
    return { project: withTranscript(project, document), error: null };
}

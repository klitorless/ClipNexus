// ==========================================================
// adapters/youtube-native.js
// Responsibility: retrieve a YouTube video's EXISTING caption
// track through the ClipNexus caption service — a small
// Cloudflare Worker that reads YouTube's caption tracks
// server-side and returns them as WebVTT. No API key, no third
// party transcript vendor, no backend database. EVERYTHING about
// the caption service (its URL, request shape, response and
// error contract) stays in this file and is returned as an
// AdapterResponse (see ../provider.js).
//
// Mechanism: GET {YOUTUBE_CAPTION_SERVICE_URL}?v=VIDEO_ID and
// hand the returned WebVTT to the app's existing VTT parser
// verbatim — timestamps, ordering, and text are YouTube's,
// untouched. The service answers 200 text/vtt on success, with
// X-Caption-Language and X-Caption-Generated headers describing
// the track it chose; anything else is a structured JSON error
// ({ "error": { "type", "message" } }) which this adapter maps
// into the standard acquisition vocabulary.
//
// The provider stays behind the provider interface, so the
// service can be replaced later (production Worker, VPS, …)
// without touching TranscriptDocument consumers — only
// YOUTUBE_CAPTION_SERVICE_URL changes.
//
// KNOWN LIMITATION (documented, not hidden): the caption
// service picks the track itself (manual captions preferred,
// auto-generated accepted); a requested language or method can
// therefore only be HONORED when the service happens to return
// a matching track. The ACTUAL language and method are always
// reported in provenance — never claimed. An explicit
// method request ("native" or "generated") that the returned
// track does not satisfy fails with TRANSCRIPT_UNAVAILABLE so
// the fallback chain can try the next provider.
//
// SECURITY
//   - The service URL is PUBLIC frontend configuration, not a
//     secret: it carries no credential and nothing is hardcoded
//     beyond the URL itself. It is never written to localStorage,
//     sessionStorage, project state, transcript data, or the
//     Supadata key store.
//   - The request carries only the 11-character video id (which
//     is validated before sending) — never transcript content,
//     never credentials.
//   - The service's error text is never kept; only its short
//     error type and the HTTP status, in console-only detail.
// ==========================================================

import { defineProvider, PROVIDER_STATUS, METHOD_PREFERENCE } from "../provider.js";
import { ACQUISITION_ERROR_CODES as CODES } from "../errors.js";

export const YOUTUBE_NATIVE_ID = "youtube-native";

// The caption service endpoint. Public, not a secret — see the
// header note. This is the ONE place the URL lives; pass
// `captionServiceUrl` to the factory to point at a different
// deployment (e.g. a production Worker) without touching the
// rest of the app.
export const YOUTUBE_CAPTION_SERVICE_URL =
    "https://clipnexus-youtube-caption-test.klitorless.workers.dev/youtube-transcript";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const fail = (code, detail = {}) => ({ success: false, error: { code, detail } });

// The service's structured error types → the standard vocabulary.
// A "no transcript available" answer stays distinguishable from
// a generic network failure: the provider manager needs that
// distinction to decide whether to try the next provider.
function codeForWorkerErrorType(type) {
    switch (type) {
        case "invalid-video-id": return CODES.INVALID_REQUEST;
        case "transcript-unavailable":
        case "track-unavailable": return CODES.TRANSCRIPT_UNAVAILABLE;
        case "rate-limited": return CODES.RATE_LIMITED;
        case "timeout": return CODES.PROVIDER_TIMEOUT;
        case "retrieval-failure": return CODES.PROVIDER_UNAVAILABLE;
        case "malformed-response": return CODES.MALFORMED_RESPONSE;
        case "not-found": return CODES.PROVIDER_ERROR;
        default: return null;   // unknown type → fall back to the HTTP status
    }
}

function codeForHttpStatus(status) {
    if (status === 429) return CODES.RATE_LIMITED;
    if (status === 404) return CODES.TRANSCRIPT_UNAVAILABLE;
    if (status === 408 || status === 504) return CODES.PROVIDER_TIMEOUT;
    if (status >= 500) return CODES.PROVIDER_UNAVAILABLE;
    return CODES.PROVIDER_ERROR;
}

const DEFAULTS = Object.freeze({
    requestDeadlineMs: 25000   // below the manager's 30 s timeout
});

function looksLikeVtt(text) {
    return text.replace(/^\uFEFF/, "").trimStart().slice(0, 6) === "WEBVTT";
}

function headerValue(headers, name) {
    if (!headers || typeof headers.get !== "function") return null;
    const value = headers.get(name);
    return typeof value === "string" && value.length > 0 ? value : null;
}

// The service's { error: { type, message } } body → its type, or
// null when the body is not that shape. The human-readable
// message is untrusted service text and is never kept.
function workerErrorType(text) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { return null; }
    const error = parsed && typeof parsed === "object" ? parsed.error : null;
    const type = error && typeof error === "object" ? error.type : null;
    return typeof type === "string" && type.length > 0 ? type : null;
}

/**
 * Factory so tests can inject fetch, time, and the service URL.
 * @param {object} deps
 * @param {(url:string, init:object) => Promise<Response>} [deps.fetchImpl]
 * @param {number} [deps.requestDeadlineMs]
 * @param {string} [deps.captionServiceUrl]
 */
export function createYouTubeNativeProvider({ fetchImpl, requestDeadlineMs, captionServiceUrl } = {}) {
    const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
    const deadlineMs = requestDeadlineMs ?? DEFAULTS.requestDeadlineMs;
    const serviceUrl = captionServiceUrl || YOUTUBE_CAPTION_SERVICE_URL;

    async function getTranscript(video, options = {}) {
        if (!video || video.platform !== "youtube") return fail(CODES.UNSUPPORTED_VIDEO, {});
        if (!video.videoId || !VIDEO_ID_PATTERN.test(video.videoId)) {
            return fail(CODES.INVALID_REQUEST, { reason: "video has no valid YouTube id" });
        }

        const requestUrl = `${serviceUrl}?v=${encodeURIComponent(video.videoId)}`;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), deadlineMs) : null;
        try {
            let response;
            try {
                response = await doFetch(requestUrl, {
                    method: "GET",
                    headers: { "Accept": "text/vtt" },
                    credentials: "omit",
                    referrerPolicy: "no-referrer",
                    cache: "no-store",
                    signal: controller ? controller.signal : undefined
                });
            } catch (cause) {
                if (cause && cause.name === "AbortError") {
                    return fail(CODES.PROVIDER_TIMEOUT, { deadlineMs, step: "caption-service" });
                }
                // Offline, DNS, TLS, or CORS failure: the browser hides which.
                return fail(CODES.PROVIDER_UNAVAILABLE,
                    { reason: "network request failed", step: "caption-service" });
            }

            let body;
            try {
                body = await response.text();
            } catch {
                return fail(CODES.PROVIDER_UNAVAILABLE,
                    { reason: "response body unreadable", httpStatus: response.status, step: "caption-service" });
            }

            const step = "caption-service";
            if (response.status === 200) {
                if (!looksLikeVtt(body)) {
                    return fail(CODES.MALFORMED_RESPONSE,
                        { reason: "caption service did not return WebVTT", httpStatus: 200, step });
                }
                if (!/-->/.test(body)) return fail(CODES.TRANSCRIPT_EMPTY, { step });

                const generatedHeader = headerValue(response.headers, "X-Caption-Generated");
                const method = generatedHeader === "true" ? "generated"
                    : generatedHeader === "false" ? "native" : "unknown";
                // The service picks the track; an explicit method
                // request can only be honored, never faked.
                if (options.method === METHOD_PREFERENCE.NATIVE && method === "generated") {
                    return fail(CODES.TRANSCRIPT_UNAVAILABLE,
                        { reason: "the caption service returned only auto-generated captions", step });
                }
                if (options.method === METHOD_PREFERENCE.GENERATED && method === "native") {
                    return fail(CODES.TRANSCRIPT_UNAVAILABLE,
                        { reason: "the caption service returned only native captions", step });
                }

                const mechanism = headerValue(response.headers, "X-Caption-Source");
                return {
                    success: true,
                    transcript: { rawText: body, format: "vtt" },
                    source: {
                        method,
                        language: headerValue(response.headers, "X-Caption-Language"),
                        sourceId: mechanism ? `caption-service:${mechanism}` : "caption-service"
                    }
                };
            }

            const type = workerErrorType(body);
            const code = (type && codeForWorkerErrorType(type)) || codeForHttpStatus(response.status);
            return fail(code, {
                ...(type ? { workerErrorType: type } : {}),
                httpStatus: response.status,
                step
            });
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    return defineProvider({
        id: YOUTUBE_NATIVE_ID,
        name: "YouTube native captions",
        description: "Fetches the video's existing YouTube captions through the ClipNexus caption service — " +
            "no API key needed. Works when the video has captions; otherwise the app falls back to the next provider.",
        status: PROVIDER_STATUS.AVAILABLE,
        enabled: true,
        capabilities: {
            platforms: ["youtube"],
            nativeCaptions: true,
            generatedTranscript: true,
            languageSelection: true
        },
        getTranscript
    });
}

// The app's instance: real fetch, no credential, the configured service.
export const provider = createYouTubeNativeProvider();

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
import {
    enqueueCaptionJob,
    getCaptionJob,
    fetchCaptionJobResult,
    captionJobsBaseUrl,
    isTerminalJobStatus,
    CAPTION_JOB_STATUS
} from "../../caption-jobs.js";
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
    requestDeadlineMs: 25000,  // below the manager's 30 s timeout
    // Queue polling is conservative: once a job is accepted
    // (HTTP 202) it is polled until it completes, fails, or a
    // long abandonment deadline is reached. The job is never
    // abandoned merely because it outlasts the old synchronous
    // timeouts — acceptance is the point of no return.
    queuePollIntervalMs: 5000,
    queueAbandonAfterMs: 300000, // 5 minutes: the client-side abandonment condition
    // Extra grace after a job's 10-minute fair-use slot opens,
    // so slot-waiting jobs are never abandoned early.
    queueSlotSlackMs: 180000
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function looksLikeVtt(text) {
    return text.replace(/^\uFEFF/, "").trimStart().slice(0, 6) === "WEBVTT";
}

function headerValue(headers, name) {
    if (!headers || typeof headers.get !== "function") return null;
    const value = headers.get(name);
    return typeof value === "string" && value.length > 0 ? value : null;
}

// The service may also report the video's title (percent-encoded
// UTF-8 in X-Video-Title, since HTTP headers are Latin-1). Decodes
// to a usable string, or null when absent/unusable.
function decodeVideoTitle(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    try {
        const decoded = decodeURIComponent(value);
        return decoded.trim().length > 0 ? decoded : null;
    } catch {
        return null;
    }
}

// The service may also report the video's duration in whole seconds
// (X-Video-Duration). Returns the integer, or null when absent or
// not a non-negative integer.
function decodeVideoDuration(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    if (!/^\d+$/.test(value.trim())) return null;
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
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
 * @param {number} [deps.queuePollIntervalMs]
 * @param {number} [deps.queueAbandonAfterMs]
 * @param {number} [deps.queueSlotSlackMs]
 * @param {boolean} [deps.useCaptionQueue] — use the Worker's async
 *   caption queue (with synchronous fallback when the Worker has
 *   no queue configured). Default false: the direct endpoint,
 *   byte-identical to the historical behavior.
 * @param {string} [deps.captionServiceUrl]
 */
export function createYouTubeNativeProvider({ fetchImpl, requestDeadlineMs, queuePollIntervalMs, queueAbandonAfterMs, queueSlotSlackMs, useCaptionQueue = false, captionServiceUrl } = {}) {
    const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
    const deadlineMs = requestDeadlineMs ?? DEFAULTS.requestDeadlineMs;
    const pollIntervalMs = queuePollIntervalMs ?? DEFAULTS.queuePollIntervalMs;
    const abandonAfterMs = queueAbandonAfterMs ?? DEFAULTS.queueAbandonAfterMs;
    const slotSlackMs = queueSlotSlackMs ?? DEFAULTS.queueSlotSlackMs;
    const serviceUrl = captionServiceUrl || YOUTUBE_CAPTION_SERVICE_URL;

    // Shared success builder for both retrieval paths: the
    // WebVTT body plus the service's X-Caption-* provenance
    // headers (direct path) or the job result metadata (queue
    // path) — same AdapterResponse shape either way.
    function buildSuccess(body, getHeader, options, step) {
        if (!looksLikeVtt(body)) {
            return fail(CODES.MALFORMED_RESPONSE,
                { reason: "caption service did not return WebVTT", httpStatus: 200, step });
        }
        if (!/-->/.test(body)) return fail(CODES.TRANSCRIPT_EMPTY, { step });

        const generatedHeader = getHeader("X-Caption-Generated");
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

        const mechanism = getHeader("X-Caption-Source");
        return {
            success: true,
            transcript: { rawText: body, format: "vtt" },
            videoTitle: decodeVideoTitle(getHeader("X-Video-Title")),
            videoDurationSeconds: decodeVideoDuration(getHeader("X-Video-Duration")),
            source: {
                method,
                language: getHeader("X-Caption-Language"),
                sourceId: mechanism ? `caption-service:${mechanism}` : "caption-service"
            }
        };
    }

    // The original synchronous retrieval: GET the Worker
    // endpoint and read WebVTT directly. Kept as the fallback
    // when the Worker has no queue configured.
    async function fetchDirect(videoId, options) {
        const requestUrl = `${serviceUrl}?v=${encodeURIComponent(videoId)}`;
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
                return buildSuccess(body, (name) => headerValue(response.headers, name), options, step);
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

    // Queue retrieval: enqueue, poll the job status gently,
    // then fetch the completed result. Reports progress via
    // options.onCaptionJobUpdate when provided. Returns
    // { fallback: true } when the Worker has no queue
    // configured so the caller can use the direct endpoint.
    async function fetchViaQueue(videoId, options) {
        const notify = typeof options.onCaptionJobUpdate === "function"
            ? options.onCaptionJobUpdate : null;
        const baseUrl = captionJobsBaseUrl(serviceUrl);
        const step = "caption-queue";

        const enqueued = await enqueueCaptionJob({ baseUrl, videoId, fetchImpl: doFetch });
        if (!enqueued.ok) {
            if (enqueued.notConfigured) return { fallback: true };
            const code = enqueued.error.type === "queue-full"
                ? CODES.RATE_LIMITED : CODES.PROVIDER_UNAVAILABLE;
            return fail(code, {
                ...(enqueued.error.type ? { workerErrorType: enqueued.error.type } : {}),
                step
            });
        }

        const jobId = enqueued.job.id;
        const snapshot = (job, phase) => ({
            phase,
            jobId,
            status: job.status,
            positionApproximate: job.positionApproximate ?? null,
            backlog: job.backlog ?? null,
            estimatedWaitSeconds: job.estimatedWaitSeconds ?? null,
            notBefore: job.notBefore ?? null,
            slotWaitSeconds: job.slotWaitSeconds ?? null
        });
        if (notify) notify(snapshot(enqueued.job, "queued"));

        // Point of no return: the job was accepted (HTTP 202).
        // Poll until it completes, fails terminally, or the
        // client-side abandonment deadline is reached. The
        // deadline stretches past the job's 10-minute fair-use
        // slot, so slot-waiting jobs are never abandoned early.
        // NEVER fall back to the synchronous endpoint here —
        // the job exists server-side and abandoning it would
        // strand it.
        const slotOpensAt = typeof enqueued.job.notBefore === "number" ? enqueued.job.notBefore : 0;
        const abandonAt = Math.max(Date.now() + abandonAfterMs, slotOpensAt + slotSlackMs);
        let last = enqueued.job;
        while (Date.now() < abandonAt) {
            await sleep(pollIntervalMs);
            const checked = await getCaptionJob({ baseUrl, jobId, fetchImpl: doFetch });
            if (!checked.ok) continue; // transient read failure: keep polling
            last = checked.job;
            if (isTerminalJobStatus(last.status)) break;
            if (notify) notify(snapshot(last, last.status));
        }

        if (!isTerminalJobStatus(last.status)) {
            if (notify) notify(snapshot(last, "abandoned"));
            return fail(CODES.PROVIDER_TIMEOUT, {
                reason: "queue-abandoned",
                jobId,
                deadlineMs: abandonAfterMs,
                step
            });
        }
        if (last.status === CAPTION_JOB_STATUS.FAILED) {
            const type = last.error && last.error.type;
            const code = (type && codeForWorkerErrorType(type)) || CODES.PROVIDER_UNAVAILABLE;
            if (notify) notify(snapshot(last, "failed"));
            return fail(code, { ...(type ? { workerErrorType: type } : {}), step });
        }
        if (notify) notify(snapshot(last, "completed"));
        const result = await fetchCaptionJobResult({ baseUrl, jobId, fetchImpl: doFetch });
        if (!result.ok) {
            return fail(CODES.PROVIDER_UNAVAILABLE, { reason: "job result unreadable", step });
        }
        // The job-result metadata uses short keys; buildSuccess
        // reads X-Caption-* header names, so translate here.
        const headerFor = (name) => {
            switch (name) {
                case "X-Caption-Generated": return result.meta.generated;
                case "X-Caption-Source": return result.meta.source;
                case "X-Caption-Language": return result.meta.language;
                case "X-Caption-Format": return result.meta.format;
                case "X-Video-Title": return result.meta.videoTitle;
                case "X-Video-Duration": return result.meta.videoDuration;
                default: return null;
            }
        };
        return buildSuccess(result.vtt, headerFor, options, step);
    }

    async function getTranscript(video, options = {}) {
        if (!video || video.platform !== "youtube") return fail(CODES.UNSUPPORTED_VIDEO, {});
        if (!video.videoId || !VIDEO_ID_PATTERN.test(video.videoId)) {
            return fail(CODES.INVALID_REQUEST, { reason: "video has no valid YouTube id" });
        }

        // The async caption queue is opt-in per instance: the app
        // enables it, while the historical direct endpoint remains
        // the default. When enabled, prefer the queue but fall back
        // to the synchronous endpoint when the Worker has no queue
        // configured (501) — the app keeps working before the
        // Worker is redeployed with queue support. The queue is
        // real server-side state, never a frontend simulation.
        if (useCaptionQueue) {
            const notify = typeof options.onCaptionJobUpdate === "function"
                ? options.onCaptionJobUpdate : null;
            const queued = await fetchViaQueue(video.videoId, options);
            if (!queued.fallback) return queued;
            if (notify) notify({ phase: "direct", mode: "synchronous-fallback" });
        }
        return fetchDirect(video.videoId, options);
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

// The app's instance: real fetch, no credential, the configured
// service, and the async caption queue (with synchronous
// fallback while the Worker has no queue bindings).
export const provider = createYouTubeNativeProvider({ useCaptionQueue: true });

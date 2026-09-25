// ==========================================================
// adapters/supadata.js  (Stage 2B — REAL provider)
// Responsibility: retrieve a YouTube transcript from the
// Supadata API and translate it into an AdapterResponse
// (see ../provider.js). EVERYTHING Supadata-specific — URL,
// query parameters, auth header, response fields, job polling,
// error codes — stays in this file.
//
// Request:  GET https://api.supadata.ai/v1/transcript
//             ?url=<canonical video URL>&text=false&mode=<auto|native|generate>[&lang=<code>]
//           header x-api-key: <user's key, typed in at runtime>
// Response: { content: [{ text, offset(ms), duration(ms), lang }], lang, availableLangs }
//           or { jobId } (HTTP 202) → poll GET /v1/transcript/<jobId>
// Errors:   { error: "<code>", message, details, documentationUrl }
//
// NORMALIZATION (the provider boundary)
//   - Chunks are re-enveloped into the app's generic JSON record shape
//     (formats/json.js): one record per line,
//       {"startMs": <offset>, "durationMs": <duration>, "text": <text>}
//     text, offset, and duration values are copied VERBATIM (no trimming,
//     no merging, no unit conversion). Missing values are omitted, never
//     filled in. Everything else (availableLangs, per-chunk lang, job
//     metadata, documentationUrl, headers) is dropped here.
//   - method: mode "native" → native, "generate" → generated,
//     "auto" → unknown (Supadata does not say which one it used).
//   - language: the language Supadata REPORTS (it silently falls back to
//     another language when the requested one is missing).
//   - sourceId: the async jobId when there was one; otherwise null
//     (Supadata exposes no caption-track id).
//
// SECURITY / PRIVACY
//   - The only network destination is api.supadata.ai. The request carries
//     the canonical video URL and options — never transcript content.
//   - The key comes from the in-memory credential store; it is never put in
//     URLs, error details, logs, or provenance. Supadata's own error text is
//     never kept (it can echo the key back), only its short error code.
//   - credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store".
// ==========================================================

import { defineProvider, PROVIDER_STATUS, METHOD_PREFERENCE } from "../provider.js";
import { ACQUISITION_ERROR_CODES as CODES } from "../errors.js";

export const SUPADATA_ID = "supadata";
export const SUPADATA_API_BASE = "https://api.supadata.ai/v1";

const MODE_FOR_METHOD = {
    [METHOD_PREFERENCE.ANY]: "auto",
    [METHOD_PREFERENCE.NATIVE]: "native",
    [METHOD_PREFERENCE.GENERATED]: "generate"
};
const METHOD_FOR_MODE = { auto: "unknown", native: "native", generate: "generated" };

// Supadata error codes → app vocabulary.
const ERROR_CODE_MAP = {
    "unauthorized": CODES.AUTHENTICATION_FAILED,
    "forbidden": CODES.AUTHENTICATION_FAILED,
    "upgrade-required": CODES.RATE_LIMITED,          // plan / credit limit reached
    "limit-exceeded": CODES.RATE_LIMITED,
    "transcript-unavailable": CODES.TRANSCRIPT_UNAVAILABLE,
    "not-found": CODES.VIDEO_UNAVAILABLE,
    "invalid-request": CODES.PROVIDER_ERROR,
    "internal-error": CODES.PROVIDER_ERROR
};

function codeForHttpStatus(status) {
    if (status === 401 || status === 403) return CODES.AUTHENTICATION_FAILED;
    if (status === 402 || status === 429) return CODES.RATE_LIMITED;
    if (status === 404) return CODES.VIDEO_UNAVAILABLE;
    if (status === 206) return CODES.TRANSCRIPT_UNAVAILABLE;
    if (status === 408 || status === 504) return CODES.PROVIDER_TIMEOUT;
    if (status === 500) return CODES.PROVIDER_ERROR;
    if (status >= 500) return CODES.PROVIDER_UNAVAILABLE;
    return CODES.UNKNOWN_ERROR;
}

const DEFAULTS = Object.freeze({
    requestDeadlineMs: 25000,   // below the manager's 30 s timeout
    pollIntervalMs: 1500
});

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Keep only a short, safe token of Supadata's error code for diagnostics.
const safeProviderCode = (value) =>
    (typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value) ? value : null);

const fail = (code, detail = {}) => ({ success: false, error: { code, detail } });

function failureFromBody(httpStatus, body) {
    const providerCode = isPlainObject(body) ? safeProviderCode(body.error) : null;
    const code = (providerCode && ERROR_CODE_MAP[providerCode]) || codeForHttpStatus(httpStatus);
    return fail(code, { httpStatus, providerCode });
}

function toInterchangeRecord(chunk) {
    const record = {};
    if (chunk.offset !== undefined) record.startMs = chunk.offset;
    if (chunk.duration !== undefined) record.durationMs = chunk.duration;
    record.text = chunk.text;
    return JSON.stringify(record);
}

// Supadata transcript body → AdapterResponse (success or MALFORMED/EMPTY).
function normalizeTranscriptBody(body, { mode, sourceId }) {
    if (!isPlainObject(body) || !Array.isArray(body.content)) {
        return fail(CODES.MALFORMED_RESPONSE, { reason: "content is not an array" });
    }
    const chunks = body.content;
    if (chunks.length === 0) return fail(CODES.TRANSCRIPT_EMPTY, {});
    const badIndex = chunks.findIndex((chunk) => !isPlainObject(chunk) || typeof chunk.text !== "string");
    if (badIndex !== -1) return fail(CODES.MALFORMED_RESPONSE, { reason: "chunk without text", index: badIndex });
    if (chunks.every((chunk) => chunk.text.trim().length === 0)) return fail(CODES.TRANSCRIPT_EMPTY, {});

    const rawText = `[\n${chunks.map(toInterchangeRecord).join(",\n")}\n]\n`;
    return {
        success: true,
        transcript: { rawText, format: "json" },
        source: {
            method: METHOD_FOR_MODE[mode] || "unknown",
            language: typeof body.lang === "string" ? body.lang : null,   // validated by the boundary
            sourceId
        }
    };
}

/**
 * Factory so tests can inject fetch, the credential store, and time.
 * @param {object} deps
 * @param {(url:string, init:object) => Promise<Response>} deps.fetchImpl
 * @param {{read:(id:string)=>string|null}} deps.credentials
 * @param {(ms:number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {number} [deps.requestDeadlineMs]
 * @param {number} [deps.pollIntervalMs]
 */
export function createSupadataProvider({ fetchImpl, credentials, sleep, now, requestDeadlineMs, pollIntervalMs } = {}) {
    const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const clock = now || (() => Date.now());
    const deadlineMs = requestDeadlineMs ?? DEFAULTS.requestDeadlineMs;
    const intervalMs = pollIntervalMs ?? DEFAULTS.pollIntervalMs;

    // One HTTP GET → { status, body } | AdapterResponse failure.
    async function get(url, apiKey, signal) {
        let response;
        try {
            response = await fetchImpl(url, {
                method: "GET",
                headers: { "x-api-key": apiKey, "Accept": "application/json" },
                credentials: "omit",
                referrerPolicy: "no-referrer",
                cache: "no-store",
                signal
            });
        } catch (cause) {
            if (cause && cause.name === "AbortError") return { failure: fail(CODES.PROVIDER_TIMEOUT, { deadlineMs }) };
            // Offline, DNS, CORS, or TLS failure: the browser hides which.
            return { failure: fail(CODES.PROVIDER_UNAVAILABLE, { reason: "network request failed" }) };
        }
        let text;
        try {
            text = await response.text();
        } catch {
            return { failure: fail(CODES.PROVIDER_UNAVAILABLE, { reason: "response body unreadable", httpStatus: response.status }) };
        }
        let body = null;
        try { body = JSON.parse(text); } catch { body = undefined; }
        return { status: response.status, body };
    }

    async function pollJob(jobId, apiKey, signal, startedAt) {
        const url = `${SUPADATA_API_BASE}/transcript/${encodeURIComponent(jobId)}`;
        while (clock() - startedAt < deadlineMs) {
            await wait(intervalMs);
            const reply = await get(url, apiKey, signal);
            if (reply.failure) return reply.failure;
            const { status, body } = reply;
            if (body === undefined) return fail(CODES.MALFORMED_RESPONSE, { reason: "job status is not JSON", httpStatus: status });
            if (status < 200 || status >= 300 || (isPlainObject(body) && typeof body.error === "string")) {
                return failureFromBody(status, body);
            }
            const jobStatus = isPlainObject(body) ? body.status : null;
            if (jobStatus === "completed") return { done: isPlainObject(body.result) ? body.result : body };
            if (jobStatus === "failed") {
                const error = isPlainObject(body.error) ? body.error.error : body.error;
                const providerCode = safeProviderCode(error);
                return fail((providerCode && ERROR_CODE_MAP[providerCode]) || CODES.PROVIDER_ERROR,
                    { reason: "job failed", providerCode });
            }
            if (jobStatus !== "queued" && jobStatus !== "active") {
                return fail(CODES.MALFORMED_RESPONSE, { reason: "unknown job status" });
            }
        }
        return fail(CODES.PROVIDER_TIMEOUT, { reason: "job still running", deadlineMs, jobId });
    }

    async function getTranscript(video, options) {
        const apiKey = credentials.read(SUPADATA_ID);
        if (!apiKey) return fail(CODES.CREDENTIAL_REQUIRED, { reason: "no API key entered" });
        if (video.platform !== "youtube") return fail(CODES.UNSUPPORTED_VIDEO, {});

        const mode = MODE_FOR_METHOD[options.method] || "auto";
        const params = new URLSearchParams({ url: video.canonicalUrl, text: "false", mode });
        if (options.language) params.set("lang", options.language);

        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), deadlineMs) : null;
        const startedAt = clock();
        try {
            const reply = await get(`${SUPADATA_API_BASE}/transcript?${params}`, apiKey, controller ? controller.signal : undefined);
            if (reply.failure) return reply.failure;
            const { status, body } = reply;

            if (status < 200 || status >= 300 || status === 206 || (isPlainObject(body) && typeof body.error === "string")) {
                return failureFromBody(status, body);
            }
            if (body === undefined) return fail(CODES.MALFORMED_RESPONSE, { reason: "response is not JSON", httpStatus: status });

            if (isPlainObject(body) && typeof body.jobId === "string" && !("content" in body)) {
                const jobId = body.jobId.slice(0, 200);
                const job = await pollJob(jobId, apiKey, controller ? controller.signal : undefined, startedAt);
                if (!job.done) return job;
                return normalizeTranscriptBody(job.done, { mode, sourceId: jobId });
            }
            return normalizeTranscriptBody(body, { mode, sourceId: null });
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    return defineProvider({
        id: SUPADATA_ID,
        name: "Supadata",
        description: "Hosted transcript API. Uses your own Supadata API key; requests go only to api.supadata.ai.",
        status: PROVIDER_STATUS.AVAILABLE,
        enabled: true,
        capabilities: {
            platforms: ["youtube"],
            nativeCaptions: true,
            generatedTranscript: true,
            languageSelection: true
        },
        credential: {
            label: "Supadata API key",
            hint: "Kept in memory for this page only and sent only to api.supadata.ai. " +
                "Never saved, logged, or shown. Reloading the page forgets it."
        },
        getTranscript
    });
}

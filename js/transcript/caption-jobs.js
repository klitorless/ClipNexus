// ==========================================================
// caption-jobs.js
// Responsibility: frontend client for the caption service's
// async request queue (POST /caption-jobs, GET
// /caption-jobs/:id, GET /caption-jobs/:id/result).
//
// Pure fetch wrappers: no DOM, no state, no secrets. The
// caption service URL is public configuration (it carries no
// credential); only the 11-character video id is ever sent.
//
// Contract notes:
//   - enqueue() answers 501 { error: { type:
//     "queue-unavailable" } } when the Worker has no queue
//     bindings; callers should fall back to the synchronous
//     /youtube-transcript endpoint in that case.
//   - Job ids are unguessable bearer tokens: whoever holds
//     the id can read that job's status/result for its TTL.
// ==========================================================

export const CAPTION_JOB_STATUS = Object.freeze({
    QUEUED: "queued",
    PROCESSING: "processing",
    COMPLETED: "completed",
    FAILED: "failed"
});

const TERMINAL_STATUSES = new Set([
    CAPTION_JOB_STATUS.COMPLETED,
    CAPTION_JOB_STATUS.FAILED
]);

export function isTerminalJobStatus(status) {
    return TERMINAL_STATUSES.has(status);
}

/** Derive the Worker root from the /youtube-transcript endpoint URL. */
export function captionJobsBaseUrl(captionServiceUrl) {
    return String(captionServiceUrl).replace(/\/youtube-transcript\/?$/, "");
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Enqueue a caption request.
 * Resolves to { ok: true, job } or { ok: false, notConfigured }
 * or { ok: false, error: { type, message, httpStatus } }.
 *
 * notConfigured covers every pre-acceptance infrastructure
 * state: 501 (no queue bindings), 404 (old Worker without
 * queue routes), 503 (queue temporarily not accepting).
 * In all of these the job was NOT accepted, so the caller
 * may fall back to the synchronous endpoint. Once a 202 is
 * returned the job IS accepted and must be polled to a
 * terminal state — never abandoned for the sync endpoint.
 */
export async function enqueueCaptionJob({ baseUrl, videoId, lang = null, fetchImpl = fetch }) {
    let response;
    try {
        response = await fetchImpl(`${baseUrl}/caption-jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "omit",
            referrerPolicy: "no-referrer",
            body: JSON.stringify({ v: videoId, ...(lang ? { lang } : {}) })
        });
    } catch (cause) {
        return { ok: false, error: { type: "network-failure", message: "Could not reach the caption service.", cause } };
    }
    if (response.status === 501 || response.status === 404 || response.status === 503) {
        return { ok: false, notConfigured: true };
    }
    const parsed = await readJson(response);
    const job = parsed && typeof parsed === "object" ? parsed.job : null;
    if (response.status === 202 && job && typeof job.id === "string") {
        return { ok: true, job };
    }
    const type = parsed && parsed.error && parsed.error.type;
    return {
        ok: false,
        error: {
            type: typeof type === "string" ? type : "enqueue-failed",
            message: "Could not queue the caption request.",
            httpStatus: response.status
        }
    };
}

/**
 * Fetch the current status of a job.
 * Resolves to { ok: true, job } or { ok: false, ... }.
 */
export async function getCaptionJob({ baseUrl, jobId, fetchImpl = fetch }) {
    let response;
    try {
        response = await fetchImpl(
            `${baseUrl}/caption-jobs/${encodeURIComponent(jobId)}`,
            { method: "GET", credentials: "omit", referrerPolicy: "no-referrer" }
        );
    } catch (cause) {
        return { ok: false, error: { type: "network-failure", message: "Could not reach the caption service.", cause } };
    }
    const parsed = await readJson(response);
    const job = parsed && typeof parsed === "object" ? parsed.job : null;
    if (response.ok && job && typeof job.status === "string") {
        return { ok: true, job };
    }
    return { ok: false, error: { type: "status-failed", message: "Could not read the job status.", httpStatus: response.status } };
}

/**
 * Fetch a completed job's WebVTT result (with the service's
 * X-Caption-* provenance headers). Call only after the job
 * reports completed.
 * Resolves to { ok: true, vtt, meta } or { ok: false, error }.
 */
export async function fetchCaptionJobResult({ baseUrl, jobId, fetchImpl = fetch }) {
    let response;
    try {
        response = await fetchImpl(
            `${baseUrl}/caption-jobs/${encodeURIComponent(jobId)}/result`,
            { method: "GET", headers: { "Accept": "text/vtt" }, credentials: "omit", referrerPolicy: "no-referrer" }
        );
    } catch (cause) {
        return { ok: false, error: { type: "network-failure", message: "Could not reach the caption service.", cause } };
    }
    if (!response.ok) {
        return { ok: false, error: { type: "result-failed", message: "Could not fetch the job result.", httpStatus: response.status } };
    }
    let vtt;
    try {
        vtt = await response.text();
    } catch {
        return { ok: false, error: { type: "result-unreadable", message: "The job result was unreadable." } };
    }
    const header = (name) => {
        const value = response.headers.get(name);
        return typeof value === "string" && value.length > 0 ? value : null;
    };
    return {
        ok: true,
        vtt,
        meta: {
            language: header("X-Caption-Language"),
            generated: header("X-Caption-Generated"),
            source: header("X-Caption-Source"),
            format: header("X-Caption-Format"),
            videoTitle: header("X-Video-Title"),
            videoDuration: header("X-Video-Duration")
        }
    };
}

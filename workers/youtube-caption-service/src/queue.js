// ============================================================
// queue.js — Cloudflare Queue-backed caption request queue.
//
// Flow:
//   POST /caption-jobs { v, lang? } -> 202 { job }
//   Cloudflare Queue consumer processes the message
//   GET  /caption-jobs/:id          -> { job: status }
//   GET  /caption-jobs/:id/result   -> 200 text/vtt (when completed)
//
// State lives in KV (JOB_STORE binding):
//   job:<id>        JSON job record (1h TTL)
//   jobresult:<id>  WebVTT text (1h TTL, only when completed)
//   queue:pending   integer: jobs not yet completed/failed
//   queue:avgms     rolling average processing time, ms
//
// The queue is FIFO-ish; reported positions and wait times
// are APPROXIMATIONS, always labeled as such. Nothing here
// holds secrets: job records contain only the video id,
// status, and caption metadata. Job ids are unguessable
// bearer tokens — anyone with the id can read that job's
// status/result for its TTL window.
// ============================================================

export const JOB_TTL_SECONDS = 3600;
export const MAX_ATTEMPTS = 3;
export const MAX_BACKLOG = 100;
// Fair-use spacing: 1 caption request per user every 10
// minutes. Enforced at admission (each user's slot) and by
// the consumer (never processes before a job's notBefore).
// This is ClipNexus's own policy to stay within YouTube's
// adaptive throttling — not a YouTube-published number.
export const USER_SLOT_MS = 600000;
export const USER_SLOT_KV_TTL = 3600;
// Longest single retry delay the consumer will request while
// waiting for a user's slot to open (11 min > 10 min slot).
export const MAX_SLOT_RETRY_DELAY_S = 660;
// Fallback per-job processing estimate (ms) until measured
// averages exist. Reported wait times are always estimates.
export const FALLBACK_JOB_MS = 8000;

const JOB_KEY_PREFIX = "job:";
const RESULT_KEY_PREFIX = "jobresult:";
const PENDING_KEY = "queue:pending";
const AVG_MS_KEY = "queue:avgms";

export const JOB_STATUS = Object.freeze({
    QUEUED: "queued",
    PROCESSING: "processing",
    COMPLETED: "completed",
    FAILED: "failed"
});

/** Stable, unguessable request id: job_<time36>_<16 hex>. */
export function createJobId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `job_${Date.now().toString(36)}_${hex}`;
}

/**
 * Hash a client IP for the per-user slot marker. The salt
 * keeps the stored value from being a trivially reversible
 * IP; raw IPs never touch KV.
 */
export async function hashClientIp(ip) {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`clipnexus-slot:v1:${ip}`)
    );
    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Claim this user's next 10-minute slot. Returns the
 * earliest time (ms epoch) the new request may be processed.
 * First request: now (immediate). Each following request:
 * at least USER_SLOT_MS after the previously claimed slot,
 * so one user's requests always space out even if they
 * enqueue several at once.
 */
export async function claimUserSlot(store, ipHash, now = Date.now()) {
    const key = `userslot:${ipHash}`;
    const raw = await store.get(key);
    const lastSlot = raw === null ? 0 : Number(raw);
    const base = Number.isFinite(lastSlot) && lastSlot > 0 ? lastSlot : 0;
    const notBefore = Math.max(now, base + USER_SLOT_MS);
    await store.put(key, String(notBefore), { expirationTtl: USER_SLOT_KV_TTL });
    return notBefore;
}

async function readCounter(store, key) {
    const raw = await store.get(key);
    const n = raw === null || raw === undefined ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// The pending counter is USER-VISIBLE queue statistics, so its
// lifecycle is strict:
//
//   * Exactly one increment per createJob (before queue.send).
//   * Exactly one decrement per terminal transition:
//     completed, failed, or expired-orphan (valid id, record
//     gone — the 1h TTL beat the consumer).
//   * Retries never touch the counter: the job is still pending.
//   * Duplicate deliveries re-read the record and never
//     decrement twice: only a non-terminal -> terminal
//     transition decrements.
//   * Decrements clamp at zero; the counter is approximate
//     and must never go negative.
//
// Residual risk (documented, not hidden): KV has no
// transactions. If a KV write throws mid-transition, a later
// redelivery re-reads the record and the transition guard
// above keeps the counter correct in every case except a KV
// outage inside the catch block itself.
async function decrementPending(store) {
    const pending = await readCounter(store, PENDING_KEY);
    await store.put(PENDING_KEY, String(Math.max(0, pending - 1)));
}

function isTerminalStatus(status) {
    return status === JOB_STATUS.COMPLETED || status === JOB_STATUS.FAILED;
}

async function putJob(store, record) {
    await store.put(JOB_KEY_PREFIX + record.id, JSON.stringify(record), {
        expirationTtl: JOB_TTL_SECONDS
    });
}

export async function getJob(store, id) {
    if (typeof id !== "string" || !/^job_[a-z0-9]+_[0-9a-f]{16}$/.test(id)) return null;
    const raw = await store.get(JOB_KEY_PREFIX + id);
    if (!raw) return null;
    try {
        const record = JSON.parse(raw);
        return record && typeof record === "object" ? record : null;
    } catch {
        return null;
    }
}

/** Approximate wait: position in line x measured (or fallback) per-job time. */
export function estimateWaitSeconds(positionAtEnqueue, avgMs) {
    const perJobMs = typeof avgMs === "number" && avgMs > 0 ? avgMs : FALLBACK_JOB_MS;
    const ahead = Math.max(0, (positionAtEnqueue || 1) - 1);
    return Math.round((ahead * perJobMs) / 1000);
}

/**
 * Create a job: claim the user's slot, persist the record,
 * bump the backlog counter, and send the message to the Queue.
 * Returns { record, backlog }.
 *
 * notBefore is the user's 10-minute fair-use slot: the job is
 * accepted immediately (HTTP 202) but the consumer will not
 * process it before notBefore. The slot wait is visible to
 * the client in the public status.
 *
 * If queue.send throws, the job never entered the queue: the
 * record is marked failed and the counter is decremented, so
 * no phantom pending job is left behind. Throws a typed error
 * the HTTP layer maps to 503 (pre-acceptance failure — the
 * caller may fall back to the synchronous endpoint).
 */
export async function createJob(store, queue, { videoId, lang = null, notBefore = null }) {
    const id = createJobId();
    const now = Date.now();
    const pending = await readCounter(store, PENDING_KEY);
    await store.put(PENDING_KEY, String(pending + 1));
    const record = {
        id,
        videoId,
        lang,
        status: JOB_STATUS.QUEUED,
        // Earliest processing time (ms epoch) from the
        // per-user 10-minute slot. Null = no slot (tests,
        // requests without an identifiable client).
        notBefore: typeof notBefore === "number" && notBefore > 0 ? notBefore : null,
        // Approximate: jobs ahead of this one when it was enqueued.
        // This is NOT a physical Cloudflare Queue position.
        positionAtEnqueue: pending + 1,
        createdAt: now,
        updatedAt: now,
        attempts: 0
    };
    await putJob(store, record);
    try {
        await queue.send({ jobId: id, videoId, lang });
    } catch (err) {
        record.status = JOB_STATUS.FAILED;
        record.errorType = "enqueue-failed";
        record.updatedAt = Date.now();
        await putJob(store, record);
        await decrementPending(store);
        const failure = new Error("Caption queue unavailable.");
        failure.code = "QUEUE_SEND_FAILED";
        throw failure;
    }
    return { record, backlog: pending + 1 };
}

/**
 * Public job status shape. Never includes secrets, the VTT,
 * or internal counters beyond the documented approximations.
 */
export async function publicJobStatus(store, record) {
    const out = {
        id: record.id,
        status: record.status,
        videoId: record.videoId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        attempts: record.attempts
    };
    if (record.status === JOB_STATUS.QUEUED) {
        const backlog = await readCounter(store, PENDING_KEY);
        const avgMsRaw = await store.get(AVG_MS_KEY);
        const avgMs = avgMsRaw === null ? null : Number(avgMsRaw);
        out.positionApproximate = record.positionAtEnqueue;
        out.backlog = backlog;
        // "Time til next request": the later of the queue-depth
        // estimate and the user's 10-minute slot wait, so the
        // displayed time always depicts the cooldown.
        const slotWaitSeconds = typeof record.notBefore === "number"
            ? Math.max(0, Math.ceil((record.notBefore - Date.now()) / 1000))
            : 0;
        if (slotWaitSeconds > 0) {
            out.notBefore = record.notBefore;
            out.slotWaitSeconds = slotWaitSeconds;
        }
        const hasAvg = typeof avgMs === "number" && Number.isFinite(avgMs) && avgMs > 0;
        if (hasAvg || slotWaitSeconds > 0) {
            // Only report a wait estimate when real timing data
            // exists or a slot wait applies. Without either there
            // is no meaningful number — omit it rather than
            // invent one.
            const avgBased = hasAvg ? estimateWaitSeconds(record.positionAtEnqueue, avgMs) : 0;
            out.estimatedWaitSeconds = Math.max(avgBased, slotWaitSeconds);
            out.estimatedWaitNote = "Estimate only — not a guarantee.";
        }
    }
    if (record.status === JOB_STATUS.FAILED) {
        out.error = {
            type: record.errorType || "processing-failed",
            message: publicFailureMessage(record.errorType)
        };
    }
    if (record.status === JOB_STATUS.COMPLETED) {
        out.result = { ...(record.resultMeta || {}) };
        out.resultUrl = `/caption-jobs/${record.id}/result`;
    }
    return out;
}

function publicFailureMessage(errorType) {
    switch (errorType) {
        case "rate-limited":
            return "YouTube is rate-limiting requests from this network. Try again later.";
        case "timeout":
            return "YouTube took too long to respond.";
        case "transcript-unavailable":
        case "track-unavailable":
            return "No caption track was found for this video.";
        default:
            return "Caption retrieval failed.";
    }
}

function isRetryable(errorType) {
    return errorType === "rate-limited" || errorType === "timeout" ||
        errorType === "retrieval-failure";
}

function backoffSeconds(attempts) {
    // 10s, 30s, 90s — gentle on YouTube's rate limiter.
    return Math.min(90, 10 * Math.pow(3, attempts - 1));
}

async function recordCompletionSample(store, startedAt) {
    const ms = Date.now() - startedAt;
    if (!(ms > 0)) return;
    const raw = await store.get(AVG_MS_KEY);
    const prev = raw === null ? null : Number(raw);
    const next = prev === null || !Number.isFinite(prev) ? ms : Math.round(prev * 0.7 + ms * 0.3);
    await store.put(AVG_MS_KEY, String(next));
}

/**
 * Process one queue message. Idempotent: already-terminal jobs
 * ack without re-fetching and without touching the counter;
 * missing records with a well-formed id are expired orphans
 * (the 1h TTL beat the consumer) and decrement the counter
 * once; malformed ids were never enqueued and change nothing.
 *
 * retrieve(videoId, lang) is the shared caption core and
 * returns { ok: true, vtt, meta } or { ok: false, ... }.
 *
 * Terminal transitions re-read the record first: a duplicate
 * delivery that arrives after another delivery settled the
 * job sees the terminal status and acks without decrementing
 * twice or re-sampling the timing average.
 */
export async function processJobMessage(message, { store, retrieve, msg }) {
    try {
        return await processJobMessageInner(message, { store, retrieve, msg });
    } catch (err) {
        // Unexpected infrastructure failure (a KV write threw,
        // ...). Best effort: settle the job as failed so the
        // counter cannot inflate forever, then ack so the
        // message cannot poison-loop. If even this throws, the
        // message redelivers and the DLQ eventually catches it.
        try {
            const { jobId } = message || {};
            const record = await getJob(store, jobId);
            if (record && !isTerminalStatus(record.status)) {
                record.status = JOB_STATUS.FAILED;
                record.errorType = "processing-failure";
                record.updatedAt = Date.now();
                await putJob(store, record);
                await decrementPending(store);
            }
        } catch {
            // Best effort only.
        }
        msg.ack();
        return { outcome: "failed", reason: String((err && err.message) || err) };
    }
}

async function processJobMessageInner(message, { store, retrieve, msg }) {
    const { jobId, videoId, lang } = message || {};
    const record = await getJob(store, jobId);
    if (!record) {
        if (typeof jobId === "string" && /^job_[a-z0-9]+_[0-9a-f]{16}$/.test(jobId)) {
            // Expired orphan: enqueued (counter incremented) but
            // the record's TTL expired before the consumer ran.
            await decrementPending(store);
            msg.ack();
            return { outcome: "expired" };
        }
        // Malformed id: never enqueued, counter untouched.
        msg.ack();
        return { outcome: "acked" };
    }
    if (isTerminalStatus(record.status)) {
        msg.ack();
        return { outcome: "acked" };
    }

    // Fair-use slot: never process before the user's
    // 10-minute slot opens. Requeue with a delay instead of
    // burning an attempt or touching the counter — this is
    // waiting, not failing.
    if (typeof record.notBefore === "number" && Date.now() < record.notBefore) {
        const waitSeconds = Math.ceil((record.notBefore - Date.now()) / 1000);
        msg.retry({ delaySeconds: Math.min(Math.max(waitSeconds, 1), MAX_SLOT_RETRY_DELAY_S) });
        return { outcome: "slot-wait" };
    }

    const startedAt = Date.now();
    record.status = JOB_STATUS.PROCESSING;
    record.attempts += 1;
    record.updatedAt = startedAt;
    await putJob(store, record);

    let outcome;
    try {
        outcome = await retrieve(videoId, lang);
    } catch (err) {
        outcome = { ok: false, errorType: "retrieval-failure", message: String(err && err.message || err) };
    }

    // Re-read: a duplicate delivery may have settled the job
    // while this delivery was retrieving. Only a non-terminal
    // -> terminal transition decrements the counter and
    // samples the timing average.
    const fresh = await getJob(store, jobId);
    if (!fresh || isTerminalStatus(fresh.status)) {
        msg.ack();
        return { outcome: "acked" };
    }

    if (outcome && outcome.ok) {
        await store.put(RESULT_KEY_PREFIX + jobId, outcome.vtt, {
            expirationTtl: JOB_TTL_SECONDS
        });
        fresh.status = JOB_STATUS.COMPLETED;
        fresh.updatedAt = Date.now();
        fresh.attempts = record.attempts;
        fresh.resultMeta = {
            language: outcome.meta.language,
            generated: outcome.meta.generated,
            source: outcome.meta.source,
            format: outcome.meta.format,
            videoTitle: outcome.meta.videoTitle || null,
            videoDurationSeconds: normalizeDuration(outcome.meta.videoDuration)
        };
        await putJob(store, fresh);
        await decrementPending(store);
        await recordCompletionSample(store, startedAt);
        msg.ack();
        return { outcome: "completed" };
    }

    const errorType = (outcome && outcome.errorType) || "retrieval-failure";
    if (isRetryable(errorType) && fresh.attempts < MAX_ATTEMPTS) {
        fresh.status = JOB_STATUS.QUEUED;
        fresh.attempts = record.attempts;
        fresh.updatedAt = Date.now();
        await putJob(store, fresh);
        msg.retry({ delaySeconds: backoffSeconds(record.attempts) });
        return { outcome: "retried" };
    }

    fresh.status = JOB_STATUS.FAILED;
    fresh.attempts = record.attempts;
    fresh.errorType = errorType;
    fresh.updatedAt = Date.now();
    await putJob(store, fresh);
    await decrementPending(store);
    msg.ack();
    return { outcome: "failed" };
}

function normalizeDuration(value) {
    const n = typeof value === "string" ? Number(value) : value;
    return Number.isInteger(n) && n >= 0 ? n : null;
}

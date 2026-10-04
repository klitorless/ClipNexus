// ============================================================
// clipnexus-youtube-caption — deployable YouTube caption service
//
//   GET /youtube-transcript?v=VIDEO_ID[&lang=BCP47]  →  200 text/vtt
//   (or a structured JSON error the ClipNexus client understands)
//
// Server-side caption retrieval, tried in order:
//
//   A. InnerTube player API: POST youtubei/v1/player, read
//      captionTracks from captions.playerCaptionsTracklistRenderer.
//      Uses YouTube's own PUBLIC client key (the one embedded in
//      youtube.com's JavaScript) — not a private credential.
//   B. Watch-page fallback: GET the canonical watch page, extract
//      "captionTracks" from the embedded player response.
//
// The selected track's baseUrl is fetched VERBATIM (raw string
// append of &fmt=vtt). Never reconstructed or re-serialized: that
// can invalidate YouTube's query signature.
//
// YouTube currently ignores fmt on these signed URLs and returns
// the default srv3 XML (<timedtext format="3">), so the Worker
// converts that XML to WebVTT itself. If YouTube ever honors
// fmt=vtt, the verbatim VTT passes through unchanged.
//
// Track selection (deterministic): manual/native captions first,
// auto-generated accepted; when a `lang` parameter is supplied a
// matching track is preferred; otherwise English is preferred,
// else the first usable track. The response always reports what
// was actually selected via X-Caption-* headers.
//
// CORS: EVERY response carries Access-Control-Allow-Origin: *,
// and successful caption responses also expose the X-Caption-*
// headers via Access-Control-Expose-Headers. OPTIONS is handled.
//
// No API keys, no Supadata, no video download, no scraping of
// video content, no logging of transcript contents. Only the
// video ID (and an optional language code) is accepted from the
// caller; arbitrary upstream URLs can never be supplied.
// The async caption-job queue (see queue.js) keeps per-job
// status and the resulting WebVTT in KV for one hour so the
// client can poll; nothing else is stored.
// ============================================================

import {
    createJob,
    getJob,
    publicJobStatus,
    processJobMessage,
    claimUserSlot,
    hashClientIp,
    MAX_BACKLOG
} from "./queue.js";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const LANG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const FETCH_TIMEOUT_MS = 20000;
// Polite spacing between queue-consumer requests to YouTube
// (see the queue() handler). Not a YouTube-published number.
const MESSAGE_SPACING_MS = 2000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// YouTube's own public InnerTube client key, embedded in
// youtube.com's JavaScript. Public, not a private credential.
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
// A desktop browser UA: YouTube serves bot/consent pages to
// non-browser user agents, which would hide the caption tracks.
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const EXPOSED_CAPTION_HEADERS =
    "X-Caption-Language, X-Caption-Generated, X-Caption-Source, X-Caption-Format, X-Video-Title, X-Video-Duration";

// Video titles travel as a response header (percent-encoded UTF-8,
// since HTTP headers are Latin-1). Truncated to keep headers small.
const MAX_TITLE_LENGTH = 300;

function encodeVideoTitle(title) {
    if (typeof title !== "string") return null;
    const trimmed = title.trim();
    if (!trimmed) return null;
    return encodeURIComponent(trimmed.slice(0, MAX_TITLE_LENGTH));
}

// Video duration travels as plain integer seconds in X-Video-Duration.
function normalizeDurationSeconds(value) {
    const n = typeof value === "string" ? Number(value) : value;
    if (!Number.isInteger(n) || n < 0) return null;
    return String(n);
}

// --- Response helpers: CORS is applied here, so no response path
// can accidentally omit it. -------------------------------------

function corsHeaders(extra = {}) {
    return { "Access-Control-Allow-Origin": "*", ...extra };
}

/** Structured JSON error. Every error path funnels through here. */
export function jsonError(type, message, status) {
    return new Response(JSON.stringify({ error: { type, message } }), {
        status,
        headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" })
    });
}

/** Successful caption response, with provenance headers exposed. */
export function vttResponse(body, meta) {
    const headers = corsHeaders({
        "Content-Type": "text/vtt; charset=utf-8",
        "Access-Control-Expose-Headers": EXPOSED_CAPTION_HEADERS,
        "X-Caption-Language": meta.language,
        "X-Caption-Generated": meta.generated ? "true" : "false",
        "X-Caption-Source": meta.source,
        "X-Caption-Format": meta.format
    });
    if (meta.videoTitle) headers["X-Video-Title"] = meta.videoTitle;
    if (meta.videoDuration) headers["X-Video-Duration"] = meta.videoDuration;
    return new Response(body, { status: 200, headers });
}

/** CORS preflight response. */
export function optionsResponse() {
    return new Response(null, {
        status: 204,
        headers: corsHeaders({
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Accept, Content-Type",
            "Access-Control-Max-Age": "86400"
        })
    });
}

// --- Caption-track selection -----------------------------------

function isManual(track) {
    return track.kind !== "asr";
}

function primarySubtag(code) {
    return String(code).toLowerCase().split("-")[0];
}

/**
 * Deterministic track selection.
 *   1. If preferredLanguage is given, a matching track wins
 *      (manual before auto-generated).
 *   2. Otherwise manual/native captions are preferred.
 *   3. English is preferred among equivalent tracks.
 *   4. Otherwise the first usable track.
 * Only tracks with a string baseUrl and languageCode are usable.
 * Returns the track object or null.
 */
export function selectTrack(tracks, preferredLanguage = null) {
    const usable = (Array.isArray(tracks) ? tracks : []).filter(
        (t) => t && typeof t.baseUrl === "string" && typeof t.languageCode === "string"
    );
    if (usable.length === 0) return null;
    const manual = usable.filter(isManual);
    const generated = usable.filter((t) => !isManual(t));
    if (preferredLanguage) {
        const want = primarySubtag(preferredLanguage);
        const match = (t) => primarySubtag(t.languageCode) === want;
        return manual.find(match) || generated.find(match) || null;
    }
    const englishManual = manual.filter((t) => primarySubtag(t.languageCode) === "en");
    const englishGenerated = generated.filter((t) => primarySubtag(t.languageCode) === "en");
    // Manual first (English preferred among manuals), then
    // auto-generated (English preferred among generated).
    return englishManual[0] || manual[0] || englishGenerated[0] || generated[0] || usable[0];
}

// --- Timed-text XML (srv3 / legacy transcript) -> WebVTT ----------

export function decodeEntities(s) {
    return String(s)
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function stripTags(s) {
    return String(s).replace(/<[^>]*>/g, "");
}

export function formatTimestamp(ms) {
    const total = Math.max(0, Math.floor(ms));
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const x = total % 1000;
    const p2 = (n) => String(n).padStart(2, "0");
    return `${p2(h)}:${p2(m)}:${p2(s)}.${String(x).padStart(3, "0")}`;
}

/**
 * Convert YouTube timed-text XML to WebVTT.
 * Supports srv3 (<p t="ms" d="ms">, milliseconds) and the legacy
 * <text start="s" dur="s"> form (seconds). Preserves cue order,
 * timestamps, text, and Unicode; decodes entities; strips XML
 * markup; never invents timestamps. Returns the VTT string, or
 * null when no cues could be parsed.
 */
export function timedTextXmlToVtt(xml) {
    const cues = [];
    const source = String(xml || "");
    // srv3: <p t="1360" d="1680">text</p>  (t/d in milliseconds)
    const srv3 = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    // legacy transcript: <text start="1.36" dur="1.68">text</text> (seconds)
    const legacy = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = srv3.exec(source)) !== null) {
        const text = decodeEntities(stripTags(m[3])).trim();
        if (text) {
            const start = parseInt(m[1], 10);
            cues.push({ start, end: start + parseInt(m[2], 10), text });
        }
    }
    if (cues.length === 0) {
        while ((m = legacy.exec(source)) !== null) {
            const text = decodeEntities(stripTags(m[3])).trim();
            if (text) {
                const start = Math.round(parseFloat(m[1]) * 1000);
                cues.push({ start, end: start + Math.round(parseFloat(m[2]) * 1000), text });
            }
        }
    }
    if (cues.length === 0) return null;
    cues.sort((a, b) => a.start - b.start);
    const body = cues
        .map((c) => `${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}`)
        .join("\n\n");
    return `WEBVTT\n\n${body}\n`;
}

// --- Upstream plumbing -------------------------------------------

function timedTextHostOk(hostname) {
    return (
        hostname === "www.youtube.com" ||
        hostname === "youtube.com" ||
        hostname === "m.youtube.com" ||
        hostname === "video.google.com" ||
        hostname.endsWith(".googlevideo.com")
    );
}

function statusToErrorType(status) {
    if (status === 429) return "rate-limited";
    if (status === 404) return "transcript-unavailable";
    return "retrieval-failure";
}

function statusToHttpStatus(status) {
    if (status === 429) return 429;
    return 502;
}

// Pull one JSON array/object out of a larger string, starting
// right after `marker`. Handles nesting and quoted strings.
export function extractJsonValue(text, marker) {
    const source = String(text || "");
    const at = source.indexOf(marker);
    if (at === -1) return null;
    let i = at + marker.length;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    const open = source[i];
    const close = open === "[" ? "]" : open === "{" ? "}" : null;
    if (close === null) return null;
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < source.length; i += 1) {
        const ch = source[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === open) {
            depth += 1;
        } else if (ch === close) {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return null;
}

function isTimeoutError(err) {
    return !!err && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Mechanism A: InnerTube player API. Returns {tracks}|{rateLimited}|{httpStatus}|{malformed}. */
async function captionTracksViaInnerTube(videoId, fetchImpl, timeoutMs) {
    const res = await fetchWithTimeout(
        fetchImpl,
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({
                videoId,
                context: {
                    client: {
                        clientName: "ANDROID",
                        clientVersion: "20.10.36",
                        androidSdkVersion: 30,
                        hl: "en",
                        gl: "US"
                    }
                }
            })
        },
        timeoutMs
    );
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return { httpStatus: res.status };
    let data;
    try {
        data = await res.json();
    } catch {
        return { malformed: true };
    }
    const tracks = data && data.captions && data.captions.playerCaptionsTracklistRenderer
        ? data.captions.playerCaptionsTracklistRenderer.captionTracks
        : null;
    const title = data && data.videoDetails && typeof data.videoDetails.title === "string"
        ? data.videoDetails.title
        : null;
    const durationSeconds = data && data.videoDetails
        ? normalizeDurationSeconds(data.videoDetails.lengthSeconds)
        : null;
    return { tracks: Array.isArray(tracks) ? tracks : null, title, durationSeconds };
}

/** Mechanism B: watch-page fallback. Same result shape as mechanism A. */
async function captionTracksViaWatchPage(videoId, fetchImpl, timeoutMs) {
    const res = await fetchWithTimeout(
        fetchImpl,
        `https://www.youtube.com/watch?v=${videoId}`,
        {
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "text/html",
                "Accept-Language": "en-US,en;q=0.9"
            },
            redirect: "follow"
        },
        timeoutMs
    );
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return { httpStatus: res.status };
    const html = await res.text();
    const raw = extractJsonValue(html, '"captionTracks":');
    const title = extractVideoTitle(html);
    const durationSeconds = extractVideoDuration(html);
    if (raw === null) return { tracks: null, title, durationSeconds };
    try {
        const parsed = JSON.parse(raw);
        return { tracks: Array.isArray(parsed) ? parsed : null, title, durationSeconds };
    } catch {
        return { malformed: true, title, durationSeconds };
    }
}

/** Best-effort video duration (integer seconds, as a string) from watch-page HTML. */
export function extractVideoDuration(html) {
    const raw = extractJsonValue(html, '"videoDetails":');
    if (raw === null) return null;
    try {
        const details = JSON.parse(raw);
        return details ? normalizeDurationSeconds(details.lengthSeconds) : null;
    } catch {
        return null;
    }
}

/** Best-effort video title from a watch-page HTML document. */
export function extractVideoTitle(html) {
    const raw = extractJsonValue(html, '"videoDetails":');
    if (raw !== null) {
        try {
            const details = JSON.parse(raw);
            if (details && typeof details.title === "string" && details.title.trim()) {
                return details.title;
            }
        } catch { /* fall through to meta/title tags */ }
    }
    const meta = String(html).match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i) ||
        String(html).match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']title["']/i);
    if (meta) return meta[1];
    const tag = String(html).match(/<title>([^<]+)<\/title>/i);
    if (tag) return tag[1].replace(/\s*-\s*YouTube\s*$/i, "");
    return null;
}

async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Core caption retrieval, shared by the synchronous endpoint
 * and the queue consumer: gather tracks (InnerTube, then watch
 * page), pick one deterministically, fetch it verbatim, and
 * convert timed-text XML to WebVTT when needed.
 *
 * Returns { ok: true, vtt, meta } or
 * { ok: false, errorType, message, httpStatus }.
 * meta.videoTitle is the RAW title (unencoded); callers
 * percent-encode it for the X-Video-Title header.
 */
export async function retrieveCaptions(videoId, lang, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS) {
        // 1. Gather caption tracks: InnerTube first, watch page as fallback.
        let tracks = null;
        let mechanism = null;
        let softFailure = null;
        let videoTitle = null;
        let videoDuration = null;
        try {
            const inner = await captionTracksViaInnerTube(videoId, fetchImpl, timeoutMs);
            if (inner.rateLimited) softFailure = "rate-limited";
            else if (inner.tracks) { tracks = inner.tracks; mechanism = "innertube"; }
            else if (inner.malformed || inner.httpStatus) softFailure = "retrieval-failure";
            if (inner.title) videoTitle = inner.title;
            if (inner.durationSeconds) videoDuration = inner.durationSeconds;
        } catch (err) {
            softFailure = isTimeoutError(err) ? "timeout" : "retrieval-failure";
        }
        if (!tracks) {
            try {
                const page = await captionTracksViaWatchPage(videoId, fetchImpl, timeoutMs);
                if (page.rateLimited) softFailure = "rate-limited";
                else if (page.tracks) { tracks = page.tracks; mechanism = "watch-page"; }
                else if (!softFailure) softFailure = "transcript-unavailable";
                if (!videoTitle && page.title) videoTitle = page.title;
                if (!videoDuration && page.durationSeconds) videoDuration = page.durationSeconds;
            } catch (err) {
                if (!softFailure) softFailure = isTimeoutError(err) ? "timeout" : "retrieval-failure";
            }
        }
        if (!tracks) {
            const messages = {
                "rate-limited": ["rate-limited", "YouTube is rate-limiting requests from this network.", 429],
                "timeout": ["timeout", "YouTube took too long to respond.", 504],
                "transcript-unavailable": ["transcript-unavailable", "No caption tracks were found for this video.", 404],
                "retrieval-failure": ["retrieval-failure", "Could not retrieve caption information from YouTube.", 502]
            };
            const [type, message, status] = messages[softFailure] || messages["retrieval-failure"];
            return { ok: false, errorType: type, message, httpStatus: status };
        }

        const track = selectTrack(tracks, lang);
        if (!track) {
            return {
                ok: false,
                errorType: "track-unavailable",
                message: lang
                    ? `YouTube has no usable caption track matching "${lang}".`
                    : "YouTube listed no usable caption track for this video.",
                httpStatus: 404
            };
        }

        // 2. Verify the track URL, then fetch it VERBATIM.
        //    Only YouTube timed-text hosts are allowed — the caller
        //    can never supply an arbitrary upstream URL.
        let trackHost;
        try {
            trackHost = new URL(track.baseUrl).hostname;
        } catch {
            return { ok: false, errorType: "malformed-response", message: "The caption track URL was not a valid URL.", httpStatus: 502 };
        }
        if (!timedTextHostOk(trackHost)) {
            return { ok: false, errorType: "malformed-response", message: "The caption track URL was not a YouTube timedtext host.", httpStatus: 502 };
        }
        const trackUrl = `${track.baseUrl}&fmt=vtt`;

        // 3. Fetch the track; accept native VTT or convert timed-text XML.
        let body;
        let sourceFormat = "vtt";
        try {
            const res = await fetchWithTimeout(
                fetchImpl,
                trackUrl,
                { headers: { "User-Agent": USER_AGENT, "Accept": "text/vtt" } },
                timeoutMs
            );
            if (res.status === 429) {
                return { ok: false, errorType: "rate-limited", message: "YouTube is rate-limiting requests from this network.", httpStatus: 429 };
            }
            if (!res.ok) {
                const type = statusToErrorType(res.status);
                const messages = {
                    "transcript-unavailable": "The caption track is no longer available.",
                    "retrieval-failure": `The caption track returned HTTP ${res.status}.`
                };
                return { ok: false, errorType: type, message: messages[type], httpStatus: statusToHttpStatus(res.status) };
            }
            const raw = await res.text();
            if (raw.replace(/^\uFEFF/, "").trimStart().startsWith("WEBVTT")) {
                body = raw;
            } else {
                const vtt = timedTextXmlToVtt(raw);
                if (vtt === null) {
                    return { ok: false, errorType: "malformed-response", message: "The caption track was not valid WebVTT.", httpStatus: 502 };
                }
                body = vtt;
                sourceFormat = "xml";
            }
        } catch (err) {
            const timedOut = isTimeoutError(err);
            return {
                ok: false,
                errorType: timedOut ? "timeout" : "retrieval-failure",
                message: timedOut ? "The caption track took too long to respond." : "Could not fetch the caption track.",
                httpStatus: timedOut ? 504 : 502
            };
        }

        return {
            ok: true,
            vtt: body,
            meta: {
                language: track.languageCode,
                generated: !isManual(track),
                source: mechanism || "unknown",
                format: sourceFormat,
                videoTitle,
                videoDuration
            }
        };
}

/**
 * Build the request handler. fetchImpl defaults to the global
 * fetch (the Workers runtime); tests inject a mock.
 *
 * Queue routes need env.JOB_STORE (KV) and env.CAPTION_QUEUE
 * (Queue producer). Without them POST /caption-jobs answers
 * 501 so callers can fall back to the synchronous endpoint.
 */
export function createRequestHandler({ fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {

    function bindings(env) {
        const e = env || {};
        return { store: e.JOB_STORE || null, queue: e.CAPTION_QUEUE || null };
    }

    async function handleEnqueue(request, env) {
        const { store, queue } = bindings(env);
        if (!store || !queue) {
            return jsonError(
                "queue-unavailable",
                "The caption queue is not configured on this Worker.",
                501
            );
        }
        let body = null;
        try {
            body = await request.json();
        } catch {
            return jsonError("invalid-request", "The request body must be JSON.", 400);
        }
        const videoId = body && body.v;
        if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
            return jsonError(
                "invalid-video-id",
                "The v parameter must be an 11-character YouTube video ID.",
                400
            );
        }
        const lang = body && body.lang !== undefined ? body.lang : null;
        if (lang !== null && !LANG_PATTERN.test(lang)) {
            return jsonError(
                "invalid-language",
                "The lang parameter must be a BCP 47 language code.",
                400
            );
        }
        // Bound KV growth: refuse to pile up when the backlog is
        // already deep instead of accepting work we cannot drain.
        const pendingRaw = await store.get("queue:pending");
        const pending = pendingRaw === null ? 0 : Number(pendingRaw);
        if (Number.isFinite(pending) && pending >= MAX_BACKLOG) {
            return jsonError(
                "queue-full",
                "The caption queue is full. Try again in a little while.",
                429
            );
        }
        let created = null;
        try {
            // Fair use: 1 request per user every 10 minutes.
            // The client IP (Cloudflare's CF-Connecting-IP) is
            // hashed before storage; raw IPs never touch KV.
            // Without an identifiable client (tests, direct
            // deploys) the slot is skipped: notBefore stays null.
            const clientIp = request.headers.get("CF-Connecting-IP");
            const notBefore = clientIp
                ? await claimUserSlot(store, await hashClientIp(clientIp))
                : null;
            created = await createJob(store, queue, { videoId, lang, notBefore });
        } catch (err) {
            // Pre-acceptance infrastructure failure: the job never
            // entered the queue, so the caller may fall back to the
            // synchronous endpoint.
            if (err && err.code === "QUEUE_SEND_FAILED") {
                return jsonError(
                    "queue-unavailable",
                    "The caption queue is not accepting requests right now.",
                    503
                );
            }
            throw err;
        }
        const { record, backlog } = created;
        const status = await publicJobStatus(store, record);
        return new Response(JSON.stringify({ job: status, backlog }), {
            status: 202,
            headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" })
        });
    }

    async function handleJobStatus(jobId, env) {
        const { store } = bindings(env);
        if (!store) {
            return jsonError("queue-unavailable", "The caption queue is not configured on this Worker.", 501);
        }
        const record = await getJob(store, jobId);
        if (!record) {
            return jsonError("job-not-found", "No caption job with that id.", 404);
        }
        const status = await publicJobStatus(store, record);
        return new Response(JSON.stringify({ job: status }), {
            status: 200,
            headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" })
        });
    }

    async function handleJobResult(jobId, env) {
        const { store } = bindings(env);
        if (!store) {
            return jsonError("queue-unavailable", "The caption queue is not configured on this Worker.", 501);
        }
        const record = await getJob(store, jobId);
        if (!record) {
            return jsonError("job-not-found", "No caption job with that id.", 404);
        }
        if (record.status !== "completed") {
            return jsonError(
                "result-not-ready",
                `The job is ${record.status}; no result is available yet.`,
                409
            );
        }
        const vtt = await store.get(`jobresult:${jobId}`, { type: "text" });
        if (!vtt) {
            return jsonError("result-expired", "The job result has expired.", 410);
        }
        const meta = record.resultMeta || {};
        return vttResponse(vtt, {
            language: meta.language,
            generated: meta.generated,
            source: meta.source,
            format: meta.format,
            videoTitle: meta.videoTitle ? encodeVideoTitle(meta.videoTitle) : null,
            videoDuration: meta.videoDurationSeconds
        });
    }

    return async function handleRequest(request, env = {}) {
        const url = new URL(request.url);
        const method = String(request.method || "GET").toUpperCase();

        if (method === "OPTIONS") return optionsResponse();

        if (url.pathname === "/caption-jobs" && method === "POST") {
            return handleEnqueue(request, env);
        }
        const jobMatch = url.pathname.match(/^\/caption-jobs\/([^/]+)(\/result)?$/);
        if (jobMatch && method === "GET") {
            return jobMatch[2]
                ? handleJobResult(jobMatch[1], env)
                : handleJobStatus(jobMatch[1], env);
        }

        if (url.pathname !== "/youtube-transcript") {
            return jsonError("not-found", "Use GET /youtube-transcript?v=VIDEO_ID.", 404);
        }

        if (method !== "GET") {
            return jsonError("not-found", "Only GET and OPTIONS are supported.", 405);
        }

        const videoId = url.searchParams.get("v");
        if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
            return jsonError(
                "invalid-video-id",
                "The v parameter must be an 11-character YouTube video ID.",
                400
            );
        }

        const lang = url.searchParams.get("lang");
        if (lang !== null && !LANG_PATTERN.test(lang)) {
            return jsonError(
                "invalid-language",
                "The lang parameter must be a BCP 47 language code.",
                400
            );
        }

        const outcome = await retrieveCaptions(videoId, lang, fetchImpl, timeoutMs);
        if (!outcome.ok) {
            return jsonError(outcome.errorType, outcome.message, outcome.httpStatus);
        }
        return vttResponse(outcome.vtt, {
            language: outcome.meta.language,
            generated: outcome.meta.generated,
            source: outcome.meta.source,
            format: outcome.meta.format,
            videoTitle: encodeVideoTitle(outcome.meta.videoTitle),
            videoDuration: outcome.meta.videoDuration
        });
    };
}

export default {
    async fetch(request, env) {
        return createRequestHandler()(request, env || {});
    },
    // Cloudflare Queue consumer: each message is one caption job.
    // retrieveCaptions is the same core the synchronous endpoint
    // uses — one retrieval implementation, two entry points.
    //
    // Polite spacing between messages: YouTube throttles
    // automated caption requests adaptively and publishes no
    // fixed cooldown, so the consumer spaces its requests
    // instead of bursting. This is politeness, not a claimed
    // YouTube cooldown number.
    async queue(batch, env) {
        const store = env && env.JOB_STORE ? env.JOB_STORE : null;
        const retrieve = (videoId, lang) => retrieveCaptions(videoId, lang, fetch);
        let first = true;
        for (const msg of batch.messages) {
            if (!store) {
                // Misconfigured: never let messages poison-loop.
                msg.ack();
                continue;
            }
            if (!first) await sleep(MESSAGE_SPACING_MS);
            first = false;
            await processJobMessage(msg.body, { store, retrieve, msg });
        }
    }
};

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
// video content, no transcript storage (no KV/R2/D1), no logging
// of transcript contents. Only the video ID (and an optional
// language code) is accepted from the caller; arbitrary upstream
// URLs can never be supplied.
// ============================================================

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const LANG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const FETCH_TIMEOUT_MS = 20000;
// YouTube's own public InnerTube client key, embedded in
// youtube.com's JavaScript. Public, not a private credential.
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
// A desktop browser UA: YouTube serves bot/consent pages to
// non-browser user agents, which would hide the caption tracks.
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const EXPOSED_CAPTION_HEADERS =
    "X-Caption-Language, X-Caption-Generated, X-Caption-Source, X-Caption-Format, X-Video-Title";

// Video titles travel as a response header (percent-encoded UTF-8,
// since HTTP headers are Latin-1). Truncated to keep headers small.
const MAX_TITLE_LENGTH = 300;

function encodeVideoTitle(title) {
    if (typeof title !== "string") return null;
    const trimmed = title.trim();
    if (!trimmed) return null;
    return encodeURIComponent(trimmed.slice(0, MAX_TITLE_LENGTH));
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
    return new Response(body, { status: 200, headers });
}

/** CORS preflight response. */
export function optionsResponse() {
    return new Response(null, {
        status: 204,
        headers: corsHeaders({
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Accept",
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
    return { tracks: Array.isArray(tracks) ? tracks : null, title };
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
    if (raw === null) return { tracks: null, title: extractVideoTitle(html) };
    let title = extractVideoTitle(html);
    try {
        const parsed = JSON.parse(raw);
        return { tracks: Array.isArray(parsed) ? parsed : null, title };
    } catch {
        return { malformed: true, title };
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
 * Build the request handler. fetchImpl defaults to the global
 * fetch (the Workers runtime); tests inject a mock.
 */
export function createRequestHandler({ fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    return async function handleRequest(request) {
        const url = new URL(request.url);
        const method = String(request.method || "GET").toUpperCase();

        if (method === "OPTIONS") return optionsResponse();

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

        // 1. Gather caption tracks: InnerTube first, watch page as fallback.
        let tracks = null;
        let mechanism = null;
        let softFailure = null;
        let videoTitle = null;
        try {
            const inner = await captionTracksViaInnerTube(videoId, fetchImpl, timeoutMs);
            if (inner.rateLimited) softFailure = "rate-limited";
            else if (inner.tracks) { tracks = inner.tracks; mechanism = "innertube"; }
            else if (inner.malformed || inner.httpStatus) softFailure = "retrieval-failure";
            if (inner.title) videoTitle = inner.title;
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
            return jsonError(type, message, status);
        }

        const track = selectTrack(tracks, lang);
        if (!track) {
            return jsonError(
                "track-unavailable",
                lang
                    ? `YouTube has no usable caption track matching "${lang}".`
                    : "YouTube listed no usable caption track for this video.",
                404
            );
        }

        // 2. Verify the track URL, then fetch it VERBATIM.
        //    Only YouTube timed-text hosts are allowed — the caller
        //    can never supply an arbitrary upstream URL.
        let trackHost;
        try {
            trackHost = new URL(track.baseUrl).hostname;
        } catch {
            return jsonError("malformed-response", "The caption track URL was not a valid URL.", 502);
        }
        if (!timedTextHostOk(trackHost)) {
            return jsonError(
                "malformed-response",
                "The caption track URL was not a YouTube timedtext host.",
                502
            );
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
                return jsonError("rate-limited", "YouTube is rate-limiting requests from this network.", 429);
            }
            if (!res.ok) {
                const type = statusToErrorType(res.status);
                const messages = {
                    "transcript-unavailable": "The caption track is no longer available.",
                    "retrieval-failure": `The caption track returned HTTP ${res.status}.`
                };
                return jsonError(type, messages[type], statusToHttpStatus(res.status));
            }
            const raw = await res.text();
            if (raw.replace(/^\uFEFF/, "").trimStart().startsWith("WEBVTT")) {
                body = raw;
            } else {
                const vtt = timedTextXmlToVtt(raw);
                if (vtt === null) {
                    return jsonError("malformed-response", "The caption track was not valid WebVTT.", 502);
                }
                body = vtt;
                sourceFormat = "xml";
            }
        } catch (err) {
            const timedOut = isTimeoutError(err);
            return jsonError(
                timedOut ? "timeout" : "retrieval-failure",
                timedOut ? "The caption track took too long to respond." : "Could not fetch the caption track.",
                timedOut ? 504 : 502
            );
        }

        return vttResponse(body, {
            language: track.languageCode,
            generated: !isManual(track),
            source: mechanism || "unknown",
            format: sourceFormat,
            videoTitle: encodeVideoTitle(videoTitle)
        });
    };
}

export default {
    async fetch(request) {
        return createRequestHandler()(request);
    }
};

// ==========================================================
// adapters/youtube-native.js
// Responsibility: retrieve a YouTube video's EXISTING caption
// track directly from YouTube — no API key, no third party, no
// backend. EVERYTHING YouTube-specific (watch-page scrape,
// caption-track selection, timedtext fetch) stays in this file
// and is returned as an AdapterResponse (see ../provider.js).
//
// Mechanism: GET the watch page, extract the "captionTracks"
// array from the embedded player response, pick a track (manual
// captions preferred; auto-generated accepted), then GET its
// timedtext URL with fmt=vtt. The VTT is handed to the app's
// existing VTT parser verbatim — timestamps, ordering, and text
// are YouTube's, untouched.
//
// Request destinations: www.youtube.com (watch page) and the
// track's own timedtext URL (which must be a YouTube/Google
// video host). The request carries only the video id — never
// transcript content, never credentials.
//   fetch: credentials "omit", referrerPolicy "no-referrer",
//   cache "no-store".
//
// KNOWN LIMITATION (documented, not hidden): this is a direct
// browser fetch, so it only works where the browser is allowed
// to read youtube.com responses. A plain static page is normally
// blocked by YouTube's CORS policy, in which case the fetch
// fails and this provider reports PROVIDER_UNAVAILABLE — the
// app then falls back to the next provider (e.g. Supadata).
// The provider stays behind the provider interface, so it can
// be replaced later without touching TranscriptDocument
// consumers.
//
// SECURITY
//   - No credential exists for this path; nothing is hardcoded.
//   - The watch-page HTML is untrusted: caption data is pulled
//     out with a JSON-substring parser (never inserted into the
//     DOM), and the track URL must be https on a YouTube/Google
//     video host before it is fetched.
//   - YouTube's error text is never kept; only short codes.
// ==========================================================

import { defineProvider, PROVIDER_STATUS, METHOD_PREFERENCE } from "../provider.js";
import { ACQUISITION_ERROR_CODES as CODES } from "../errors.js";

export const YOUTUBE_NATIVE_ID = "youtube-native";

const CAPTION_TRACKS_MARKER = "\"captionTracks\":";

// Hosts a YouTube timedtext track URL may legitimately use.
const TIMEDTEXT_HOSTS = new Set([
    "www.youtube.com",
    "youtube.com",
    "m.youtube.com",
    "video.google.com"
]);

const isAllowedTimedtextHost = (hostname) =>
    TIMEDTEXT_HOSTS.has(hostname) || hostname.endsWith(".googlevideo.com");

const fail = (code, detail = {}) => ({ success: false, error: { code, detail } });

function codeForHttpStatus(status) {
    if (status === 429) return CODES.RATE_LIMITED;
    if (status === 404) return CODES.VIDEO_UNAVAILABLE;
    if (status === 408 || status === 504) return CODES.PROVIDER_TIMEOUT;
    if (status >= 500) return CODES.PROVIDER_UNAVAILABLE;
    return CODES.PROVIDER_ERROR;
}

const DEFAULTS = Object.freeze({
    requestDeadlineMs: 25000   // below the manager's 30 s timeout
});

/**
 * Pull one JSON value (array or object) out of a larger string,
 * starting right after `marker`. Handles nested brackets and
 * quoted strings with escapes. Returns the substring, or null.
 */
export function extractJsonValue(text, marker) {
    const at = text.indexOf(marker);
    if (at === -1) return null;
    let i = at + marker.length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const open = text[i];
    const close = open === "[" ? "]" : open === "{" ? "}" : null;
    if (close === null) return null;
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === "\"") inString = false;
        } else if (ch === "\"") {
            inString = true;
        } else if (ch === open) {
            depth += 1;
        } else if (ch === close) {
            depth -= 1;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

// A raw captionTracks entry → the fields this adapter needs.
// Anything else is dropped. Returns null when unusable.
export function normalizeCaptionTrack(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const baseUrl = typeof entry.baseUrl === "string" && entry.baseUrl.length > 0 ? entry.baseUrl : null;
    const languageCode = typeof entry.languageCode === "string" && entry.languageCode.length > 0
        ? entry.languageCode : null;
    if (!baseUrl || !languageCode) return null;
    let name = null;
    if (entry.name && typeof entry.name === "object") {
        if (typeof entry.name.simpleText === "string") name = entry.name.simpleText;
        else if (Array.isArray(entry.name.runs)) {
            name = entry.name.runs
                .filter((run) => run && typeof run.text === "string")
                .map((run) => run.text)
                .join("") || null;
        }
    }
    return {
        baseUrl,
        languageCode,
        kind: entry.kind === "asr" ? "asr" : "manual",   // "asr" = auto-generated
        vssId: typeof entry.vssId === "string" && entry.vssId.length > 0 ? entry.vssId : null,
        name
    };
}

/**
 * Pick the track to fetch.
 *   method "native"    → manual captions only
 *   method "generated" → auto-generated only
 *   method "any"       → manual preferred, auto-generated accepted
 * A requested language is preferred (exact, then base-language
 * match); otherwise the provider default is used and the ACTUAL
 * language is always reported in provenance — never claimed.
 * Returns null when nothing matches the requested method.
 */
export function selectCaptionTrack(tracks, { language = null, method = METHOD_PREFERENCE.ANY } = {}) {
    let pool = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
    if (method === METHOD_PREFERENCE.NATIVE) pool = pool.filter((track) => track.kind !== "asr");
    else if (method === METHOD_PREFERENCE.GENERATED) pool = pool.filter((track) => track.kind === "asr");
    if (pool.length === 0) return null;

    if (typeof language === "string" && language.length > 0) {
        const wanted = language.toLowerCase();
        const exact = pool.find((track) => track.languageCode.toLowerCase() === wanted);
        if (exact) return exact;
        const base = wanted.split("-")[0];
        const loose = pool.find((track) => {
            const code = track.languageCode.toLowerCase();
            return code === base || code.split("-")[0] === base;
        });
        if (loose) return loose;
    }
    return pool.find((track) => track.kind !== "asr") || pool[0];
}

function looksLikeVtt(text) {
    return text.replace(/^\uFEFF/, "").trimStart().slice(0, 6) === "WEBVTT";
}

/**
 * Factory so tests can inject fetch and time.
 * @param {object} deps
 * @param {(url:string, init:object) => Promise<Response>} [deps.fetchImpl]
 * @param {number} [deps.requestDeadlineMs]
 */
export function createYouTubeNativeProvider({ fetchImpl, requestDeadlineMs } = {}) {
    const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
    const deadlineMs = requestDeadlineMs ?? DEFAULTS.requestDeadlineMs;

    // One HTTP GET → { status, text } | { failure } (an AdapterResponse failure).
    async function fetchText(url, accept, signal, step) {
        let response;
        try {
            response = await doFetch(url, {
                method: "GET",
                headers: { "Accept": accept },
                credentials: "omit",
                referrerPolicy: "no-referrer",
                cache: "no-store",
                signal
            });
        } catch (cause) {
            if (cause && cause.name === "AbortError") {
                return { failure: fail(CODES.PROVIDER_TIMEOUT, { deadlineMs, step }) };
            }
            // Offline, DNS, CORS, or TLS failure: the browser hides which.
            return { failure: fail(CODES.PROVIDER_UNAVAILABLE, { reason: "network request failed", step }) };
        }
        let text;
        try {
            text = await response.text();
        } catch {
            return { failure: fail(CODES.PROVIDER_UNAVAILABLE,
                { reason: "response body unreadable", httpStatus: response.status, step }) };
        }
        return { status: response.status, text };
    }

    async function getTranscript(video, options) {
        if (!video || video.platform !== "youtube") return fail(CODES.UNSUPPORTED_VIDEO, {});
        if (!video.videoId || !video.canonicalUrl) {
            return fail(CODES.INVALID_REQUEST, { reason: "video has no id or canonical URL" });
        }

        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), deadlineMs) : null;
        const signal = controller ? controller.signal : undefined;
        try {
            // 1. The watch page carries the player's caption track list.
            const page = await fetchText(video.canonicalUrl, "text/html", signal, "watch-page");
            if (page.failure) return page.failure;
            if (page.status !== 200) {
                return fail(codeForHttpStatus(page.status), { httpStatus: page.status, step: "watch-page" });
            }

            // 2. Extract and parse the captionTracks array.
            let parsed = null;
            const rawTracks = extractJsonValue(page.text, CAPTION_TRACKS_MARKER);
            if (rawTracks !== null) {
                try { parsed = JSON.parse(rawTracks); } catch { parsed = null; }
            }
            if (!Array.isArray(parsed)) {
                return fail(CODES.TRANSCRIPT_UNAVAILABLE, { reason: "no caption tracks in player response" });
            }
            const tracks = parsed.map(normalizeCaptionTrack).filter(Boolean);
            if (tracks.length === 0) {
                return fail(CODES.TRANSCRIPT_UNAVAILABLE, { reason: "no usable caption tracks" });
            }
            const track = selectCaptionTrack(tracks, options);
            if (!track) {
                return fail(CODES.TRANSCRIPT_UNAVAILABLE,
                    { reason: "no caption track matches the requested method" });
            }

            // 3. The track URL comes from YouTube's response — verify it
            //    before fetching.
            let trackUrl;
            try {
                trackUrl = new URL(track.baseUrl);
            } catch {
                return fail(CODES.MALFORMED_RESPONSE, { reason: "caption track URL is not a URL" });
            }
            if (trackUrl.protocol !== "https:" || !isAllowedTimedtextHost(trackUrl.hostname)) {
                return fail(CODES.MALFORMED_RESPONSE,
                    { reason: "caption track URL is not a YouTube timedtext host" });
            }
            trackUrl.searchParams.set("fmt", "vtt");

            // 4. Fetch the track. It is passed to the VTT parser verbatim.
            const captions = await fetchText(trackUrl.toString(), "text/vtt", signal, "caption-track");
            if (captions.failure) return captions.failure;
            if (captions.status !== 200) {
                return fail(codeForHttpStatus(captions.status),
                    { httpStatus: captions.status, step: "caption-track" });
            }
            if (!looksLikeVtt(captions.text)) {
                return fail(CODES.MALFORMED_RESPONSE, { reason: "caption track is not WebVTT" });
            }
            if (!/-->/.test(captions.text)) return fail(CODES.TRANSCRIPT_EMPTY, {});

            return {
                success: true,
                transcript: { rawText: captions.text, format: "vtt" },
                source: {
                    method: track.kind === "asr" ? "generated" : "native",
                    language: track.languageCode,          // validated by the provider boundary
                    sourceId: track.vssId || track.languageCode
                }
            };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    return defineProvider({
        id: YOUTUBE_NATIVE_ID,
        name: "YouTube native captions",
        description: "Fetches the video's existing YouTube captions directly — no API key needed. " +
            "Works when the video has captions and the browser can read YouTube responses.",
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

// The app's instance: real fetch, in-memory nothing (no credential).
export const provider = createYouTubeNativeProvider();

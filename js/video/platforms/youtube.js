// ==========================================================
// platforms/youtube.js
// Responsibility: recognize YouTube URLs and extract the
// video id. IDENTITY ONLY — this module does not fetch
// metadata, transcripts, or control any player.
//
// Handled forms:
//   https://www.youtube.com/watch?v=ID    (also youtube.com, m.youtube.com, music.youtube.com)
//   https://youtu.be/ID
//   https://www.youtube.com/embed/ID      (also youtube-nocookie.com)
//   https://www.youtube.com/shorts/ID
//   https://www.youtube.com/live/ID
//   https://www.youtube.com/v/ID          (legacy)
//
// Unrelated query parameters (t, si, list, feature, ...) do
// not affect identity and are ignored.
// ==========================================================

export const platformId = "youtube";
export const label = "YouTube";

const watchHosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"];
const embedHosts = ["youtube-nocookie.com", "www.youtube-nocookie.com"];
const shortHosts = ["youtu.be"];
const pathPrefixes = ["embed", "shorts", "live", "v"];

// YouTube video ids are 11 characters from [A-Za-z0-9_-].
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

export function matchesHost(hostname) {
    return watchHosts.includes(hostname) || embedHosts.includes(hostname) || shortHosts.includes(hostname);
}

export function buildCanonicalUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

// Returns the raw candidate id string (unvalidated), or null.
function extractCandidateId(parsedUrl) {
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);

    if (shortHosts.includes(parsedUrl.hostname)) {
        return pathParts[0] || null;
    }
    if (pathParts[0] === "watch") {
        return parsedUrl.searchParams.get("v");
    }
    if (pathPrefixes.includes(pathParts[0])) {
        return pathParts[1] || null;
    }
    return null;
}

/**
 * @param {URL} parsedUrl  Already parsed, http(s), host matched.
 * @returns {{success:true, videoId:string} | {success:false, code:string, message:string}}
 */
export function extractVideoId(parsedUrl) {
    const candidate = extractCandidateId(parsedUrl);

    if (candidate === null || candidate === "") {
        return {
            success: false,
            code: "missing_video_id",
            message: "This YouTube link does not point to a single video (e.g. a channel, playlist, or search page)."
        };
    }
    if (!videoIdPattern.test(candidate)) {
        return {
            success: false,
            code: "invalid_video_id",
            message: "This YouTube link contains a video ID in an unexpected format."
        };
    }
    return { success: true, videoId: candidate };
}

// ==========================================================
// video/metadata-provider.js
// Responsibility: fetch video metadata (title) from the
// YouTube Data API v3, using a user-supplied API key.
//
// SECURITY RULES (same as providers/credentials.js)
//   - The key is supplied at call time by the app, which holds
//     it in memory for the current page only. It is never
//     persisted, rendered, or logged here.
//   - The key travels only as a query parameter to
//     www.googleapis.com, the API's documented auth mechanism.
//   - Only the video title is requested (fields=...snippet(title));
//     nothing else is read from the response.
//   - The caller passes fetchFn for tests; production uses the
//     global fetch.
//
// Failure vocabulary (mirrors Stage 7/8 style):
//   "metadata_bad_key"    API rejected the key (400/401/403)
//   "metadata_not_found"  video has no retrievable title
//                         (404, or 200 with no usable item)
//   "metadata_network"    the request itself failed
//   "metadata_unexpected" response was not the documented shape
// ==========================================================

export const METADATA_ERROR_CODES = Object.freeze({
    BAD_KEY: "metadata_bad_key",
    NOT_FOUND: "metadata_not_found",
    NETWORK: "metadata_network",
    UNEXPECTED: "metadata_unexpected"
});

export class MetadataError extends Error {
    constructor(code, message, detail = null) {
        super(message);
        this.name = "MetadataError";
        this.code = code;
        this.detail = detail;
    }
}

const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

function isUsableTitle(value) {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * Fetch a YouTube video's title.
 *
 * @param {string} videoId  YouTube video id (e.g. "dQw4w9WgXcQ").
 * @param {string} apiKey   User-supplied YouTube Data API key.
 * @param {object} [options]
 * @param {Function} [options.fetchFn]  fetch implementation (tests inject a mock).
 * @returns {Promise<{title:string}>}
 * @throws {MetadataError} with a METADATA_ERROR_CODES code.
 */
export async function fetchYouTubeTitle(videoId, apiKey, { fetchFn = fetch } = {}) {
    if (typeof videoId !== "string" || videoId.trim() === "" ||
        typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new MetadataError(METADATA_ERROR_CODES.UNEXPECTED,
            "A video id and API key are required to fetch a title.");
    }

    const url = `${VIDEOS_ENDPOINT}?part=snippet` +
        `&id=${encodeURIComponent(videoId.trim())}` +
        `&fields=${encodeURIComponent("items(snippet(title))")}` +
        `&key=${encodeURIComponent(apiKey.trim())}`;

    let response;
    try {
        response = await fetchFn(url, { method: "GET" });
    } catch (cause) {
        throw new MetadataError(METADATA_ERROR_CODES.NETWORK,
            "Could not reach the YouTube Data API. Check the connection and try again.",
            { cause: cause && cause.message ? cause.message : String(cause) });
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new MetadataError(METADATA_ERROR_CODES.BAD_KEY,
            "YouTube rejected the API key. Check the key and try again.",
            { httpStatus: response.status });
    }
    if (response.status === 404) {
        throw new MetadataError(METADATA_ERROR_CODES.NOT_FOUND,
            "YouTube has no title for this video (it may be private or removed).",
            { httpStatus: response.status });
    }
    if (!response.ok) {
        throw new MetadataError(METADATA_ERROR_CODES.NETWORK,
            "The YouTube Data API returned an unexpected response.",
            { httpStatus: response.status });
    }

    let body;
    try {
        body = await response.json();
    } catch (cause) {
        throw new MetadataError(METADATA_ERROR_CODES.UNEXPECTED,
            "The YouTube Data API returned a response that could not be read.",
            { cause: cause && cause.message ? cause.message : String(cause) });
    }

    const items = body && Array.isArray(body.items) ? body.items : null;
    const title = items && items.length > 0 ? items[0] && items[0].snippet && items[0].snippet.title : null;
    if (!isUsableTitle(title)) {
        throw new MetadataError(METADATA_ERROR_CODES.NOT_FOUND,
            "YouTube returned no title for this video.");
    }
    return { title: title.trim() };
}

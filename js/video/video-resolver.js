// ==========================================================
// video-resolver.js
// Responsibility: turn an untrusted, user-typed URL into a
// video IDENTITY, or a structured failure. Platform-neutral:
// all platform-specific rules live in ./platforms/*.js.
//
//   user text → safe URL parse → platform detection
//             → platform adapter → canonical identity
//
// The resolver never fetches anything, never throws for bad
// input, and never guesses: failure stays distinguishable
// from success via the `success` flag and an error code.
// ==========================================================

import { createVideoIdentity } from "./video-model.js";
import * as youtube from "./platforms/youtube.js";

// Registered platform adapters. To add a platform (e.g. Twitch):
// create ./platforms/twitch.js with the same exports and add it here.
const platformAdapters = [youtube];

const maxUrlLength = 2048;

export function getSupportedPlatforms() {
    return platformAdapters.map((adapter) => ({ id: adapter.platformId, label: adapter.label }));
}

export function getPlatformLabel(platformId) {
    const adapter = platformAdapters.find((item) => item.platformId === platformId);
    return adapter ? adapter.label : platformId;
}

function failure(code, message, detail = {}) {
    return { success: false, error: { code, message, detail } };
}

// Accept "youtu.be/ID" without a scheme by assuming https. Anything that
// already has a scheme (including javascript:, data:, ftp:) is left as-is
// so the protocol check below can reject it.
function withAssumedScheme(text) {
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
    return hasScheme ? text : `https://${text}`;
}

function parseUrlSafely(text) {
    try {
        return new URL(withAssumedScheme(text));
    } catch {
        return null;
    }
}

/**
 * Resolve a user-provided URL into a video identity.
 *
 * @param {unknown} input  Raw user input (untrusted).
 * @returns {{success:true, video:object} | {success:false, error:{code:string, message:string, detail:object}}}
 *          On success, `video` is a frozen identity from createVideoIdentity().
 */
export function resolveVideoUrl(input) {
    if (typeof input !== "string" || input.trim() === "") {
        return failure("empty_url", "Enter a video URL.");
    }

    const text = input.trim();
    if (text.length > maxUrlLength) {
        return failure("url_too_long", "That URL is too long to be a video link.", { length: text.length });
    }
    if (/\s/.test(text)) {
        return failure("malformed_url", "That doesn't look like a valid URL.", { reason: "contains whitespace" });
    }

    const parsedUrl = parseUrlSafely(text);
    if (!parsedUrl) {
        return failure("malformed_url", "That doesn't look like a valid URL.");
    }
    // Protocol first, so javascript:/data: are reported as such.
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        return failure("unsupported_protocol", "Only http:// and https:// links are supported.",
            { protocol: parsedUrl.protocol });
    }
    if (!parsedUrl.hostname) {
        return failure("malformed_url", "That doesn't look like a valid URL.");
    }
    if (parsedUrl.username || parsedUrl.password) {
        return failure("malformed_url", "Links containing login details are not supported.");
    }

    const adapter = platformAdapters.find((item) => item.matchesHost(parsedUrl.hostname));
    if (!adapter) {
        const labels = getSupportedPlatforms().map((platform) => platform.label).join(", ");
        return failure("unsupported_platform", `This site isn't supported yet. Supported: ${labels}.`,
            { hostname: parsedUrl.hostname });
    }

    const extracted = adapter.extractVideoId(parsedUrl);
    if (!extracted.success) {
        return failure(extracted.code, extracted.message, { platform: adapter.platformId });
    }

    return {
        success: true,
        video: createVideoIdentity({
            platform: adapter.platformId,
            videoId: extracted.videoId,
            canonicalUrl: adapter.buildCanonicalUrl(extracted.videoId),
            url: input          // exactly as entered (source evidence)
        })
    };
}

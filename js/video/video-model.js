// ==========================================================
// video-model.js
// Responsibility: define the canonical VIDEO model.
// Factory functions only — no URL parsing, no network, no
// player logic.
//
// A video has two strictly separate parts:
//
//   identity  WHICH video this is (platform, videoId,
//             canonicalUrl). Known locally from the URL.
//   metadata  WHAT the video is like (title, thumbnail,
//             duration). Only a future metadata provider may
//             fill these in. Until then they are null.
//
// Unknown is not false: null means "not acquired", never
// "empty" or "none". UI fallbacks such as "Not loaded" are
// display text only and are never stored here.
// ==========================================================

export const VIDEO_SCHEMA_VERSION = 1;

// metadata.status values:
//   "unknown"      no metadata has been requested (Stage 1.6: always)
//   "loading"      a provider request is in flight        (future)
//   "loaded"       provider returned metadata             (future)
//   "unavailable"  provider says the video has none/private (future)
//   "failed"       provider request failed                (future)
export const METADATA_STATUS = Object.freeze({
    UNKNOWN: "unknown",
    LOADING: "loading",
    LOADED: "loaded",
    UNAVAILABLE: "unavailable",
    FAILED: "failed"
});

/**
 * Identity produced by the resolver for one video.
 *
 * @param {object} fields
 * @param {string} fields.platform      Platform id, e.g. "youtube".
 * @param {string} fields.videoId       Platform's own video id.
 * @param {string} fields.canonicalUrl  One stable URL for this video.
 * @param {string} fields.url           The URL exactly as the user entered it (source evidence).
 */
export function createVideoIdentity({ platform, videoId, canonicalUrl, url }) {
    return Object.freeze({ platform, videoId, canonicalUrl, url });
}

function createEmptyMetadata() {
    return Object.freeze({
        title: null,
        thumbnailUrl: null,
        durationSeconds: null,
        status: METADATA_STATUS.UNKNOWN,
        provider: null,          // which metadata provider supplied the values (future)
        retrievedAt: null
    });
}

/**
 * Create a Video from a resolved identity. Metadata starts empty.
 */
export function createVideo(identity) {
    return Object.freeze({
        schemaVersion: VIDEO_SCHEMA_VERSION,
        identity,
        metadata: createEmptyMetadata()
    });
}

// Two videos are the same video when platform + videoId match.
// (URLs are not compared: many URLs point to one video.)
export function isSameVideo(videoA, videoB) {
    if (!videoA || !videoB) return false;
    return videoA.identity.platform === videoB.identity.platform &&
        videoA.identity.videoId === videoB.identity.videoId;
}

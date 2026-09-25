// ==========================================================
// video-model.js
// Responsibility: define the canonical VIDEO model.
// Factory functions only — no URL parsing, no network, no
// player logic.
//
// A video has strictly separate parts:
//
//   identity       WHICH video this is (platform, videoId,
//                  canonicalUrl). Known locally from the URL.
//   metadata       WHAT the video is like (title, thumbnail,
//                  duration). Only a future metadata provider may
//                  fill these in. Until then they are null.
//   startPosition  An optional playback HINT read from the URL
//                  (e.g. YouTube "?t=1m20s"). NOT identity: two
//                  URLs with different hints are the same video.
//                  Never verified against the video.
//
// Unknown is not false: null means "not acquired", never
// "empty" or "none". UI fallbacks such as "Not loaded" are
// display text only and are never stored here.
// ==========================================================

import { createTimestamp, TIMESTAMP_STATUS } from "../transcript/model.js";

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
 * Start-position hint. Uses the Stage 1.5 timestamp shape
 * {raw, seconds, status} — there is no second timestamp format.
 *
 * @param {object} fields
 * @param {string} fields.raw        Time text exactly as in the URL, e.g. "1m20s".
 * @param {number|null} fields.seconds  Derived seconds; null unless status is "parsed".
 * @param {string} fields.status     TIMESTAMP_STATUS value.
 * @param {string} fields.sourceUrl  The exact URL the hint came from.
 */
export function createStartPosition({ raw, seconds, status, sourceUrl }) {
    const timestamp = createTimestamp({ raw, seconds, status });
    return Object.freeze({
        ...timestamp,
        seconds: timestamp.status === TIMESTAMP_STATUS.PARSED ? timestamp.seconds : null,
        source: "url",
        sourceUrl,
        verified: false          // never checked against the actual video
    });
}

/**
 * Create a Video from a resolved identity. Metadata starts empty.
 * startPosition is a createStartPosition() result or null.
 */
export function createVideo(identity, startPosition = null) {
    return Object.freeze({
        schemaVersion: VIDEO_SCHEMA_VERSION,
        identity,
        metadata: createEmptyMetadata(),
        startPosition
    });
}

// Same video, different hint: returns a new Video that keeps the
// identity and metadata objects and swaps only the hint.
export function withStartPosition(video, startPosition) {
    return Object.freeze({ ...video, startPosition });
}

export function isSameStartPosition(a, b) {
    if (a === null || b === null) return a === b;
    return a.raw === b.raw && a.seconds === b.seconds && a.status === b.status;
}

// Two videos are the same video when platform + videoId match.
// (URLs are not compared: many URLs point to one video.)
export function isSameVideo(videoA, videoB) {
    if (!videoA || !videoB) return false;
    return videoA.identity.platform === videoB.identity.platform &&
        videoA.identity.videoId === videoB.identity.videoId;
}

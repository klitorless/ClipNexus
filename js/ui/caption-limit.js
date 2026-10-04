// ==========================================================
// caption-limit.js
// Responsibility: shared, honest copy explaining the YouTube
// caption service's rate limit — used by the Dashboard notice,
// the Transcripts error view, and the Help page so all three
// say the same thing.
//
// What is verified and what is not:
//   - VERIFIED: YouTube throttles automated caption requests;
//     the throttle is adaptive and IP-based, and YouTube
//     publishes no fixed cooldown number. Six rapid requests
//     from one network succeeded in testing (2026-10-03) —
//     there is no strict per-second limit to quote.
//   - VERIFIED (2026-10-03, supadata.ai): Supadata's free tier
//     is 100 credits/month, no card required; a native
//     transcript costs 1 credit. Pricing can change.
//   - NOT claimed: any specific cooldown duration.
// ==========================================================

import { YOUTUBE_NATIVE_ID } from "../transcript/providers/adapters/youtube-native.js";

// Error codes from the youtube-native provider that mean
// "YouTube is throttling the caption service" (as opposed to
// "this video has no captions" etc.).
const LIMIT_CODES = new Set(["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT"]);

export function isCaptionLimitError(error) {
    return !!error &&
        error.providerId === YOUTUBE_NATIVE_ID &&
        LIMIT_CODES.has(error.code);
}

export function isCaptionRateLimited(error) {
    return !!error &&
        error.providerId === YOUTUBE_NATIVE_ID &&
        error.code === "RATE_LIMITED";
}

// Short explainer for inline notices (Dashboard, error view).
export const CAPTION_LIMIT_EXPLAINER =
    "YouTube limits how often the caption service can request captions. " +
    "The cooldown is set by YouTube — it varies and isn't published, " +
    "but waiting a while before retrying usually helps.";

// The Supadata bypass, with verified free-tier facts and a
// pricing-can-change caveat. Never hardcode other numbers.
export const SUPADATA_BYPASS_EXPLAINER =
    "A Supadata API key bypasses this limit entirely: Supadata fetches " +
    "transcripts through its own service instead of YouTube's caption " +
    "endpoints. Its free tier includes 100 credits per month " +
    "(a native transcript costs 1 credit, no card required); " +
    "pricing can change, so check supadata.ai/pricing for current numbers. " +
    "Enter your key on the Transcripts page — it stays in memory for " +
    "this page session only.";

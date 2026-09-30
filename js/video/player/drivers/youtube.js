// ==========================================================
// drivers/youtube.js
// Responsibility: the YouTube embedded-player driver — PURE
// functions mapping a canonical YouTube video identity to a
// privacy-enhanced embed and to the YouTube IFrame Player
// postMessage protocol.
//
// No DOM, no network, no state. The controller
// (../controller.js) owns the live iframe and the readiness
// handshake; this module only computes values, so every rule
// is unit-testable under Node.
//
// Embedding uses the privacy-enhanced host
// https://www.youtube-nocookie.com with enablejsapi=1 and the
// supported postMessage player protocol. The YouTube IFrame
// Player JS API script is deliberately NOT loaded, so
// script-src stays 'self' — the only CSP change Stage 10 needs
// is frame-src for this host.
//
// The iframe source is built ONLY from a validated canonical
// video identity — never from user input. isExpectedEmbedUrl is
// the strict allowlist the controller enforces as defense in
// depth before any iframe is created.
// ==========================================================

import { AppError } from "../../../core/errors.js";
import { isValidVideoId } from "../../platforms/youtube.js";

export const YOUTUBE_NOCOOKIE_HOST = "www.youtube-nocookie.com";
export const YOUTUBE_MESSAGE_ORIGIN = "https://www.youtube-nocookie.com";

export const playerPlatform = "youtube";

/**
 * Whether this driver can play the given canonical video
 * identity. The video id must still match YouTube's canonical
 * shape — a resolved identity is trusted, but the embed URL is
 * only ever built from validated parts.
 */
export function canPlayVideo(identity) {
    return !!identity && identity.platform === "youtube" && isValidVideoId(identity.videoId);
}

/**
 * Build the privacy-enhanced embed URL for a playable identity.
 * Throws for anything canPlayVideo rejects.
 */
export function buildEmbedUrl(identity) {
    if (!canPlayVideo(identity)) {
        throw new AppError("unplayable_video_identity",
            "Cannot build a YouTube embed URL for this video identity.",
            { platform: identity ? identity.platform : null });
    }
    return `https://${YOUTUBE_NOCOOKIE_HOST}/embed/${identity.videoId}?enablejsapi=1&rel=0`;
}

/**
 * Strict allowlist for iframe sources: the ONLY embed form the
 * player may ever use. Rejects http, wrong hosts, wrong paths,
 * malformed ids, and any parameter outside the driver's own set.
 */
export function isExpectedEmbedUrl(url) {
    if (typeof url !== "string") return false;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== YOUTUBE_NOCOOKIE_HOST) return false;
    if (!/^\/embed\/[A-Za-z0-9_-]{11}$/.test(parsed.pathname)) return false;
    const keys = [...parsed.searchParams.keys()];
    return keys.every((key) => key === "enablejsapi" || key === "rel");
}

/**
 * Serialize a seek command for the YouTube postMessage player
 * protocol: seekTo(seconds, allowSeekAhead=true).
 */
export function createSeekCommand(seconds) {
    return JSON.stringify({ event: "command", func: "seekTo", args: [seconds, true] });
}

/** Begin the readiness handshake; the player answers onReady. */
export function createListenCommand() {
    return JSON.stringify({ event: "listening" });
}

/** Whether an incoming postMessage payload is the player's onReady. */
export function isPlayerReadyMessage(data) {
    if (typeof data !== "string") return false;
    try {
        const message = JSON.parse(data);
        return !!message && message.event === "onReady";
    } catch {
        return false;
    }
}

export const youtubePlayerDriver = Object.freeze({
    platform: playerPlatform,
    messageOrigin: YOUTUBE_MESSAGE_ORIGIN,
    canPlayVideo,
    buildEmbedUrl,
    isExpectedEmbedUrl,
    createSeekCommand,
    createListenCommand,
    isPlayerReadyMessage
});

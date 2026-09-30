// ==========================================================
// controller.js
// Responsibility: provider-neutral embedded-player controller
// contract. A controller is created for ONE canonical video
// identity and ONE DOM mount. It is a LIVE object — it owns the
// iframe element, the readiness handshake, and the seek queue —
// and must NEVER enter the immutable Project or serializable
// state. The application coordinator (js/app.js) owns controller
// instances.
//
// Contract:
//
//   createPlayerController({ driver, identity, mountElement, host })
//     -> { ready, destroyed, queuedSeekCount, seek(seconds), destroy() }
//
//   driver       provider driver (e.g. drivers/youtube.js)
//   identity     canonical video identity (platform + videoId)
//   mountElement DOM element the player iframe is mounted into
//   host         { document, window } — injected so the
//                controller is unit-testable (mirrors the
//                fetchImpl/sleep/now injection used by the
//                transcript provider adapters)
//
// Readiness is mandatory: seeks requested before the embedded
// player signals ready are QUEUED in order and executed once
// the player is ready. A seek is never silently lost.
//
// The controller never builds URLs itself and never touches
// user input: the iframe source comes only from
// driver.buildEmbedUrl(identity) and must pass
// driver.isExpectedEmbedUrl — defense in depth against
// arbitrary iframe sources.
// ==========================================================

import { AppError } from "../../core/errors.js";

function assertDriver(driver) {
    const methods = ["canPlayVideo", "buildEmbedUrl", "isExpectedEmbedUrl",
        "createSeekCommand", "createListenCommand", "isPlayerReadyMessage"];
    const ok = driver && typeof driver.messageOrigin === "string" &&
        methods.every((name) => typeof driver[name] === "function");
    if (!ok) {
        throw new AppError("invalid_player_driver",
            "The player controller needs a driver with the full player-driver contract.", {});
    }
    return driver;
}

function assertValidSeconds(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        throw new AppError("invalid_seek_seconds",
            "seek() needs a finite number of seconds >= 0.", { seconds });
    }
    return seconds;
}

export function createPlayerController({ driver, identity, mountElement, host }) {
    assertDriver(driver);
    if (!driver.canPlayVideo(identity)) {
        throw new AppError("unplayable_video_identity",
            "This video cannot be played in the embedded player.",
            { platform: identity ? identity.platform : null });
    }
    const document = host ? host.document : null;
    const window = host ? host.window : null;
    if (!document || typeof document.createElement !== "function" ||
        !window || typeof window.addEventListener !== "function" ||
        typeof window.removeEventListener !== "function") {
        throw new AppError("invalid_player_host",
            "The player controller needs a host with document and window.", {});
    }
    if (!mountElement || typeof mountElement.replaceChildren !== "function") {
        throw new AppError("invalid_player_mount",
            "The player controller needs a mount element.", {});
    }

    const embedUrl = driver.buildEmbedUrl(identity);
    if (!driver.isExpectedEmbedUrl(embedUrl)) {
        // Defense in depth: the driver must only ever produce
        // allowlisted embed URLs.
        throw new AppError("unexpected_embed_url",
            "The player driver produced an unexpected embed URL.", {});
    }

    let destroyed = false;
    let ready = false;
    const queuedSeeks = [];

    const frame = document.createElement("iframe");
    frame.src = embedUrl;
    frame.className = "player-frame";
    if (typeof frame.setAttribute === "function") {
        frame.setAttribute("title", "Embedded VOD player");
        frame.setAttribute("allow",
            "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture");
        frame.setAttribute("allowfullscreen", "");
    }
    mountElement.replaceChildren(frame);

    function postToPlayer(message) {
        const target = frame.contentWindow;
        if (!target || typeof target.postMessage !== "function") return false;
        target.postMessage(message, driver.messageOrigin);
        return true;
    }

    function flushQueue() {
        while (queuedSeeks.length > 0 && !destroyed) {
            postToPlayer(driver.createSeekCommand(queuedSeeks.shift()));
        }
    }

    function handleMessage(event) {
        if (destroyed || ready) return;
        if (!event || event.origin !== driver.messageOrigin) return;
        if (event.source !== frame.contentWindow) return;
        if (driver.isPlayerReadyMessage(event.data)) {
            ready = true;
            flushQueue();
        }
    }

    function handleFrameLoad() {
        if (destroyed || ready) return;
        // Begin the readiness handshake; the player answers onReady.
        postToPlayer(driver.createListenCommand());
    }

    window.addEventListener("message", handleMessage);
    if (typeof frame.addEventListener === "function") {
        frame.addEventListener("load", handleFrameLoad);
    } else {
        // Host without frame load events: attempt the handshake
        // immediately so readiness can still complete.
        handleFrameLoad();
    }

    return {
        get ready() { return ready; },
        get destroyed() { return destroyed; },
        get queuedSeekCount() { return queuedSeeks.length; },
        seek(seconds) {
            if (destroyed) {
                throw new AppError("player_destroyed",
                    "The player has been destroyed.", {});
            }
            assertValidSeconds(seconds);
            if (!ready) {
                queuedSeeks.push(seconds);
                return { queued: true };
            }
            postToPlayer(driver.createSeekCommand(seconds));
            return { queued: false };
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            ready = false;
            queuedSeeks.length = 0;
            window.removeEventListener("message", handleMessage);
            mountElement.replaceChildren();
        }
    };
}

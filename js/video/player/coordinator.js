// ==========================================================
// coordinator.js
// Responsibility: provider-neutral embedded-player coordination.
// A coordinator owns LIVE player controller instances for ONE route
// (Dashboard preview or Clips review). The application creates one
// coordinator per player-showing route; both share this mechanism
// instead of duplicating player logic.
//
// Contract:
//
//   createPlayerCoordinator({ driver })
//     -> { controller, getMount(host), teardown(), sync(identity, host) }
//
//   driver provider driver (e.g. drivers/youtube.js)
//   host   { document, window } — injected at sync/mount time so the
//          coordinator is unit-testable without a browser
//
// The controller is a LIVE object — it owns the iframe, the
// readiness handshake, and the seek queue — and must NEVER enter
// the immutable Project or serializable state. The coordinator
// owns it and tracks the canonical identity it was built for.
//
// sync(identity, host):
//   - identity null        -> tears down any existing controller
//   - identity unchanged    -> reuses the existing controller
//   - identity changed      -> destroys the old controller and
//                              builds a new one for the new identity
//   - identity unplayable   -> returns null (no iframe is created)
//   Returns the controller or null. Never builds an iframe URL
//   itself: the controller delegates URL construction to the
//   driver, which only ever produces allowlisted embed URLs.
//
// teardown() destroys the controller (removing its iframe and
// event listeners) and forgets the identity. Call it when leaving
// the coordinator's route so no hidden iframe keeps running.
//
// The mount is a persistent element: re-attaching the SAME mount
// across re-renders preserves the loaded video (no reload on
// re-render), while destroy() empties it on teardown.
// ==========================================================

import { createPlayerController } from "./controller.js";

export function createPlayerCoordinator({ driver }) {
    if (!driver || typeof driver.canPlayVideo !== "function") {
        throw new Error("createPlayerCoordinator needs a driver with canPlayVideo.");
    }
    const state = {
        controller: null,
        platform: null,
        videoId: null,
        mount: null
    };

    function getMount(host) {
        if (!state.mount) {
            state.mount = host.document.createElement("div");
            state.mount.className = "player-mount";
        }
        return state.mount;
    }

    function teardown() {
        if (state.controller) {
            state.controller.destroy();
            state.controller = null;
        }
        state.platform = null;
        state.videoId = null;
    }

    function sync(identity, host) {
        const matches = identity !== null && state.platform === identity.platform &&
            state.videoId === identity.videoId;
        if (!matches) teardown();
        if (identity !== null && state.controller === null) {
            if (!driver.canPlayVideo(identity)) return null;
            state.controller = createPlayerController({
                driver,
                identity,
                mountElement: getMount(host),
                host
            });
            state.platform = identity.platform;
            state.videoId = identity.videoId;
        }
        return state.controller;
    }

    return {
        get controller() { return state.controller; },
        getMount,
        teardown,
        sync
    };
}

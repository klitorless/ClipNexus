// ==========================================================
// devtools-stage10-tests.js
// Stage 10: embedded VOD review and clip candidate selection.
//
// Covered: the canonical ClipDecision domain, immutable
// Project integration (withClipDecisions / setClipDecision /
// clearClipDecision / getKeptClipSpecs), the provider-neutral
// player controller with its YouTube driver, readiness queueing,
// the Clip Queue candidate view-model, the Clip Queue view, and
// the revised security boundary (narrow YouTube frame source).
//
// No AI, no ranking, no scoring, no clip generation, no
// network. Player tests use an injected fake host so the
// readiness/queue/teardown logic runs deterministically under
// Node; the Clip Queue DOM assembly tests need a real document
// and are browser-only (same standing as the existing
// DOM-dependent tests).
// ==========================================================

import { AppError } from "./errors.js";
import {
    createProject, withClipSpecs, withClipDecisions, setClipDecision,
    clearClipDecision, getKeptClipSpecs, applyVideoIdentity
} from "./project.js";
import {
    createClipDecision, assertClipDecision, getClipDecision,
    getKeptClipSpecIds, normalizeClipDecisions,
    CLIP_DECISION, CLIP_DECISION_SCHEMA_VERSION
} from "../analysis/clip-decisions.js";
import { createClipSpec } from "../analysis/clip-spec.js";
import {
    youtubePlayerDriver, canPlayVideo, buildEmbedUrl, isExpectedEmbedUrl,
    createSeekCommand, createListenCommand, isPlayerReadyMessage,
    YOUTUBE_MESSAGE_ORIGIN
} from "../video/player/drivers/youtube.js";
import { createPlayerController } from "../video/player/controller.js";
import {
    renderClipsView, describeCandidate, describeSeekDisabledReason
} from "../ui/clips.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";

const FIXED_AT = "2026-09-30T10:00:00.000Z";
const VIDEO_ID = "dQw4w9WgXcQ"; // 11 chars, canonical YouTube shape

const youtubeIdentity = {
    platform: "youtube",
    videoId: VIDEO_ID,
    canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    url: `https://www.youtube.com/watch?v=${VIDEO_ID}`
};

function clipSpec(overrides = {}) {
    return createClipSpec({
        id: "clip-000000",
        transcriptId: "tx-1",
        eventId: "event-000000",
        startSeconds: 763,
        endSeconds: 798,
        poiIds: ["poi-000000"],
        derivation: { deriverId: "mock-clip-spec-deriver", derivedAt: FIXED_AT },
        ...overrides
    });
}

function projectWithCandidates(specs) {
    return withClipSpecs(createProject(), specs);
}

function projectWithVideo(identity = youtubeIdentity, startPosition = null) {
    return applyVideoIdentity(null, identity, startPosition).project;
}

function docFromRecords(records) {
    const rawText = JSON.stringify(records);
    return buildTranscriptDocument({
        rawText, format: "json", filename: "vod.json",
        size: rawText.length, acquisition: createFileAcquisition()
    });
}

// ---------- Fake DOM host for controller tests ----------

function createFakeFrame() {
    const listeners = {};
    return {
        src: "",
        className: "",
        attributes: {},
        contentWindow: {
            posted: [],
            postMessage(message, origin) { this.posted.push({ message, origin }); }
        },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        fire(type) { (listeners[type] || []).forEach((fn) => fn()); }
    };
}

function createFakeHost() {
    const frame = createFakeFrame();
    const messageListeners = [];
    const mount = {
        children: [],
        replaceChildren(...items) { this.children = items; }
    };
    const host = {
        document: {
            createElement(tag) {
                if (tag !== "iframe") throw new Error(`unexpected element: ${tag}`);
                return frame;
            }
        },
        window: {
            addEventListener(type, fn) { if (type === "message") messageListeners.push(fn); },
            removeEventListener(type, fn) {
                const index = messageListeners.indexOf(fn);
                if (index >= 0) messageListeners.splice(index, 1);
            },
            dispatchMessage(event) { [...messageListeners].forEach((fn) => fn(event)); },
            get messageListenerCount() { return messageListeners.length; }
        }
    };
    return { host, frame, mount, messageListeners };
}

function readyEvent(frame) {
    return {
        origin: YOUTUBE_MESSAGE_ORIGIN,
        source: frame.contentWindow,
        data: JSON.stringify({ event: "onReady" })
    };
}

function makeController(hostParts, identity = youtubeIdentity) {
    return createPlayerController({
        driver: youtubePlayerDriver,
        identity,
        mountElement: hostParts.mount,
        host: hostParts.host
    });
}

function renderDetached(render) {
    const mount = document.createElement("div");
    render(mount);
    return mount;
}

export function addStage10Tests(add) {

    // ---------- ClipDecision domain ----------

    add("decisions: absence of a decision means unreviewed", () => {
        const project = projectWithCandidates([clipSpec()]);
        return getClipDecision(project.clipDecisions, "clip-000000") === null &&
            getKeptClipSpecIds(project.clipDecisions).length === 0;
    });

    add("decisions: createClipDecision builds a frozen keep/reject record", () => {
        const keep = createClipDecision({ clipSpecId: "clip-000000", decision: "keep", decidedAt: FIXED_AT });
        const reject = createClipDecision({ clipSpecId: "clip-000001", decision: "reject", decidedAt: FIXED_AT });
        return keep.schemaVersion === CLIP_DECISION_SCHEMA_VERSION &&
            keep.clipSpecId === "clip-000000" && keep.decision === CLIP_DECISION.KEEP &&
            keep.decidedAt === FIXED_AT && reject.decision === CLIP_DECISION.REJECT &&
            Object.isFrozen(keep) && Object.isFrozen(reject);
    });

    add("decisions: invalid values and shapes are rejected", () => {
        const bad = [
            () => createClipDecision({ clipSpecId: "", decision: "keep", decidedAt: FIXED_AT }),
            () => createClipDecision({ decision: "keep", decidedAt: FIXED_AT }),
            () => createClipDecision({ clipSpecId: "clip-000000", decision: "maybe", decidedAt: FIXED_AT }),
            () => createClipDecision({ clipSpecId: "clip-000000", decision: "KEEP", decidedAt: FIXED_AT }),
            () => createClipDecision({ clipSpecId: "clip-000000", decision: "keep", decidedAt: "not-a-date" }),
            () => createClipDecision({ clipSpecId: "clip-000000", decision: "keep", decidedAt: FIXED_AT, schemaVersion: "1" })
        ];
        return bad.every((fn) => {
            try { fn(); return false; }
            catch (error) { return error instanceof AppError && error.code === "invalid_clip_decision"; }
        });
    });

    add("decisions: assertClipDecision returns valid input unchanged", () => {
        const input = createClipDecision({ clipSpecId: "clip-000000", decision: "keep", decidedAt: FIXED_AT });
        return assertClipDecision(input) === input;
    });

    // ---------- Project integration ----------

    add("decisions: setClipDecision records keep on a new project; original unchanged", () => {
        const project = projectWithCandidates([clipSpec()]);
        const before = JSON.stringify(project);
        const next = setClipDecision(project, "clip-000000", "keep", { decidedAt: FIXED_AT });
        return next !== project &&
            JSON.stringify(project) === before &&
            project.clipDecisions.length === 0 &&
            next.clipDecisions.length === 1 &&
            next.clipDecisions[0].decision === "keep" &&
            next.clipDecisions[0].decidedAt === FIXED_AT;
    });

    add("decisions: unknown ClipSpec ids are rejected", () => {
        const project = projectWithCandidates([clipSpec()]);
        const direct = () => setClipDecision(project, "clip-999999", "keep", { decidedAt: FIXED_AT });
        const bulk = () => withClipDecisions(project,
            [createClipDecision({ clipSpecId: "clip-999999", decision: "keep", decidedAt: FIXED_AT })]);
        return [direct, bulk].every((fn) => {
            try { fn(); return false; }
            catch (error) { return error instanceof AppError && error.code === "unknown_clip_spec"; }
        });
    });

    add("decisions: invalid decision values are rejected by project ops", () => {
        const project = projectWithCandidates([clipSpec()]);
        try {
            setClipDecision(project, "clip-000000", "maybe", { decidedAt: FIXED_AT });
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "invalid_clip_decision";
        }
    });

    add("decisions: KEEP <-> REJECT transitions replace the earlier decision", () => {
        let project = projectWithCandidates([clipSpec()]);
        project = setClipDecision(project, "clip-000000", "keep", { decidedAt: FIXED_AT });
        project = setClipDecision(project, "clip-000000", "reject", { decidedAt: FIXED_AT });
        const afterReject = project.clipDecisions.length === 1 &&
            getClipDecision(project.clipDecisions, "clip-000000") === "reject";
        project = setClipDecision(project, "clip-000000", "keep", { decidedAt: FIXED_AT });
        return afterReject && project.clipDecisions.length === 1 &&
            getClipDecision(project.clipDecisions, "clip-000000") === "keep";
    });

    add("decisions: clearClipDecision resets to unreviewed; no-op returns the same project", () => {
        const original = projectWithCandidates([clipSpec()]);
        const untouched = clearClipDecision(original, "clip-000000");
        const decided = setClipDecision(original, "clip-000000", "keep", { decidedAt: FIXED_AT });
        const cleared = clearClipDecision(decided, "clip-000000");
        return untouched === original &&
            cleared !== decided &&
            cleared.clipDecisions.length === 0 &&
            getClipDecision(cleared.clipDecisions, "clip-000000") === null;
    });

    add("decisions: withClipDecisions replaces the whole set and dedupes deterministically", () => {
        const project = projectWithCandidates([clipSpec(), clipSpec({ id: "clip-000001" })]);
        const next = withClipDecisions(project, [
            createClipDecision({ clipSpecId: "clip-000000", decision: "keep", decidedAt: FIXED_AT }),
            createClipDecision({ clipSpecId: "clip-000001", decision: "reject", decidedAt: FIXED_AT }),
            createClipDecision({ clipSpecId: "clip-000000", decision: "reject", decidedAt: FIXED_AT })
        ]);
        return next.clipDecisions.length === 2 &&
            getClipDecision(next.clipDecisions, "clip-000000") === "reject" && // last wins
            getClipDecision(next.clipDecisions, "clip-000001") === "reject" &&
            next.clipDecisions[0].clipSpecId === "clip-000000"; // first-appearance order
    });

    add("decisions: decision data is deeply frozen on the project", () => {
        const project = setClipDecision(projectWithCandidates([clipSpec()]),
            "clip-000000", "keep", { decidedAt: FIXED_AT });
        return Object.isFrozen(project.clipDecisions) &&
            Object.isFrozen(project.clipDecisions[0]) &&
            (() => {
                try { project.clipDecisions[0].decision = "reject"; return false; }
                catch (error) { return error instanceof TypeError; }
            })();
    });

    add("decisions: existing project fields and ClipSpecs remain intact", () => {
        const specs = [clipSpec(), clipSpec({ id: "clip-000001" })];
        const project = projectWithCandidates(specs);
        const next = setClipDecision(project, "clip-000000", "keep", { decidedAt: FIXED_AT });
        return next.schemaVersion === project.schemaVersion && next.id === project.id &&
            next.video === project.video && next.transcript === project.transcript &&
            next.clipSpecs.length === 2 && next.clipSpecs[0] === specs[0] && next.clipSpecs[1] === specs[1] &&
            Array.isArray(next.clips) && Array.isArray(next.pois) && Array.isArray(next.events);
    });

    add("decisions: kept ClipSpecs are retrievable deterministically in clipSpecs order", () => {
        const specs = [clipSpec(), clipSpec({ id: "clip-000001" }), clipSpec({ id: "clip-000002" })];
        let project = projectWithCandidates(specs);
        project = setClipDecision(project, "clip-000002", "keep", { decidedAt: FIXED_AT });
        project = setClipDecision(project, "clip-000001", "reject", { decidedAt: FIXED_AT });
        project = setClipDecision(project, "clip-000000", "keep", { decidedAt: FIXED_AT });
        const kept = getKeptClipSpecs(project);
        return kept.length === 2 && kept[0] === specs[0] && kept[1] === specs[2] &&
            getKeptClipSpecs(project).map((spec) => spec.id).join(",") === "clip-000000,clip-000002";
    });

    add("decisions: ClipSpec objects are never mutated by decisions", () => {
        const specs = [clipSpec()];
        const project = projectWithCandidates(specs);
        const before = JSON.stringify(specs);
        let next = setClipDecision(project, "clip-000000", "keep", { decidedAt: FIXED_AT });
        next = setClipDecision(next, "clip-000000", "reject", { decidedAt: FIXED_AT });
        next = clearClipDecision(next, "clip-000000");
        return JSON.stringify(specs) === before && next.clipSpecs[0] === specs[0];
    });

    add("decisions: normalizeClipDecisions rejects non-arrays", () => {
        try {
            normalizeClipDecisions("keep", ["clip-000000"]);
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "invalid_clip_decisions";
        }
    });

    // ---------- Player: YouTube driver (pure) ----------

    add("player: canonical YouTube identity builds the expected nocookie embed URL", () =>
        canPlayVideo(youtubeIdentity) === true &&
        buildEmbedUrl(youtubeIdentity) ===
            `https://www.youtube-nocookie.com/embed/${VIDEO_ID}?enablejsapi=1&rel=0`);

    add("player: malformed identities are not playable", () => {
        const bad = [
            null, undefined, {},
            { platform: "twitch", videoId: VIDEO_ID },
            { platform: "youtube", videoId: "short" },
            { platform: "youtube", videoId: "dQw4w9WgXcQ!!!" },
            { platform: "youtube", videoId: "" },
            { platform: "youtube" }
        ];
        return bad.every((identity) => canPlayVideo(identity) === false);
    });

    add("player: embed URL allowlist rejects arbitrary URLs", () => {
        const evil = [
            youtubeIdentity.url, // user watch URL — never an iframe source
            `http://www.youtube-nocookie.com/embed/${VIDEO_ID}?enablejsapi=1&rel=0`,
            `https://www.youtube.com/embed/${VIDEO_ID}?enablejsapi=1`,
            `https://www.youtube-nocookie.com/watch?v=${VIDEO_ID}`,
            `https://www.youtube-nocookie.com/embed/${VIDEO_ID}?enablejsapi=1&autoplay=1`,
            "javascript:alert(1)",
            "https://evil.example.com/embed/dQw4w9WgXcQ",
            ""
        ];
        const good = buildEmbedUrl(youtubeIdentity);
        return evil.every((url) => isExpectedEmbedUrl(url) === false) &&
            isExpectedEmbedUrl(good) === true &&
            isExpectedEmbedUrl(null) === false;
    });

    add("player: buildEmbedUrl throws for unplayable identities", () => {
        try {
            buildEmbedUrl({ platform: "twitch", videoId: "abc" });
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "unplayable_video_identity";
        }
    });

    add("player: seek command serializes to the YouTube postMessage protocol", () => {
        const parsed = JSON.parse(createSeekCommand(763));
        return parsed.event === "command" && parsed.func === "seekTo" &&
            Array.isArray(parsed.args) && parsed.args[0] === 763 && parsed.args[1] === true;
    });

    add("player: ready messages are recognized; other payloads are not", () =>
        isPlayerReadyMessage(JSON.stringify({ event: "onReady" })) === true &&
        isPlayerReadyMessage(createListenCommand()) === false &&
        isPlayerReadyMessage(JSON.stringify({ event: "command" })) === false &&
        isPlayerReadyMessage("not json") === false &&
        isPlayerReadyMessage(null) === false);

    // ---------- Player: controller (fake DOM host) ----------

    add("player: unsupported identity throws and creates no iframe", () => {
        const parts = createFakeHost();
        try {
            makeController(parts, { platform: "twitch", videoId: "abc" });
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "unplayable_video_identity" &&
                parts.mount.children.length === 0;
        }
    });

    add("player: malformed identity creates no player", () => {
        const parts = createFakeHost();
        try {
            makeController(parts, null);
            return false;
        } catch (error) {
            return error instanceof AppError && parts.mount.children.length === 0;
        }
    });

    add("player: creating the controller mounts exactly one expected iframe", () => {
        const parts = createFakeHost();
        makeController(parts);
        return parts.mount.children.length === 1 &&
            parts.mount.children[0].src === buildEmbedUrl(youtubeIdentity) &&
            isExpectedEmbedUrl(parts.mount.children[0].src) === true;
    });

    add("player: seek before ready is queued, never lost", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        const result = controller.seek(763);
        return result.queued === true && controller.queuedSeekCount === 1 &&
            controller.ready === false && parts.frame.contentWindow.posted.length === 0;
    });

    add("player: queued seeks execute in order after readiness", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        parts.frame.fire("load"); // begins the handshake
        controller.seek(763);
        controller.seek(100);
        parts.host.window.dispatchMessage(readyEvent(parts.frame));
        const posted = parts.frame.contentWindow.posted.map((entry) => entry.message);
        return controller.ready === true && controller.queuedSeekCount === 0 &&
            posted.length === 3 && // listen handshake + 2 seeks
            JSON.parse(posted[1]).args[0] === 763 &&
            JSON.parse(posted[2]).args[0] === 100 &&
            posted.every((message, index) =>
                parts.frame.contentWindow.posted[index].origin === YOUTUBE_MESSAGE_ORIGIN);
    });

    add("player: messages from other origins or sources are ignored", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        parts.host.window.dispatchMessage({
            origin: "https://evil.example.com", source: parts.frame.contentWindow,
            data: JSON.stringify({ event: "onReady" })
        });
        parts.host.window.dispatchMessage({
            origin: YOUTUBE_MESSAGE_ORIGIN, source: {},
            data: JSON.stringify({ event: "onReady" })
        });
        return controller.ready === false && controller.queuedSeekCount === 0;
    });

    add("player: later seeks post immediately once ready", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        parts.host.window.dispatchMessage(readyEvent(parts.frame));
        const result = controller.seek(500);
        const posted = parts.frame.contentWindow.posted;
        return result.queued === false && controller.ready === true &&
            posted.length === 1 && JSON.parse(posted[0].message).args[0] === 500;
    });

    add("player: invalid seek values are rejected", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        return [-1, NaN, Infinity, "763", null].every((value) => {
            try { controller.seek(value); return false; }
            catch (error) { return error instanceof AppError && error.code === "invalid_seek_seconds"; }
        });
    });

    add("player: destroy removes the iframe, clears the queue, detaches listeners", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        controller.seek(763); // queued while not ready
        controller.destroy();
        controller.destroy(); // idempotent
        return controller.destroyed === true && parts.mount.children.length === 0 &&
            controller.queuedSeekCount === 0 && parts.host.window.messageListenerCount === 0;
    });

    add("player: seek after destroy throws", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        controller.destroy();
        try {
            controller.seek(10);
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "player_destroyed";
        }
    });

    add("player: recreation after video change works", () => {
        const parts = createFakeHost();
        const first = makeController(parts);
        first.destroy();
        const second = makeController(parts, { ...youtubeIdentity, videoId: "abcdefghijk" });
        return first.destroyed === true && second.destroyed === false &&
            parts.mount.children.length === 1 &&
            parts.mount.children[0].src ===
                "https://www.youtube-nocookie.com/embed/abcdefghijk?enablejsapi=1&rel=0";
    });

    add("player: live controller objects never enter project state", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        controller.seek(763);
        const project = setClipDecision(projectWithCandidates([clipSpec()]),
            "clip-000000", "keep", { decidedAt: FIXED_AT });
        const serialized = JSON.stringify(project);
        return controller.destroyed === false &&
            project.player === undefined && JSON.parse(serialized).player === undefined &&
            !serialized.includes("contentWindow") && !serialized.includes("postMessage");
    });

    // ---------- Clip Queue: candidate view-model (pure) ----------

    add("clip queue: candidate view-model shows the formatted time range", () => {
        const vm = describeCandidate(clipSpec(), {
            decision: null, playerAvailable: true, transcriptId: "tx-1", currentCandidateId: null
        });
        return vm.rangeLabel === "12:43.000 → 13:18.000" && vm.canSeek === true &&
            vm.seekDisabledReason === null && vm.eventId === "event-000000" &&
            vm.poiCount === 1 && vm.deriverId === "mock-clip-spec-deriver" &&
            vm.isCurrent === false;
    });

    add("clip queue: null startSeconds cannot seek", () => {
        const vm = describeCandidate(clipSpec({ startSeconds: null, endSeconds: null }), {
            decision: null, playerAvailable: true, transcriptId: "tx-1", currentCandidateId: null
        });
        return vm.canSeek === false && vm.seekDisabledReason === "no-timestamp" &&
            vm.startLabel === "no time" &&
            describeSeekDisabledReason(vm.seekDisabledReason).includes("no start timestamp");
    });

    add("clip queue: null endSeconds still allows seeking to start", () => {
        const vm = describeCandidate(clipSpec({ endSeconds: null }), {
            decision: null, playerAvailable: true, transcriptId: "tx-1", currentCandidateId: null
        });
        return vm.canSeek === true && vm.endLabel === "no time" &&
            vm.rangeLabel === "12:43.000 → no time";
    });

    add("clip queue: missing player cannot seek", () => {
        const vm = describeCandidate(clipSpec(), {
            decision: null, playerAvailable: false, transcriptId: "tx-1", currentCandidateId: null
        });
        return vm.canSeek === false && vm.seekDisabledReason === "no-player";
    });

    add("clip queue: transcript mismatch cannot seek", () => {
        const vm = describeCandidate(clipSpec({ transcriptId: "tx-1" }), {
            decision: null, playerAvailable: true, transcriptId: "tx-2", currentCandidateId: null
        });
        const noTranscript = describeCandidate(clipSpec({ transcriptId: "tx-1" }), {
            decision: null, playerAvailable: true, transcriptId: null, currentCandidateId: null
        });
        return vm.canSeek === false && vm.seekDisabledReason === "transcript-mismatch" &&
            noTranscript.canSeek === false && noTranscript.seekDisabledReason === "transcript-mismatch";
    });

    add("clip queue: current candidate is flagged in the view-model", () => {
        const vm = describeCandidate(clipSpec(), {
            decision: "keep", playerAvailable: true, transcriptId: "tx-1",
            currentCandidateId: "clip-000000"
        });
        return vm.isCurrent === true && vm.decision === "keep";
    });

    // ---------- Clip Queue: view (browser-only) ----------

    add("clip queue: candidates render with timestamps, controls, and decision state", () => {
        const project = projectWithCandidates([clipSpec(), clipSpec({ id: "clip-000001", startSeconds: 10 })]);
        const mount = renderDetached((element) => renderClipsView(element, project, {
            playerMount: document.createElement("div"),
            playerAvailable: false,
            playerUnavailableReason: "no-video",
            currentCandidateId: null,
            onSelectCandidate: () => {}, onKeep: () => {}, onReject: () => {}, onClearDecision: () => {}
        }));
        const cards = mount.querySelectorAll('[data-section="candidate"]');
        const buttons = mount.querySelectorAll('[data-section="candidate"] button');
        return cards.length === 2 &&
            mount.textContent.includes("12:43.000 → 13:18.000") &&
            mount.textContent.includes("Unreviewed") &&
            buttons.length === 8 && // seek + keep + reject + reset per candidate
            mount.querySelectorAll("iframe").length === 0; // the view never creates iframes
    });

    add("clip queue: Review & seek invokes the select handler with the ClipSpec id", () => {
        const project = projectWithCandidates([clipSpec()]);
        let selected = null;
        const mount = renderDetached((element) => renderClipsView(element, project, {
            playerMount: document.createElement("div"),
            playerAvailable: true,
            playerUnavailableReason: null,
            currentCandidateId: null,
            onSelectCandidate: (id) => { selected = id; },
            onKeep: () => {}, onReject: () => {}, onClearDecision: () => {}
        }));
        mount.querySelector('[data-section="candidate"] button').click();
        return selected === "clip-000000";
    });

    add("clip queue: KEEP / REJECT / Reset invoke decision handlers", () => {
        let project = projectWithCandidates([clipSpec()]);
        project = setClipDecision(project, "clip-000000", "keep", { decidedAt: FIXED_AT });
        const calls = [];
        const mount = renderDetached((element) => renderClipsView(element, project, {
            playerMount: document.createElement("div"),
            playerAvailable: false,
            playerUnavailableReason: "no-video",
            currentCandidateId: null,
            onSelectCandidate: () => {},
            onKeep: (id) => calls.push(["keep", id]),
            onReject: (id) => calls.push(["reject", id]),
            onClearDecision: (id) => calls.push(["clear", id])
        }));
        const buttons = mount.querySelectorAll('[data-section="candidate"] button');
        // keep is disabled once kept; reject and reset are enabled
        buttons[2].click();
        buttons[3].click();
        return buttons[1].disabled === true && buttons[2].disabled === false &&
            mount.textContent.includes("Kept") &&
            calls.length === 2 && calls[0][0] === "reject" && calls[1][0] === "clear";
    });

    add("clip queue: null startSeconds disables seek with an honest message", () => {
        const project = projectWithCandidates([clipSpec({ startSeconds: null, endSeconds: null })]);
        let selected = null;
        const mount = renderDetached((element) => renderClipsView(element, project, {
            playerMount: document.createElement("div"),
            playerAvailable: true,
            playerUnavailableReason: null,
            currentCandidateId: null,
            onSelectCandidate: (id) => { selected = id; },
            onKeep: () => {}, onReject: () => {}, onClearDecision: () => {}
        }));
        const seekButton = mount.querySelector('[data-section="candidate"] button');
        return seekButton.disabled === true && selected === null &&
            mount.textContent.includes("no start timestamp");
    });

    add("clip queue: no video shows the honest unavailable state and no iframe", () => {
        const project = projectWithCandidates([clipSpec()]);
        const mount = renderDetached((element) => renderClipsView(element, project, {
            playerMount: document.createElement("div"),
            playerAvailable: false,
            playerUnavailableReason: "no-video",
            currentCandidateId: null,
            onSelectCandidate: () => {}, onKeep: () => {}, onReject: () => {}, onClearDecision: () => {}
        }));
        return mount.querySelectorAll("iframe").length === 0 &&
            mount.textContent.includes("No video is loaded") &&
            mount.textContent.includes("Time alignment is unverified");
    });

    add("clip queue: unsupported platform shows the honest unavailable state", () => {
        const project = projectWithCandidates([clipSpec()]);
        const mount = renderDetached((element) => renderClipsView(element, project, {
            playerMount: document.createElement("div"),
            playerAvailable: false,
            playerUnavailableReason: "unsupported-platform",
            currentCandidateId: null,
            onSelectCandidate: () => {}, onKeep: () => {}, onReject: () => {}, onClearDecision: () => {}
        }));
        return mount.querySelectorAll("iframe").length === 0 &&
            mount.textContent.includes("not supported for this video platform");
    });

    // ---------- Security: the revised Stage 10 boundary ----------

    add("security: clips view creates only the coordinator-provided player iframe", () => {
        const project = projectWithCandidates([clipSpec()]);
        const playerMount = document.createElement("div");
        const frame = document.createElement("iframe");
        frame.src = buildEmbedUrl(youtubeIdentity); // what the coordinator builds
        playerMount.append(frame);
        const mount = renderDetached((element) => renderClipsView(element, project, {
            playerMount,
            playerAvailable: true,
            playerUnavailableReason: null,
            currentCandidateId: null,
            onSelectCandidate: () => {}, onKeep: () => {}, onReject: () => {}, onClearDecision: () => {}
        }));
        const frames = mount.querySelectorAll("iframe");
        return frames.length === 1 &&
            isExpectedEmbedUrl(frames[0].src) === true &&
            frames[0].src.includes("youtube-nocookie.com");
    });

    add("security: arbitrary user URLs can never become an iframe source", () =>
        // The driver builds embed URLs only from validated canonical
        // identities; the allowlist rejects everything else.
        isExpectedEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ") === false &&
        isExpectedEmbedUrl(youtubeIdentity.canonicalUrl) === false &&
        (() => {
            try { buildEmbedUrl({ platform: "youtube", videoId: "https://evil.example/x" }); return false; }
            catch (error) { return error instanceof AppError; }
        })());

    add("security: malformed video identity creates no player", () => {
        const parts = createFakeHost();
        const bad = [null, { platform: "youtube", videoId: "x".repeat(100) }, { platform: "vimeo", videoId: "123" }];
        return bad.every((identity) => {
            try {
                makeController(parts, identity);
                return false;
            } catch (error) {
                return error instanceof AppError && parts.mount.children.length === 0;
            }
        });
    });

    add("security: player teardown removes the iframe cleanly", () => {
        const parts = createFakeHost();
        const controller = makeController(parts);
        if (parts.mount.children.length !== 1) return false;
        controller.destroy();
        return parts.mount.children.length === 0 && controller.destroyed === true;
    });

    add("security: transcript mismatch is reported, never guessed past", () => {
        const doc = docFromRecords([{ start: 1, end: 2, text: "hello" }]);
        const vm = describeCandidate(clipSpec({ transcriptId: "tx-1" }), {
            decision: null, playerAvailable: true, transcriptId: doc.id, currentCandidateId: null
        });
        return doc.id !== "tx-1" && vm.canSeek === false &&
            vm.seekDisabledReason === "transcript-mismatch";
    });
}

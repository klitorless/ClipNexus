// ==========================================================
// devtools-analysis-timestamps-tests.js
// Responsibility: self-tests for Analysis timestamp
// navigation (js/ui/analysis.js), the sensitivity cleanup,
// and the Rickroll dev default URL.
//
// Covered: resolveEvidenceTimestamp (first valid segment
// start, invalid skipped, none -> null), formatTimestamp,
// describeTimestamp, evidence timestamp buttons (render,
// click -> onSeekTimestamp, honest omission), player
// coordinator seek/queue/reuse semantics, sensitivity
// control presence per detector, and the Rickroll default.
//
// No network, no AI. DOM tests need a real document and are
// browser-only (same standing as the existing DOM tests).
// ==========================================================

import {
    renderAnalysisView,
    resolveEvidenceTimestamp,
    formatTimestamp,
    describeTimestamp
} from "../ui/analysis.js";
import { createVideoUrlForm, DEV_DEFAULT_VIDEO_URL } from "../ui/project-panel.js";
import { createDetectorExtractor } from "../analysis/detectors/extractor.js";
import { createAnalyzer } from "../analysis/analyzer.js";
import { createAnalysisRequest } from "../analysis/contracts.js";
import { thresholdFor, DETECTOR_TYPE } from "../analysis/detectors/types.js";
import { createPlayerCoordinator } from "../video/player/coordinator.js";
import { createPlayerController } from "../video/player/controller.js";
import { youtubePlayerDriver, YOUTUBE_MESSAGE_ORIGIN } from "../video/player/drivers/youtube.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";
import { createProject, withTranscript } from "./project.js";

const RICKROLL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function docWith(texts) {
    const rawText = JSON.stringify(texts.map((text, i) => ({
        start: i * 10, end: i * 10 + 5, text
    })));
    return buildTranscriptDocument({
        rawText,
        format: "json",
        filename: "timestamps.json",
        size: rawText.length,
        acquisition: createFileAcquisition()
    });
}

function projectWithDoc(doc) {
    return withTranscript(createProject(), doc);
}

function evidenceWith(segmentIds) {
    return {
        id: "ev-test-seg-000000",
        type: "text",
        sourceRef: { transcriptId: "tx-1", segmentIds },
        content: { detector: "hype", score: 5, signals: ["oh my god"], quote: "oh my god" },
        provenance: "source-observed",
        reliability: "high"
    };
}

function transcriptWithSegments(entries) {
    return {
        segments: entries.map(([id, seconds], index) => ({
            id: `seg-${String(index).padStart(6, "0")}`,
            start: seconds === null ? null : { seconds },
            _testId: id
        }))
    };
}

function renderAnalysisWithEvidence(evidenceItems, { playerAvailable = true, onSeekTimestamp = () => {} } = {}) {
    const doc = docWith(["oh my god, why is this happening?"]);
    const mount = document.createElement("div");
    const request = { id: "req-1", scope: { type: "full" } };
    const result = { evidence: evidenceItems, observations: [], warnings: [], limitations: [] };
    renderAnalysisView(mount, projectWithDoc(doc), {
        analysis: { status: "done", request, result },
        onAnalyze: () => {},
        builder: null,
        player: { mount: document.createElement("div"), available: playerAvailable },
        onSeekTimestamp
    });
    return { mount, doc };
}

// ---------- Fake host for coordinator/controller tests ----------

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
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
    };
}

function createCoordinatorHost() {
    const frame = createFakeFrame();
    const messageListeners = [];
    const mount = {
        tag: "div",
        className: "",
        children: [],
        replaceChildren(...items) { this.children = items; }
    };
    const host = {
        document: {
            createElement(tag) {
                if (tag === "iframe") return frame;
                if (tag === "div") return mount;
                throw new Error(`unexpected element: ${tag}`);
            }
        },
        window: {
            addEventListener(type, fn) { if (type === "message") messageListeners.push(fn); },
            removeEventListener(type, fn) {
                const index = messageListeners.indexOf(fn);
                if (index >= 0) messageListeners.splice(index, 1);
            },
            dispatchMessage(event) { [...messageListeners].forEach((fn) => fn(event)); }
        }
    };
    return { host, frame, mount, messageListeners };
}

const youtubeIdentity = {
    platform: "youtube",
    videoId: "dQw4w9WgXcQ",
    canonicalUrl: RICKROLL,
    url: RICKROLL
};

function readyEvent(frame) {
    return {
        origin: YOUTUBE_MESSAGE_ORIGIN,
        source: frame.contentWindow,
        data: JSON.stringify({ event: "onReady" })
    };
}

export function addAnalysisTimestampsTests(add) {
    // ---------- resolveEvidenceTimestamp ----------

    add("timestamps: resolves one valid segment start", () => {
        const transcript = transcriptWithSegments([["a", 83]]);
        return resolveEvidenceTimestamp(evidenceWith(["seg-000000"]), transcript) === 83;
    });

    add("timestamps: uses the first valid segment when several are referenced", () => {
        const transcript = transcriptWithSegments([["a", 10], ["b", 20], ["c", 30]]);
        const evidence = evidenceWith(["seg-000002", "seg-000000"]);
        return resolveEvidenceTimestamp(evidence, transcript) === 30;
    });

    add("timestamps: skips invalid and missing starts", () => {
        const transcript = {
            segments: [
                { id: "seg-000000", start: { seconds: NaN } },
                { id: "seg-000001", start: null },
                { id: "seg-000002", start: { seconds: -5 } },
                { id: "seg-000003", start: { seconds: 42 } }
            ]
        };
        const evidence = evidenceWith(["seg-000000", "seg-000001", "seg-000002", "seg-000003", "seg-999999"]);
        return resolveEvidenceTimestamp(evidence, transcript) === 42;
    });

    add("timestamps: no valid segment yields null", () => {
        const transcript = transcriptWithSegments([["a", null]]);
        return resolveEvidenceTimestamp(evidenceWith(["seg-000000"]), transcript) === null &&
            resolveEvidenceTimestamp(evidenceWith(["seg-999999"]), transcript) === null;
    });

    add("timestamps: malformed inputs yield null, never throw", () => {
        const transcript = transcriptWithSegments([["a", 10]]);
        return resolveEvidenceTimestamp(null, transcript) === null &&
            resolveEvidenceTimestamp(evidenceWith(["seg-000000"]), null) === null &&
            resolveEvidenceTimestamp({}, transcript) === null &&
            resolveEvidenceTimestamp(evidenceWith("seg-000000"), transcript) === null;
    });

    // ---------- formatTimestamp ----------

    add("timestamps: formatTimestamp handles seconds, minutes, hours", () => {
        return formatTimestamp(0) === "00:00" &&
            formatTimestamp(8.4) === "00:08" &&
            formatTimestamp(83) === "01:23" &&
            formatTimestamp(3599) === "59:59" &&
            formatTimestamp(3600) === "01:00:00" &&
            formatTimestamp(3723) === "01:02:03";
    });

    add("timestamps: formatTimestamp clamps negatives and rounds", () => {
        return formatTimestamp(-5) === "00:00" && formatTimestamp(8.6) === "00:09";
    });

    // ---------- describeTimestamp ----------

    add("timestamps: describeTimestamp produces spoken labels", () => {
        return describeTimestamp(83) === "1 minute 23 seconds" &&
            describeTimestamp(8) === "8 seconds" &&
            describeTimestamp(60) === "1 minute" &&
            describeTimestamp(3723) === "1 hour 2 minutes 3 seconds";
    });

    // ---------- Evidence timestamp buttons ----------

    add("timestamps: evidence card shows a timestamp button when resolvable", () => {
        const { mount } = renderAnalysisWithEvidence([evidenceWith(["seg-000000"])]);
        // docWith gives segment 0 start 0 -> "00:00"
        const button = mount.querySelector(".timestamp-button");
        return button !== null &&
            button.tagName === "BUTTON" &&
            button.textContent.includes("00:00") &&
            button.getAttribute("aria-label") === "Seek player to 0 seconds";
    });

    add("timestamps: clicking the button calls onSeekTimestamp with seconds", () => {
        const doc = docWith(["first", "second oh my god"]);
        const mount = document.createElement("div");
        const received = [];
        renderAnalysisView(mount, projectWithDoc(doc), {
            analysis: {
                status: "done",
                request: { id: "req-1", scope: { type: "full" } },
                result: {
                    evidence: [evidenceWith([doc.segments[1].id])],
                    observations: [], warnings: [], limitations: []
                }
            },
            onAnalyze: () => {},
            builder: null,
            player: { mount: document.createElement("div"), available: true },
            onSeekTimestamp: (seconds) => received.push(seconds)
        });
        const button = mount.querySelector(".timestamp-button");
        button.click();
        return received.length === 1 && received[0] === 10 &&
            button.textContent.includes("00:10");
    });

    add("timestamps: no button when no segment resolves", () => {
        const { mount } = renderAnalysisWithEvidence([evidenceWith(["seg-999999"])]);
        return mount.querySelector(".timestamp-button") === null;
    });

    add("timestamps: no button when no playable video exists", () => {
        const { mount } = renderAnalysisWithEvidence([evidenceWith(["seg-000000"])], {
            playerAvailable: false
        });
        return mount.querySelector(".timestamp-button") === null &&
            mount.textContent.includes("Load a video on the Dashboard");
    });

    add("timestamps: button is a real button, not a link", () => {
        const { mount } = renderAnalysisWithEvidence([evidenceWith(["seg-000000"])]);
        const button = mount.querySelector(".timestamp-button");
        return button.tagName === "BUTTON" && button.getAttribute("href") === null;
    });

    // ---------- Player integration (coordinator/controller) ----------

    add("timestamps: seek on a ready player posts immediately", () => {
        const { host, frame } = createCoordinatorHost();
        const coordinator = createPlayerCoordinator({ driver: youtubePlayerDriver });
        const controller = coordinator.sync(youtubeIdentity, host);
        host.window.dispatchMessage(readyEvent(frame));
        if (!controller.ready) return false;
        controller.seek(83);
        return frame.contentWindow.posted.length === 1 &&
            controller.queuedSeekCount === 0;
    });

    add("timestamps: seek before ready queues and flushes on ready", () => {
        const { host, frame } = createCoordinatorHost();
        const coordinator = createPlayerCoordinator({ driver: youtubePlayerDriver });
        const controller = coordinator.sync(youtubeIdentity, host);
        controller.seek(83);
        if (controller.queuedSeekCount !== 1) return false;
        if (frame.contentWindow.posted.length !== 0) return false;
        host.window.dispatchMessage(readyEvent(frame));
        return controller.queuedSeekCount === 0 &&
            frame.contentWindow.posted.length === 1;
    });

    add("timestamps: coordinator reuses the controller for the same identity", () => {
        const { host } = createCoordinatorHost();
        const coordinator = createPlayerCoordinator({ driver: youtubePlayerDriver });
        const first = coordinator.sync(youtubeIdentity, host);
        const second = coordinator.sync({ ...youtubeIdentity }, host);
        return first !== null && first === second;
    });

    add("timestamps: coordinator yields null with no playable identity", () => {
        const { host } = createCoordinatorHost();
        const coordinator = createPlayerCoordinator({ driver: youtubePlayerDriver });
        return coordinator.sync(null, host) === null &&
            coordinator.controller === null;
    });

    add("timestamps: controller rejects invalid seek seconds", () => {
        const { host, mount } = createCoordinatorHost();
        const controller = createPlayerController({
            driver: youtubePlayerDriver,
            identity: youtubeIdentity,
            mountElement: mount,
            host
        });
        let threw = false;
        try {
            controller.seek(NaN);
        } catch (error) {
            threw = error && error.code === "invalid_seek_seconds";
        }
        controller.destroy();
        return threw === true;
    });

    // ---------- Sensitivity cleanup ----------

    add("timestamps: keyword and phrase expose no sensitivity control", () => {
        const mount = document.createElement("div");
        renderAnalysisView(mount, projectWithDoc(docWith(["hello"])), {
            analysis: { status: "idle" },
            onAnalyze: () => {},
            builder: { config: {}, onConfigChange: () => {} }
        });
        const keywordRadios = mount.querySelectorAll('details[data-detector="keyword"] input[type="radio"]');
        const phraseRadios = mount.querySelectorAll('details[data-detector="phrase"] input[type="radio"]');
        return keywordRadios.length === 0 && phraseRadios.length === 0;
    });

    add("timestamps: hype, question, reaction, emphasis keep sensitivity", () => {
        const mount = document.createElement("div");
        renderAnalysisView(mount, projectWithDoc(docWith(["hello"])), {
            analysis: { status: "idle" },
            onAnalyze: () => {},
            builder: { config: {}, onConfigChange: () => {} }
        });
        return ["hype", "question", "reaction", "emphasis"].every((type) =>
            mount.querySelectorAll(`details[data-detector="${type}"] input[type="radio"]`).length === 3);
    });

    add("timestamps: keyword/phrase thresholds ignore sensitivity in the detector", () => {
        return thresholdFor(DETECTOR_TYPE.KEYWORD, "low") === 1 &&
            thresholdFor(DETECTOR_TYPE.KEYWORD, "high") === 1 &&
            thresholdFor(DETECTOR_TYPE.PHRASE, "low") === 1 &&
            thresholdFor(DETECTOR_TYPE.PHRASE, "high") === 1 &&
            thresholdFor(DETECTOR_TYPE.HYPE, "low") > thresholdFor(DETECTOR_TYPE.HYPE, "normal");
    });

    // ---------- Rickroll dev default ----------

    add("timestamps: rickroll dev constant is the expected URL", () => {
        return DEV_DEFAULT_VIDEO_URL === RICKROLL;
    });

    add("timestamps: empty initial URL field receives the dev default", () => {
        const form = createVideoUrlForm({
            onSubmit: () => ({}),
            initialUrl: DEV_DEFAULT_VIDEO_URL
        });
        return form.querySelector("#video-url-input").value === RICKROLL;
    });

    add("timestamps: existing URL value is preserved, not overwritten", () => {
        const existing = "https://www.youtube.com/watch?v=9bZkp7q19f0";
        const form = createVideoUrlForm({
            onSubmit: () => ({}),
            initialUrl: existing
        });
        return form.querySelector("#video-url-input").value === existing;
    });

    add("timestamps: typing reports the draft without submitting", () => {
        const drafts = [];
        let submitted = 0;
        const form = createVideoUrlForm({
            onSubmit: () => { submitted += 1; return {}; },
            initialUrl: DEV_DEFAULT_VIDEO_URL,
            onUrlInput: (value) => drafts.push(value)
        });
        const input = form.querySelector("#video-url-input");
        input.value = "https://www.youtube.com/watch?v=abc";
        const EventCtor = input.ownerDocument.defaultView.Event;
        input.dispatchEvent(new EventCtor("input", { bubbles: true }));
        return drafts.length === 1 &&
            drafts[0] === "https://www.youtube.com/watch?v=abc" &&
            submitted === 0;
    });

    add("timestamps: creating the form never auto-submits", () => {
        let submitted = 0;
        createVideoUrlForm({
            onSubmit: () => { submitted += 1; return {}; },
            initialUrl: DEV_DEFAULT_VIDEO_URL
        });
        return submitted === 0;
    });
}

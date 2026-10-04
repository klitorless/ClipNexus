// ==========================================================
// devtools-caption-queue-tests.js
// Responsibility: self-tests for the caption request queue
// frontend: the caption-jobs client, the youtube-native
// provider's queue flow (with synchronous fallback), the
// queue-status component, the Help view, and the Learn-more
// control.
//
// Provider tests inject a mock fetch and short poll timings
// so the queue flow runs deterministically with no network.
// DOM tests need a real document (browser-only, same standing
// as the existing DOM tests).
// ==========================================================

import {
    enqueueCaptionJob,
    getCaptionJob,
    fetchCaptionJobResult,
    captionJobsBaseUrl,
    isTerminalJobStatus,
    CAPTION_JOB_STATUS
} from "../transcript/caption-jobs.js";
import {
    createYouTubeNativeProvider,
    YOUTUBE_CAPTION_SERVICE_URL
} from "../transcript/providers/adapters/youtube-native.js";
import { createQueueStatus } from "../ui/acquisition-panel.js";
import { createVideoUrlForm, DEV_DEFAULT_VIDEO_URL } from "../ui/project-panel.js";
import { renderHelpView, SUPPORT_CONTACT } from "../ui/help.js";
import { routes } from "../core/router.js";

const VID = "dQw4w9WgXcQ";
const BASE = "https://caption.example.test";
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n";

function jsonResponse(status, body, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers }
    });
}

function vttResponse(headers = {}) {
    return new Response(VTT, {
        status: 200,
        headers: {
            "Content-Type": "text/vtt",
            "X-Caption-Language": "en",
            "X-Caption-Generated": "false",
            "X-Caption-Source": "innertube",
            "X-Caption-Format": "xml",
            ...headers
        }
    });
}

// Mock fetch routing by URL for the provider queue flow.
function queueMockFetch({ enqueueStatus = 202, statusSequence = null, resultOk = true } = {}) {
    let statusCalls = 0;
    const seq = statusSequence || ["processing", "completed"];
    return async (url, init = {}) => {
        const method = (init.method || "GET").toUpperCase();
        if (url.endsWith("/caption-jobs") && method === "POST") {
            if (enqueueStatus !== 202) return jsonResponse(enqueueStatus, { error: { type: "x" } });
            return jsonResponse(202, {
                job: {
                    id: "job_test_0123456789abcdef",
                    status: "queued",
                    positionApproximate: 3,
                    backlog: 3,
                    estimatedWaitSeconds: 16
                }
            });
        }
        if (url.includes("/caption-jobs/") && url.endsWith("/result")) {
            return resultOk ? vttResponse() : new Response("nope", { status: 410 });
        }
        if (url.includes("/caption-jobs/")) {
            const status = seq[Math.min(statusCalls, seq.length - 1)];
            statusCalls += 1;
            return jsonResponse(200, {
                job: {
                    id: "job_test_0123456789abcdef",
                    status,
                    ...(status === "failed"
                        ? { error: { type: "transcript-unavailable", message: "none" } }
                        : {})
                }
            });
        }
        // Synchronous fallback endpoint.
        return vttResponse();
    };
}

const fastQueue = {
    queuePollIntervalMs: 5,
    queueAbandonAfterMs: 500,
    captionServiceUrl: `${BASE}/youtube-transcript`
};

const testVideo = { platform: "youtube", videoId: VID };

export function addCaptionQueueTests(add) {
    // ---------- caption-jobs client ----------

    add("queue: base URL derivation strips the endpoint path", () => {
        return captionJobsBaseUrl("https://h.example/youtube-transcript") === "https://h.example" &&
            captionJobsBaseUrl(YOUTUBE_CAPTION_SERVICE_URL) ===
                "https://clipnexus-youtube-caption-test.klitorless.workers.dev";
    });

    add("queue: terminal statuses are completed and failed", () => {
        return isTerminalJobStatus(CAPTION_JOB_STATUS.COMPLETED) &&
            isTerminalJobStatus(CAPTION_JOB_STATUS.FAILED) &&
            !isTerminalJobStatus(CAPTION_JOB_STATUS.QUEUED) &&
            !isTerminalJobStatus("direct");
    });

    add("queue: enqueue returns the job on 202", async () => {
        const fetchImpl = async () => jsonResponse(202, { job: { id: "job_x", status: "queued" } });
        const result = await enqueueCaptionJob({ baseUrl: BASE, videoId: VID, fetchImpl });
        return result.ok === true && result.job.id === "job_x";
    });

    add("queue: enqueue reports notConfigured on 501", async () => {
        const fetchImpl = async () => jsonResponse(501, { error: { type: "queue-unavailable" } });
        const result = await enqueueCaptionJob({ baseUrl: BASE, videoId: VID, fetchImpl });
        return result.ok === false && result.notConfigured === true;
    });

    add("queue: enqueue reports notConfigured on 503", async () => {
        const fetchImpl = async () => jsonResponse(503, { error: { type: "queue-unavailable" } });
        const result = await enqueueCaptionJob({ baseUrl: BASE, videoId: VID, fetchImpl });
        return result.ok === false && result.notConfigured === true;
    });

    add("queue: provider falls back to sync on 503 pre-acceptance", async () => {
        const updates = [];
        const provider = createYouTubeNativeProvider({
            fetchImpl: queueMockFetch({ enqueueStatus: 503 }),
            useCaptionQueue: true,
            ...fastQueue
        });
        const result = await provider.getTranscript(testVideo, {
            method: "any",
            onCaptionJobUpdate: (update) => updates.push(update)
        });
        return result.success === true &&
            updates.some((u) => u.phase === "direct");
    });

    add("queue: enqueue reports network failures without throwing", async () => {
        const fetchImpl = async () => { throw new Error("down"); };
        const result = await enqueueCaptionJob({ baseUrl: BASE, videoId: VID, fetchImpl });
        return result.ok === false && result.error.type === "network-failure";
    });

    add("queue: getCaptionJob reads status", async () => {
        const fetchImpl = async () => jsonResponse(200, { job: { id: "j", status: "processing" } });
        const result = await getCaptionJob({ baseUrl: BASE, jobId: "j", fetchImpl });
        return result.ok === true && result.job.status === "processing";
    });

    add("queue: fetchCaptionJobResult returns VTT and provenance", async () => {
        const result = await fetchCaptionJobResult({
            baseUrl: BASE, jobId: "j", fetchImpl: async () => vttResponse()
        });
        return result.ok === true &&
            result.vtt.startsWith("WEBVTT") &&
            result.meta.language === "en" &&
            result.meta.generated === "false";
    });

    // ---------- provider queue flow ----------

    add("queue: provider completes via the queue and reports progress", async () => {
        const updates = [];
        const provider = createYouTubeNativeProvider({
            fetchImpl: queueMockFetch(),
            useCaptionQueue: true,
            ...fastQueue
        });
        const result = await provider.getTranscript(testVideo, {
            method: "any",
            onCaptionJobUpdate: (update) => updates.push(update)
        });
        const phases = updates.map((u) => u.phase);
        return result.success === true &&
            result.transcript.rawText.startsWith("WEBVTT") &&
            phases[0] === "queued" &&
            phases.includes("completed") &&
            result.source.sourceId === "caption-service:innertube";
    });

    add("queue: provider falls back to sync when the queue is unconfigured", async () => {
        const updates = [];
        const provider = createYouTubeNativeProvider({
            fetchImpl: queueMockFetch({ enqueueStatus: 501 }),
            useCaptionQueue: true,
            ...fastQueue
        });
        const result = await provider.getTranscript(testVideo, {
            method: "any",
            onCaptionJobUpdate: (update) => updates.push(update)
        });
        return result.success === true &&
            result.transcript.rawText.startsWith("WEBVTT") &&
            updates.some((u) => u.phase === "direct");
    });

    add("queue: provider surfaces job failure honestly", async () => {
        const provider = createYouTubeNativeProvider({
            fetchImpl: queueMockFetch({ statusSequence: ["failed"] }),
            useCaptionQueue: true,
            ...fastQueue
        });
        const result = await provider.getTranscript(testVideo, { method: "any" });
        return result.success === false &&
            result.error.code === "TRANSCRIPT_UNAVAILABLE";
    });

    add("queue: accepted job is never abandoned for the sync endpoint", async () => {
        // The job stays queued past the old 21 s deadline; the
        // provider keeps polling instead of falling back.
        const updates = [];
        const provider = createYouTubeNativeProvider({
            fetchImpl: queueMockFetch({ statusSequence: ["queued"] }),
            useCaptionQueue: true,
            ...fastQueue,
            queuePollIntervalMs: 5,
            queueAbandonAfterMs: 60
        });
        const result = await provider.getTranscript(testVideo, {
            method: "any",
            onCaptionJobUpdate: (update) => updates.push(update)
        });
        const phases = updates.map((u) => u.phase);
        return result.success === false &&
            result.error.code === "PROVIDER_TIMEOUT" &&
            result.error.detail && result.error.detail.reason === "queue-abandoned" &&
            phases[0] === "queued" &&
            phases.includes("abandoned") &&
            !phases.includes("direct");
    });

    add("queue: queue-full enqueue maps to rate-limited", async () => {
        const fetchImpl = async (url, init = {}) =>
            (init.method || "GET").toUpperCase() === "POST"
                ? jsonResponse(429, { error: { type: "queue-full" } })
                : vttResponse();
        const provider = createYouTubeNativeProvider({ fetchImpl, useCaptionQueue: true, ...fastQueue });
        const result = await provider.getTranscript(testVideo, { method: "any" });
        return result.success === false && result.error.code === "RATE_LIMITED";
    });

    // ---------- queue status component ----------

    add("queue: status renders queued state with honest estimates", () => {
        const node = createQueueStatus({
            phase: "queued",
            jobId: "job_x",
            status: "queued",
            positionApproximate: 4,
            backlog: 4,
            estimatedWaitSeconds: 24
        });
        const text = node.textContent;
        return text.includes("Transcript request queued") &&
            text.includes("About 3 requests ahead") &&
            text.includes("Estimated wait:") &&
            text.includes("estimate") &&
            !text.includes("will complete");
    });

    add("queue: status omits what the backend cannot determine", () => {
        const node = createQueueStatus({ phase: "queued", jobId: "job_x", status: "queued" });
        const text = node.textContent;
        return text.includes("Transcript request queued") &&
            !text.includes("ahead") &&
            !text.includes("Estimated wait");
    });

    add("queue: status covers processing, failed, timeout, abandoned", () => {
        const processing = createQueueStatus({ phase: "processing" }).textContent;
        const failed = createQueueStatus({ phase: "failed" }).textContent;
        const timeout = createQueueStatus({ phase: "timeout" }).textContent;
        const abandoned = createQueueStatus({ phase: "abandoned" }).textContent;
        return processing.includes("Processing transcript request") &&
            failed.includes("Transcript request failed") &&
            timeout.includes("taking longer than expected") &&
            abandoned.includes("timed out");
    });

    add("queue: direct phase renders nothing", () => {
        const node = createQueueStatus({ phase: "direct" });
        return node.textContent.trim() === "";
    });

    add("queue: null job renders an empty status node", () => {
        const node = createQueueStatus(null);
        return node.dataset.section === "caption-queue-status" &&
            node.textContent.trim() === "";
    });

    // ---------- help page ----------

    add("queue: help route is registered", () => {
        return routes.some((route) => route.id === "help");
    });

    add("queue: help page covers API keys, quotas, queue limits", () => {
        const mount = document.createElement("div");
        renderHelpView(mount);
        const text = mount.textContent.toLowerCase();
        return text.includes("api keys") &&
            text.includes("never share") &&
            text.includes("quotas") &&
            text.includes("estimates, never guarantees") &&
            mount.textContent.includes("Terms and licensing");
    });

    add("queue: help page marks contact as pending, not invented", () => {
        const mount = document.createElement("div");
        renderHelpView(mount);
        return SUPPORT_CONTACT === null &&
            mount.textContent.includes("before the public beta");
    });

    add("queue: learn-more control links to help", () => {
        const form = createVideoUrlForm({
            onSubmit: () => ({}),
            apiKey: { ready: false, onSave: () => true, onClear: () => {} }
        });
        const link = form.querySelector('a[href="#help"]');
        return link !== null && link.textContent.includes("Learn more");
    });

    add("queue: rickroll default is the expected URL", () => {
        return DEV_DEFAULT_VIDEO_URL === "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    });
}

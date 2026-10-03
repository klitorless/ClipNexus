// ==========================================================
// devtools-youtube-native-tests.js
// Responsibility: self-tests for the no-key YouTube native
// captions provider (now backed by the ClipNexus caption
// service, a Cloudflare Worker), the automatic fallback chain,
// and the registry wiring.
//
// Deterministic and offline: the caption service is exercised
// through a FAKE fetch (Worker-style 200 text/vtt answers and
// structured JSON errors are inline fixtures). No request ever
// leaves the browser, and the suite never touches the real
// Worker, live YouTube, or Supadata quota.
// ==========================================================

import { createProviderRegistry } from "../transcript/providers/registry.js";
import { PROVIDER_STATUS } from "../transcript/providers/provider.js";
import {
    acquireTranscript, acquireTranscriptWithFallback, applyAcquisitionToProject
} from "../transcript/providers/manager.js";
import {
    createYouTubeNativeProvider, YOUTUBE_NATIVE_ID, YOUTUBE_CAPTION_SERVICE_URL
} from "../transcript/providers/adapters/youtube-native.js";
import { createSupadataProvider, SUPADATA_ID } from "../transcript/providers/adapters/supadata.js";
import { createCredentialStore } from "../transcript/providers/credentials.js";
import {
    createDefaultProviderRegistry, AUTOMATIC_PROVIDER_IDS
} from "../transcript/providers/default-providers.js";
import { buildAcquiredTranscript } from "../transcript/pipeline.js";
import { applyVideoIdentity } from "./project.js";
import { resolveVideoUrl } from "../video/video-resolver.js";

const videoId = "dQw4w9WgXcQ";
const serviceUrl = (id = videoId) => `${YOUTUBE_CAPTION_SERVICE_URL}?v=${encodeURIComponent(id)}`;
const TEST_KEY = "sd_test_key_0123456789";     // fake; never a real key

// ---------- Fakes ----------

// headers: plain object; looked up case-insensitively like Headers.get.
function reply(status, body, headers = {}) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const map = new Map(Object.entries(headers).map(([name, value]) => [String(name).toLowerCase(), value]));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
        text: async () => text
    };
}

// replies: array of reply() or functions (url, init) => reply | throw.
function fakeFetch(replies) {
    const calls = [];
    let index = 0;
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        const next = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return typeof next === "function" ? next(url, init) : next;
    };
    return { fetchImpl, calls };
}

const vttHeaders = (overrides = {}) => ({
    "Content-Type": "text/vtt; charset=utf-8",
    "X-Caption-Language": "en",
    "X-Caption-Generated": "false",
    "X-Caption-Source": "innertube",
    "X-Caption-Format": "xml",
    ...overrides
});

const workerError = (type) => ({ error: { type, message: `worker says: ${type}` } });

const SAMPLE_VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello world\n\n00:00:04.000 --> 00:00:06.000\nSecond cue\n";

const SUPADATA_BODY = Object.freeze({
    lang: "en",
    content: [{ text: "Supadata fallback line", offset: 1000, duration: 2000, lang: "en" }]
});

function setup(replies, { deadlineMs, captionServiceUrl } = {}) {
    const fake = fakeFetch(replies);
    const provider = createYouTubeNativeProvider({
        fetchImpl: fake.fetchImpl, requestDeadlineMs: deadlineMs, captionServiceUrl
    });
    return { registry: createProviderRegistry([provider]), provider, calls: fake.calls };
}

function projectFor(url = `https://youtu.be/${videoId}?t=90`) {
    const resolved = resolveVideoUrl(url);
    return applyVideoIdentity(null, resolved.video, resolved.startPosition).project;
}

const acquire = (registry, project, options = {}) =>
    acquireTranscript({ registry, providerId: YOUTUBE_NATIVE_ID, video: project.video, options });

const noKeyIn = (init) => {
    const headers = (init && init.headers) || {};
    return !Object.keys(headers).some((name) => /api-key|authorization/i.test(name)) &&
        !JSON.stringify(init).includes(TEST_KEY);
};

export function addYouTubeNativeTests(add) {

    // ---------- Registration & configuration ----------

    add("youtube-native: registered first, available, no credential", () => {
        const registry = createDefaultProviderRegistry();
        const first = registry.listSelectable()[0];
        const described = registry.list().find((item) => item.id === YOUTUBE_NATIVE_ID);
        return first && first.id === YOUTUBE_NATIVE_ID &&
            described.status === PROVIDER_STATUS.AVAILABLE && described.enabled === true &&
            described.credential === null &&
            described.capabilities.platforms.join() === "youtube" &&
            described.capabilities.nativeCaptions === true &&
            described.capabilities.generatedTranscript === true;
    });

    add("youtube-native: automatic provider order is no-key first, Supadata second", () => {
        return Array.isArray(AUTOMATIC_PROVIDER_IDS) &&
            AUTOMATIC_PROVIDER_IDS.join(",") === `${YOUTUBE_NATIVE_ID},${SUPADATA_ID}`;
    });

    add("youtube-native: caption service URL is a single public configuration point", () => {
        return typeof YOUTUBE_CAPTION_SERVICE_URL === "string" &&
            YOUTUBE_CAPTION_SERVICE_URL === "https://clipnexus-youtube-caption-test.klitorless.workers.dev/youtube-transcript";
    });

    add("youtube-native: service URL can be replaced without touching the adapter", async () => {
        const custom = "https://example.com/captions";
        const { registry, calls } = setup([reply(200, SAMPLE_VTT, vttHeaders())], { captionServiceUrl: custom });
        const result = await acquire(registry, projectFor());
        return result.success === true && calls.length === 1 &&
            calls[0].url === `${custom}?v=${videoId}`;
    });

    // ---------- Retrieval ----------

    add("youtube-native: valid YouTube video requests the caption service by video id", async () => {
        const { registry, calls } = setup([reply(200, SAMPLE_VTT, vttHeaders())]);
        const result = await acquire(registry, projectFor());
        return result.success === true && calls.length === 1 &&
            calls[0].url === serviceUrl();
    });

    add("youtube-native: caption-service request sends no credential and minimal headers", async () => {
        const { registry, calls } = setup([reply(200, SAMPLE_VTT, vttHeaders())]);
        await acquire(registry, projectFor());
        return calls.every((call) => noKeyIn(call.init) &&
            call.init.credentials === "omit" && call.init.referrerPolicy === "no-referrer");
    });

    add("youtube-native: manual captions reported as native with the service's language", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders())]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.source.method === "native" &&
            result.source.generated === false && result.source.language === "en" &&
            result.source.providerId === YOUTUBE_NATIVE_ID &&
            result.source.providerName === "YouTube native captions" &&
            typeof result.source.sourceId === "string" && result.source.sourceId.length > 0;
    });

    add("youtube-native: auto-generated captions reported as generated", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders({
            "X-Caption-Language": "ko", "X-Caption-Generated": "true"
        }))]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.source.method === "generated" &&
            result.source.generated === true && result.source.language === "ko";
    });

    add("youtube-native: X-Video-Title header surfaces as decoded videoTitle", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders({
            "X-Video-Title": encodeURIComponent("Never Gonna Give You Up")
        }))]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.videoTitle === "Never Gonna Give You Up";
    });

    add("youtube-native: unicode video titles decode correctly", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders({
            "X-Video-Title": encodeURIComponent("café ☕ & <friends>")
        }))]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.videoTitle === "café ☕ & <friends>";
    });

    add("youtube-native: missing X-Video-Title → videoTitle is null", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders())]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.videoTitle === null;
    });

    add("youtube-native: malformed X-Video-Title encoding → videoTitle is null", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders({
            "X-Video-Title": "%E0%A4%A"   // truncated percent-encoding
        }))]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.videoTitle === null;
    });

    add("youtube-native: X-Video-Duration header surfaces as videoDurationSeconds", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders({
            "X-Video-Duration": "212"
        }))]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.videoDurationSeconds === 212;
    });

    add("youtube-native: missing X-Video-Duration → videoDurationSeconds is null", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders())]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.videoDurationSeconds === null;
    });

    add("youtube-native: non-integer X-Video-Duration → videoDurationSeconds is null", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders({
            "X-Video-Duration": "12.5"
        }))]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.videoDurationSeconds === null;
    });

    add("youtube-native: method native with only auto-generated captions → TRANSCRIPT_UNAVAILABLE", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders({ "X-Caption-Generated": "true" }))]);
        const result = await acquire(registry, projectFor(), { method: "native" });
        return result.success === false && result.error.code === "TRANSCRIPT_UNAVAILABLE" &&
            result.error.providerId === YOUTUBE_NATIVE_ID && result.error.retryable === false;
    });

    add("youtube-native: method generated with only native captions → TRANSCRIPT_UNAVAILABLE", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders({ "X-Caption-Generated": "false" }))]);
        const result = await acquire(registry, projectFor(), { method: "generated" });
        return result.success === false && result.error.code === "TRANSCRIPT_UNAVAILABLE";
    });

    add("youtube-native: non-YouTube video → UNSUPPORTED_VIDEO, no request", async () => {
        const { provider, calls } = setup([]);
        const result = await provider.getTranscript(
            { platform: "vimeo", videoId: "12345678901", canonicalUrl: "https://vimeo.com/12345678901" },
            { language: null, method: "any" });
        return result.success === false && result.error.code === "UNSUPPORTED_VIDEO" && calls.length === 0;
    });

    add("youtube-native: invalid video id → INVALID_REQUEST, no request", async () => {
        const { provider, calls } = setup([]);
        const result = await provider.getTranscript(
            { platform: "youtube", videoId: "not-an-id", canonicalUrl: "https://www.youtube.com/watch?v=not-an-id" },
            { language: null, method: "any" });
        return result.success === false && result.error.code === "INVALID_REQUEST" && calls.length === 0;
    });

    // ---------- Failure modes ----------

    add("youtube-native: worker transcript-unavailable → TRANSCRIPT_UNAVAILABLE (not a network failure)", async () => {
        const { registry, calls } = setup([reply(404, workerError("transcript-unavailable"))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "TRANSCRIPT_UNAVAILABLE" &&
            result.error.retryable === false && calls.length === 1;
    });

    add("youtube-native: worker track-unavailable → TRANSCRIPT_UNAVAILABLE", async () => {
        const { registry } = setup([reply(404, workerError("track-unavailable"))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "TRANSCRIPT_UNAVAILABLE";
    });

    add("youtube-native: worker invalid-video-id → INVALID_REQUEST", async () => {
        const { registry } = setup([reply(400, workerError("invalid-video-id"))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "INVALID_REQUEST";
    });

    add("youtube-native: worker rate-limited → RATE_LIMITED", async () => {
        const { registry } = setup([reply(429, workerError("rate-limited"))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "RATE_LIMITED" &&
            result.error.retryable === true;
    });

    add("youtube-native: worker timeout → PROVIDER_TIMEOUT", async () => {
        const { registry } = setup([reply(504, workerError("timeout"))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "PROVIDER_TIMEOUT";
    });

    add("youtube-native: worker retrieval-failure → PROVIDER_UNAVAILABLE", async () => {
        const { registry } = setup([reply(502, workerError("retrieval-failure"))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "PROVIDER_UNAVAILABLE";
    });

    add("youtube-native: worker malformed-response → MALFORMED_RESPONSE", async () => {
        const { registry } = setup([reply(502, workerError("malformed-response"))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "MALFORMED_RESPONSE";
    });

    add("youtube-native: non-JSON error body falls back to the HTTP status", async () => {
        const { registry } = setup([reply(500, "boom")]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "PROVIDER_UNAVAILABLE";
    });

    add("youtube-native: unknown worker error type falls back to the HTTP status", async () => {
        const { registry } = setup([reply(503, workerError("something-new"))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "PROVIDER_UNAVAILABLE";
    });

    add("youtube-native: HTTP 200 with non-VTT body → MALFORMED_RESPONSE", async () => {
        const { registry } = setup([reply(200, "<html>oops</html>", vttHeaders())]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "MALFORMED_RESPONSE";
    });

    add("youtube-native: empty caption track → TRANSCRIPT_EMPTY", async () => {
        const { registry } = setup([reply(200, "WEBVTT\n\nNOTE nothing here\n", vttHeaders())]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "TRANSCRIPT_EMPTY";
    });

    add("youtube-native: network failure → PROVIDER_UNAVAILABLE (never a raw error)", async () => {
        const { registry } = setup([async () => { throw new TypeError("fetch failed"); }]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "PROVIDER_UNAVAILABLE" &&
            result.error.retryable === true;
    });

    add("youtube-native: request deadline → PROVIDER_TIMEOUT", async () => {
        const { registry } = setup([() => new Promise(() => {})], { deadlineMs: 20 });
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "PROVIDER_TIMEOUT";
    });

    // ---------- TranscriptDocument ----------

    add("youtube-native: captions become a canonical TranscriptDocument", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders())]);
        const project = projectFor();
        const result = await acquire(registry, project);
        if (!result.success) return false;
        const document = buildAcquiredTranscript(result);
        return document.acquisition.type === "provider" &&
            document.acquisition.providerId === YOUTUBE_NATIVE_ID &&
            document.acquisition.video.videoId === videoId &&
            document.source.filename === null &&
            typeof document.rawText === "string" && document.rawText.includes("WEBVTT") &&
            Object.isFrozen(document) && Object.isFrozen(document.segments);
    });

    add("youtube-native: timestamps normalized, ordering preserved", async () => {
        const { registry } = setup([reply(200, SAMPLE_VTT, vttHeaders())]);
        const result = await acquire(registry, projectFor());
        if (!result.success) return false;
        const document = buildAcquiredTranscript(result);
        const [first, second] = document.segments;
        return document.segments.length === 2 &&
            first.id === "seg-000000" && second.id === "seg-000001" &&
            first.start.seconds === 1 && first.end.seconds === 3.5 &&
            second.start.seconds === 4 && second.end.seconds === 6 &&
            first.text === "Hello world" && second.text === "Second cue" &&
            first.start.status === "parsed";
    });

    add("youtube-native: failure never corrupts project state", async () => {
        const { registry } = setup([reply(404, workerError("transcript-unavailable"))]);
        const project = projectFor();
        const result = await acquire(registry, project);
        const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
        return result.success === false && applied.error !== null &&
            applied.project === project && project.transcript === null;
    });

    // ---------- Fallback chain ----------

    function fallbackSetup(nativeReplies) {
        const credentials = createCredentialStore();
        credentials.set(SUPADATA_ID, TEST_KEY);
        const nativeCalls = [];
        const native = createYouTubeNativeProvider({
            fetchImpl: async (url, init) => {
                nativeCalls.push(String(url));
                const next = nativeReplies[Math.min(nativeCalls.length - 1, nativeReplies.length - 1)];
                return typeof next === "function" ? next(url, init) : next;
            }
        });
        const supadataCalls = [];
        const supadataProvider = createSupadataProvider({
            fetchImpl: async (url, init) => {
                supadataCalls.push(String(url));
                return reply(200, SUPADATA_BODY);
            },
            credentials,
            sleep: async () => {}
        });
        const registry = createProviderRegistry([native, supadataProvider]);
        return { registry, nativeCalls, supadataCalls };
    }

    add("fallback: youtube-native failure → Supadata is tried and its transcript wins", async () => {
        const { registry, nativeCalls, supadataCalls } = fallbackSetup([reply(404, workerError("transcript-unavailable"))]);
        const result = await acquireTranscriptWithFallback({
            registry, providerIds: AUTOMATIC_PROVIDER_IDS, video: projectFor().video, options: {}
        });
        return result.success === true && result.source.providerId === SUPADATA_ID &&
            nativeCalls.length === 1 && supadataCalls.length === 1;
    });

    add("fallback: youtube-native success → Supadata is never called (no quota consumed)", async () => {
        const { registry, nativeCalls, supadataCalls } = fallbackSetup([reply(200, SAMPLE_VTT, vttHeaders())]);
        const result = await acquireTranscriptWithFallback({
            registry, providerIds: AUTOMATIC_PROVIDER_IDS, video: projectFor().video, options: {}
        });
        return result.success === true && result.source.providerId === YOUTUBE_NATIVE_ID &&
            nativeCalls.length === 1 && supadataCalls.length === 0;
    });

    add("fallback: Supadata CREDENTIAL_REQUIRED does not hide the youtube-native failure", async () => {
        const credentials = createCredentialStore();   // no key → Supadata reports CREDENTIAL_REQUIRED
        const native = createYouTubeNativeProvider({
            fetchImpl: async () => { throw new TypeError("blocked"); }
        });
        const supadataProvider = createSupadataProvider({
            fetchImpl: fakeFetch([reply(200, SUPADATA_BODY)]).fetchImpl, credentials, sleep: async () => {}
        });
        const registry = createProviderRegistry([native, supadataProvider]);
        const result = await acquireTranscriptWithFallback({
            registry, providerIds: [YOUTUBE_NATIVE_ID, SUPADATA_ID], video: projectFor().video, options: {}
        });
        return result.success === false && result.error.code === "PROVIDER_UNAVAILABLE" &&
            result.error.providerId === YOUTUBE_NATIVE_ID &&
            Array.isArray(result.error.detail.attemptedProviders) &&
            result.error.detail.attemptedProviders.join(",") === `${YOUTUBE_NATIVE_ID},${SUPADATA_ID}` &&
            Array.isArray(result.error.detail.credentialRequiredProviders) &&
            result.error.detail.credentialRequiredProviders.join(",") === SUPADATA_ID;
    });

    add("fallback: youtube-native TRANSCRIPT_UNAVAILABLE stays visible when Supadata needs a key", async () => {
        const credentials = createCredentialStore();   // no key → Supadata reports CREDENTIAL_REQUIRED
        const native = createYouTubeNativeProvider({
            fetchImpl: async () => reply(404, workerError("transcript-unavailable"))
        });
        const supadataProvider = createSupadataProvider({
            fetchImpl: fakeFetch([reply(200, SUPADATA_BODY)]).fetchImpl, credentials, sleep: async () => {}
        });
        const registry = createProviderRegistry([native, supadataProvider]);
        const result = await acquireTranscriptWithFallback({
            registry, providerIds: [YOUTUBE_NATIVE_ID, SUPADATA_ID], video: projectFor().video, options: {}
        });
        return result.success === false && result.error.code === "TRANSCRIPT_UNAVAILABLE" &&
            result.error.providerId === YOUTUBE_NATIVE_ID && result.error.retryable === false;
    });

    add("fallback: when no provider attempted, the last CREDENTIAL_REQUIRED is returned", async () => {
        const credentials = createCredentialStore();   // no key anywhere
        const supadataProvider = createSupadataProvider({
            fetchImpl: fakeFetch([reply(200, SUPADATA_BODY)]).fetchImpl, credentials, sleep: async () => {}
        });
        const registry = createProviderRegistry([supadataProvider]);
        const result = await acquireTranscriptWithFallback({
            registry, providerIds: [SUPADATA_ID], video: projectFor().video, options: {}
        });
        return result.success === false && result.error.code === "CREDENTIAL_REQUIRED" &&
            result.error.providerId === SUPADATA_ID;
    });

    add("fallback: a later attempted failure still wins over an earlier one", async () => {
        const credentials = createCredentialStore();
        credentials.set(SUPADATA_ID, TEST_KEY);
        const native = createYouTubeNativeProvider({
            fetchImpl: async () => reply(404, workerError("transcript-unavailable"))
        });
        const supadataProvider = createSupadataProvider({
            fetchImpl: async () => reply(401, { error: "unauthorized" }),
            credentials, sleep: async () => {}
        });
        const registry = createProviderRegistry([native, supadataProvider]);
        const result = await acquireTranscriptWithFallback({
            registry, providerIds: [YOUTUBE_NATIVE_ID, SUPADATA_ID], video: projectFor().video, options: {}
        });
        return result.success === false && result.error.code === "AUTHENTICATION_FAILED" &&
            result.error.providerId === SUPADATA_ID;
    });

    add("fallback: no video → INVALID_REQUEST without any request", async () => {
        const { registry, nativeCalls } = fallbackSetup([reply(200, SAMPLE_VTT, vttHeaders())]);
        const result = await acquireTranscriptWithFallback({
            registry, providerIds: AUTOMATIC_PROVIDER_IDS, video: null, options: {}
        });
        return result.success === false && result.error.code === "INVALID_REQUEST" && nativeCalls.length === 0;
    });

    add("supadata remains selectable alongside youtube-native", () => {
        const registry = createDefaultProviderRegistry();
        const ids = registry.listSelectable().map((item) => item.id);
        const supadata = registry.getSelectable(SUPADATA_ID);
        return ids.includes(SUPADATA_ID) && ids.includes(YOUTUBE_NATIVE_ID) &&
            supadata.success === true && supadata.provider.credential !== null;
    });
}

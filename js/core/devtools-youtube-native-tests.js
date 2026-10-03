// ==========================================================
// devtools-youtube-native-tests.js
// Responsibility: self-tests for the no-key YouTube native
// captions provider, the automatic fallback chain, and the
// registry wiring.
//
// Deterministic and offline: YouTube is exercised through a
// FAKE fetch (watch-page HTML and caption-track bodies are
// inline fixtures). No request ever leaves the browser, and the
// suite never touches live YouTube or Supadata quota.
// ==========================================================

import { createProviderRegistry } from "../transcript/providers/registry.js";
import { PROVIDER_STATUS } from "../transcript/providers/provider.js";
import {
    acquireTranscript, acquireTranscriptWithFallback, applyAcquisitionToProject
} from "../transcript/providers/manager.js";
import {
    createYouTubeNativeProvider, YOUTUBE_NATIVE_ID,
    extractJsonValue, normalizeCaptionTrack, selectCaptionTrack
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
const TEST_KEY = "sd_test_key_0123456789";     // fake; never a real key

// ---------- Fakes ----------

function reply(status, body) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { status, ok: status >= 200 && status < 300, text: async () => text };
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

const manualTrack = (overrides = {}) => ({
    baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&xorp=1&lang=en`,
    languageCode: "en",
    vssId: ".en",
    name: { simpleText: "English" },
    ...overrides
});

const asrTrack = (overrides = {}) => manualTrack({
    kind: "asr",
    vssId: "a.en",
    name: { simpleText: "English (auto-generated)" },
    ...overrides
});

// Minimal watch page carrying the player response, the way YouTube embeds it.
function watchPage(tracks) {
    const playerResponse = JSON.stringify({
        videoDetails: { videoId },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
    });
    return `<html><head><title>watch</title></head><body>` +
        `<script>var ytInitialPlayerResponse = ${playerResponse};</script>` +
        `</body></html>`;
}

const SAMPLE_VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello world\n\n00:00:04.000 --> 00:00:06.000\nSecond cue\n";

const SUPADATA_BODY = Object.freeze({
    lang: "en",
    content: [{ text: "Supadata fallback line", offset: 1000, duration: 2000, lang: "en" }]
});

function setup(replies, { deadlineMs } = {}) {
    const fake = fakeFetch(replies);
    const provider = createYouTubeNativeProvider({ fetchImpl: fake.fetchImpl, requestDeadlineMs: deadlineMs });
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

    // ---------- Registration ----------

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

    // ---------- Retrieval ----------

    add("youtube-native: valid YouTube video is accepted and the watch page is fetched by id", async () => {
        const { registry, calls } = setup([reply(200, watchPage([manualTrack()])), reply(200, SAMPLE_VTT)]);
        const result = await acquire(registry, projectFor());
        return result.success === true && calls.length === 2 &&
            calls[0].url === `https://www.youtube.com/watch?v=${videoId}`;
    });

    add("youtube-native: watch-page fetch sends no credential and minimal headers", async () => {
        const { registry, calls } = setup([reply(200, watchPage([manualTrack()])), reply(200, SAMPLE_VTT)]);
        await acquire(registry, projectFor());
        return calls.every((call) => noKeyIn(call.init) &&
            call.init.credentials === "omit" && call.init.referrerPolicy === "no-referrer");
    });

    add("youtube-native: manual captions preferred, reported as native", async () => {
        const { registry } = setup([reply(200, watchPage([asrTrack(), manualTrack()])), reply(200, SAMPLE_VTT)]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.source.method === "native" &&
            result.source.generated === false && result.source.language === "en" &&
            result.source.providerId === YOUTUBE_NATIVE_ID &&
            result.source.providerName === "YouTube native captions" &&
            result.source.sourceId === ".en";
    });

    add("youtube-native: auto-generated captions used when available, reported as generated", async () => {
        const { registry } = setup([reply(200, watchPage([asrTrack()])), reply(200, SAMPLE_VTT)]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.source.method === "generated" &&
            result.source.generated === true && result.source.sourceId === "a.en";
    });

    add("youtube-native: method native with only auto-generated tracks → TRANSCRIPT_UNAVAILABLE", async () => {
        const { registry } = setup([reply(200, watchPage([asrTrack()]))]);
        const result = await acquire(registry, projectFor(), { method: "native" });
        return result.success === false && result.error.code === "TRANSCRIPT_UNAVAILABLE" &&
            result.error.providerId === YOUTUBE_NATIVE_ID;
    });

    add("youtube-native: requested language picks the matching track", async () => {
        const spanish = manualTrack({
            baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&xorp=1&lang=es`,
            languageCode: "es", vssId: ".es", name: { simpleText: "Spanish" }
        });
        const { registry, calls } = setup([reply(200, watchPage([manualTrack(), spanish])), reply(200, SAMPLE_VTT)]);
        const result = await acquire(registry, projectFor(), { language: "es" });
        return result.success === true && result.source.language === "es" &&
            calls[1].url.includes("lang=es") && calls[1].url.includes("fmt=vtt");
    });

    add("youtube-native: non-YouTube video → UNSUPPORTED_VIDEO, no request", async () => {
        const { provider, calls } = setup([]);
        const result = await provider.getTranscript(
            { platform: "vimeo", videoId: "123", canonicalUrl: "https://vimeo.com/123" },
            { language: null, method: "any" });
        return result.success === false && result.error.code === "UNSUPPORTED_VIDEO" && calls.length === 0;
    });

    // ---------- Failure modes ----------

    add("youtube-native: page without caption tracks → TRANSCRIPT_UNAVAILABLE", async () => {
        const { registry, calls } = setup([reply(200, "<html><body>no player here</body></html>")]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "TRANSCRIPT_UNAVAILABLE" &&
            result.error.retryable === false && calls.length === 1;
    });

    add("youtube-native: empty caption track → TRANSCRIPT_EMPTY", async () => {
        const { registry } = setup([reply(200, watchPage([manualTrack()])), reply(200, "WEBVTT\n\nNOTE nothing here\n")]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "TRANSCRIPT_EMPTY";
    });

    add("youtube-native: network failure → PROVIDER_UNAVAILABLE (never a raw error)", async () => {
        const { registry } = setup([async () => { throw new TypeError("fetch failed"); }]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "PROVIDER_UNAVAILABLE" &&
            result.error.retryable === true;
    });

    add("youtube-native: non-VTT track body → MALFORMED_RESPONSE", async () => {
        const { registry } = setup([reply(200, watchPage([manualTrack()])), reply(200, "<html>oops</html>")]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "MALFORMED_RESPONSE";
    });

    add("youtube-native: track URL off YouTube hosts is never fetched → MALFORMED_RESPONSE", async () => {
        const evil = manualTrack({ baseUrl: "https://evil.example/timedtext?lang=en" });
        const { registry, calls } = setup([reply(200, watchPage([evil]))]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "MALFORMED_RESPONSE" && calls.length === 1;
    });

    add("youtube-native: HTTP 429 on the watch page → RATE_LIMITED", async () => {
        const { registry } = setup([reply(429, "slow down")]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "RATE_LIMITED";
    });

    // ---------- TranscriptDocument ----------

    add("youtube-native: captions become a canonical TranscriptDocument", async () => {
        const { registry } = setup([reply(200, watchPage([manualTrack()])), reply(200, SAMPLE_VTT)]);
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
        const { registry } = setup([reply(200, watchPage([manualTrack()])), reply(200, SAMPLE_VTT)]);
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
        const { registry } = setup([reply(200, "<html><body>no player here</body></html>")]);
        const project = projectFor();
        const result = await acquire(registry, project);
        const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
        return result.success === false && applied.error !== null &&
            applied.project === project && project.transcript === null;
    });

    // ---------- Pure helpers ----------

    add("youtube-native: extractJsonValue pulls the captionTracks array out of page noise", () => {
        const html = `<script>var x = 1;</script><script>var ytInitialPlayerResponse = ` +
            `{"a":1,"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[` +
            `{"baseUrl":"https://www.youtube.com/api/timedtext?v=${videoId}","languageCode":"en"}]}},` +
            `"b":[1,2]};</script>`;
        const raw = extractJsonValue(html, "\"captionTracks\":");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length === 1 && parsed[0].languageCode === "en" &&
            extractJsonValue(html, "\"missing\":") === null;
    });

    add("youtube-native: selectCaptionTrack honors method and language preference", () => {
        const tracks = [asrTrack(), manualTrack()].map(normalizeCaptionTrack);
        const any = selectCaptionTrack(tracks, { method: "any" });
        const native = selectCaptionTrack(tracks, { method: "native" });
        const generated = selectCaptionTrack(tracks, { method: "generated" });
        const noneForNative = selectCaptionTrack([normalizeCaptionTrack(asrTrack())], { method: "native" });
        return any && any.kind !== "asr" && native && native.kind !== "asr" &&
            generated && generated.kind === "asr" && noneForNative === null;
    });

    // ---------- Fallback chain ----------

    function fallbackSetup() {
        const credentials = createCredentialStore();
        credentials.set(SUPADATA_ID, TEST_KEY);
        const nativeCalls = [];
        const native = createYouTubeNativeProvider({
            fetchImpl: async (url, init) => { nativeCalls.push(String(url)); throw new TypeError("blocked"); }
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
        const { registry, nativeCalls, supadataCalls } = fallbackSetup();
        const result = await acquireTranscriptWithFallback({
            registry, providerIds: AUTOMATIC_PROVIDER_IDS, video: projectFor().video, options: {}
        });
        return result.success === true && result.source.providerId === SUPADATA_ID &&
            nativeCalls.length === 1 && supadataCalls.length === 1;
    });

    add("fallback: all providers failing returns the last error with attemptedProviders", async () => {
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
        return result.success === false && result.error.code === "CREDENTIAL_REQUIRED" &&
            Array.isArray(result.error.detail.attemptedProviders) &&
            result.error.detail.attemptedProviders.join(",") === `${YOUTUBE_NATIVE_ID},${SUPADATA_ID}`;
    });

    add("fallback: no video → INVALID_REQUEST without any request", async () => {
        const { registry, nativeCalls } = fallbackSetup();
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

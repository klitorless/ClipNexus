// ==========================================================
// devtools-provider-tests.js
// Responsibility: Stage 2A self-tests — provider registry,
// provider contract, error vocabulary, manual provider
// switching, provenance, and the acquisition panel.
// Registered by devtools.js via addProviderTests(add).
//
// Deterministic: every provider here is a local mock
// (adapters/mock.js) in a LOCAL registry. The application's
// registry and state are never modified. No network.
// ==========================================================

import { createProviderRegistry } from "../transcript/providers/registry.js";
import {
    defineProvider, isValidProvider, normalizeAdapterResponse, PROVIDER_STATUS, METHOD_PREFERENCE
} from "../transcript/providers/provider.js";
import { createAcquisitionError, ACQUISITION_ERROR_CODES } from "../transcript/providers/errors.js";
import { acquireTranscript, applyAcquisitionToProject } from "../transcript/providers/manager.js";
import {
    createAcquisitionState, withSelection, beginAttempt, completeAttempt, resetAttempt, ACQUISITION_STATUS
} from "../transcript/providers/acquisition-state.js";
import { createMockProvider, MOCK_TRANSCRIPT } from "../transcript/providers/adapters/mock.js";
import { createDefaultProviderRegistry } from "../transcript/providers/default-providers.js";
import { buildTranscriptDocument, buildAcquiredTranscript } from "../transcript/pipeline.js";
import { createFileAcquisition, ACQUISITION_TYPE } from "../transcript/model.js";
import { applyVideoIdentity, withTranscript } from "./project.js";
import { resolveVideoUrl } from "../video/video-resolver.js";
import { renderTranscriptsView } from "../ui/transcripts.js";
import { renderDashboard } from "../ui/dashboard.js";

const videoId = "dQw4w9WgXcQ";
const otherVideoId = "aaaaaaaaaaa";

const STANDARD_CODES = [
    "PROVIDER_UNAVAILABLE", "AUTHENTICATION_FAILED", "RATE_LIMITED", "VIDEO_UNAVAILABLE",
    "TRANSCRIPT_UNAVAILABLE", "LANGUAGE_UNAVAILABLE", "TRANSCRIPT_EMPTY", "PROVIDER_TIMEOUT",
    "PROVIDER_ERROR", "MALFORMED_RESPONSE", "NOT_IMPLEMENTED", "UNKNOWN_ERROR"
];

function projectFor(url) {
    const resolved = resolveVideoUrl(url);
    return applyVideoIdentity(null, resolved.video, resolved.startPosition).project;
}

function fileTranscript() {
    const rawText = "1\r\n00:00:01,000 --> 00:00:02,000\r\nimported\r\n";
    return buildTranscriptDocument({
        rawText, format: "srt", filename: "vod.srt", size: rawText.length, acquisition: createFileAcquisition()
    });
}

function projectWithFileTranscript() {
    return withTranscript(projectFor(`https://youtu.be/${videoId}?t=90`), fileTranscript());
}

const acquire = (registry, providerId, project, options = {}, timeoutMs) =>
    acquireTranscript({ registry, providerId, video: project ? project.video : null, options, timeoutMs });

function renderDetached(render) {
    const mount = document.createElement("div");
    render(mount);
    return mount;
}

const hasNoUnsafeElements = (root) => root.querySelectorAll("script, iframe, img, video, object, embed").length === 0;

export function addProviderTests(add) {

    // ---------- Registry ----------

    add("registry: providers can be registered and listed", () => {
        const registry = createProviderRegistry();
        registry.register(createMockProvider({ id: "provider-a" }));
        registry.register(createMockProvider({ id: "provider-b" }));
        const ids = registry.list().map((item) => item.id);
        return ids.length === 2 && ids[0] === "provider-a" && ids[1] === "provider-b";
    });

    add("registry: provider retrieved by id", () => {
        const mock = createMockProvider({ id: "provider-a" });
        const found = createProviderRegistry([mock]).get("provider-a");
        return found.success === true && found.provider === mock;
    });

    add("registry: unknown provider → controlled PROVIDER_NOT_FOUND", () => {
        const registry = createProviderRegistry([createMockProvider({ id: "provider-a" })]);
        return [registry.get("nope"), registry.get(undefined), registry.getSelectable("<script>")].every((found) =>
            found.success === false && found.error.code === "PROVIDER_NOT_FOUND" &&
            typeof found.error.message === "string" && Object.isFrozen(found.error));
    });

    add("registry: disabled provider is listed but cannot be selected", async () => {
        const registry = createProviderRegistry([
            createMockProvider({ id: "provider-a" }), createMockProvider({ id: "off", enabled: false })
        ]);
        let called = false;
        const offWithSpy = createProviderRegistry([createMockProvider({ id: "off", enabled: false, onCall: () => { called = true; } })]);
        const result = await acquire(offWithSpy, "off", projectFor(`https://youtu.be/${videoId}`));
        return registry.list().some((item) => item.id === "off" && item.enabled === false) &&
            !registry.listSelectable().some((item) => item.id === "off") &&
            registry.getSelectable("off").error.code === "PROVIDER_DISABLED" &&
            result.success === false && result.error.code === "PROVIDER_DISABLED" && called === false;
    });

    add("registry: invalid or duplicate providers are rejected", () => {
        const registry = createProviderRegistry([createMockProvider({ id: "provider-a" })]);
        const rejects = (provider) => { try { registry.register(provider); return false; } catch { return true; } };
        return rejects(createMockProvider({ id: "provider-a" })) && rejects(null) && rejects({ id: "x" }) &&
            rejects({ ...createMockProvider({ id: "bad id!" }) }) && registry.list().length === 1;
    });

    add("registry: list() exposes frozen data only (no functions)", () => {
        const list = createProviderRegistry([createMockProvider({ id: "provider-a" })]).list();
        return Object.isFrozen(list) && Object.isFrozen(list[0]) && Object.isFrozen(list[0].capabilities) &&
            !("getTranscript" in list[0]) && !JSON.stringify(list).includes("function");
    });

    // ---------- Contract ----------

    // Stage 2B update: Supadata is now implemented; the other stays a placeholder.
    add("contract: default providers conform and report status honestly", () => {
        const transcriptProviders = createDefaultProviderRegistry();
        const ids = transcriptProviders.list().map((item) => item.id);
        const expected = { "supadata": PROVIDER_STATUS.AVAILABLE, "youtube-transcript-api": PROVIDER_STATUS.NOT_IMPLEMENTED };
        return ids.includes("supadata") && ids.includes("youtube-transcript-api") &&
            ids.every((id) => {
                const { provider } = transcriptProviders.get(id);
                return isValidProvider(provider) && Object.isFrozen(provider) &&
                    provider.status === expected[id] &&
                    typeof provider.capabilities.nativeCaptions === "boolean" &&
                    typeof provider.capabilities.generatedTranscript === "boolean" &&
                    typeof provider.capabilities.languageSelection === "boolean";
            });
    });

    // Stage 2B update: only NOT_IMPLEMENTED providers are called here (the real
    // one would make a network request; it is tested with a fake fetch instead).
    add("contract: placeholder adapters return structured NOT_IMPLEMENTED", async () => {
        const project = projectFor(`https://youtu.be/${videoId}`);
        const transcriptProviders = createDefaultProviderRegistry();
        const placeholders = transcriptProviders.list().filter((item) => item.status === PROVIDER_STATUS.NOT_IMPLEMENTED);
        const results = await Promise.all(placeholders.map((item) => acquire(transcriptProviders, item.id, project)));
        return placeholders.length >= 1 && results.every((result, index) =>
            result.success === false && result.error.code === "NOT_IMPLEMENTED" &&
            result.error.retryable === false && result.error.providerId === placeholders[index].id &&
            Object.isFrozen(result));
    });

    add("contract: capabilities default to false (nothing assumed)", () => {
        const provider = defineProvider({ id: "bare", name: "Bare", status: "available",
            capabilities: {}, getTranscript: async () => null });
        const { capabilities } = provider;
        return capabilities.platforms.length === 0 && capabilities.nativeCaptions === false &&
            capabilities.generatedTranscript === false && capabilities.languageSelection === false;
    });

    add("contract: malformed adapter responses normalize safely", async () => {
        const project = projectFor(`https://youtu.be/${videoId}`);
        const cases = [
            [null, "MALFORMED_RESPONSE"], ["text", "MALFORMED_RESPONSE"], [[], "MALFORMED_RESPONSE"],
            [{}, "MALFORMED_RESPONSE"], [{ success: "yes" }, "MALFORMED_RESPONSE"],
            [{ success: true }, "MALFORMED_RESPONSE"],
            [{ success: true, transcript: { rawText: 42, format: "vtt" } }, "MALFORMED_RESPONSE"],
            [{ success: true, transcript: { rawText: "x", format: "docx" } }, "MALFORMED_RESPONSE"],
            [{ success: true, transcript: { rawText: " \n\t ", format: "txt" } }, "TRANSCRIPT_EMPTY"],
            [{ success: false }, "UNKNOWN_ERROR"],
            [{ success: false, error: { code: "SOMETHING_ELSE" } }, "UNKNOWN_ERROR"]
        ];
        const results = await Promise.all(cases.map(([response], index) => acquire(
            createProviderRegistry([createMockProvider({ id: `m${index}`, behavior: "raw", response })]),
            `m${index}`, project)));
        return results.every((result, index) => result.success === false && result.error.code === cases[index][1]);
    });

    add("contract: adapter throw → PROVIDER_ERROR, hang → PROVIDER_TIMEOUT", async () => {
        const project = projectFor(`https://youtu.be/${videoId}`);
        const registry = createProviderRegistry([
            createMockProvider({ id: "thrower", behavior: "throw" }), createMockProvider({ id: "hanger", behavior: "hang" })
        ]);
        const thrown = await acquire(registry, "thrower", project);
        const hung = await acquire(registry, "hanger", project, {}, 25);
        return thrown.error.code === "PROVIDER_ERROR" && thrown.error.retryable === true &&
            hung.error.code === "PROVIDER_TIMEOUT" && hung.error.retryable === true;
    });

    add("contract: provider-specific fields never leak into results", async () => {
        const project = projectFor(`https://youtu.be/${videoId}`);
        const response = {
            success: true, vendorEnvelope: { quota: 3, token: "SECRET" },
            transcript: { rawText: MOCK_TRANSCRIPT, format: "vtt", vendorTrack: "TRACK_X" },
            source: { method: "native", language: "en", sourceId: "abc", providerId: "spoofed", vendorLang: "zz" }
        };
        const registry = createProviderRegistry([createMockProvider({ id: "leaky", name: "Leaky", behavior: "raw", response })]);
        const result = await acquire(registry, "leaky", project);
        const doc = buildAcquiredTranscript(result);
        const serialized = JSON.stringify(result) + JSON.stringify(doc);
        return result.success && result.source.providerId === "leaky" && result.source.providerName === "Leaky" &&
            ["SECRET", "TRACK_X", "vendorLang", "spoofed", "vendorEnvelope"].every((token) => !serialized.includes(token)) &&
            Object.keys(result.payload).sort().join() === "format,rawText";
    });

    add("contract: adapter receives normalized video + options only", async () => {
        let seen = null;
        const registry = createProviderRegistry([createMockProvider({ id: "spy", onCall: (video, options) => { seen = { video, options }; } })]);
        const project = projectFor(`https://m.youtube.com/watch?v=${videoId}&t=1m20s&si=track`);
        await acquire(registry, "spy", project, { language: "pt-BR" });
        const defaults = { value: null };
        await acquire(createProviderRegistry([createMockProvider({ id: "spy2", onCall: (_v, options) => { defaults.value = options; } })]),
            "spy2", project);
        return seen !== null && Object.isFrozen(seen.video) &&
            Object.keys(seen.video).sort().join() === "canonicalUrl,platform,videoId" &&
            seen.video.canonicalUrl === `https://www.youtube.com/watch?v=${videoId}` &&
            seen.options.language === "pt-BR" && seen.options.method === "any" &&
            defaults.value.language === null; // provider default, not English
    });

    // ---------- Errors ----------

    add("errors: every standardized code has message + retryable", () =>
        STANDARD_CODES.every((code) => {
            const error = createAcquisitionError(code, { providerId: "p" });
            return ACQUISITION_ERROR_CODES[code] === code && error.code === code &&
                typeof error.message === "string" && error.message.length > 10 &&
                typeof error.retryable === "boolean" && error.providerId === "p" && Object.isFrozen(error);
        }));

    add("errors: each adapter error code normalizes to itself; provider text hidden", async () => {
        const project = projectFor(`https://youtu.be/${videoId}`);
        const results = await Promise.all(STANDARD_CODES.map((code, index) => acquire(
            createProviderRegistry([createMockProvider({ id: `e${index}`, behavior: "fail", errorCode: code,
                errorDetail: { providerMessage: "<b>vendor stack trace</b>" } })]), `e${index}`, project)));
        return results.every((result, index) =>
            result.success === false && result.error.code === STANDARD_CODES[index] &&
            result.error.message === createAcquisitionError(STANDARD_CODES[index]).message &&
            !result.error.message.includes("vendor"));
    });

    add("errors: unknown code → UNKNOWN_ERROR (original kept for console)", () => {
        const error = createAcquisitionError("VENDOR_429");
        return error.code === "UNKNOWN_ERROR" && error.detail.originalCode === "VENDOR_429";
    });

    add("errors: request checks run before the provider is called", async () => {
        let calls = 0;
        const onCall = () => { calls += 1; };
        const registry = createProviderRegistry([
            createMockProvider({ id: "vimeo-only", onCall, capabilities: { platforms: ["vimeo"] } }),
            createMockProvider({ id: "basic", onCall, capabilities: { platforms: ["youtube"], nativeCaptions: true } })
        ]);
        const project = projectFor(`https://youtu.be/${videoId}`);
        const codes = [
            (await acquire(registry, "basic", null)).error.code,                                   // no video
            (await acquire(registry, "vimeo-only", project)).error.code,                           // platform
            (await acquire(registry, "basic", project, { language: "en" })).error.code,            // no language choice
            (await acquire(registry, "basic", project, { method: "generated" })).error.code,       // no generated
            (await acquire(registry, "basic", project, { language: "<script>" })).error.code,      // bad code
            (await acquire(registry, "basic", project, { method: "whisper" })).error.code          // bad method
        ];
        return codes.join() === "INVALID_REQUEST,UNSUPPORTED_VIDEO,UNSUPPORTED_OPTION,UNSUPPORTED_OPTION,INVALID_REQUEST,INVALID_REQUEST" &&
            calls === 0;
    });

    // ---------- Provider switching ----------

    add("switching: A fails → select B → B attempted and supplies the transcript", async () => {
        const registry = createProviderRegistry([
            createMockProvider({ id: "provider-a", name: "Provider A", behavior: "fail", errorCode: "TRANSCRIPT_UNAVAILABLE" }),
            createMockProvider({ id: "provider-b", name: "Provider B" })
        ]);
        const project = projectFor(`https://youtu.be/${videoId}`);
        let acquisition = createAcquisitionState({ providerId: "provider-a" });
        acquisition = beginAttempt(acquisition, { id: 1, providerName: "Provider A", projectId: project.id });
        const first = await acquire(registry, acquisition.selection.providerId, project);
        acquisition = completeAttempt(acquisition, 1, { error: first.error });
        const afterFailure = acquisition.status === ACQUISITION_STATUS.ERROR && acquisition.attempt.providerId === "provider-a";

        acquisition = withSelection(acquisition, { providerId: "provider-b" });
        acquisition = beginAttempt(acquisition, { id: 2, providerName: "Provider B", projectId: project.id });
        const second = await acquire(registry, acquisition.selection.providerId, project);
        acquisition = completeAttempt(acquisition, 2, { source: second.source });
        const applied = applyAcquisitionToProject(project, second, buildAcquiredTranscript);
        return afterFailure && first.error.code === "TRANSCRIPT_UNAVAILABLE" &&
            acquisition.status === ACQUISITION_STATUS.SUCCESS && acquisition.attempt.providerId === "provider-b" &&
            applied.error === null && applied.project.transcript.acquisition.providerId === "provider-b" &&
            applied.project.transcript.acquisition.providerName === "Provider B";
    });

    add("switching: failure never changes an existing transcript", async () => {
        const project = projectWithFileTranscript();
        const before = JSON.stringify(project);
        const registry = createProviderRegistry(STANDARD_CODES.map((code, index) =>
            createMockProvider({ id: `f${index}`, behavior: "fail", errorCode: code })));
        const results = await Promise.all(STANDARD_CODES.map((_code, index) => acquire(registry, `f${index}`, project)));
        return results.every((result) => {
            const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
            return applied.project === project && applied.error !== null;
        }) && JSON.stringify(project) === before && project.transcript.acquisition.type === "file";
    });

    add("switching: pipeline failure on success result keeps the transcript", () => {
        const project = projectWithFileTranscript();
        const result = { success: true, source: { providerId: "x", video: { platform: "youtube", videoId } },
            payload: { rawText: "x", format: "txt" } };
        const applied = applyAcquisitionToProject(project, result, () => { throw new Error("boom"); });
        return applied.project === project && applied.error.code === "MALFORMED_RESPONSE";
    });

    add("switching: never automatic — B is not called when A fails", async () => {
        let bCalls = 0;
        const registry = createProviderRegistry([
            createMockProvider({ id: "provider-a", behavior: "fail", errorCode: "PROVIDER_UNAVAILABLE" }),
            createMockProvider({ id: "provider-b", onCall: () => { bCalls += 1; } })
        ]);
        const result = await acquire(registry, "provider-a", projectFor(`https://youtu.be/${videoId}`));
        return result.success === false && result.error.providerId === "provider-a" && bCalls === 0;
    });

    add("switching: project id and video identity never change", async () => {
        const project = projectFor(`https://youtu.be/${videoId}?t=90`);
        const registry = createProviderRegistry([
            createMockProvider({ id: "provider-a", behavior: "fail" }), createMockProvider({ id: "provider-b" })
        ]);
        const failed = applyAcquisitionToProject(project, await acquire(registry, "provider-a", project), buildAcquiredTranscript);
        const succeeded = applyAcquisitionToProject(failed.project, await acquire(registry, "provider-b", failed.project), buildAcquiredTranscript);
        return succeeded.project.id === project.id && succeeded.project.video === project.video &&
            succeeded.project.video.startPosition.seconds === 90 &&
            succeeded.project.alignment.status === "unverified" && succeeded.project.alignment.evidence.length === 0;
    });

    add("switching: attempt state is separate, frozen, and ignores stale results", () => {
        let acquisition = createAcquisitionState({ providerId: "provider-a" });
        acquisition = beginAttempt(acquisition, { id: 7, providerName: "A", projectId: "p" });
        const stale = completeAttempt(acquisition, 6, { error: createAcquisitionError("RATE_LIMITED") });
        const reset = resetAttempt(acquisition);
        const late = completeAttempt(reset, 7, { error: createAcquisitionError("RATE_LIMITED") });
        return Object.isFrozen(acquisition) && acquisition.status === "acquiring" && stale === acquisition &&
            reset.status === "idle" && reset.attempt === null && reset.selection.providerId === "provider-a" &&
            late === reset && !("transcriptAcquisition" in projectFor(`https://youtu.be/${videoId}`));
    });

    add("switching: result for a different video is not attached", async () => {
        const registry = createProviderRegistry([createMockProvider({ id: "provider-b" })]);
        const other = projectFor(`https://youtu.be/${otherVideoId}`);
        const result = await acquire(registry, "provider-b", other);
        const project = projectWithFileTranscript();
        const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
        return result.success && applied.project === project && applied.error.code === "INVALID_REQUEST";
    });

    // ---------- Provenance ----------

    add("provenance: acquired transcript identifies its full source", async () => {
        const registry = createProviderRegistry([createMockProvider({ id: "provider-b", name: "Provider B",
            method: "generated", language: "es", sourceId: "track-17" })]);
        const project = projectFor(`https://youtu.be/${videoId}`);
        const before = Date.now();
        const result = await acquire(registry, "provider-b", project, { language: "es", method: METHOD_PREFERENCE.ANY });
        const doc = applyAcquisitionToProject(project, result, buildAcquiredTranscript).project.transcript;
        const a = doc.acquisition;
        const retrieved = Date.parse(a.retrievedAt);
        return a.type === ACQUISITION_TYPE.PROVIDER && a.providerId === "provider-b" && a.providerName === "Provider B" &&
            a.method === "generated" && a.generated === true && a.language === "es" && a.requestedLanguage === "es" &&
            a.requestedMethod === "any" && a.sourceId === "track-17" &&
            retrieved >= before - 1000 && retrieved <= Date.now() + 1000 &&
            a.video.platform === "youtube" && a.video.videoId === videoId && Object.keys(a.video).length === 2 &&
            Object.isFrozen(a) && Object.isFrozen(a.video);
    });

    add("provenance: native / generated / unknown stay distinguishable", async () => {
        const project = projectFor(`https://youtu.be/${videoId}`);
        const registry = createProviderRegistry(["native", "generated", "unknown", "bogus"].map((method) =>
            createMockProvider({ id: `m-${method}`, method })));
        const sources = await Promise.all(["native", "generated", "unknown", "bogus"].map(async (method) =>
            (await acquire(registry, `m-${method}`, project)).source));
        return sources[0].method === "native" && sources[0].generated === false &&
            sources[1].method === "generated" && sources[1].generated === true &&
            sources[2].method === "unknown" && sources[2].generated === null &&
            sources[3].method === "unknown" && sources[3].generated === null;
    });

    add("provenance: acquired rawText is stored exactly, once, canonically", async () => {
        const rawText = "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\n<script>x</script> héllo 🎮\r\n";
        const registry = createProviderRegistry([createMockProvider({ id: "provider-b", rawText })]);
        const project = projectFor(`https://youtu.be/${videoId}`);
        const doc = buildAcquiredTranscript(await acquire(registry, "provider-b", project));
        return doc.rawText === rawText && doc.source.filename === null && doc.source.format === "vtt" &&
            doc.source.size === new TextEncoder().encode(rawText).length &&
            JSON.stringify(doc).split("héllo").length === 2 && // raw text not duplicated
            Object.isFrozen(doc) && Object.isFrozen(doc.acquisition) && doc.schemaVersion === 2;
    });

    add("provenance: imported file is distinguishable, unknowns stay null", () => {
        const doc = fileTranscript();
        const a = doc.acquisition;
        return a.type === "file" && a.providerId === null && a.method === "unknown" && a.generated === null &&
            a.language === null && a.retrievedAt === null && a.video === null && doc.source.filename === "vod.srt";
    });

    // ---------- UI ----------

    const viewFor = (project, acquisition, providers) => renderDetached((element) =>
        renderTranscriptsView(element, project, {
            acquisition, providers, onSelectionChange: () => {}, onAcquire: () => {}
        }));

    add("transcripts page: acquisition panel lists providers from the registry", () => {
        const registry = createProviderRegistry([
            createMockProvider({ id: "provider-a", name: "Provider A" }),
            createMockProvider({ id: "off", name: "Off", enabled: false })
        ]);
        const project = projectFor(`https://youtu.be/${videoId}`);
        const mount = viewFor(project, createAcquisitionState({ providerId: "provider-a" }), registry.list());
        const panel = mount.querySelector("[data-section='acquisition']");
        const options = [...mount.querySelectorAll("#acq-provider option")];
        const noVideo = viewFor(null, createAcquisitionState(), registry.list());
        return panel !== null && mount.firstElementChild.dataset.section === "linked-video" &&
            options.map((option) => option.value).join() === "provider-a,off" && options[1].disabled === true &&
            mount.querySelector("#acq-language option").value === "" &&           // provider default first
            mount.querySelectorAll("#acq-method option").length === 3 &&
            mount.querySelector("[data-action='acquire']") !== null &&
            noVideo.querySelector("#acq-provider") === null && noVideo.textContent.includes("Link a video");
    });

    add("transcripts page: failure view offers retry + switching, rendered safely", () => {
        const hostile = "<img src=x onerror=alert(1)>";
        const registry = createProviderRegistry([
            createMockProvider({ id: "provider-a", name: hostile }),
            createMockProvider({ id: "provider-b", name: "Provider B" })
        ]);
        const project = projectWithFileTranscript();
        let acquisition = beginAttempt(createAcquisitionState({ providerId: "provider-a" }),
            { id: 1, providerName: hostile, projectId: project.id });
        acquisition = completeAttempt(acquisition, 1, { error: createAcquisitionError("RATE_LIMITED", { providerId: "provider-a" }) });
        const mount = viewFor(project, acquisition, registry.list());
        const alert = mount.querySelector("[data-state='error']");
        const switchOptions = [...mount.querySelectorAll("#acq-switch-provider option")].map((o) => o.value);
        const unavailable = completeAttempt(beginAttempt(createAcquisitionState({ providerId: "provider-a" }),
            { id: 2, providerName: "A", projectId: project.id }), 2, { error: createAcquisitionError("TRANSCRIPT_UNAVAILABLE") });
        const noRetry = viewFor(project, unavailable, registry.list());
        return alert !== null && alert.getAttribute("role") === "alert" &&
            alert.textContent.includes(`${hostile} could not retrieve this transcript.`) &&
            alert.textContent.includes("temporarily limited") && alert.textContent.includes("was not changed") &&
            mount.querySelector("[data-action='retry']") !== null &&
            switchOptions.join() === "provider-b" &&
            mount.querySelector("[data-action='switch']").textContent === "Try With Provider B" &&
            noRetry.querySelector("[data-action='retry']") === null && noRetry.querySelector("[data-action='switch']") !== null &&
            hasNoUnsafeElements(mount) && mount.textContent.includes("vod.srt");  // existing transcript still shown
    });

    add("transcripts page: success view and summary show provenance", async () => {
        const registry = createProviderRegistry([createMockProvider({ id: "provider-b", name: "Provider B",
            method: "native", language: "en", sourceId: "<script>alert(1)</script>" })]);
        const project = projectFor(`https://youtu.be/${videoId}`);
        const result = await acquire(registry, "provider-b", project, { language: "en" });
        const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
        const acquisition = completeAttempt(beginAttempt(createAcquisitionState({ providerId: "provider-b" }),
            { id: 1, providerName: "Provider B", projectId: project.id }), 1, { source: result.source });
        const mount = viewFor(applied.project, acquisition, registry.list());
        const success = mount.querySelector("[data-state='success']");
        const text = mount.textContent;
        return success !== null && success.textContent.includes("Transcript retrieved from Provider B.") &&
            text.includes("Transcript provider") && text.includes("Native captions") &&
            text.includes("English (en)") && text.includes("<script>alert(1)</script>") &&
            hasNoUnsafeElements(mount);
    });

    // Stage 2B update: 2A is now listed as completed; 2B is current.
    add("dashboard: status card describes Stage 2B honestly (2A completed)", () => {
        const stubState = { get: (key) => (key === "ui" ? {} : null) };
        const mount = renderDetached((element) =>
            renderDashboard(element, stubState, { onVideoUrlSubmit: () => ({ ok: true, message: "" }) }));
        const text = mount.textContent;
        return text.includes("Stage 2B — First Real Transcript Provider") &&
            text.includes("Completed:") && text.includes("Stage 2A — Transcript Acquisition Architecture") &&
            text.includes("your own API key") && text.includes("Not built yet") && text.includes("AI analysis");
    });
}

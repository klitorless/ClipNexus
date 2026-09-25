// ==========================================================
// devtools-supadata-tests.js
// Responsibility: Stage 2B self-tests — the Supadata adapter,
// its normalization boundary, the generic JSON parser, the
// credential store, stale-attempt protection, and the Stage 2B
// UI states. Registered by devtools.js via addSupadataTests(add).
//
// Deterministic and offline: Supadata is exercised through a
// FAKE fetch with a LOCAL credential store and registry. The
// app's registry, key store, and state are never touched, and
// no request ever leaves the browser.
// ==========================================================

import { createProviderRegistry } from "../transcript/providers/registry.js";
import { describeProvider, PROVIDER_STATUS } from "../transcript/providers/provider.js";
import { acquireTranscript, applyAcquisitionToProject } from "../transcript/providers/manager.js";
import {
    createAcquisitionState, beginAttempt, completeAttempt, resetAttempt, isCurrentAttemptResult, ACQUISITION_STATUS
} from "../transcript/providers/acquisition-state.js";
import { createSupadataProvider, SUPADATA_ID } from "../transcript/providers/adapters/supadata.js";
import { createCredentialStore } from "../transcript/providers/credentials.js";
import { createDefaultProviderRegistry } from "../transcript/providers/default-providers.js";
import { createMockProvider } from "../transcript/providers/adapters/mock.js";
import { buildTranscriptDocument, buildAcquiredTranscript } from "../transcript/pipeline.js";
import { createFileAcquisition, ACQUISITION_TYPE } from "../transcript/model.js";
import { parse as parseJson } from "../transcript/formats/json.js";
import { applyVideoIdentity, withTranscript } from "./project.js";
import { resolveVideoUrl } from "../video/video-resolver.js";
import { renderTranscriptsView } from "../ui/transcripts.js";
import { createAcquisitionError } from "../transcript/providers/errors.js";

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

function setup(replies, { key = TEST_KEY, deadlineMs, now } = {}) {
    const credentials = createCredentialStore();
    if (key) credentials.set(SUPADATA_ID, key);
    const fake = fakeFetch(replies);
    const provider = createSupadataProvider({
        fetchImpl: fake.fetchImpl, credentials, sleep: async () => {}, now, requestDeadlineMs: deadlineMs, pollIntervalMs: 0
    });
    return { registry: createProviderRegistry([provider]), provider, credentials, calls: fake.calls };
}

function projectFor(url = `https://youtu.be/${videoId}?t=90`) {
    const resolved = resolveVideoUrl(url);
    return applyVideoIdentity(null, resolved.video, resolved.startPosition).project;
}

function projectWithFileTranscript() {
    const rawText = "1\r\n00:00:01,000 --> 00:00:02,000\r\nimported\r\n";
    return withTranscript(projectFor(), buildTranscriptDocument({
        rawText, format: "srt", filename: "vod.srt", size: rawText.length, acquisition: createFileAcquisition()
    }));
}

const acquire = (registry, project, options = {}) =>
    acquireTranscript({ registry, providerId: SUPADATA_ID, video: project.video, options });

// A realistic Supadata body (shape from docs.supadata.ai), with vendor extras.
const SAMPLE_BODY = Object.freeze({
    lang: "en",
    availableLangs: ["en", "es", "de"],
    content: [
        { text: "Never gonna give you up", offset: 18000, duration: 2640, lang: "en" },
        { text: "  <b>never</b> gonna   let you down ", offset: 20640, duration: 3520, lang: "en" },
        { text: "[Music]", offset: 24160, duration: 1200, lang: "en" }
    ]
});

const noKey = (value) => !JSON.stringify(value).includes(TEST_KEY);

export function addSupadataTests(add) {

    // ---------- Registration / request ----------

    add("supadata: registered as the one real provider, needs a key", () => {
        const registry = createDefaultProviderRegistry();
        const described = registry.list().find((item) => item.id === SUPADATA_ID);
        const real = registry.list().filter((item) => item.status === PROVIDER_STATUS.AVAILABLE);
        return described && described.status === PROVIDER_STATUS.AVAILABLE && described.enabled === true &&
            real.length === 1 && described.credential && described.credential.label === "Supadata API key" &&
            described.capabilities.platforms.join() === "youtube" && typeof described.getTranscript === "undefined";
    });

    add("supadata: no key → CREDENTIAL_REQUIRED and NO request is made", async () => {
        const { registry, calls } = setup([reply(200, SAMPLE_BODY)], { key: null });
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "CREDENTIAL_REQUIRED" &&
            result.error.retryable === false && calls.length === 0;
    });

    add("supadata: request goes only to api.supadata.ai with the documented parameters", async () => {
        const { registry, calls } = setup([reply(200, SAMPLE_BODY)]);
        await acquire(registry, projectFor(), { language: "es", method: "native" });
        await acquire(registry, projectFor(), { method: "generated" });
        await acquire(registry, projectFor(), { method: "any" });
        const urls = calls.map((call) => new URL(call.url));
        const [first] = calls;
        return calls.length === 3 && urls.every((url) => url.origin === "https://api.supadata.ai" &&
                url.pathname === "/v1/transcript" && url.searchParams.get("text") === "false" &&
                url.searchParams.get("url") === `https://www.youtube.com/watch?v=${videoId}`) &&
            urls.map((url) => url.searchParams.get("mode")).join() === "native,generate,auto" &&
            urls[0].searchParams.get("lang") === "es" && urls[1].searchParams.has("lang") === false &&
            first.init.method === "GET" && first.init.headers["x-api-key"] === TEST_KEY &&
            first.init.credentials === "omit" && first.init.referrerPolicy === "no-referrer" &&
            !first.url.includes(TEST_KEY) && !first.url.includes("t=90");
    });

    // ---------- Success + normalization ----------

    add("supadata: success → normalized result, text and timing kept verbatim", async () => {
        const { registry } = setup([reply(200, SAMPLE_BODY)]);
        const result = await acquire(registry, projectFor(), { language: "en", method: "native" });
        const records = JSON.parse(result.payload.rawText);
        return result.success === true && result.payload.format === "json" &&
            records.length === 3 && records[1].text === "  <b>never</b> gonna   let you down " &&
            records[0].startMs === 18000 && records[0].durationMs === 2640 &&
            Object.keys(records[0]).join() === "startMs,durationMs,text" &&
            result.payload.rawText.split("\n").length === 6 &&           // one record per line
            Object.isFrozen(result) && result.source.providerId === SUPADATA_ID;
    });

    add("supadata: provenance survives into the final TranscriptDocument", async () => {
        const { registry } = setup([reply(200, SAMPLE_BODY)]);
        const project = projectFor();
        const result = await acquire(registry, project, { language: "en", method: "native" });
        const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
        const doc = applied.project.transcript;
        const a = doc.acquisition;
        return !applied.error && a.type === ACQUISITION_TYPE.PROVIDER && a.providerId === SUPADATA_ID &&
            a.providerName === "Supadata" && a.method === "native" && a.generated === false &&
            a.language === "en" && a.requestedLanguage === "en" && a.requestedMethod === "native" &&
            a.sourceId === null && typeof a.retrievedAt === "string" &&
            a.video.platform === "youtube" && a.video.videoId === videoId &&
            doc.rawText === result.payload.rawText && doc.parse.status === "complete" && doc.segments.length === 3 &&
            doc.segments[1].text === SAMPLE_BODY.content[1].text && Object.isFrozen(doc) && noKey(applied.project);
    });

    add("supadata: timestamps keep raw, derive seconds, report status", async () => {
        const { registry } = setup([reply(200, SAMPLE_BODY)]);
        const project = projectFor();
        const applied = applyAcquisitionToProject(project, await acquire(registry, project), buildAcquiredTranscript);
        const [first] = applied.project.transcript.segments;
        return first.start.raw === "18000" && first.start.seconds === 18 && first.start.status === "parsed" &&
            first.duration.raw === "2640" && first.duration.seconds === 2.64 && first.duration.status === "parsed" &&
            first.end.raw === null && first.end.seconds === 20.64 && first.end.status === "derived";
    });

    add("supadata: missing or malformed times stay unknown — never 0", async () => {
        const body = { lang: "en", content: [
            { text: "no times" },
            { text: "bad", offset: "abc", duration: -5 },
            { text: "null", offset: null, duration: 100 }
        ] };
        const { registry } = setup([reply(200, body)]);
        const project = projectFor();
        const applied = applyAcquisitionToProject(project, await acquire(registry, project), buildAcquiredTranscript);
        const [a, b, c] = applied.project.transcript.segments;
        return a.start.status === "missing" && a.start.seconds === null && a.end.status === "missing" &&
            b.start.status === "malformed" && b.start.raw === "abc" && b.start.seconds === null &&
            b.duration.status === "malformed" && b.duration.raw === "-5" && b.end.status === "missing" &&
            c.start.status === "missing" && c.end.status === "missing" && c.end.seconds === null;
    });

    add("supadata: method native/generated/auto → generated false/true/null", async () => {
        const results = [];
        for (const method of ["native", "generated", "any"]) {
            const { registry } = setup([reply(200, SAMPLE_BODY)]);
            results.push((await acquire(registry, projectFor(), { method })).source);
        }
        const [native, generated, auto] = results;
        return native.method === "native" && native.generated === false &&
            generated.method === "generated" && generated.generated === true &&
            auto.method === "unknown" && auto.generated === null && auto.requestedMethod === "any";
    });

    add("supadata: language is what the provider reported, request kept separately", async () => {
        const mismatch = await acquire(setup([reply(200, SAMPLE_BODY)]).registry, projectFor(), { language: "es" });
        const missing = await acquire(setup([reply(200, { content: SAMPLE_BODY.content })]).registry, projectFor(), { language: "es" });
        const invalid = await acquire(setup([reply(200, { ...SAMPLE_BODY, lang: "<script>" })]).registry, projectFor());
        return mismatch.source.language === "en" && mismatch.source.requestedLanguage === "es" &&
            missing.source.language === null && missing.source.requestedLanguage === "es" &&
            invalid.source.language === null && invalid.source.requestedLanguage === null;
    });

    add("supadata: vendor fields never leak past the boundary", async () => {
        const body = { ...SAMPLE_BODY, documentationUrl: "https://docs.example", requestId: "req-123",
            content: SAMPLE_BODY.content.map((chunk) => ({ ...chunk, trackId: "track-9" })) };
        const { registry } = setup([reply(200, body)]);
        const project = projectFor();
        const result = await acquire(registry, project);
        const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
        const text = JSON.stringify({ result, project: applied.project });
        return ["availableLangs", "documentationUrl", "requestId", "req-123", "trackId", "track-9", "\"offset\"", "\"lang\":\"en\"", "content"]
            .every((token) => !text.includes(token)) && noKey(result);
    });

    // ---------- Async jobs ----------

    add("supadata: async job (202) is polled to completion; jobId is the source ID", async () => {
        const { registry, calls } = setup([
            reply(202, { jobId: "job-42" }),
            reply(200, { status: "queued" }),
            reply(200, { status: "active" }),
            reply(200, { status: "completed", result: SAMPLE_BODY })
        ]);
        const result = await acquire(registry, projectFor());
        return result.success === true && result.source.sourceId === "job-42" && calls.length === 4 &&
            new URL(calls[1].url).pathname === "/v1/transcript/job-42" && calls[3].init.headers["x-api-key"] === TEST_KEY;
    });

    add("supadata: failed or never-finishing job → controlled error", async () => {
        const failed = await acquire(setup([reply(202, { jobId: "j" }),
            reply(200, { status: "failed", error: { error: "transcript-unavailable" } })]).registry, projectFor());
        let clock = 0;
        const slow = setup([reply(202, { jobId: "j" }), () => { clock += 10000; return reply(200, { status: "active" }); }],
            { deadlineMs: 25000, now: () => clock });
        const timeout = await acquire(slow.registry, projectFor());
        const weird = await acquire(setup([reply(202, { jobId: "j" }), reply(200, { status: "exploded" })]).registry, projectFor());
        return failed.error.code === "TRANSCRIPT_UNAVAILABLE" &&
            timeout.error.code === "PROVIDER_TIMEOUT" && timeout.error.retryable === true && slow.calls.length <= 4 &&
            weird.error.code === "MALFORMED_RESPONSE";
    });

    // ---------- Errors ----------

    add("supadata: provider errors map to the standard vocabulary (no key/message leak)", async () => {
        const cases = [
            [401, { error: "unauthorized", message: `Invalid key ${TEST_KEY}` }, "AUTHENTICATION_FAILED"],
            [403, { error: "forbidden" }, "AUTHENTICATION_FAILED"],
            [402, { error: "upgrade-required" }, "RATE_LIMITED"],
            [429, { error: "limit-exceeded" }, "RATE_LIMITED"],
            [404, { error: "not-found" }, "VIDEO_UNAVAILABLE"],
            [206, { error: "transcript-unavailable" }, "TRANSCRIPT_UNAVAILABLE"],
            [400, { error: "invalid-request" }, "PROVIDER_ERROR"],
            [500, { error: "internal-error" }, "PROVIDER_ERROR"],
            [503, "<html>Service Unavailable</html>", "PROVIDER_UNAVAILABLE"],
            [418, { error: "<script>x</script>" }, "UNKNOWN_ERROR"]
        ];
        const outcomes = await Promise.all(cases.map(([status, body]) =>
            acquire(setup([reply(status, body)]).registry, projectFor())));
        return outcomes.every((result, index) => result.success === false &&
                result.error.code === cases[index][2] && result.error.providerId === SUPADATA_ID &&
                result.error.detail.httpStatus === cases[index][0] && noKey(result) &&
                !JSON.stringify(result).includes("Invalid key")) &&
            outcomes[0].error.detail.providerCode === "unauthorized" &&
            outcomes[9].error.detail.providerCode === null;               // unsafe code not echoed
    });

    add("supadata: network failure → PROVIDER_UNAVAILABLE (retryable)", async () => {
        const { registry } = setup([() => { throw new TypeError("Failed to fetch"); }]);
        const result = await acquire(registry, projectFor());
        return result.success === false && result.error.code === "PROVIDER_UNAVAILABLE" && result.error.retryable === true;
    });

    add("supadata: malformed responses → controlled MALFORMED_RESPONSE / TRANSCRIPT_EMPTY", async () => {
        const bodies = [
            ["not json {", "MALFORMED_RESPONSE"],
            [{ content: "plain text" }, "MALFORMED_RESPONSE"],
            [{ content: [{ offset: 1 }] }, "MALFORMED_RESPONSE"],
            [[1, 2, 3], "MALFORMED_RESPONSE"],
            [{ content: [] }, "TRANSCRIPT_EMPTY"],
            [{ content: [{ text: "   " }, { text: "" }] }, "TRANSCRIPT_EMPTY"]
        ];
        const outcomes = await Promise.all(bodies.map(([body]) => acquire(setup([reply(200, body)]).registry, projectFor())));
        return outcomes.every((result, index) => result.success === false && result.error.code === bodies[index][1] &&
            Object.isFrozen(result));
    });

    // ---------- Project protection ----------

    add("supadata: failure never changes an existing transcript", async () => {
        const project = projectWithFileTranscript();
        const before = JSON.stringify(project);
        const results = await Promise.all([
            acquire(setup([reply(401, { error: "unauthorized" })]).registry, project),
            acquire(setup([reply(200, "garbage")]).registry, project),
            acquire(setup([() => { throw new TypeError("offline"); }]).registry, project)
        ]);
        return results.every((result) => {
            const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
            return applied.error !== null && applied.project === project;
        }) && JSON.stringify(project) === before && project.transcript.source.filename === "vod.srt";
    });

    add("supadata: success replaces the transcript, keeps project + video identity", async () => {
        const project = projectWithFileTranscript();
        const result = await acquire(setup([reply(200, SAMPLE_BODY)]).registry, project);
        const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
        const next = applied.project;
        return applied.error === null && next !== project && next.id === project.id &&
            next.video.identity.videoId === videoId && next.video === project.video && next.video.startPosition.seconds === 90 &&
            next.transcript.acquisition.type === ACQUISITION_TYPE.PROVIDER &&
            next.transcript.source.format === "json" && project.transcript.source.filename === "vod.srt";
    });

    add("stale attempt: a late result from an older attempt is ignored (regression)", () => {
        const project = projectFor();
        const other = projectFor(`https://youtu.be/aaaaaaaaaaa`);
        let state = beginAttempt(createAcquisitionState({ providerId: SUPADATA_ID }),
            { id: 1, providerName: "Supadata", projectId: project.id });
        state = beginAttempt(state, { id: 2, providerName: "Supadata", projectId: project.id });  // user retried
        const lateFirst = completeAttempt(state, 1, { error: null, source: { providerName: "old" } });
        const staleA = isCurrentAttemptResult(state, 1, project, project);
        const currentB = isCurrentAttemptResult(state, 2, project, project);
        const projectChanged = isCurrentAttemptResult(state, 2, other, project);
        const afterReset = isCurrentAttemptResult(resetAttempt(state), 2, project, project);
        const done = completeAttempt(state, 2, { source: { providerName: "new" } });
        return lateFirst === state && staleA === false && currentB === true && projectChanged === false &&
            afterReset === false && isCurrentAttemptResult(done, 2, project, project) === false &&
            done.status === ACQUISITION_STATUS.SUCCESS && done.attempt.source.providerName === "new";
    });

    // ---------- Credential store ----------

    add("credentials: in-memory only, validated, never exposed", () => {
        const store = createCredentialStore();
        const rejected = [store.set(SUPADATA_ID, ""), store.set(SUPADATA_ID, "has space"),
            store.set(SUPADATA_ID, "a\nb"), store.set(SUPADATA_ID, "x".repeat(600))];
        const accepted = store.set(SUPADATA_ID, `  ${TEST_KEY}  `);
        const described = describeProvider(setup([]).provider);
        const shown = JSON.stringify(store);
        store.clear(SUPADATA_ID);
        return rejected.every((ok) => ok === false) && accepted === true && !shown.includes(TEST_KEY) &&
            store.has(SUPADATA_ID) === false && store.read(SUPADATA_ID) === null &&
            noKey(described) && described.credential.hint.includes("memory");
    });

    // ---------- Generic JSON parser ----------

    add("json parser: seconds, ms, clock strings, raw repr, ambiguity", () => {
        const raw = '{"segments":[{"start":1.0,"end":"00:00:03.50","text":"a","id":7},' +
            '{"startMs":"1500","endMs":2500,"text":"b"},{"start":1,"startMs":1000,"text":"c"},' +
            '{"start":"1:75","text":"d"},{"text":42},"junk"]}';
        const result = parseJson(raw);
        const [a, b, c, d] = result.segments;
        return result.status === "complete" && result.segments.length === 4 &&
            a.start.raw === "1.0" && a.start.seconds === 1 && a.end.raw === "00:00:03.50" && a.end.seconds === 3.5 &&
            a.source.cueId === "7" && a.source.sequence === 0 &&
            b.start.raw === "1500" && b.start.seconds === 1.5 && b.end.seconds === 2.5 &&
            c.start.status === "ambiguous" && c.start.seconds === null &&
            d.start.status === "malformed" && d.start.seconds === null &&
            result.notes.some((note) => note.includes("2 record(s)")) && a.speaker.source === "unknown";
    });

    add("json parser: invalid JSON or unknown shape fails safely", () => {
        const results = [parseJson("{not json"), parseJson('{"a":1}'), parseJson("[]"), parseJson('[{"t":"x"}]'), parseJson("5")];
        return results.every((result) => result.status === "failed" && result.segments.length === 0 && result.notes.length > 0);
    });

    // ---------- UI ----------

    const view = (project, acquisition, providers, extra = {}) => {
        const mount = document.createElement("div");
        renderTranscriptsView(mount, project, { acquisition, providers, onSelectionChange: () => {}, onAcquire: () => {}, ...extra });
        return mount;
    };

    add("transcripts page: honest status — Available / Needs API key / Not implemented", () => {
        const providers = createDefaultProviderRegistry().list();
        const project = projectFor();
        const noKeyView = view(project, createAcquisitionState({ providerId: SUPADATA_ID }), providers);
        const withKey = view(project, createAcquisitionState({ providerId: SUPADATA_ID }), providers, { credentialReady: () => true });
        const placeholder = view(project, createAcquisitionState({ providerId: "youtube-transcript-api" }), providers,
            { credentialReady: () => true });
        const tag = (mount) => mount.querySelector("[data-provider-status]").dataset.providerStatus;
        const button = (mount) => mount.querySelector("[data-action='acquire']");
        const labels = [...noKeyView.querySelectorAll("#acq-provider option")].map((option) => option.textContent);
        return tag(noKeyView) === "needs-key" && button(noKeyView).disabled === true &&
            noKeyView.querySelector("#acq-credential").type === "password" &&
            labels.some((label) => label.includes("Needs API key")) && labels.some((label) => label.includes("Not implemented")) &&
            tag(withKey) === "available" && button(withKey).disabled === false &&
            withKey.querySelector("[data-credential='ready']") !== null && withKey.querySelector("#acq-credential") === null &&
            tag(placeholder) === "not-implemented" && button(placeholder).disabled === true &&
            placeholder.querySelector("[data-state='blocked']").textContent.includes("not implemented");
    });

    add("transcripts page: entering a key never renders it; switch list offers only runnable providers", () => {
        const store = createCredentialStore();
        const providers = [...createDefaultProviderRegistry().list(), describeProvider(createMockProvider({ id: "mock-b", name: "Mock B" }))];
        const project = projectFor();
        const mount = view(project, createAcquisitionState({ providerId: SUPADATA_ID }), providers, {
            credentialReady: (id) => store.has(id),
            onCredentialChange: (id, value) => (value === null ? (store.clear(id), true) : store.set(id, value))
        });
        const input = mount.querySelector("#acq-credential");
        input.value = TEST_KEY;
        mount.querySelector("[data-action='set-credential']").click();
        const afterSet = mount.querySelector("[data-provider-status]").dataset.providerStatus;
        const html = new XMLSerializer().serializeToString(mount);   // read-only inspection
        mount.querySelector("[data-action='clear-credential']").click();
        const failed = completeAttempt(beginAttempt(createAcquisitionState({ providerId: SUPADATA_ID }),
            { id: 1, providerName: "Supadata", projectId: project.id }), 1,
            { error: createAcquisitionError("AUTHENTICATION_FAILED", { providerId: SUPADATA_ID }) });
        const errorView = view(project, failed, providers);
        const switchIds = [...errorView.querySelectorAll("#acq-switch-provider option")].map((option) => option.value);
        const alert = errorView.querySelector("[data-state='error']").textContent;
        return afterSet === "available" && !html.includes(TEST_KEY) && input.value === "" &&
            store.has(SUPADATA_ID) === false && switchIds.join() === "mock-b" &&
            alert.includes("Supadata") && alert.includes("AUTHENTICATION_FAILED") && alert.includes("unlikely to help");
    });

    add("transcripts page: success shows provenance, language mismatch, segments", async () => {
        const project = projectFor();
        const result = await acquire(setup([reply(200, SAMPLE_BODY)]).registry, project, { language: "es" });
        const applied = applyAcquisitionToProject(project, result, buildAcquiredTranscript);
        const acquisition = completeAttempt(beginAttempt(createAcquisitionState({ providerId: SUPADATA_ID }),
            { id: 1, providerName: "Supadata", projectId: project.id }), 1, { source: result.source });
        const mount = view(applied.project, acquisition, createDefaultProviderRegistry().list());
        const success = mount.querySelector("[data-state='success']").textContent;
        const segments = mount.querySelector("[data-section='segments']");
        return success.includes("Transcript retrieved from Supadata.") && success.includes("English (en)") &&
            success.includes("You asked for Spanish (es); the provider returned English (en).") &&
            success.includes("did not report whether") && success.includes(videoId) &&
            segments !== null && segments.querySelectorAll("li").length === 3 &&
            segments.textContent.includes("0:18.000") && segments.textContent.includes("<b>never</b>") &&
            mount.querySelectorAll("script, img, b").length === 0;
    });

    add("security: CSP allows only the app and api.supadata.ai", () => {
        const meta = document.querySelector("meta[http-equiv='Content-Security-Policy']");
        if (!meta) return false;
        const policy = meta.content;
        const connect = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith("connect-src"));
        return connect === "connect-src 'self' https://api.supadata.ai" && policy.includes("script-src 'self'") &&
            policy.includes("default-src 'none'");
    });
}

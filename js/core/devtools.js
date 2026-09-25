// ==========================================================
// devtools.js
// Responsibility: lightweight browser-console helpers for
// inspecting state and running architectural self-tests.
// No test framework, no network, no effect on app state.
//
// Usage in the browser console:
//   vodAnalyzer.inspectProject()      // frozen Project (or null)
//   vodAnalyzer.inspectTranscript()   // frozen TranscriptDocument
//   vodAnalyzer.resolveVideoUrl(url)  // try the resolver (pure)
//   vodAnalyzer.getState("route")
//   vodAnalyzer.listProviders()       // registry descriptors
//   vodAnalyzer.registerMockProviders() // add 2 deterministic mock
//                                       // providers (UI preview only)
//   await vodAnalyzer.runSelfTests()  // prints a pass/fail table
//
// This is the only intentional global (window.vodAnalyzer).
// ==========================================================

import { AppError } from "./errors.js";
import { TRANSCRIPT_FORMATS, getFormatForFilename, getAcceptAttribute } from "../transcript/formats.js";
import { parseTranscript } from "../transcript/parser.js";
import { validateTranscript, createValidationIssue, ISSUE_TYPES } from "../transcript/validator.js";
import { chunkTranscript } from "../transcript/chunker.js";
import { createSegment, createTimestamp, withDerivedLayer } from "../transcript/model.js";
import { resolveVideoUrl } from "../video/video-resolver.js";
import { addProjectTests, addStage17Tests } from "./devtools-project-tests.js";
import { addProviderTests } from "./devtools-provider-tests.js";
import { addSupadataTests } from "./devtools-supadata-tests.js";
import { addAnalysisTests } from "./devtools-analysis-tests.js";
import { createMockProvider } from "../transcript/providers/adapters/mock.js";

function getStoredTranscript(appState) {
    const project = appState.get("project");
    return project ? project.transcript : null;
}

// Samples include CRLF, Unicode, and HTML-like text to prove the raw
// source survives byte-for-byte and is never treated as markup.
const samples = {
    txt: "[00:00:01] Streamer: hello <b>chat</b>\r\n[00:00:05] ok 🎮\n",
    srt: "1\r\n00:00:01,000 --> 00:00:03,500\r\n<script>alert(1)</script>\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nnext line\r\n",
    vtt: "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v Streamer>hello & welcome\n",
    json: "[{\"start\": 1.0, \"end\": 3.5, \"speaker\": \"Streamer\", \"text\": \"héllo\"}]"
};

function parseSample(formatId) {
    return parseTranscript({
        rawText: samples[formatId],
        format: formatId,
        filename: `sample.${formatId}`,
        size: samples[formatId].length
    });
}

function throwsTypeError(action) {
    try { action(); return false; } catch (error) { return error instanceof TypeError; }
}

function buildTests(appState) {
    const tests = [];
    const add = (name, check) => tests.push({ name, check });

    add("every format has a parser", () =>
        TRANSCRIPT_FORMATS.every((format) => parseSample(format.id).parse.parser === format.id));

    add("upload accept matches formats.js", () => {
        const input = document.getElementById("transcript-file-input");
        return input !== null && input.accept === getAcceptAttribute();
    });

    add("extension lookup is case-insensitive", () =>
        getFormatForFilename("VOD.SRT")?.id === "srt" && getFormatForFilename("a.vtt")?.id === "vtt");

    add("unsupported extensions are rejected", () =>
        getFormatForFilename("clip.mp4") === null && getFormatForFilename("noextension") === null);

    add("parser rejects unknown format with AppError", () => {
        try { parseTranscript({ rawText: "x", format: "pdf", filename: "a.pdf", size: 1 }); return false; }
        catch (error) { return error instanceof AppError && error.code === "no_parser_for_format"; }
    });

    TRANSCRIPT_FORMATS.forEach(({ id }) => {
        add(`${id}: raw text preserved exactly`, () => parseSample(id).rawText === samples[id]);
        add(`${id}: document and source are frozen`, () => {
            const doc = parseSample(id);
            return Object.isFrozen(doc) && Object.isFrozen(doc.source) && Object.isFrozen(doc.segments);
        });
        // Stage 2B update: JSON is implemented; the others are still placeholders.
        if (id === "json") return;
        add(`${id}: reports placeholder parse status`, () =>
            parseSample(id).parse.status === "not_implemented" && parseSample(id).processing.parsed === false);
    });

    add("json: parses records into segments, raw values kept (Stage 2B)", () => {
        const doc = parseSample("json");
        const [segment] = doc.segments;
        return doc.parse.status === "complete" && doc.processing.parsed === true && doc.segments.length === 1 &&
            segment.text === "h\u00e9llo" && segment.start.raw === "1.0" && segment.start.seconds === 1 &&
            segment.start.status === "parsed" && segment.end.raw === "3.5" && segment.end.seconds === 3.5 &&
            segment.speaker.value === "Streamer" && segment.speaker.source === "explicit" &&
            segment.duration.status === "missing" && doc.rawText === samples.json;
    });

    add("mutating a document throws (strict mode)", () => {
        const doc = parseSample("srt");
        return throwsTypeError(() => { doc.rawText = "changed"; }) &&
            throwsTypeError(() => { doc.source.filename = "changed"; });
    });

    add("validator does not mutate the document", () => {
        const doc = parseSample("vtt");
        const before = JSON.stringify(doc);
        const report = validateTranscript(doc);
        return JSON.stringify(doc) === before && report.valid === null && Array.isArray(report.issues);
    });

    add("derived layer creates a new document", () => {
        const doc = parseSample("txt");
        const next = withDerivedLayer(doc, { chunks: chunkTranscript(doc.segments) });
        return next !== doc && next.rawText === doc.rawText && doc.processing.chunked === false;
    });

    add("segment keeps provenance + raw timestamp", () => {
        const segment = createSegment({
            index: 3, format: "srt", sequence: 3, cueId: "4",
            lines: { start: 13, end: 15 }, offsets: { start: 120, end: 168 },
            start: createTimestamp({ raw: "01:23:45,500", seconds: 5025.5 }),
            text: "  original   spacing kept "
        });
        return segment.id === "seg-000003" && segment.source.cueId === "4" &&
            segment.start.raw === "01:23:45,500" && segment.start.seconds === 5025.5 &&
            segment.text === "  original   spacing kept " && segment.end.status === "missing";
    });

    add("validation issue has canonical shape", () => {
        const issue = createValidationIssue({
            index: 0, type: ISSUE_TYPES.TIMESTAMP_RESET, message: "Clock reset",
            segmentIds: ["seg-000123", "seg-000124"], source: { format: "srt", sequence: 123 }
        });
        return issue.id === "issue-000000" && issue.severity === "warning" && issue.segmentIds.length === 2;
    });

    add("stored transcript cannot be corrupted via inspection", () => {
        const stored = getStoredTranscript(appState);
        if (!stored) return true; // Nothing loaded; nothing to corrupt.
        const before = JSON.stringify(stored);
        throwsTypeError(() => { stored.rawText = ""; });
        throwsTypeError(() => { stored.segments.push({}); });
        return JSON.stringify(getStoredTranscript(appState)) === before;
    });

    // Stage 1.6: project + video foundation.
    addProjectTests(add);

    // Stage 1.7: start hint, replacement confirmation, alignment, linked video.
    addStage17Tests(add);

    // Stage 2A: provider architecture (deterministic mocks, no network).
    addProviderTests(add);

    // Stage 2B: the first real provider (fake fetch — no network) + JSON parser.
    addSupadataTests(add);

    // Stage 3: analysis contracts (interface only — no AI integration).
    addAnalysisTests(add);

    return tests;
}

// Checks may return a boolean or a Promise<boolean> (Stage 2A
// acquisition is async). Tests run one at a time, in order.
async function runSelfTests(appState) {
    const results = [];
    for (const { name, check } of buildTests(appState)) {
        try { results.push({ test: name, result: (await check()) === true ? "PASS" : "FAIL" }); }
        catch (error) { results.push({ test: name, result: `ERROR: ${error.message}` }); }
    }
    const failed = results.filter((row) => row.result !== "PASS").length;
    console.table(results);
    console.log(`[VOD Analyzer] Self-tests: ${results.length - failed}/${results.length} passed`);
    return { passed: results.length - failed, failed, results };
}

// Opt-in UI preview: registers one always-failing and one
// always-succeeding mock provider. Their names start with "Mock",
// so any "transcript" they supply is visibly test data.
function registerMockProviders(registry, refresh) {
    const mocks = [
        createMockProvider({ id: "mock-unavailable", name: "Mock A (always fails)",
            behavior: "fail", errorCode: "TRANSCRIPT_UNAVAILABLE", delayMs: 600 }),
        createMockProvider({ id: "mock-success", name: "Mock B (returns test data)", delayMs: 600 })
    ];
    const known = new Set(registry.list().map((item) => item.id));
    mocks.filter((mock) => !known.has(mock.id)).forEach((mock) => registry.register(mock));
    refresh();
    return registry.list();
}

export function installDevtools(appState, { providers, refresh }) {
    window.vodAnalyzer = Object.freeze({
        getState: (key) => appState.get(key),
        inspectProject: () => appState.get("project"),
        inspectTranscript: () => getStoredTranscript(appState),
        resolveVideoUrl,
        formats: TRANSCRIPT_FORMATS,
        listProviders: () => providers.list(),
        registerMockProviders: () => registerMockProviders(providers, refresh),
        runSelfTests: () => runSelfTests(appState)
    });
}

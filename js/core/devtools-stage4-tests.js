// ==========================================================
// devtools-stage4-tests.js
// Stage 4: application integration — validator checks,
// pipeline → chunking, JSON export + download, and the
// analyzer with the deterministic question-pattern extractor.
// ==========================================================

import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { validateTranscript, ISSUE_TYPES } from "../transcript/validator.js";
import { chunkDocument } from "../transcript/chunker.js";
import { exportTranscript } from "../transcript/export.js";
import {
    createTranscriptDocument, createSegment, createTimestamp,
    createFileAcquisition, TIMESTAMP_STATUS
} from "../transcript/model.js";
import { createProject, withTranscript } from "./project.js";
import { AppError } from "./errors.js";
import { createAnalyzer } from "../analysis/analyzer.js";
import { createAnalysisRequest } from "../analysis/contracts.js";
import { createQuestionExtractor } from "../analysis/deterministic-extractor.js";
import { renderTranscriptsView } from "../ui/transcripts.js";
import { renderAnalysisView } from "../ui/analysis.js";
import { downloadTextFile } from "../ui/download.js";

function docFromRecords(records, filename = "vod.json") {
    const rawText = JSON.stringify(records);
    return buildTranscriptDocument({
        rawText, format: "json", filename,
        size: rawText.length, acquisition: createFileAcquisition()
    });
}

function throwsCode(action, code) {
    try { action(); return false; }
    catch (error) { return error instanceof AppError && error.code === code; }
}

async function rejectsCode(promise, code) {
    try { await promise; return false; }
    catch (error) { return error instanceof AppError && error.code === code; }
}

// Hand-built document for structural cases the parser cannot
// produce (duplicate ids, malformed timestamps).
function handBuiltDocument(segments) {
    const doc = createTranscriptDocument({
        filename: "test.json", format: "json", size: 10,
        rawText: "[]", acquisition: createFileAcquisition()
    });
    doc.parse = { status: "complete", parser: "json", notes: [] };
    doc.segments = segments;
    return doc;
}

function projectWith(doc) {
    return withTranscript(createProject(), doc);
}

export function addStage4Tests(add) {

    // ---------- Validator ----------

    add("stage4: validator passes a clean transcript", () => {
        const doc = docFromRecords([{ start: 1, end: 2, text: "hello" }]);
        const report = doc.validation;
        return report.status === "passed" && report.valid === true &&
            report.checks.includes("parse_complete") &&
            report.checks.includes("segment_ids_unique") &&
            report.checks.includes("segment_text") &&
            report.checks.includes("timestamps") &&
            report.issues.length === 0 && doc.processing.validated === true;
    });

    add("stage4: validator warns on empty segment text", () => {
        const doc = docFromRecords([
            { start: 1, end: 2, text: "hello" },
            { start: 3, end: 4, text: "   " }
        ]);
        const issues = doc.validation.issues;
        const empty = issues.find((issue) => issue.type === ISSUE_TYPES.SEGMENT_EMPTY);
        return doc.validation.valid === true && !!empty &&
            empty.severity === "warning" &&
            empty.segmentIds.length === 1 && empty.segmentIds[0] === "seg-000001";
    });

    add("stage4: validator warns on malformed timestamps with evidence", () => {
        const doc = handBuiltDocument([
            createSegment({
                index: 0, format: "json",
                start: createTimestamp({ raw: "bogus", seconds: null, status: TIMESTAMP_STATUS.MALFORMED }),
                end: createTimestamp({ raw: "2.0", seconds: 2 }),
                text: "hello"
            })
        ]);
        const report = validateTranscript(doc);
        const malformed = report.issues.find((issue) => issue.type === ISSUE_TYPES.TIMESTAMP_MALFORMED);
        return report.valid === true && !!malformed &&
            malformed.severity === "warning" && malformed.evidence === "bogus" &&
            malformed.segmentIds[0] === "seg-000000";
    });

    add("stage4: validator notes missing timestamps as info", () => {
        const doc = docFromRecords([{ text: "no times here" }]);
        const missing = doc.validation.issues
            .find((issue) => issue.type === ISSUE_TYPES.TIMESTAMP_MISSING);
        return doc.validation.valid === true && !!missing && missing.severity === "info";
    });

    add("stage4: validator errors on duplicate segment ids", () => {
        const doc = handBuiltDocument([
            createSegment({ index: 0, format: "json", text: "one" }),
            createSegment({ index: 0, format: "json", text: "two" })
        ]);
        const report = validateTranscript(doc);
        const duplicate = report.issues
            .find((issue) => issue.type === ISSUE_TYPES.SEGMENT_DUPLICATE);
        return report.valid === false && report.status === "issues_found" &&
            !!duplicate && duplicate.severity === "error" &&
            duplicate.segmentIds.length === 1 && duplicate.segmentIds[0] === "seg-000000";
    });

    add("stage4: validator warns when the parser did not complete", () => {
        const rawText = "plain text, no parser";
        const doc = buildTranscriptDocument({
            rawText, format: "txt", filename: "notes.txt",
            size: rawText.length, acquisition: createFileAcquisition()
        });
        const concern = doc.validation.issues
            .find((issue) => issue.type === ISSUE_TYPES.QUALITY_CONCERN);
        // A warning, not a rejection: the document still loads.
        return doc.validation.valid === true && !!concern && concern.severity === "warning";
    });

    add("stage4: validator rejects non-documents", () => {
        return throwsCode(() => validateTranscript(null), "invalid_transcript_document") &&
            throwsCode(() => validateTranscript({}), "invalid_transcript_document") &&
            throwsCode(() => validateTranscript({ id: "tx-1", segments: [{ text: "no id" }] }),
                "invalid_transcript_document");
    });

    add("stage4: validator does not mutate the document", () => {
        const doc = docFromRecords([{ start: 1, end: 2, text: "hello" }]);
        const before = JSON.stringify(doc);
        validateTranscript(doc);
        return JSON.stringify(doc) === before;
    });

    // ---------- Pipeline → chunking ----------

    add("stage4: chunking attaches as a derived layer without mutating the source", () => {
        const doc = docFromRecords([
            { start: 0, end: 5, text: "first" },
            { start: 300, end: 305, text: "second" }
        ]);
        const before = JSON.stringify(doc);
        const chunked = chunkDocument(doc);
        return chunked !== doc &&
            doc.chunks.length === 0 && JSON.stringify(doc) === before &&
            chunked.chunks.length === 1 &&
            chunked.chunks[0].transcriptId === doc.id &&
            chunked.chunks[0].segmentIds.join() === doc.segments.map((s) => s.id).join() &&
            chunked.processing.chunked === true &&
            chunked.rawText === doc.rawText;
    });

    add("stage4: chunked transcript attaches to project state", () => {
        const doc = docFromRecords([{ start: 0, end: 5, text: "first" }]);
        const project = projectWith(chunkDocument(doc));
        return project.transcript.chunks.length === 1 &&
            project.transcript.chunks[0].transcriptId === project.transcript.id;
    });

    // ---------- Export ----------

    add("stage4: exportTranscript is deterministic", () => {
        const doc = docFromRecords([
            { start: 1, end: 2, speaker: "Ava", text: "hello" },
            { start: 3, end: 4, text: "world" }
        ]);
        const first = exportTranscript(doc, "json");
        const second = exportTranscript(doc, "json");
        const parsed = JSON.parse(first);
        return first === second &&
            parsed.segments.length === 2 &&
            parsed.segments[0].text === "hello" &&
            parsed.segments[0].speaker === "Ava" &&
            parsed.segments[1].start === 3 &&
            JSON.stringify(doc) === JSON.stringify(doc); // export never mutates
    });

    add("stage4: exportTranscript rejects unsupported formats", () => {
        const doc = docFromRecords([{ start: 1, text: "hello" }]);
        return throwsCode(() => exportTranscript(doc, "srt"), "export_not_supported") &&
            throwsCode(() => exportTranscript(doc, "vtt"), "export_not_supported") &&
            throwsCode(() => exportTranscript(null, "json"), "invalid_transcript_document");
    });

    add("stage4: download helper saves the exported text", () => {
        const realDocument = globalThis.document;
        const realCreateObjectURL = URL.createObjectURL;
        const realRevokeObjectURL = URL.revokeObjectURL;
        const realSetTimeout = globalThis.setTimeout;
        const seen = {};
        const fakeLink = {
            set href(value) { seen.href = value; },
            set download(value) { seen.download = value; },
            click() { seen.clicked = true; },
            remove() { seen.removed = true; }
        };
        globalThis.document = {
            createElement: () => fakeLink,
            body: { appendChild(link) { seen.appended = link === fakeLink; } }
        };
        URL.createObjectURL = () => "blob:stage4-test";
        URL.revokeObjectURL = () => { seen.revoked = true; };
        globalThis.setTimeout = (fn) => { fn(); return 0; };
        try {
            downloadTextFile("tx-test.json", "{\"ok\":true}");
        } finally {
            globalThis.document = realDocument;
            URL.createObjectURL = realCreateObjectURL;
            URL.revokeObjectURL = realRevokeObjectURL;
            globalThis.setTimeout = realSetTimeout;
        }
        return seen.href === "blob:stage4-test" && seen.download === "tx-test.json" &&
            seen.clicked === true && seen.appended === true && seen.revoked === true;
    });

    add("stage4: transcripts view offers JSON export", () => {
        const doc = docFromRecords([{ start: 1, text: "hello" }]);
        const mount = document.createElement("div");
        let called = 0;
        renderTranscriptsView(mount, projectWith(doc), null, {
            onExportTranscript: () => { called += 1; },
            exportNotice: null
        });
        const button = mount.querySelector("button");
        if (!button) return false;
        button.click();
        return called === 1;
    });

    // ---------- Analysis ----------

    function questionDoc() {
        return docFromRecords([
            { start: 0, end: 5, text: "first?" },
            { start: 300, end: 305, text: "second" },
            { start: 700, end: 705, text: "third?" },
            { start: 1300, end: 1305, text: "fourth" }
        ]);
    }

    function chunkedQuestionDoc() {
        return chunkDocument(questionDoc(), { windowSeconds: 600, overlapSeconds: 60 });
    }

    add("stage4: full-scope analysis yields traceable evidence", async () => {
        const doc = questionDoc();
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({ transcriptId: doc.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, doc);
        const known = new Set(doc.segments.map((s) => s.id));
        return result.requestId === request.id &&
            result.evidence.length === 2 &&
            result.evidence.every((item) =>
                item.sourceRef.transcriptId === doc.id &&
                item.sourceRef.segmentIds.length === 1 &&
                known.has(item.sourceRef.segmentIds[0]) &&
                item.provenance === "source-observed" &&
                item.reliability === "high" &&
                typeof item.content.quote === "string" &&
                item.content.quote.includes("?")) &&
            result.evidence[0].sourceRef.segmentIds[0] === "seg-000000" &&
            result.evidence[1].sourceRef.segmentIds[0] === "seg-000002";
    });

    add("stage4: chunk-scoped analysis stays inside the chunk", async () => {
        const doc = chunkedQuestionDoc();
        const chunk = doc.chunks.find((entry) => entry.id === "chunk-000001");
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({
            transcriptId: doc.id,
            scope: { type: "partial", segmentIds: [...chunk.segmentIds] },
            chunkId: chunk.id
        });
        const result = await analyzer.analyze(request, doc);
        const inChunk = new Set(chunk.segmentIds);
        return result.evidence.length === 1 &&
            result.evidence.every((item) => inChunk.has(item.sourceRef.segmentIds[0])) &&
            result.evidence[0].sourceRef.segmentIds[0] === "seg-000002";
    });

    add("stage4: extractor is deterministic", async () => {
        const doc = questionDoc();
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({ transcriptId: doc.id, scope: { type: "full" } });
        const first = await analyzer.analyze(request, doc);
        const second = await analyzer.analyze(request, doc);
        return JSON.stringify(first.evidence) === JSON.stringify(second.evidence);
    });

    add("stage4: extractor with no questions yields empty evidence", async () => {
        const doc = docFromRecords([{ start: 0, text: "no questions here." }]);
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({ transcriptId: doc.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, doc);
        return Array.isArray(result.evidence) && result.evidence.length === 0 &&
            result.observations.length === 1;
    });

    add("stage4: extractor failure surfaces as analysis failure", async () => {
        const doc = questionDoc();
        const failing = createAnalyzer({
            extract: async () => {
                throw new AppError("extractor_failed", "The extractor failed.", {});
            }
        });
        const request = createAnalysisRequest({ transcriptId: doc.id, scope: { type: "full" } });
        return rejectsCode(failing.analyze(request, doc), "extractor_failed");
    });

    add("stage4: missing chunk is rejected", async () => {
        const doc = chunkedQuestionDoc();
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({
            transcriptId: doc.id,
            scope: { type: "full" },
            chunkId: "chunk-999999"
        });
        return rejectsCode(analyzer.analyze(request, doc), "unknown_chunk_id");
    });

    add("stage4: chunk request on an unchunked transcript is rejected", async () => {
        const doc = questionDoc(); // never chunked
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({
            transcriptId: doc.id,
            scope: { type: "full" },
            chunkId: "chunk-000000"
        });
        return rejectsCode(analyzer.analyze(request, doc), "transcript_not_chunked");
    });

    add("stage4: transcript mismatch is rejected", async () => {
        const doc = questionDoc();
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({ transcriptId: "tx-someone-else", scope: { type: "full" } });
        return rejectsCode(analyzer.analyze(request, doc), "transcript_mismatch");
    });

    add("stage4: invalid analysis scope is rejected", () => {
        const doc = questionDoc();
        return throwsCode(() => createAnalysisRequest({
            transcriptId: doc.id, scope: { type: "bogus" }
        }), "invalid_scope") &&
            throwsCode(() => createAnalysisRequest({
                transcriptId: doc.id, scope: { type: "partial", segmentIds: [] }
            }), "invalid_scope");
    });

    // ---------- Analysis UI ----------

    add("stage4: analysis view runs full-scope analysis", async () => {
        const mount = document.createElement("div");
        let received = null;
        renderAnalysisView(mount, projectWith(questionDoc()), {
            analysis: { status: "idle" },
            onAnalyze: (args) => { received = args; }
        });
        const button = mount.querySelector("button");
        if (!button) return false;
        button.click();
        return !!received && received.scopeType === "full" && received.chunkId === null;
    });

    add("stage4: analysis view offers chunk scope when chunks exist", async () => {
        const doc = chunkedQuestionDoc();
        const mount = document.createElement("div");
        let received = null;
        renderAnalysisView(mount, projectWith(doc), {
            analysis: { status: "idle" },
            onAnalyze: (args) => { received = args; }
        });
        const chunkRadio = mount.querySelectorAll("input").find((el) => el.value === "chunk");
        const options = mount.querySelectorAll("option");
        if (!chunkRadio || chunkRadio.disabled || options.length !== doc.chunks.length) return false;
        chunkRadio.checked = true;
        mount.querySelector("button").click();
        return !!received && received.scopeType === "chunk" && received.chunkId === "chunk-000000";
    });

    add("stage4: analysis view displays evidence traceability", async () => {
        const doc = questionDoc();
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({ transcriptId: doc.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, doc);
        const mount = document.createElement("div");
        renderAnalysisView(mount, projectWith(doc), {
            analysis: { status: "done", request, result },
            onAnalyze: () => {}
        });
        const text = mount.textContent;
        return text.includes(doc.id) &&
            text.includes("seg-000000") &&
            text.includes("source-observed") &&
            text.includes("high");
    });

    add("stage4: analysis view shows an empty state without a transcript", async () => {
        const mount = document.createElement("div");
        renderAnalysisView(mount, createProject(), { analysis: { status: "idle" }, onAnalyze: () => {} });
        return mount.textContent.includes("No transcript loaded");
    });
}

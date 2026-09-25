// ==========================================================
// devtools-analysis-tests.js
// Responsibility: Stage 3 self-tests — analysis contracts
// (AnalysisRequest, AnalysisResult, Evidence) and the
// analyzer boundary (read-only TranscriptDocument, no AI).
// Registered by devtools.js via addAnalysisTests(add).
//
// Deterministic: no network, no AI, no timers. Real
// TranscriptDocuments come from the shared pipeline.
// ==========================================================

import {
    ANALYSIS_SCHEMA_VERSION,
    ANALYSIS_SCOPE_TYPE,
    EVIDENCE_TYPE,
    EVIDENCE_PROVENANCE,
    EVIDENCE_RELIABILITY,
    createAnalysisRequest,
    createAnalysisResult,
    createEvidence
} from "../analysis/contracts.js";
import { createAnalyzer } from "../analysis/analyzer.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";
import { AppError } from "./errors.js";

function sampleDocument() {
    // NOTE: only the JSON format parser is implemented (Stage 2B);
    // srt/vtt/txt parse to "not_implemented" with zero segments.
    const rawText = JSON.stringify([
        { start: 1.0, end: 2.0, text: "hello chat" },
        { start: 3.0, end: 4.0, text: "second line" }
    ]);
    return buildTranscriptDocument({
        rawText, format: "json", filename: "vod.json",
        size: rawText.length, acquisition: createFileAcquisition()
    });
}

function throwsAppError(action) {
    try { action(); return false; } catch (error) { return error instanceof AppError; }
}

function throwsTypeError(action) {
    try { action(); return false; } catch (error) { return error instanceof TypeError; }
}

function sampleEvidenceFields(document) {
    return {
        type: "text",
        sourceRef: { transcriptId: document.id, segmentIds: [document.segments[0].id] },
        content: { quote: "hello chat" },
        provenance: "source-observed",
        reliability: "high"
    };
}

export function addAnalysisTests(add) {

    // ---------- Test 1: AnalysisRequest, full scope ----------

    add("analysis: request with full scope has required fields and is frozen", () => {
        const document = sampleDocument();
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        return typeof request.id === "string" && request.id.length > 0 &&
            request.transcriptId === document.id &&
            request.scope.type === ANALYSIS_SCOPE_TYPE.FULL &&
            request.schemaVersion === ANALYSIS_SCHEMA_VERSION &&
            Object.isFrozen(request) && Object.isFrozen(request.scope) &&
            !("chunkId" in request); // deferred until chunk-scoped analysis exists
    });

    add("analysis: request rejects missing transcriptId", () =>
        throwsAppError(() => createAnalysisRequest({ scope: { type: "full" } })));

    add("analysis: request rejects unknown scope type", () =>
        throwsAppError(() => createAnalysisRequest({ transcriptId: "tx-1", scope: { type: "chapter" } })));

    add("analysis: mutating a request throws (strict mode)", () => {
        const request = createAnalysisRequest({ transcriptId: "tx-1", scope: { type: "full" } });
        return throwsTypeError(() => { request.transcriptId = "tx-2"; }) &&
            throwsTypeError(() => { request.scope.type = "partial"; });
    });

    // ---------- Test 2: AnalysisRequest, partial scope ----------

    add("analysis: request with partial scope keeps segment ids, not indexes", () => {
        const document = sampleDocument();
        const ids = document.segments.map((segment) => segment.id);
        const request = createAnalysisRequest({
            transcriptId: document.id, scope: { type: "partial", segmentIds: ids }
        });
        return request.scope.type === ANALYSIS_SCOPE_TYPE.PARTIAL &&
            request.scope.segmentIds.join() === ids.join() &&
            request.scope.segmentIds.every((id) => typeof id === "string" && id.startsWith("seg-")) &&
            Object.isFrozen(request.scope.segmentIds);
    });

    add("analysis: partial scope with empty segment ids is rejected", () =>
        throwsAppError(() => createAnalysisRequest({
            transcriptId: "tx-1", scope: { type: "partial", segmentIds: [] }
        })));

    add("analysis: partial scope with non-string segment ids is rejected", () =>
        throwsAppError(() => createAnalysisRequest({
            transcriptId: "tx-1", scope: { type: "partial", segmentIds: [42] }
        })));

    // ---------- Test 3: AnalysisResult ----------

    add("analysis: result has required fields, ISO createdAt, arrays, and is frozen", () => {
        const result = createAnalysisResult({ requestId: "areq-123" });
        return typeof result.id === "string" && result.id.length > 0 &&
            result.requestId === "areq-123" &&
            !Number.isNaN(Date.parse(result.createdAt)) &&
            Array.isArray(result.observations) && result.observations.length === 0 &&
            Array.isArray(result.evidence) && Array.isArray(result.warnings) &&
            Array.isArray(result.limitations) &&
            result.schemaVersion === ANALYSIS_SCHEMA_VERSION &&
            !("status" in result) && !("pending" in result) && // no status fields
            Object.isFrozen(result) && Object.isFrozen(result.evidence) &&
            Object.isFrozen(result.observations);
    });

    add("analysis: result rejects missing requestId and bad createdAt", () =>
        throwsAppError(() => createAnalysisResult({})) &&
        throwsAppError(() => createAnalysisResult({ requestId: "areq-1", createdAt: "yesterday" })));

    // ---------- Test 4: Evidence ----------

    add("analysis: evidence carries traceable sourceRef, enums, and is frozen", () => {
        const document = sampleDocument();
        const segmentId = document.segments[0].id;
        const evidence = createEvidence(sampleEvidenceFields(document));
        return typeof evidence.id === "string" && evidence.id.length > 0 &&
            evidence.type === EVIDENCE_TYPE.TEXT &&
            evidence.sourceRef.transcriptId === document.id &&
            evidence.sourceRef.segmentIds.length === 1 &&
            evidence.sourceRef.segmentIds[0] === segmentId &&
            evidence.provenance === EVIDENCE_PROVENANCE.SOURCE_OBSERVED &&
            evidence.reliability === EVIDENCE_RELIABILITY.HIGH &&
            Object.isFrozen(evidence) && Object.isFrozen(evidence.sourceRef) &&
            Object.isFrozen(evidence.sourceRef.segmentIds);
    });

    add("analysis: evidence covers every type / provenance / reliability value", () => {
        const document = sampleDocument();
        const combos = [];
        for (const type of Object.values(EVIDENCE_TYPE)) {
            for (const provenance of Object.values(EVIDENCE_PROVENANCE)) {
                for (const reliability of Object.values(EVIDENCE_RELIABILITY)) {
                    combos.push(createEvidence({
                        ...sampleEvidenceFields(document), type, provenance, reliability
                    }));
                }
            }
        }
        return combos.length === 4 * 3 * 3 && combos.every((item) => Object.isFrozen(item));
    });

    add("analysis: evidence rejects bad enums, empty segments, missing content", () => {
        const document = sampleDocument();
        const base = sampleEvidenceFields(document);
        return throwsAppError(() => createEvidence({ ...base, type: "audio" })) &&
            throwsAppError(() => createEvidence({ ...base, provenance: "vibes" })) &&
            throwsAppError(() => createEvidence({ ...base, reliability: "99%" })) &&
            throwsAppError(() => createEvidence({
                ...base, sourceRef: { transcriptId: document.id, segmentIds: [] }
            })) &&
            throwsAppError(() => createEvidence({ ...base, content: undefined }));
    });

    // ---------- Test 5: analyzer immutability boundary ----------

    add("analysis: analyzer never mutates the TranscriptDocument", async () => {
        const document = sampleDocument();
        const before = JSON.stringify(document);
        const hostile = createAnalyzer({
            extract: async (request, transcript) => {
                try { transcript.rawText = "mutated"; } catch { /* frozen: must throw */ }
                try { transcript.segments.push({ id: "evil" }); } catch { /* frozen: must throw */ }
                try { transcript.segments[0].text = "mutated"; } catch { /* frozen: must throw */ }
                try { request.scope.segmentIds.push("seg-evil"); } catch { /* frozen: must throw */ }
                return { observations: ["looked, did not touch"] };
            }
        });
        const request = createAnalysisRequest({
            transcriptId: document.id,
            scope: { type: "partial", segmentIds: [document.segments[0].id] }
        });
        const result = await hostile.analyze(request, document);
        return JSON.stringify(document) === before &&                       // document untouched
            JSON.stringify(request) === JSON.stringify(createAnalysisRequest(request)) && // request untouched
            result.requestId === request.id && result.observations.length === 1 &&
            Object.isFrozen(result);
    });

    // ---------- Analyzer contract enforcement ----------

    add("analysis: analyzer rejects a request for a different transcript", async () => {
        const document = sampleDocument();
        const analyzer = createAnalyzer();
        const request = createAnalysisRequest({ transcriptId: "tx-someone-else", scope: { type: "full" } });
        try { await analyzer.analyze(request, document); return false; }
        catch (error) { return error instanceof AppError && error.code === "transcript_mismatch"; }
    });

    add("analysis: analyzer rejects partial scope with unknown segment ids", async () => {
        const document = sampleDocument();
        const analyzer = createAnalyzer();
        const request = createAnalysisRequest({
            transcriptId: document.id, scope: { type: "partial", segmentIds: ["seg-999999"] }
        });
        try { await analyzer.analyze(request, document); return false; }
        catch (error) { return error instanceof AppError && error.code === "unknown_segment_id"; }
    });

    add("analysis: analyzer enforces evidence traceability to the analyzed transcript", async () => {
        const document = sampleDocument();
        const other = sampleDocument();
        const analyzer = createAnalyzer({
            extract: async () => ({
                evidence: [createEvidence({
                    ...sampleEvidenceFields(other), content: "wrong transcript"
                })]
            })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        try { await analyzer.analyze(request, document); return false; }
        catch (error) { return error instanceof AppError && error.code === "evidence_transcript_mismatch"; }
    });

    add("analysis: analyzer with no extract returns a valid empty result", async () => {
        const document = sampleDocument();
        const analyzer = createAnalyzer();
        const request = createAnalysisRequest({
            transcriptId: document.id,
            scope: { type: "partial", segmentIds: [document.segments[0].id] }
        });
        const result = await analyzer.analyze(request, document);
        return result.requestId === request.id &&
            result.evidence.length === 0 && result.observations.length === 0 &&
            result.warnings.length === 0 && result.limitations.length === 0 &&
            Object.isFrozen(result) && Object.isFrozen(analyzer);
    });

    add("analysis: analyzer passes findings through and stamps the request id", async () => {
        const document = sampleDocument();
        const segmentId = document.segments[1].id;
        const analyzer = createAnalyzer({
            extract: async (request, transcript) => ({
                observations: ["two segments seen"],
                evidence: [createEvidence({
                    type: "speaker",
                    sourceRef: { transcriptId: transcript.id, segmentIds: [segmentId] },
                    content: { speaker: null },
                    provenance: "inferred",
                    reliability: "low"
                })],
                warnings: ["timestamps are sparse"],
                limitations: ["no speaker attribution"]
            })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        return result.requestId === request.id &&
            result.observations.join() === "two segments seen" &&
            result.evidence.length === 1 &&
            result.evidence[0].sourceRef.segmentIds.join() === segmentId &&
            result.warnings.length === 1 && result.limitations.length === 1;
    });
}

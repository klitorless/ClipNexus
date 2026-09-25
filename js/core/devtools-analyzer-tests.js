// ==========================================================
// devtools-analyzer-tests.js
// Responsibility: analyzer/extraction-seam integration
// self-tests — the deterministic path TranscriptDocument →
// chunks → analyzer → structured evidence, via the documented
// ExtractionInput payload handed to the injected extract()
// seam. No AI, no network, no timers.
// Registered by devtools.js via addAnalyzerIntegrationTests(add).
//
// Deterministic: real TranscriptDocuments come from the shared
// pipeline (only the JSON format parser is implemented,
// Stage 2B); chunking comes from js/transcript/chunker.js.
// ==========================================================

import { createAnalyzer } from "../analysis/analyzer.js";
import { createAnalysisRequest } from "../analysis/contracts.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { chunkDocument } from "../transcript/chunker.js";
import { createFileAcquisition } from "../transcript/model.js";
import { AppError } from "./errors.js";

function docFromRecords(records, filename = "vod.json") {
    const rawText = JSON.stringify(records);
    return buildTranscriptDocument({
        rawText, format: "json", filename,
        size: rawText.length, acquisition: createFileAcquisition()
    });
}

// Four segments spread over time; with { windowSeconds: 600,
// overlapSeconds: 60 } this yields three chunks:
//   chunk-000000 [0, 600]     → seg-000000, seg-000001
//   chunk-000001 [540, 1140]  → seg-000002
//   chunk-000002 [1080, 1740] → seg-000003
function chunkedDoc() {
    return chunkDocument(docFromRecords([
        { start: 0, end: 5, speaker: "Ava", text: "first" },
        { start: 300, end: 305, text: "second" },
        { start: 700, end: 705, speaker: "Ben", text: "third" },
        { start: 1300, end: 1305, text: "fourth" }
    ]), { windowSeconds: 600, overlapSeconds: 60 });
}

function segmentIds(document) {
    return document.segments.map((segment) => segment.id);
}

async function rejectsCode(promise, code) {
    try { await promise; return false; }
    catch (error) { return error instanceof AppError && error.code === code; }
}

function throwsTypeError(action) {
    try { action(); return false; } catch (error) { return error instanceof TypeError; }
}

// Valid evidence shape; id intentionally omitted so tests can
// verify the analyzer normalizes (generates) it.
function validEvidence(document, segmentId, overrides = {}) {
    return {
        type: "text",
        sourceRef: { transcriptId: document.id, segmentIds: [segmentId] },
        content: { quote: "evidence quote" },
        provenance: "source-observed",
        reliability: "high",
        ...overrides
    };
}

export function addAnalyzerIntegrationTests(add) {

    // ---------- 1. full-document analysis ----------

    add("integration: full-document analysis hands the extractor every segment", async () => {
        const document = chunkedDoc();
        const ids = segmentIds(document);
        let seen = null;
        const analyzer = createAnalyzer({
            extract: async (request, doc, payload) => { seen = payload; return {}; }
        });
        const request = createAnalysisRequest({
            id: "areq-full-1", transcriptId: document.id, scope: { type: "full" }
        });
        const result = await analyzer.analyze(request, document);
        return seen !== null &&
            seen.requestId === "areq-full-1" &&
            seen.transcriptId === document.id &&
            seen.scope.type === "full" &&
            seen.chunkId === null && seen.chunk === null &&
            seen.segments.map((segment) => segment.id).join() === ids.join() &&
            result.requestId === "areq-full-1" && result.evidence.length === 0 &&
            Object.isFrozen(seen) && Object.isFrozen(seen.segments);
    });

    // ---------- 2. partial segment analysis ----------

    add("integration: partial scope narrows the payload to requested segments in document order", async () => {
        const document = chunkedDoc();
        const ids = segmentIds(document);
        let seen = null;
        const analyzer = createAnalyzer({
            extract: async (request, doc, payload) => { seen = payload; return {}; }
        });
        // Requested out of order on purpose: the payload must use
        // canonical document order, never caller order.
        const request = createAnalysisRequest({
            transcriptId: document.id,
            scope: { type: "partial", segmentIds: [ids[2], ids[0]] }
        });
        await analyzer.analyze(request, document);
        return seen.segments.map((segment) => segment.id).join() === [ids[0], ids[2]].join() &&
            JSON.stringify(seen.scope) ===
                JSON.stringify({ type: "partial", segmentIds: [ids[2], ids[0]] });
    });

    // ---------- 3. missing segment rejection ----------

    add("integration: partial scope with a segment outside the chunk is rejected", async () => {
        const document = chunkedDoc();
        const ids = segmentIds(document);
        const analyzer = createAnalyzer();
        const request = createAnalysisRequest({
            transcriptId: document.id,
            chunkId: "chunk-000000", // covers seg-000000, seg-000001 only
            scope: { type: "partial", segmentIds: [ids[2]] }
        });
        return rejectsCode(analyzer.analyze(request, document), "segment_not_in_chunk");
    });

    add("integration: partial scope with an unknown segment id is rejected", async () => {
        const document = chunkedDoc();
        const analyzer = createAnalyzer();
        const request = createAnalysisRequest({
            transcriptId: document.id,
            scope: { type: "partial", segmentIds: ["seg-999999"] }
        });
        return rejectsCode(analyzer.analyze(request, document), "unknown_segment_id");
    });

    // ---------- 4. chunk-aware analysis ----------

    add("integration: chunk-aware analysis resolves the chunk and its window", async () => {
        const document = chunkedDoc();
        let seen = null;
        const analyzer = createAnalyzer({
            extract: async (request, doc, payload) => { seen = payload; return {}; }
        });
        const request = createAnalysisRequest({
            id: "areq-chunk-1", transcriptId: document.id,
            chunkId: "chunk-000001", scope: { type: "full" }
        });
        const result = await analyzer.analyze(request, document);
        const chunk = document.chunks.find((entry) => entry.id === "chunk-000001");
        return seen.chunkId === "chunk-000001" && seen.chunk === chunk &&
            seen.segments.map((segment) => segment.id).join() === chunk.segmentIds.join() &&
            result.requestId === "areq-chunk-1" && Object.isFrozen(result);
    });

    add("integration: chunkId on an unchunked transcript is rejected", async () => {
        const document = docFromRecords([{ start: 0, text: "solo" }]); // never chunked
        const analyzer = createAnalyzer();
        const request = createAnalysisRequest({
            transcriptId: document.id, chunkId: "chunk-000000", scope: { type: "full" }
        });
        return rejectsCode(analyzer.analyze(request, document), "transcript_not_chunked");
    });

    add("integration: unknown chunkId is rejected", async () => {
        const document = chunkedDoc();
        const analyzer = createAnalyzer();
        const request = createAnalysisRequest({
            transcriptId: document.id, chunkId: "chunk-999999", scope: { type: "full" }
        });
        return rejectsCode(analyzer.analyze(request, document), "unknown_chunk_id");
    });

    // ---------- 5. extractor invocation ----------

    add("integration: extractor is invoked exactly once per analysis", async () => {
        const document = chunkedDoc();
        let calls = 0;
        const analyzer = createAnalyzer({ extract: async () => { calls++; return {}; } });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        await analyzer.analyze(request, document);
        return calls === 1;
    });

    // ---------- 6. extractor receives correct source information ----------

    add("integration: extractor payload carries source, scope, timestamps, and speaker info", async () => {
        const document = chunkedDoc();
        let seen = null;
        const analyzer = createAnalyzer({
            extract: async (request, doc, payload) => { seen = payload; return {}; }
        });
        const request = createAnalysisRequest({
            id: "areq-src-1", transcriptId: document.id, scope: { type: "full" }
        });
        await analyzer.analyze(request, document);
        const [first, second] = seen.segments;
        return seen.requestId === "areq-src-1" &&
            seen.transcriptId === document.id &&
            first.id === document.segments[0].id &&
            first.text === "first" &&
            first.start.seconds === 0 && first.start.status === "parsed" &&
            first.end.seconds === 5 &&
            first.speaker.value === "Ava" && first.speaker.source === "explicit" &&
            second.speaker.value === null && second.speaker.source === "unknown" &&
            !("rawText" in seen) && !("acquisition" in seen); // curated: no document internals
    });

    // ---------- 7. extractor output normalization ----------

    add("integration: extractor output is normalized into the evidence contract", async () => {
        const document = chunkedDoc();
        const segmentId = document.segments[0].id;
        const analyzer = createAnalyzer({
            extract: async () => ({ evidence: [validEvidence(document, segmentId)] })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        const [item] = result.evidence;
        return result.evidence.length === 1 &&
            typeof item.id === "string" && item.id.startsWith("ev-") && // id generated
            item.type === "text" &&
            Object.isFrozen(item) && Object.isFrozen(item.sourceRef) &&
            Object.isFrozen(item.sourceRef.segmentIds) &&
            throwsTypeError(() => { item.content.quote = "changed"; }); // frozen in place
    });

    // ---------- 8/9/10. sourceRef / provenance / reliability preservation ----------

    add("integration: sourceRef survives normalization untouched", async () => {
        const document = chunkedDoc();
        const ids = [document.segments[0].id, document.segments[1].id];
        const analyzer = createAnalyzer({
            extract: async () => ({
                evidence: [validEvidence(document, ids[0], {
                    sourceRef: { transcriptId: document.id, segmentIds: ids }
                })]
            })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        return result.evidence[0].sourceRef.transcriptId === document.id &&
            result.evidence[0].sourceRef.segmentIds.join() === ids.join();
    });

    add("integration: provenance is preserved, never upgraded", async () => {
        const document = chunkedDoc();
        const analyzer = createAnalyzer({
            extract: async () => ({
                evidence: [validEvidence(document, document.segments[0].id, { provenance: "inferred" })]
            })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        return result.evidence[0].provenance === "inferred";
    });

    add("integration: reliability is preserved, never upgraded", async () => {
        const document = chunkedDoc();
        const analyzer = createAnalyzer({
            extract: async () => ({
                evidence: [validEvidence(document, document.segments[0].id, { reliability: "low" })]
            })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        return result.evidence[0].reliability === "low";
    });

    // ---------- 11. empty extractor behavior ----------

    add("integration: empty extractor on a chunked request returns a valid result", async () => {
        const document = chunkedDoc();
        const analyzer = createAnalyzer();
        const request = createAnalysisRequest({
            id: "areq-empty-1", transcriptId: document.id,
            chunkId: "chunk-000002", scope: { type: "full" }
        });
        const result = await analyzer.analyze(request, document);
        return result.requestId === "areq-empty-1" &&
            result.evidence.length === 0 && result.observations.length === 0 &&
            result.warnings.length === 0 && result.limitations.length === 0 &&
            Object.isFrozen(result);
    });

    // ---------- 12. malformed extractor output ----------

    add("integration: malformed extractor output produces structured errors", async () => {
        const document = chunkedDoc();
        const segmentId = document.segments[0].id;
        const baseRequest = (extra = {}) => createAnalysisRequest({
            transcriptId: document.id, scope: { type: "full" }, ...extra
        });
        const checks = await Promise.all([
            rejectsCode(
                createAnalyzer({ extract: async () => null })
                    .analyze(baseRequest(), document), "invalid_findings"),
            rejectsCode(
                createAnalyzer({ extract: async () => ({ evidence: "nope" }) })
                    .analyze(baseRequest(), document), "invalid_findings"),
            rejectsCode(
                createAnalyzer({
                    extract: async () => ({
                        evidence: [validEvidence(document, segmentId, { provenance: "vibes" })]
                    })
                }).analyze(baseRequest(), document), "invalid_evidence"),
            rejectsCode(
                createAnalyzer({
                    // seg-000003 is outside chunk-000000's window
                    extract: async () => ({
                        evidence: [validEvidence(document, document.segments[3].id)]
                    })
                }).analyze(baseRequest({ chunkId: "chunk-000000" }), document),
                "unknown_segment_id")
        ]);
        return checks.every(Boolean);
    });

    // ---------- 13. source-document immutability ----------

    add("integration: analysis never mutates the source document or the payload", async () => {
        const document = chunkedDoc();
        const before = JSON.stringify(document);
        let seen = null;
        const hostile = createAnalyzer({
            extract: async (request, doc, payload) => {
                seen = payload;
                try { doc.rawText = "mutated"; } catch { /* frozen: must throw */ }
                try { doc.segments.push({ id: "evil" }); } catch { /* frozen: must throw */ }
                try { doc.chunks.length = 0; } catch { /* frozen: must throw */ }
                try { payload.segments[0].text = "mutated"; } catch { /* frozen: must throw */ }
                try { payload.segments.push({}); } catch { /* frozen: must throw */ }
                return { observations: ["looked, did not touch"] };
            }
        });
        const request = createAnalysisRequest({
            transcriptId: document.id, chunkId: "chunk-000001", scope: { type: "full" }
        });
        const result = await hostile.analyze(request, document);
        return JSON.stringify(document) === before && // document untouched
            seen.segments.length === 1 &&
            seen.segments[0].text === "third" &&      // payload untouched
            result.observations.length === 1;
    });

    // ---------- 14. deterministic behavior ----------

    add("integration: identical inputs produce identical findings", async () => {
        const document = chunkedDoc();
        const segmentId = document.segments[1].id;
        const analyzer = createAnalyzer({
            extract: async (request, doc, payload) => ({
                observations: [`saw ${payload.segments.length} segments`],
                // Explicit id: createEvidence generates a random one when
                // omitted, which is correct behavior but not comparable.
                evidence: [validEvidence(document, segmentId, {
                    id: "ev-determinism-1", content: { quote: "second" }
                })]
            })
        });
        const request = createAnalysisRequest({
            id: "areq-determinism-1", transcriptId: document.id, scope: { type: "full" }
        });
        const first = await analyzer.analyze(request, document);
        const second = await analyzer.analyze(request, document);
        return first.requestId === second.requestId &&
            JSON.stringify(first.evidence) === JSON.stringify(second.evidence) &&
            JSON.stringify(first.observations) === JSON.stringify(second.observations);
    });

    // ---------- evidence stays inside the analysis window ----------

    add("integration: evidence outside the analysis window is rejected", async () => {
        const document = chunkedDoc();
        const ids = segmentIds(document);
        const analyzer = createAnalyzer({
            extract: async () => ({ evidence: [validEvidence(document, ids[1])] })
        });
        const request = createAnalysisRequest({
            transcriptId: document.id, scope: { type: "partial", segmentIds: [ids[0]] }
        });
        return rejectsCode(analyzer.analyze(request, document), "unknown_segment_id");
    });
}

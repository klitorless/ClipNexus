// ==========================================================
// analyzer.js
// Responsibility: the STAGE 3 ANALYZER BOUNDARY, wired to the
// Stage 2C chunking layer.
//
//   const analyzer = createAnalyzer({ extract });
//   const result = await analyzer.analyze(request, transcriptDocument);
//
// The analyzer READS the TranscriptDocument and PRODUCES an
// AnalysisResult. It never mutates the document.
//
// The injected `extract` seam stays provider-agnostic. It is
// called as:
//
//   extract(request, document, payload)
//
// where `payload` is the documented ExtractionInput below — a
// curated, frozen view of exactly the transcript evidence under
// analysis. `request` and `document` are kept as the first two
// arguments for backward compatibility with existing
// extractors; new extractors should read the payload, which is
// the stable contract going forward.
//
// Chunk-aware analysis: when the request carries a chunkId, the
// chunk is resolved from the document's Stage 2C chunks and the
// analysis window narrows to that chunk. The analyzer never
// re-implements chunking; it consumes chunker.js output.
//
// No AI integration at this stage: `extract` is an injected,
// testable seam where a future stage will plug in real
// analysis. Omitting it yields a valid, empty result.
//
// Traceability is enforced, not assumed: the request must
// reference the analyzed transcript, partial scopes and
// evidence may only cite segments inside the analysis window,
// and every evidence item must point back at the analyzed
// transcript. Chunk traceability rides on the request's
// chunkId → result.requestId linkage; the Evidence contract
// itself is unchanged (no second schema).
// ==========================================================

import { AppError } from "../core/errors.js";
import {
    ANALYSIS_SCHEMA_VERSION,
    ANALYSIS_SCOPE_TYPE,
    createAnalysisRequest,
    createAnalysisResult,
    createEvidence
} from "./contracts.js";
import { deepFreeze } from "../transcript/model.js";

function assertTranscriptDocumentShape(document) {
    if (!document || typeof document !== "object" ||
            typeof document.id !== "string" || !Array.isArray(document.segments)) {
        throw new AppError("invalid_transcript_document",
            "The analyzer needs a TranscriptDocument.", {});
    }
    return document;
}

function knownSegmentIds(document) {
    const ids = new Set();
    for (const segment of document.segments) {
        if (segment && typeof segment.id === "string") ids.add(segment.id);
    }
    return ids;
}

function assertKnownSegment(segmentId, known, code, extra = {}) {
    if (!known.has(segmentId)) {
        throw new AppError(code, "Unknown segment id.", { segmentId, ...extra });
    }
}

// ---------- Analysis window ----------
//
// The analysis window is the set of segment ids under analysis,
// in canonical document order (never caller order, never array
// indexes as identity):
//   - no chunkId, full scope    → every segment in the document
//   - no chunkId, partial scope → the requested segment ids
//   - chunkId                  → the chunk's segments (full scope) or
//                                the requested ids, each of which must
//                                lie inside the chunk (partial scope)

function resolveChunk(validRequest, document) {
    const chunkId = validRequest.chunkId ?? null;
    if (chunkId === null) return null;
    const chunks = Array.isArray(document.chunks) ? document.chunks : [];
    if (chunks.length === 0) {
        throw new AppError("transcript_not_chunked",
            "The request targets a chunk, but the transcript has no chunks.", { chunkId });
    }
    const chunk = chunks.find((entry) => entry && entry.id === chunkId) || null;
    if (!chunk) {
        throw new AppError("unknown_chunk_id",
            "The request references a chunk that does not exist.", { chunkId });
    }
    return chunk;
}

function chunkSegmentIds(chunk, known) {
    const ids = Array.isArray(chunk.segmentIds) ? chunk.segmentIds : [];
    return new Set(ids.filter((id) => known.has(id)));
}

function resolveAnalysisWindow(validRequest, document) {
    const known = knownSegmentIds(document);
    const chunk = resolveChunk(validRequest, document);
    const wanted = new Set();

    if (chunk) {
        const inChunk = chunkSegmentIds(chunk, known);
        if (validRequest.scope.type === ANALYSIS_SCOPE_TYPE.PARTIAL) {
            for (const segmentId of validRequest.scope.segmentIds) {
                assertKnownSegment(segmentId, known, "unknown_segment_id");
                if (!inChunk.has(segmentId)) {
                    throw new AppError("segment_not_in_chunk",
                        "A requested segment is not part of the chunk under analysis.",
                        { segmentId, chunkId: chunk.id });
                }
                wanted.add(segmentId);
            }
        } else {
            for (const segmentId of inChunk) wanted.add(segmentId);
        }
    } else if (validRequest.scope.type === ANALYSIS_SCOPE_TYPE.PARTIAL) {
        for (const segmentId of validRequest.scope.segmentIds) {
            assertKnownSegment(segmentId, known, "unknown_segment_id");
            wanted.add(segmentId);
        }
    } else {
        for (const segmentId of known) wanted.add(segmentId);
    }

    // Canonical document order. Duplicate ids (should not happen;
    // segment ids are deterministic and unique) collapse to first.
    const seen = new Set();
    const segmentIds = [];
    for (const segment of document.segments) {
        if (segment && typeof segment.id === "string" &&
                wanted.has(segment.id) && !seen.has(segment.id)) {
            seen.add(segment.id);
            segmentIds.push(segment.id);
        }
    }
    return { chunk, segmentIds };
}

// ---------- ExtractionInput ----------
//
// The documented payload handed to the injected extract() seam.
// Curated from the TranscriptDocument so an extractor never
// needs the document's internal layout and can never observe
// (or depend on) anything outside the analysis window:
//
// {
//   requestId: string,       // the AnalysisRequest id
//   transcriptId: string,    // canonical TranscriptDocument id
//   scope: { type: "full" } | { type: "partial", segmentIds: string[] },
//   chunkId: string | null,  // chunk under analysis, if any
//   chunk: object | null,    // the resolved Stage 2C chunk (frozen), if any
//   segments: [              // in-scope segments, in document order
//     {
//       id: string,          // durable segment identity (never an index)
//       text: string,        // verbatim source text
//       start: { raw, seconds, status },
//       end: { raw, seconds, status },
//       speaker: { raw, value, source }  // value/source may be null/"unknown"
//     }
//   ]
// }
//
// No UI fields, no provider-specific fields. The payload is
// frozen and built fresh on every analyze() call, so an
// extractor cannot mutate the transcript through it.

function timestampView(timestamp) {
    return {
        raw: timestamp ? timestamp.raw ?? null : null,
        seconds: timestamp ? timestamp.seconds ?? null : null,
        status: timestamp ? timestamp.status ?? null : null
    };
}

function segmentView(segment) {
    return {
        id: segment.id,
        text: segment.text ?? "",
        start: timestampView(segment.start),
        end: timestampView(segment.end),
        speaker: {
            raw: segment.speaker ? segment.speaker.raw ?? null : null,
            value: segment.speaker ? segment.speaker.value ?? null : null,
            source: segment.speaker ? segment.speaker.source ?? null : null
        }
    };
}

function buildExtractionInput(validRequest, document, chunk, segmentIds) {
    const byId = new Map();
    for (const segment of document.segments) {
        if (segment && typeof segment.id === "string" && !byId.has(segment.id)) {
            byId.set(segment.id, segment);
        }
    }
    return deepFreeze({
        requestId: validRequest.id,
        transcriptId: document.id,
        scope: validRequest.scope, // already frozen by createAnalysisRequest
        chunkId: chunk ? chunk.id : null,
        chunk,
        segments: segmentIds.map((id) => segmentView(byId.get(id)))
    });
}

function readFindings(findings) {
    if (!findings || typeof findings !== "object") {
        throw new AppError("invalid_findings",
            "Analyzer extract must resolve to an object.", { findings });
    }
    const { observations = [], evidence = [], warnings = [], limitations = [] } = findings;
    return { observations, evidence, warnings, limitations };
}

export function createAnalyzer({ extract } = {}) {
    if (extract !== undefined && typeof extract !== "function") {
        throw new AppError("invalid_analyzer",
            "Analyzer extract must be a function.", { extract });
    }

    async function analyze(request, transcriptDocument) {
        // Normalize through the factory: validates shape and returns
        // a frozen copy, so the caller's object is never touched.
        const validRequest = createAnalysisRequest(request);
        const document = assertTranscriptDocumentShape(transcriptDocument);

        if (validRequest.transcriptId !== document.id) {
            throw new AppError("transcript_mismatch",
                "The analysis request references a different transcript.",
                { requestTranscriptId: validRequest.transcriptId });
        }

        const { chunk, segmentIds } = resolveAnalysisWindow(validRequest, document);
        const payload = buildExtractionInput(validRequest, document, chunk, segmentIds);

        const findings = readFindings(
            extract ? await extract(validRequest, document, payload) : {});

        const evidence = findings.evidence;
        if (!Array.isArray(evidence)) {
            throw new AppError("invalid_findings",
                "Analyzer findings evidence must be an array.", {});
        }
        // Evidence must cite segments inside the analysis window, so
        // chunk-scoped runs stay traceable to their chunk. Each item
        // is normalized into the Stage 3 contract (missing ids are
        // generated, arrays are copied, everything is frozen) —
        // never invented, never silently upgraded.
        const windowKnown = new Set(segmentIds);
        const tracedEvidence = evidence.map((item) => {
            const normalized = createEvidence(item);
            if (normalized.sourceRef.transcriptId !== document.id) {
                throw new AppError("evidence_transcript_mismatch",
                    "Evidence must reference the analyzed transcript.",
                    { evidenceId: normalized.id });
            }
            for (const segmentId of normalized.sourceRef.segmentIds) {
                assertKnownSegment(segmentId, windowKnown, "unknown_segment_id",
                    chunk ? { chunkId: chunk.id } : {});
            }
            return normalized;
        });

        return createAnalysisResult({
            requestId: validRequest.id,
            observations: findings.observations,
            evidence: tracedEvidence,
            warnings: findings.warnings,
            limitations: findings.limitations,
            schemaVersion: ANALYSIS_SCHEMA_VERSION
        });
    }

    return Object.freeze({ analyze });
}

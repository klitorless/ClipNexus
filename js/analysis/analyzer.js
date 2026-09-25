// ==========================================================
// analyzer.js
// Responsibility: the STAGE 3 ANALYZER BOUNDARY.
//
//   const analyzer = createAnalyzer({ extract });
//   const result = await analyzer.analyze(request, transcriptDocument);
//
// The analyzer READS the TranscriptDocument and PRODUCES an
// AnalysisResult. It never mutates the document.
//
// No AI integration at this stage: `extract` is an injected,
// testable seam where a future stage will plug in real
// analysis. Omitting it yields a valid, empty result.
//
// Traceability is enforced, not assumed: the request must
// reference the analyzed transcript, partial scopes and
// evidence may only cite segments that exist in it, and
// every evidence item must point back at it.
// ==========================================================

import { AppError } from "../core/errors.js";
import {
    ANALYSIS_SCHEMA_VERSION,
    ANALYSIS_SCOPE_TYPE,
    createAnalysisRequest,
    createAnalysisResult,
    assertEvidence
} from "./contracts.js";

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

function assertKnownSegment(segmentId, known, code) {
    if (!known.has(segmentId)) {
        throw new AppError(code, "Unknown segment id.", { segmentId });
    }
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

        const known = knownSegmentIds(document);
        if (validRequest.scope.type === ANALYSIS_SCOPE_TYPE.PARTIAL) {
            for (const segmentId of validRequest.scope.segmentIds) {
                assertKnownSegment(segmentId, known, "unknown_segment_id");
            }
        }

        const findings = readFindings(extract ? await extract(validRequest, document) : {});

        const evidence = findings.evidence;
        if (!Array.isArray(evidence)) {
            throw new AppError("invalid_findings",
                "Analyzer findings evidence must be an array.", {});
        }
        const tracedEvidence = evidence.map((item) => {
            const valid = assertEvidence(item);
            if (valid.sourceRef.transcriptId !== document.id) {
                throw new AppError("evidence_transcript_mismatch",
                    "Evidence must reference the analyzed transcript.",
                    { evidenceId: valid.id });
            }
            for (const segmentId of valid.sourceRef.segmentIds) {
                assertKnownSegment(segmentId, known, "unknown_segment_id");
            }
            return valid;
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

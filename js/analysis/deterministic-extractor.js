// ==========================================================
// deterministic-extractor.js  (Stage 4 — integration test extractor)
// Responsibility: the smallest possible deterministic extractor
// behind the analyzer's extraction seam. Its only purpose is to
// prove that the analyzer hands correctly scoped transcript
// material to an extractor and that the resulting evidence
// stays traceable to transcript + segment ids.
//
// Rule: a segment is evidence when its text contains a "?".
// That is the entire rule. No AI, no network, no ranking, no
// scoring of any kind — this is an integration probe, not an
// analysis product.
//
// Evidence uses only the Stage 3 contract: generated ids,
// transcriptId + segmentIds sourceRef, source-observed
// provenance, high reliability for verbatim matches.
// ==========================================================

import {
    EVIDENCE_TYPE,
    EVIDENCE_PROVENANCE,
    EVIDENCE_RELIABILITY
} from "./contracts.js";

const QUESTION_PATTERN = "?";

/**
 * Build the extractor function for createAnalyzer({ extract }).
 * Deterministic: the same extraction payload always yields the
 * same evidence in the same order.
 */
export function createQuestionExtractor() {
    async function extractQuestionEvidence(request, document, payload) {
        const evidence = [];
        for (const segment of payload.segments) {
            if (typeof segment.text === "string" && segment.text.includes(QUESTION_PATTERN)) {
                evidence.push({
                    id: `ev-question-${String(evidence.length + 1).padStart(6, "0")}`,
                    type: EVIDENCE_TYPE.TEXT,
                    sourceRef: {
                        transcriptId: payload.transcriptId,
                        segmentIds: [segment.id]
                    },
                    content: {
                        pattern: "question",
                        quote: segment.text.trim()
                    },
                    provenance: EVIDENCE_PROVENANCE.SOURCE_OBSERVED,
                    reliability: EVIDENCE_RELIABILITY.HIGH
                });
            }
        }
        const inScope = payload.segments.length;
        return {
            observations: [
                `${evidence.length} of ${inScope} in-scope segment(s) contain a question mark.`
            ],
            evidence,
            warnings: [],
            limitations: [
                "Pattern detection only: the extractor matches a literal \"?\" and performs no semantic analysis."
            ]
        };
    }
    return extractQuestionEvidence;
}

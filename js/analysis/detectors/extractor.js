// ==========================================================
// detectors/extractor.js
// Responsibility: the analyzer-seam extractor built on the
// detector layer. Replaces the Stage 4 question-pattern
// probe (deterministic-extractor.js, kept for its tests)
// as the wired extractor in app.js.
//
// Each detector signal becomes one Stage 3 Evidence item:
//
//   id:          "ev-<detector>-<segmentId>" (deterministic)
//   type:        "text"
//   sourceRef:   { transcriptId, segmentIds: [segmentId] }
//   content:     { detector, score, signals, timestampSeconds,
//                  quote }          // quote is verbatim
//   provenance:  "source-observed"   // verbatim pattern match
//   reliability: "high"              // the MATCH is certain;
//                                   // the interpretation is
//                                   // heuristic (see limitations)
//
// Detectors find evidence. They do not decide what becomes
// a clip: no POIs, events, or ClipSpecs are created here.
// ==========================================================

import {
    EVIDENCE_TYPE,
    EVIDENCE_PROVENANCE,
    EVIDENCE_RELIABILITY
} from "../contracts.js";
import { runDetectors, resolveDetectorConfig } from "./index.js";

const HEURISTIC_LIMITATION =
    "Detector signals are deterministic heuristics over verbatim text " +
    "(weighted phrase lists, punctuation and repetition patterns). They are " +
    "not measurements of emotion, intent, or importance.";

function signalToEvidence(transcriptId, signal) {
    return {
        id: `ev-${signal.detector}-${signal.segmentId}`,
        type: EVIDENCE_TYPE.TEXT,
        sourceRef: {
            transcriptId,
            segmentIds: [signal.segmentId]
        },
        content: {
            detector: signal.detector,
            score: signal.score,
            signals: [...signal.signals],
            timestampSeconds: signal.timestampSeconds,
            quote: signal.quote
        },
        provenance: EVIDENCE_PROVENANCE.SOURCE_OBSERVED,
        reliability: EVIDENCE_RELIABILITY.HIGH
    };
}

/**
 * Build the analyzer `extract` function for the detector suite.
 * The config is resolved once, up front, so a misconfigured
 * detector fails at setup — never mid-analysis.
 */
export function createDetectorExtractor(userConfig = {}) {
    const config = resolveDetectorConfig(userConfig);

    async function extractDetectorEvidence(request, document, payload) {
        const signals = runDetectors(payload.segments, config);
        const evidence = signals.map((signal) =>
            signalToEvidence(payload.transcriptId, signal));
        const inScope = payload.segments.length;
        return {
            observations: [
                `${evidence.length} detector signal(s) across ${inScope} in-scope segment(s).`
            ],
            evidence,
            warnings: [],
            limitations: [HEURISTIC_LIMITATION]
        };
    }

    return extractDetectorEvidence;
}

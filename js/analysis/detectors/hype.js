// ==========================================================
// detectors/hype.js
// Responsibility: detect excitement / surprise / high-energy
// language with weighted heuristic phrases.
//
// Scoring: each DISTINCT matched phrase contributes its
// weight once per segment (repeating "wow wow" does not
// double-count). A weaker phrase subsumed by a stronger
// matched phrase is dropped: "that's insane" (+3) suppresses
// the bare "insane" (+1) so one span of text is not scored
// twice.
//
// Weights are heuristic signal strengths, NOT measurements
// of human excitement. The vocabulary and weights are
// explicit and easy to extend below.
// ==========================================================

import { findPhrases } from "./text.js";
import { DETECTOR_TYPE } from "./types.js";

export const HYPE_PHRASES = Object.freeze([
    // strong (+3)
    Object.freeze({ phrase: "oh my god", weight: 3 }),
    Object.freeze({ phrase: "holy shit", weight: 3 }),
    Object.freeze({ phrase: "that's insane", weight: 3 }),
    // medium (+2)
    Object.freeze({ phrase: "no way", weight: 2 }),
    Object.freeze({ phrase: "let's go", weight: 2 }),
    Object.freeze({ phrase: "are you serious", weight: 2 }),
    Object.freeze({ phrase: "what the hell", weight: 2 }),
    Object.freeze({ phrase: "what just happened", weight: 2 }),
    // weak (+1)
    Object.freeze({ phrase: "wow", weight: 1 }),
    Object.freeze({ phrase: "insane", weight: 1 }),
    Object.freeze({ phrase: "crazy", weight: 1 }),
    Object.freeze({ phrase: "unbelievable", weight: 1 })
]);

// Drop a matched phrase when a stronger-or-equal matched
// phrase contains it ("insane" inside "that's insane").
function dropSubsumed(matched) {
    return matched.filter((candidate) =>
        !matched.some((other) =>
            other !== candidate &&
            other.weight >= candidate.weight &&
            other.phrase.toLowerCase().includes(candidate.phrase.toLowerCase())
        )
    );
}

export function scoreHypePhrases(text) {
    const matched = findPhrases(text, HYPE_PHRASES.map((entry) => entry.phrase))
        .map(({ phrase }) => HYPE_PHRASES.find((entry) => entry.phrase === phrase));
    const surviving = dropSubsumed(matched);
    // Vocabulary order keeps output deterministic.
    surviving.sort((a, b) =>
        HYPE_PHRASES.indexOf(a) - HYPE_PHRASES.indexOf(b));
    return {
        score: surviving.reduce((sum, entry) => sum + entry.weight, 0),
        signals: surviving.map((entry) => entry.phrase)
    };
}

export function detectHype(segment) {
    const text = segment && typeof segment.text === "string" ? segment.text : "";
    if (text.trim().length === 0) return null;
    const { score, signals } = scoreHypePhrases(text);
    if (score <= 0) return null;
    return { detector: DETECTOR_TYPE.HYPE, score, signals };
}

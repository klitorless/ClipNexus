// ==========================================================
// detectors/question.js
// Responsibility: detect question-like segments using
// sentence structure, not just word lists.
//
// Rules (deterministic, documented):
//   1. A literal "?" anywhere is a question signal (+2).
//   2. Otherwise, a question word as the FIRST word of the
//      segment with at least 3 words is a weak structural
//      signal (+1). A question word mid-sentence
//      ("I know what you did") is NOT a signal.
//   3. Both may apply ("What the hell?!" → "?" + "what").
//      Overlap with hype/reaction detectors is allowed.
//
// Question words alone never classify a segment: position
// and structure are required.
// ==========================================================

import { firstWord, wordTokens } from "./text.js";
import { DETECTOR_TYPE } from "./types.js";

export const QUESTION_WORDS = Object.freeze([
    "how", "why", "what", "when", "where", "who", "which",
    "can", "could", "would", "should", "is", "are",
    "do", "does", "did"
]);

const MIN_STRUCTURAL_WORDS = 3;

export function scoreQuestion(text) {
    const source = typeof text === "string" ? text : "";
    const signals = [];
    let score = 0;
    if (source.includes("?")) {
        score += 2;
        signals.push("?");
    }
    const starter = firstWord(source);
    if (starter !== null &&
            QUESTION_WORDS.includes(starter) &&
            wordTokens(source).length >= MIN_STRUCTURAL_WORDS) {
        score += 1;
        signals.push(`question-word:${starter}`);
    }
    return { score, signals };
}

export function detectQuestion(segment) {
    const text = segment && typeof segment.text === "string" ? segment.text : "";
    if (text.trim().length === 0) return null;
    const { score, signals } = scoreQuestion(text);
    if (score <= 0) return null;
    return { detector: DETECTOR_TYPE.QUESTION, score, signals };
}

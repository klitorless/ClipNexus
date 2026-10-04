// ==========================================================
// detectors/reaction.js
// Responsibility: detect strong reaction language.
//
// Reaction is intentionally SEPARATE from hype: a segment
// may trigger both ("what just happened" is in both
// vocabularies), and reconciliation decides what that means
// later. Detectors never suppress each other.
//
// Scoring: each distinct matched phrase counts 1. The
// signals list preserves exactly which phrases matched, in
// vocabulary order.
// ==========================================================

import { findPhrases } from "./text.js";
import { DETECTOR_TYPE } from "./types.js";

export const REACTION_PHRASES = Object.freeze([
    "what?!",
    "no!",
    "oh shit",
    "i can't believe it",
    "are you kidding me",
    "i'm dead",
    "that's crazy",
    "what just happened"
]);

export function scoreReactionPhrases(text) {
    const matched = findPhrases(text, [...REACTION_PHRASES]);
    return {
        score: matched.length,
        signals: matched.map((entry) => entry.phrase)
    };
}

export function detectReaction(segment) {
    const text = segment && typeof segment.text === "string" ? segment.text : "";
    if (text.trim().length === 0) return null;
    const { score, signals } = scoreReactionPhrases(text);
    if (score <= 0) return null;
    return { detector: DETECTOR_TYPE.REACTION, score, signals };
}

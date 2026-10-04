// ==========================================================
// detectors/keyword.js
// Responsibility: user-defined keyword/phrase matching with
// deterministic, explainable rules.
//
//   - case-insensitive
//   - exact phrase matching on word boundaries: "cat" never
//     matches "communication"
//   - multiple keywords; each match is reported
//   - score = total occurrences across all matched keywords
//     ("turbo turbo" scores 2); signals list the distinct
//     matched keywords in configuration order
//
// The same matching infrastructure backs the phrase
// detector; the two remain semantically distinct types.
// ==========================================================

import { findPhrases } from "./text.js";
import { DETECTOR_TYPE } from "./types.js";

export function scoreKeywords(text, keywords) {
    const list = Array.isArray(keywords) ? keywords : [];
    const matched = findPhrases(text, list);
    return {
        score: matched.reduce((sum, entry) => sum + entry.count, 0),
        signals: matched.map((entry) => entry.phrase)
    };
}

export function detectKeyword(segment, keywords) {
    const text = segment && typeof segment.text === "string" ? segment.text : "";
    if (text.trim().length === 0) return null;
    const { score, signals } = scoreKeywords(text, keywords);
    if (score <= 0) return null;
    return { detector: DETECTOR_TYPE.KEYWORD, score, signals };
}

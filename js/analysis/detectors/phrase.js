// ==========================================================
// detectors/phrase.js
// Responsibility: user-defined phrase detection.
//
// Uses the same deterministic matching infrastructure as
// the keyword detector (case-insensitive, word-boundary
// phrase matching via detectors/text.js) but remains a
// semantically distinct detector type: keywords name things
// to find ("BMW", "turbo"), phrases name things people say
// ("watch this", "you won't believe").
//
// Score = total occurrences across matched phrases;
// signals list the distinct matched phrases in
// configuration order.
// ==========================================================

import { scoreKeywords } from "./keyword.js";
import { DETECTOR_TYPE } from "./types.js";

export function detectPhrase(segment, phrases) {
    const text = segment && typeof segment.text === "string" ? segment.text : "";
    if (text.trim().length === 0) return null;
    const { score, signals } = scoreKeywords(text, phrases);
    if (score <= 0) return null;
    return { detector: DETECTOR_TYPE.PHRASE, score, signals };
}

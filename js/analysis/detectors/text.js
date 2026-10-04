// ==========================================================
// detectors/text.js
// Responsibility: shared, deterministic text-matching
// infrastructure for the detector layer. Case-insensitive,
// word-boundary-aware phrase matching with no external
// dependencies.
//
// Rules:
//   - matching is always case-insensitive
//   - phrases match on word boundaries: "cat" never matches
//     "communication"; internal whitespace in a phrase is
//     flexible (tabs, multiple spaces)
//   - all functions are pure and deterministic
// ==========================================================

export function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a case-insensitive RegExp matching the phrase on word
 * boundaries. Lookarounds (not consuming matches) keep adjacent
 * matches countable: "no! no!" finds both.
 */
export function phrasePattern(phrase) {
    const words = String(phrase).trim().split(/\s+/).map(escapeRegExp).join("\\s+");
    return new RegExp(`(?<!\\w)${words}(?!\\w)`, "i");
}

/** Count non-overlapping occurrences of the phrase in the text. */
export function countOccurrences(text, phrase) {
    const source = String(text ?? "");
    if (source.length === 0) return 0;
    const pattern = new RegExp(phrasePattern(phrase).source, "gi");
    let count = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        count += 1;
        // Safety: a zero-width match must still advance.
        if (match[0].length === 0) pattern.lastIndex += 1;
    }
    return count;
}

/**
 * For each phrase (in order), report { phrase, count } when the
 * phrase occurs at least once. Phrases are matched independently;
 * callers decide how to combine them.
 */
export function findPhrases(text, phrases) {
    const found = [];
    for (const phrase of phrases) {
        if (typeof phrase !== "string" || phrase.trim().length === 0) continue;
        const count = countOccurrences(text, phrase);
        if (count > 0) found.push({ phrase: phrase.trim(), count });
    }
    return found;
}

/** Split text into lowercase word tokens (letters/digits/apostrophes). */
export function wordTokens(text) {
    const matches = String(text ?? "").toLowerCase().match(/[a-z0-9']+/g);
    return matches === null ? [] : matches;
}

/** First word token, or null when the text has no words. */
export function firstWord(text) {
    const tokens = wordTokens(text);
    return tokens.length > 0 ? tokens[0] : null;
}

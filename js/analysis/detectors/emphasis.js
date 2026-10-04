// ==========================================================
// detectors/emphasis.js
// Responsibility: detect deterministic linguistic emphasis.
//
// Signals (each worth 2 points):
//   - consecutive repeated words: "no no no",
//     "wait wait wait", "bro bro bro" (case-insensitive;
//     each distinct repeated word reported once)
//   - repeated punctuation: "!!!" or "???" (3+ marks;
//     "!!" alone is not emphasis)
//   - ALL CAPS: at least 2 words, every cased letter
//     uppercase ("OH MY GOD")
//
// Capitalization and punctuation are never REQUIRED:
// normalized/lowercase transcripts simply produce no
// emphasis signal instead of an error.
// ==========================================================

import { DETECTOR_TYPE } from "./types.js";

const EMPHASIS_POINTS = 2;
const MIN_PUNCTUATION_RUN = 3;
const MIN_CAPS_WORDS = 2;

// Maximal runs of the same word back-to-back: "no no no".
// Returns [{ word, count }] with the word in lowercase.
function repeatedWords(text) {
    const pattern = /\b([\p{L}\p{N}']+)\b(?:\s+\1\b)+/giu;
    const runs = [];
    const seen = new Set();
    let match;
    const source = String(text ?? "");
    while ((match = pattern.exec(source)) !== null) {
        const word = match[1].toLowerCase();
        if (seen.has(word)) continue;
        seen.add(word);
        const count = match[0].trim().split(/\s+/).length;
        runs.push({ word, count });
    }
    return runs;
}

// Runs of "!" or "?" of length >= 3. Returns the distinct
// marks found, e.g. ["!", "?"].
function repeatedPunctuation(text) {
    const marks = new Set();
    const pattern = /([!?])\1{2,}/g;
    let match;
    const source = String(text ?? "");
    while ((match = pattern.exec(source)) !== null) {
        marks.add(match[1]);
    }
    return [...marks];
}

// True when the text carries capitalization information and
// every cased letter is uppercase.
function isAllCaps(text) {
    const source = String(text ?? "");
    const cased = source.match(/\p{L}/gu) || [];
    if (cased.length === 0) return false;
    if (source.trim().split(/\s+/).length < MIN_CAPS_WORDS) return false;
    return cased.every((ch) => ch === ch.toUpperCase() && ch !== ch.toLowerCase());
}

export function scoreEmphasis(text) {
    const source = typeof text === "string" ? text : "";
    if (source.trim().length === 0) return { score: 0, signals: [] };
    const signals = [];
    for (const { word, count } of repeatedWords(source)) {
        signals.push(`repeated-word:"${word}"x${count}`);
    }
    for (const mark of repeatedPunctuation(source)) {
        signals.push(`repeated-punctuation:"${mark.repeat(MIN_PUNCTUATION_RUN)}"`);
    }
    if (isAllCaps(source)) {
        signals.push("all-caps");
    }
    return { score: signals.length * EMPHASIS_POINTS, signals };
}

export function detectEmphasis(segment) {
    const text = segment && typeof segment.text === "string" ? segment.text : "";
    const { score, signals } = scoreEmphasis(text);
    if (score <= 0) return null;
    return { detector: DETECTOR_TYPE.EMPHASIS, score, signals };
}

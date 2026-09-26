// ==========================================================
// clock.js  (Stage 5 — shared timestamp-string utility)
// Responsibility: convert clock strings such as "01:02:03.500"
// or "00:01,000" into seconds. Used by the txt/srt/vtt format
// parsers so the three share one deterministic interpretation.
//
// Accepted: H+:MM:SS with an optional .mmm/,mmm fraction, and
// the MM:SS form the WebVTT contract requires. Whitespace around
// the value is tolerated. Anything else -> null (the caller
// marks the timestamp "malformed"; values are never coerced).
// Seconds and minutes must be < 60; hours may exceed 99.
//
// This mirrors the clock-string handling the JSON parser has
// used since Stage 2B (its readValue is JSON-specific and stays
// where it is). The canonical model owns the Timestamp shape;
// this module only derives the seconds number.
// ==========================================================

const clockPattern = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:[.,]\d{1,3})?)$/;

const round = (seconds) => Math.round(seconds * 1e6) / 1e6;

/**
 * Parse a clock string into seconds.
 *
 * @param {*} value  The raw value (usually a string).
 * @returns {number|null} Seconds, or null when not interpretable.
 */
export function clockToSeconds(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    const match = clockPattern.exec(text);
    if (!match) return null;
    const [, hours = "0", minutes, rest] = match;
    const secondsPart = Number(rest.replace(",", "."));
    const minutesValid = match[1] === undefined || Number(minutes) < 60;
    if (secondsPart >= 60 || !minutesValid) return null;
    return round(Number(hours) * 3600 + Number(minutes) * 60 + secondsPart);
}

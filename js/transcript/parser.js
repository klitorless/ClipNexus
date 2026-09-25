// ==========================================================
// parser.js  (PLACEHOLDER — Stage 1)
// Responsibility (future): convert raw transcript text in a
// given format (txt, srt, vtt, json) into normalized segments.
//
// Future normalized segment shape:
// {
//     timestamp: "02:14:37",   // original timestamp string
//     seconds: 8077,           // timestamp converted to seconds
//     speaker: "Streamer",     // null when unknown
//     text: "Example text"
// }
// ==========================================================

/**
 * Parse raw transcript text. NOT IMPLEMENTED in Stage 1.
 *
 * @param {string} rawText - Full file contents.
 * @param {string} format  - "txt" | "srt" | "vtt" | "json".
 * @returns {{ format: string, segments: Array, implemented: boolean, notes: string[] }}
 */
export function parseTranscript(rawText, format) {
    return {
        format: format || "unknown",
        segments: [],
        implemented: false,
        notes: [
            "Parser not implemented yet (Stage 1 placeholder).",
            `Received ${typeof rawText === "string" ? rawText.length : 0} characters.`
        ]
    };
}

// ==========================================================
// validator.js  (PLACEHOLDER — Stage 1)
// Responsibility (future): inspect parsed segments and report
// source-quality problems WITHOUT modifying the transcript.
//
// Future checks:
// - malformed timestamps
// - timestamp gaps
// - timestamp overlaps
// - duplicate timestamps
// - speaker attribution problems
// - timestamp resets
// - missing transcript sections
//
// Future issue shape (suggested):
// { type: "gap", severity: "warning", atSeconds: 1234, message: "..." }
// ==========================================================

/**
 * Validate a parsed transcript. NOT IMPLEMENTED in Stage 1.
 *
 * @param {object} transcript - Output of parseTranscript().
 * @returns {{ valid: boolean, issues: Array }}
 */
export function validateTranscript(transcript) {
    return {
        valid: true,
        issues: []
    };
}

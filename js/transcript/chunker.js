// ==========================================================
// chunker.js  (PLACEHOLDER — Stage 1)
// Responsibility (future): split normalized segments into
// overlapping time windows for analysis, so events that cross
// a window boundary are still seen with context.
//
// Future chunk shape (suggested):
// { index: 0, startSeconds: 0, endSeconds: 600, segments: [...] }
// ==========================================================

export const defaultChunkOptions = {
    windowSeconds: 600,
    overlapSeconds: 60
};

/**
 * Chunk segments into overlapping windows. NOT IMPLEMENTED in Stage 1.
 *
 * @param {Array} segments - Normalized segments from the parser.
 * @param {{ windowSeconds?: number, overlapSeconds?: number }} options
 * @returns {Array} Always an empty array for now.
 */
export function chunkTranscript(segments, options = {}) {
    const config = { ...defaultChunkOptions, ...options };
    void config; // Will be used once chunking is implemented.
    return [];
}

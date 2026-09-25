// ==========================================================
// chunker.js  (PLACEHOLDER — Stage 2)
// Responsibility (future): split normalized segments into
// overlapping time windows for analysis, so events that cross
// a window boundary are still seen with context.
//
// Chunks REFERENCE segments by id; they never copy segment text
// or rawText (memory rule in model.js).
//
// Future chunk shape:
// {
//     id: "chunk-000000",
//     index: 0,
//     startSeconds: 0,
//     endSeconds: 600,
//     overlapStartSeconds: null,   // start of the region shared with previous chunk
//     segmentIds: ["seg-000000", "seg-000001"]
// }
// ==========================================================

export const defaultChunkOptions = Object.freeze({
    windowSeconds: 600,
    overlapSeconds: 60
});

/**
 * Chunk segments into overlapping windows. NOT IMPLEMENTED in Stage 1.5.
 *
 * @param {Array} segments - Canonical segments (read-only).
 * @param {{ windowSeconds?: number, overlapSeconds?: number }} options
 * @returns {Array} Always an empty array for now.
 */
export function chunkTranscript(segments, options = {}) {
    const config = { ...defaultChunkOptions, ...options };
    void config; // Will be used once chunking is implemented.
    return [];
}

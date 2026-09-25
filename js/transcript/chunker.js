// ==========================================================
// chunker.js  (Stage 2C — implemented)
// Responsibility: split a TranscriptDocument's segments into
// deterministic, overlapping time windows for analysis, so
// events that cross a window boundary are still seen with
// context.
//
// Chunks REFERENCE segments by id; they never copy segment text
// or rawText (memory rule in model.js). The source document is
// never mutated: chunkDocument() returns a NEW document with the
// chunks attached as a derived layer (see withDerivedLayer).
//
// Chunk shape:
// {
//     id: "chunk-000000",        // deterministic: zero-padded index
//     transcriptId: "tx-...",    // traceability to the source document
//     index: 0,
//     startSeconds: 0,           // window start (inclusive)
//     endSeconds: 600,           // window end (inclusive)
//     overlapStartSeconds: null, // start of the region shared with the
//                                // previous emitted chunk, or null
//     segmentIds: ["seg-000000"] // in segment order; ids, never indexes
// }
//
// Membership rule: a segment belongs to every chunk whose
// [startSeconds, endSeconds] window contains its effective time.
// Effective time is segment.start.seconds, falling back to the
// previous segment's effective time (then 0) when missing —
// deterministic, order-preserving, and a segment is never split.
// Windows with no segments are dropped, so every emitted chunk
// carries evidence.
// ==========================================================

import { AppError } from "../core/errors.js";
import { deepFreeze, withDerivedLayer } from "./model.js";

export const defaultChunkOptions = Object.freeze({
    windowSeconds: 600,
    overlapSeconds: 60
});

function createChunkId(index) {
    return `chunk-${String(index).padStart(6, "0")}`;
}

function assertTranscriptDocument(document) {
    if (!document || typeof document !== "object" ||
            typeof document.id !== "string" || !Array.isArray(document.segments)) {
        throw new AppError("invalid_transcript_document",
            "Chunking needs a TranscriptDocument.", {});
    }
    return document;
}

function readOptions(options) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new AppError("invalid_chunk_options",
            "Chunk options must be an object.", { options });
    }
    const {
        windowSeconds = defaultChunkOptions.windowSeconds,
        overlapSeconds = defaultChunkOptions.overlapSeconds
    } = options;
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
        throw new AppError("invalid_chunk_options",
            "windowSeconds must be a positive number.", { windowSeconds });
    }
    if (!Number.isFinite(overlapSeconds) || overlapSeconds < 0) {
        throw new AppError("invalid_chunk_options",
            "overlapSeconds must be a non-negative number.", { overlapSeconds });
    }
    if (overlapSeconds >= windowSeconds) {
        throw new AppError("invalid_chunk_options",
            "overlapSeconds must be smaller than windowSeconds.",
            { windowSeconds, overlapSeconds });
    }
    return { windowSeconds, overlapSeconds };
}

// Effective time for window assignment: segment.start.seconds when
// known, otherwise the previous segment's effective time (then 0).
// Deterministic and preserves source order; a segment is never split.
function effectiveTimes(segments) {
    const times = new Array(segments.length);
    let last = 0;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const seconds = segment && segment.start ? segment.start.seconds : null;
        if (typeof seconds === "number" && Number.isFinite(seconds)) last = seconds;
        times[i] = last;
    }
    return times;
}

/**
 * Split a TranscriptDocument's segments into deterministic,
 * overlapping time windows. The document is not modified.
 *
 * @param {object} document - Frozen TranscriptDocument.
 * @param {{ windowSeconds?: number, overlapSeconds?: number }} [options]
 * @returns {Array} Frozen chunk objects (possibly empty).
 */
export function chunkTranscript(document, options = {}) {
    assertTranscriptDocument(document);
    const { windowSeconds, overlapSeconds } = readOptions(options);
    const segments = document.segments;
    if (segments.length === 0) return [];

    const times = effectiveTimes(segments);
    const stride = windowSeconds - overlapSeconds;
    let maxTime = times[0];
    for (let i = 1; i < times.length; i++) {
        if (times[i] > maxTime) maxTime = times[i];
    }
    const windowCount = Math.floor(maxTime / stride) + 1;

    const chunks = [];
    let previous = null;
    for (let w = 0; w < windowCount; w++) {
        const startSeconds = w * stride;
        const endSeconds = startSeconds + windowSeconds;
        const segmentIds = [];
        for (let s = 0; s < segments.length; s++) {
            if (times[s] >= startSeconds && times[s] <= endSeconds) {
                segmentIds.push(segments[s].id);
            }
        }
        if (segmentIds.length === 0) continue; // drop empty windows
        const index = chunks.length;
        // Region shared with the previous emitted chunk, if any.
        let overlapStartSeconds = null;
        if (previous) {
            const sharedStart = Math.max(startSeconds, previous.startSeconds);
            const sharedEnd = Math.min(endSeconds, previous.endSeconds);
            if (sharedStart < sharedEnd) overlapStartSeconds = sharedStart;
        }
        const chunk = {
            id: createChunkId(index),
            transcriptId: document.id,
            index,
            startSeconds,
            endSeconds,
            overlapStartSeconds,
            segmentIds
        };
        chunks.push(deepFreeze(chunk));
        previous = chunk;
    }
    return Object.freeze(chunks);
}

/**
 * Return a NEW TranscriptDocument with Stage 2C chunks attached as
 * a derived layer. The input document is untouched; rawText and
 * segments are shared by reference.
 */
export function chunkDocument(document, options = {}) {
    const chunks = chunkTranscript(document, options);
    return deepFreeze(withDerivedLayer(document, {
        chunks,
        processing: { chunked: true }
    }));
}

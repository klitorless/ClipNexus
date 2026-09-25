// ==========================================================
// export.js  (Stage 2C — implemented)
// Responsibility: deterministic serialization of a
// TranscriptDocument (transcript export) and of its chunk
// manifest (chunk export).
//
// Only formats the architecture actually supports are
// implemented: JSON round-trips through formats/json.js, so it
// is the one export target. Anything else throws
// AppError("export_not_supported") — export formats are never
// invented here.
//
// Exports never mutate the source document and never embed
// volatile data (no exportedAt): the same document always
// produces the same string.
// ==========================================================

import { AppError } from "../core/errors.js";

export const EXPORT_FORMATS = Object.freeze(["json"]);

function assertTranscriptDocument(document) {
    if (!document || typeof document !== "object" ||
            typeof document.id !== "string" || !Array.isArray(document.segments)) {
        throw new AppError("invalid_transcript_document",
            "Export needs a TranscriptDocument.", {});
    }
    return document;
}

function assertSupportedFormat(formatId) {
    if (!EXPORT_FORMATS.includes(formatId)) {
        throw new AppError("export_not_supported",
            `Transcript export to "${formatId}" is not supported.`, { formatId });
    }
}

// Canonical JSON record for one segment. Key order is fixed;
// fields are omitted (never nulled) when the source has no value,
// so the output stays deterministic and re-parses cleanly.
function toExportRecord(segment) {
    const record = { text: segment.text };
    if (segment.start && Number.isFinite(segment.start.seconds)) {
        record.start = segment.start.seconds;
    }
    if (segment.end && Number.isFinite(segment.end.seconds)) {
        record.end = segment.end.seconds;
    }
    const speaker = segment.speaker ? segment.speaker.value : null;
    if (typeof speaker === "string" && speaker.length > 0) {
        record.speaker = speaker;
    }
    return record;
}

/**
 * Serialize a TranscriptDocument's segments to a string.
 * JSON output re-parses through formats/json.js with identical
 * segment order, text, timestamps, speakers, and (index-
 * deterministic) segment ids.
 *
 * @param {object} document - TranscriptDocument (not modified).
 * @param {string} [formatId="json"]
 * @returns {string} Deterministic serialized transcript.
 */
export function exportTranscript(document, formatId = "json") {
    assertTranscriptDocument(document);
    assertSupportedFormat(formatId);
    const payload = {
        transcriptId: document.id,
        format: "json",
        segments: document.segments.map(toExportRecord)
    };
    return JSON.stringify(payload, null, 2);
}

/**
 * Serialize a TranscriptDocument's chunk manifest to a string.
 * Every chunk stays traceable to its source document via
 * transcriptId, and segment membership is fully reconstructible
 * from segmentIds.
 *
 * @param {object} document - TranscriptDocument (not modified).
 * @param {string} [formatId="json"]
 * @returns {string} Deterministic serialized chunk manifest.
 */
export function exportChunks(document, formatId = "json") {
    assertTranscriptDocument(document);
    assertSupportedFormat(formatId);
    const payload = {
        transcriptId: document.id,
        chunks: (document.chunks || []).map((chunk) => ({
            id: chunk.id,
            index: chunk.index,
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
            overlapStartSeconds: chunk.overlapStartSeconds,
            segmentIds: [...chunk.segmentIds]
        }))
    };
    return JSON.stringify(payload, null, 2);
}

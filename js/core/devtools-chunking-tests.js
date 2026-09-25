// ==========================================================
// devtools-chunking-tests.js
// Responsibility: Stage 2C self-tests — deterministic
// transcript chunking (js/transcript/chunker.js) and
// deterministic export (js/transcript/export.js).
// Registered by devtools.js via addChunkingTests(add).
//
// Deterministic: no network, no AI, no timers. Real
// TranscriptDocuments come from the shared pipeline
// (only the JSON format parser is implemented, Stage 2B).
// ==========================================================

import { chunkTranscript, chunkDocument, defaultChunkOptions } from "../transcript/chunker.js";
import { exportTranscript, exportChunks } from "../transcript/export.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";
import { createAnalysisRequest } from "../analysis/contracts.js";
import { AppError } from "./errors.js";

function docFromRecords(records, filename = "vod.json") {
    const rawText = JSON.stringify(records);
    return buildTranscriptDocument({
        rawText, format: "json", filename,
        size: rawText.length, acquisition: createFileAcquisition()
    });
}

function throwsAppError(action) {
    try { action(); return false; } catch (error) { return error instanceof AppError; }
}

function throwsTypeError(action) {
    try { action(); return false; } catch (error) { return error instanceof TypeError; }
}

function segmentIds(document) {
    return document.segments.map((segment) => segment.id);
}

export function addChunkingTests(add) {

    // ---------- Deterministic chunking ----------

    add("chunking: same document chunked twice gives identical chunks", () => {
        const document = docFromRecords([
            { start: 0, end: 5, text: "one" },
            { start: 300, end: 305, text: "two" },
            { start: 700, end: 705, text: "three" },
            { start: 1300, end: 1305, text: "four" }
        ]);
        const first = chunkTranscript(document, { windowSeconds: 600, overlapSeconds: 60 });
        const second = chunkTranscript(document, { windowSeconds: 600, overlapSeconds: 60 });
        return JSON.stringify(first) === JSON.stringify(second) && first.length === 3 &&
            first[0].id === "chunk-000000" && first[1].id === "chunk-000001" &&
            first[2].id === "chunk-000002";
    });

    add("chunking: uses default window options when none are given", () => {
        const document = docFromRecords([{ start: 0, text: "one" }]);
        const [chunk] = chunkTranscript(document);
        return chunk.startSeconds === 0 &&
            chunk.endSeconds === defaultChunkOptions.windowSeconds &&
            chunk.overlapStartSeconds === null;
    });

    // ---------- Empty / single-segment transcripts ----------

    add("chunking: empty transcript yields no chunks", () => {
        const document = docFromRecords([]);
        const chunks = chunkTranscript(document);
        return Array.isArray(chunks) && chunks.length === 0 &&
            chunkDocument(document).chunks.length === 0;
    });

    add("chunking: single segment yields exactly one chunk", () => {
        const document = docFromRecords([{ start: 10, end: 12, text: "only" }]);
        const chunks = chunkTranscript(document);
        return chunks.length === 1 && chunks[0].index === 0 &&
            chunks[0].id === "chunk-000000" &&
            chunks[0].segmentIds.length === 1 &&
            chunks[0].segmentIds[0] === document.segments[0].id &&
            chunks[0].overlapStartSeconds === null;
    });

    // ---------- Multiple chunks / boundaries ----------

    add("chunking: segments spread over time yield multiple overlapping chunks", () => {
        const document = docFromRecords([
            { start: 0, text: "a" },
            { start: 300, text: "b" },
            { start: 700, text: "c" },
            { start: 1300, text: "d" }
        ]);
        const chunks = chunkTranscript(document, { windowSeconds: 600, overlapSeconds: 60 });
        const ids = segmentIds(document);
        return chunks.length === 3 &&
            // chunk 0: [0, 600] -> a, b
            chunks[0].segmentIds.join() === [ids[0], ids[1]].join() &&
            chunks[0].startSeconds === 0 && chunks[0].endSeconds === 600 &&
            // chunk 1: [540, 1140] -> c ; shares [540, 600] with chunk 0
            chunks[1].segmentIds.join() === [ids[2]].join() &&
            chunks[1].overlapStartSeconds === 540 &&
            // chunk 2: [1080, 1740] -> d ; shares [1080, 1140] with chunk 1
            chunks[2].segmentIds.join() === [ids[3]].join() &&
            chunks[2].overlapStartSeconds === 1080;
    });

    add("chunking: segment exactly on a window boundary belongs to both chunks", () => {
        const document = docFromRecords([
            { start: 0, text: "a" },
            { start: 600, text: "edge" }
        ]);
        const chunks = chunkTranscript(document, { windowSeconds: 600, overlapSeconds: 60 });
        const edgeId = document.segments[1].id;
        return chunks.length === 2 &&
            chunks[0].segmentIds.includes(edgeId) &&
            chunks[1].segmentIds.includes(edgeId);
    });

    add("chunking: a segment is never split across chunks", () => {
        const document = docFromRecords([
            { start: 0, end: 900, text: "long" },
            { start: 650, end: 660, text: "mid" }
        ]);
        const chunks = chunkTranscript(document, { windowSeconds: 600, overlapSeconds: 60 });
        // The long segment (effective time 0) appears whole in chunk 0 only;
        // it is referenced by id, never divided.
        const longId = document.segments[0].id;
        return chunks[0].segmentIds.includes(longId) &&
            !chunks[1].segmentIds.includes(longId) &&
            chunks[1].segmentIds.join() === [document.segments[1].id].join();
    });

    // ---------- Identity / timestamps / ordering ----------

    add("chunking: segment ids are preserved, never array indexes", () => {
        const document = docFromRecords([
            { start: 5, text: "a" },
            { start: 700, text: "b" }
        ]);
        const chunks = chunkTranscript(document, { windowSeconds: 600, overlapSeconds: 60 });
        const known = new Set(segmentIds(document));
        return chunks.every((chunk) =>
            chunk.segmentIds.every((id) => typeof id === "string" && known.has(id)));
    });

    add("chunking: segment order is preserved inside each chunk", () => {
        const document = docFromRecords([
            { start: 10, text: "a" },
            { start: 20, text: "b" },
            { start: 30, text: "c" }
        ]);
        const [chunk] = chunkTranscript(document);
        const ids = segmentIds(document);
        return chunk.segmentIds.join() === ids.join();
    });

    add("chunking: segments without timestamps attach deterministically by order", () => {
        const records = [
            { start: 10, text: "timed" },
            { text: "untimed" },
            { start: 700, text: "later" }
        ];
        const document = docFromRecords(records);
        const first = chunkTranscript(document, { windowSeconds: 600, overlapSeconds: 60 });
        const second = chunkTranscript(document, { windowSeconds: 600, overlapSeconds: 60 });
        // "untimed" falls back to the previous segment's time (10) -> chunk 0.
        return JSON.stringify(first) === JSON.stringify(second) &&
            first.length === 2 &&
            first[0].segmentIds.length === 2 &&
            first[1].segmentIds.length === 1;
    });

    // ---------- Immutability ----------

    add("chunking: chunkDocument does not mutate the source document", () => {
        const document = docFromRecords([
            { start: 0, text: "a" },
            { start: 700, text: "b" }
        ]);
        const before = JSON.stringify(document);
        const next = chunkDocument(document);
        return JSON.stringify(document) === before &&
            document.chunks.length === 0 &&
            document.processing.chunked === false &&
            next !== document &&
            next.chunks.length === 2 &&
            next.processing.chunked === true &&
            next.rawText === document.rawText &&
            next.segments === document.segments && // shared by reference
            throwsTypeError(() => { next.chunks.push({}); }) &&
            throwsTypeError(() => { next.chunks[0].segmentIds.push("x"); });
    });

    // ---------- Invalid input ----------

    add("chunking: invalid options are rejected", () =>
        throwsAppError(() => chunkTranscript(docFromRecords([{ text: "a" }]), { windowSeconds: 0 })) &&
        throwsAppError(() => chunkTranscript(docFromRecords([{ text: "a" }]), { windowSeconds: -5 })) &&
        throwsAppError(() => chunkTranscript(docFromRecords([{ text: "a" }]), { overlapSeconds: -1 })) &&
        throwsAppError(() => chunkTranscript(docFromRecords([{ text: "a" }]),
            { windowSeconds: 600, overlapSeconds: 600 })) &&
        throwsAppError(() => chunkTranscript(docFromRecords([{ text: "a" }]), null)));

    add("chunking: invalid documents are rejected", () =>
        throwsAppError(() => chunkTranscript(null)) &&
        throwsAppError(() => chunkTranscript({})) &&
        throwsAppError(() => chunkDocument(null)));

    // ---------- Traceability / Stage 3 relationship ----------

    add("chunking: every chunk traces back to its source document", () => {
        const document = chunkDocument(docFromRecords([
            { start: 0, text: "a" },
            { start: 700, text: "b" }
        ]));
        const known = new Set(segmentIds(document));
        return document.chunks.every((chunk) =>
            chunk.transcriptId === document.id &&
            chunk.segmentIds.length > 0 &&
            chunk.segmentIds.every((id) => known.has(id)));
    });

    add("chunking: chunk ids populate the Stage 3 chunkId relationship", () => {
        const document = chunkDocument(docFromRecords([
            { start: 0, text: "a" },
            { start: 700, text: "b" }
        ]));
        const request = createAnalysisRequest({
            transcriptId: document.id,
            scope: { type: "full" },
            chunkId: document.chunks[0].id
        });
        return request.chunkId === document.chunks[0].id &&
            request.chunkId === "chunk-000000";
    });

    // ---------- Export ----------

    add("export: transcript export is deterministic", () => {
        const document = docFromRecords([
            { start: 1.5, end: 3.5, speaker: "Streamer", text: "héllo" },
            { start: 10, text: "plain" }
        ]);
        return exportTranscript(document) === exportTranscript(document);
    });

    add("export: json export round-trips through the parser", () => {
        const document = docFromRecords([
            { start: 1.5, end: 3.5, speaker: "Streamer", text: "héllo" },
            { start: 10, text: "plain" },
            { text: "no time" }
        ]);
        const exported = exportTranscript(document);
        const reparsed = buildTranscriptDocument({
            rawText: exported, format: "json", filename: "export.json",
            size: exported.length, acquisition: createFileAcquisition()
        });
        if (reparsed.segments.length !== document.segments.length) return false;
        return reparsed.segments.every((segment, i) => {
            const original = document.segments[i];
            return segment.id === original.id && // index-deterministic ids survive
                segment.text === original.text &&
                (segment.start.seconds === original.start.seconds) &&
                (segment.end.seconds === original.end.seconds) &&
                ((segment.speaker.value || null) === (original.speaker.value || null));
        });
    });

    add("export: unsupported formats are rejected, not invented", () =>
        throwsAppError(() => exportTranscript(docFromRecords([{ text: "a" }]), "srt")) &&
        throwsAppError(() => exportTranscript(docFromRecords([{ text: "a" }]), "vtt")) &&
        throwsAppError(() => exportTranscript(docFromRecords([{ text: "a" }]), "txt")) &&
        throwsAppError(() => exportChunks(docFromRecords([{ text: "a" }]), "srt")));

    add("export: chunk manifest export is deterministic and traceable", () => {
        const document = chunkDocument(docFromRecords([
            { start: 0, text: "a" },
            { start: 700, text: "b" }
        ]));
        const first = exportChunks(document);
        const second = exportChunks(document);
        const manifest = JSON.parse(first);
        return first === second &&
            manifest.transcriptId === document.id &&
            manifest.chunks.length === document.chunks.length &&
            manifest.chunks[0].id === document.chunks[0].id &&
            manifest.chunks[0].segmentIds.join() === document.chunks[0].segmentIds.join();
    });

    add("export: unchunked document exports an empty chunk manifest", () => {
        const document = docFromRecords([{ start: 0, text: "a" }]);
        const manifest = JSON.parse(exportChunks(document));
        return manifest.transcriptId === document.id &&
            Array.isArray(manifest.chunks) && manifest.chunks.length === 0;
    });

    add("export: exporting does not mutate the document", () => {
        const document = chunkDocument(docFromRecords([{ start: 1, text: "a" }]));
        const before = JSON.stringify(document);
        exportTranscript(document);
        exportChunks(document);
        return JSON.stringify(document) === before;
    });
}

// ==========================================================
// devtools-stage6-tests.js
// Stage 6: semantic temporal validation — deterministic
// ordering/reset/overlap/end-before-start checks over the
// canonical TranscriptDocument, observe-only, no cascading
// false findings from missing/malformed timestamps.
// ==========================================================

import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { validateTranscript, ISSUE_TYPES } from "../transcript/validator.js";
import { chunkDocument } from "../transcript/chunker.js";
import { createFileAcquisition, TIMESTAMP_STATUS } from "../transcript/model.js";
import { createAnalyzer } from "../analysis/analyzer.js";
import { createAnalysisRequest } from "../analysis/contracts.js";
import { createQuestionExtractor } from "../analysis/deterministic-extractor.js";

export function addStage6Tests(add) {

    function docFromRecords(records, filename = "vod.json") {
        const rawText = JSON.stringify(records);
        return buildTranscriptDocument({
            rawText, format: "json", filename,
            size: rawText.length, acquisition: createFileAcquisition()
        });
    }

    function docFromText(rawText, format, filename = `sample.${format}`) {
        return buildTranscriptDocument({
            rawText, format, filename,
            size: rawText.length, acquisition: createFileAcquisition()
        });
    }

    const temporalTypes = new Set([
        ISSUE_TYPES.TIMESTAMP_RESET,
        ISSUE_TYPES.TIMESTAMP_OVERLAP,
        ISSUE_TYPES.ORDER_SUSPICIOUS
    ]);
    const temporalIssues = (report) =>
        report.issues.filter((issue) => temporalTypes.has(issue.type) ||
            (issue.type === ISSUE_TYPES.QUALITY_CONCERN && /ends at .* before it starts/.test(issue.message)));
    const byType = (report, type) => report.issues.filter((issue) => issue.type === type);

    // ---------- Ordering ----------

    add("stage6: increasing timestamps produce no temporal issues", () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "a" },
            { start: 30, end: 40, text: "b" },
            { start: 50, end: 60, text: "c" }
        ]);
        return doc.validation.issues.length === 0 && doc.validation.valid === true;
    });

    add("stage6: backward timestamp is reported (spec example 00:30 → 00:20)", () => {
        const doc = docFromRecords([
            { start: 30, end: 35, text: "a" },
            { start: 20, end: 25, text: "b" }
        ]);
        const resets = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_RESET);
        return doc.validation.valid === true && resets.length === 1 &&
            resets[0].severity === "warning" &&
            JSON.stringify(resets[0].segmentIds) === JSON.stringify(["seg-000000", "seg-000001"]);
    });

    add("stage6: local backward move is order_suspicious, not reset", () => {
        const doc = docFromRecords([
            { start: 30, end: 35, text: "a" },
            { start: 50, end: 55, text: "b" },
            { start: 40, end: 45, text: "c" }
        ]);
        const orders = byType(doc.validation, ISSUE_TYPES.ORDER_SUSPICIOUS);
        const resets = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_RESET);
        return orders.length === 1 && resets.length === 0 &&
            JSON.stringify(orders[0].segmentIds) === JSON.stringify(["seg-000001", "seg-000002"]);
    });

    add("stage6: multiple backward timestamps each reported", () => {
        const doc = docFromRecords([
            { start: 50, end: 55, text: "a" },
            { start: 40, end: 45, text: "b" },
            { start: 30, end: 35, text: "c" }
        ]);
        const resets = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_RESET);
        return resets.length === 2 && doc.validation.valid === true;
    });

    add("stage6: reset and local backward are distinguished in one document", () => {
        const doc = docFromRecords([
            { start: 30, end: 35, text: "a" },
            { start: 50, end: 55, text: "b" },
            { start: 40, end: 45, text: "c" },
            { start: 10, end: 15, text: "d" }
        ]);
        const orders = byType(doc.validation, ISSUE_TYPES.ORDER_SUSPICIOUS);
        const resets = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_RESET);
        return orders.length === 1 && resets.length === 1 &&
            JSON.stringify(resets[0].segmentIds) === JSON.stringify(["seg-000002", "seg-000003"]);
    });

    // ---------- Reset semantics ----------

    add("stage6: reset language is factual, never speculative", () => {
        const doc = docFromRecords([
            { start: 30, end: 35, text: "a" },
            { start: 20, end: 25, text: "b" }
        ]);
        const message = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_RESET)[0].message;
        return message.includes("earlier than every preceding valid segment start") &&
            !/corrupt|failure|restart|stream|parser error/i.test(message);
    });

    // ---------- Overlap ----------

    add("stage6: genuine overlap is detected with segment ids", () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "a" },
            { start: 15, end: 25, text: "b" }
        ]);
        const overlaps = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_OVERLAP);
        return overlaps.length === 1 && overlaps[0].severity === "warning" &&
            JSON.stringify(overlaps[0].segmentIds) === JSON.stringify(["seg-000000", "seg-000001"]) &&
            overlaps[0].startSeconds === 15 && overlaps[0].endSeconds === 20 &&
            doc.validation.valid === true;
    });

    add("stage6: multiple overlaps each reported once", () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "a" },
            { start: 15, end: 25, text: "b" },
            { start: 18, end: 30, text: "c" }
        ]);
        return byType(doc.validation, ISSUE_TYPES.TIMESTAMP_OVERLAP).length === 2;
    });

    add("stage6: exact boundary touch is not overlap", () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "a" },
            { start: 20, end: 30, text: "b" }
        ]);
        return doc.validation.issues.length === 0;
    });

    add("stage6: missing end does not create overlap", () => {
        const doc = docFromRecords([
            { start: 10, text: "a" },
            { start: 15, end: 25, text: "b" }
        ]);
        return byType(doc.validation, ISSUE_TYPES.TIMESTAMP_OVERLAP).length === 0 &&
            doc.validation.valid === true;
    });

    add("stage6: inverted interval cannot establish overlap", () => {
        const doc = docFromRecords([
            { start: 20, end: 15, text: "a" },
            { start: 16, end: 25, text: "b" }
        ]);
        const endFirst = doc.validation.issues.find((issue) =>
            issue.type === ISSUE_TYPES.QUALITY_CONCERN && /before it starts/.test(issue.message));
        return !!endFirst &&
            byType(doc.validation, ISSUE_TYPES.TIMESTAMP_OVERLAP).length === 0;
    });

    // ---------- End validation ----------

    add("stage6: end before start is reported, never repaired", () => {
        const doc = docFromRecords([{ start: 20, end: 15, text: "a" }]);
        const found = doc.validation.issues.find((issue) =>
            issue.type === ISSUE_TYPES.QUALITY_CONCERN && /before it starts/.test(issue.message));
        return doc.validation.valid === true && !!found && found.severity === "warning" &&
            found.segmentIds[0] === "seg-000000" &&
            doc.segments[0].start.seconds === 20 && doc.segments[0].end.seconds === 15;
    });

    add("stage6: zero-length segments are valid", () => {
        const doc = docFromRecords([{ start: 10, end: 10, text: "instant" }]);
        return doc.validation.issues.length === 0 && doc.validation.valid === true;
    });

    add("stage6: missing end is not an end-before-start error", () => {
        const doc = docFromRecords([{ start: 10, text: "a" }]);
        const bad = doc.validation.issues.filter((issue) =>
            issue.type === ISSUE_TYPES.QUALITY_CONCERN);
        return bad.length === 0 && doc.validation.valid === true;
    });

    // ---------- Timestamp states ----------

    add("stage6: missing timestamps produce no temporal findings", () => {
        const doc = docFromRecords([{ text: "a" }, { text: "b" }, { text: "c" }]);
        return temporalIssues(doc.validation).length === 0 && doc.validation.valid === true;
    });

    add("stage6: malformed timestamps produce no temporal findings", () => {
        const doc = docFromRecords([
            { start: "bogus", end: 5, text: "a" },
            { start: 20, end: 25, text: "b" }
        ]);
        const malformed = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_MALFORMED);
        return malformed.length === 1 && temporalIssues(doc.validation).length === 0 &&
            doc.validation.valid === true;
    });

    add("stage6: malformed segment does not cascade false findings", () => {
        const doc = docFromRecords([
            { start: 10, end: 12, text: "a" },
            { start: "bogus", end: 14, text: "b" },
            { start: 20, end: 22, text: "c" },
            { start: 15, end: 17, text: "d" }
        ]);
        const temporal = temporalIssues(doc.validation);
        const mentionsBad = doc.validation.issues.some((issue) =>
            (issue.segmentIds || []).includes("seg-000001") &&
            (temporalTypes.has(issue.type) || /before it starts/.test(issue.message)));
        // C and D are both valid, so their backward move IS a real finding.
        return temporal.length === 1 &&
            temporal[0].type === ISSUE_TYPES.ORDER_SUSPICIOUS &&
            JSON.stringify(temporal[0].segmentIds) === JSON.stringify(["seg-000002", "seg-000003"]) &&
            mentionsBad === false;
    });

    add("stage6: missing segment between valid ones does not cascade", () => {
        const doc = docFromRecords([
            { start: 10, end: 12, text: "a" },
            { text: "unknown time" },
            { start: 20, end: 22, text: "c" }
        ]);
        return temporalIssues(doc.validation).length === 0 && doc.validation.valid === true;
    });

    // ---------- Traceability ----------

    add("stage6: temporal issues reference canonical segment ids", () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "a" },
            { start: 15, end: 25, text: "b" },
            { start: 40, end: 35, text: "c" }
        ]);
        const temporal = temporalIssues(doc.validation);
        return temporal.length > 0 && temporal.every((issue) =>
            Array.isArray(issue.segmentIds) && issue.segmentIds.length > 0 &&
            issue.segmentIds.every((id) => /^seg-\d{6}$/.test(id)));
    });

    // ---------- Immutability ----------

    add("stage6: temporal validation does not mutate the document", () => {
        const doc = docFromRecords([
            { start: 30, end: 35, text: "a" },
            { start: 20, end: 15, text: "b" },
            { start: 22, end: 40, text: "c" }
        ]);
        const before = JSON.stringify(doc);
        validateTranscript(doc);
        return JSON.stringify(doc) === before;
    });

    // ---------- Determinism ----------

    add("stage6: repeated validation produces identical results", () => {
        const doc = docFromRecords([
            { start: 30, end: 35, text: "a" },
            { start: 20, end: 25, text: "b" },
            { start: 22, end: 40, text: "c" },
            { start: "bogus", end: 45, text: "d" }
        ]);
        const first = validateTranscript(doc);
        const second = validateTranscript(doc);
        return JSON.stringify(first.issues) === JSON.stringify(second.issues) &&
            first.valid === second.valid && first.status === second.status &&
            JSON.stringify(first.checks) === JSON.stringify(second.checks);
    });

    // ---------- Cross-format ----------

    function findingsFingerprint(doc) {
        return JSON.stringify(doc.validation.issues.map((issue) =>
            [issue.type, ...(issue.segmentIds || [])]));
    }

    add("stage6: equivalent srt and vtt fixtures produce equivalent findings", () => {
        const srt = docFromText(
            "1\n00:00:30,000 --> 00:00:35,000\nfirst\n\n" +
            "2\n00:00:20,000 --> 00:00:25,000\nsecond\n\n" +
            "3\n00:00:22,000 --> 00:00:40,000\nthird\n", "srt");
        const vtt = docFromText(
            "WEBVTT\n\n00:00:30.000 --> 00:00:35.000\nfirst\n\n" +
            "00:00:20.000 --> 00:00:25.000\nsecond\n\n" +
            "00:00:22.000 --> 00:00:40.000\nthird\n", "vtt");
        const expected = JSON.stringify([
            [ISSUE_TYPES.TIMESTAMP_RESET, "seg-000000", "seg-000001"],
            [ISSUE_TYPES.TIMESTAMP_OVERLAP, "seg-000001", "seg-000002"]
        ]);
        return srt.validation.valid === true && vtt.validation.valid === true &&
            findingsFingerprint(srt) === expected &&
            findingsFingerprint(vtt) === expected;
    });

    // ---------- Integration ----------

    add("stage6: temporal findings flow through the pipeline validation layer", () => {
        const doc = docFromText(
            "1\n00:00:10,000 --> 00:00:20,000\nfirst\n\n" +
            "2\n00:00:15,000 --> 00:00:25,000\nsecond\n", "srt");
        const overlaps = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_OVERLAP);
        return doc.validation.valid === true && overlaps.length === 1 &&
            doc.processing.validated === true;
    });

    add("stage6: analysis still works on a transcript with temporal issues", async () => {
        const doc = chunkDocument(docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 15, end: 25, text: "second" }
        ]));
        if (byType(doc.validation, ISSUE_TYPES.TIMESTAMP_OVERLAP).length !== 1) return false;
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({ transcriptId: doc.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, doc);
        return result.evidence.length === 1 &&
            result.evidence[0].sourceRef.segmentIds[0] === "seg-000000";
    });

    add("stage6: derived timestamps participate in temporal checks", () => {
        // JSON end = start + duration is marked "derived" and must count
        // as a valid numeric timestamp.
        const doc = docFromRecords([
            { start: 10, duration: 15, text: "a" },
            { start: 30, end: 40, text: "b" }
        ]);
        const seg = doc.segments[0];
        if (seg.end.status !== TIMESTAMP_STATUS.DERIVED || seg.end.seconds !== 25) return false;
        // 10→25 then 30→40: forward, no overlap, no findings.
        return doc.validation.issues.length === 0;
    });

    add("stage6: derived end overlapping the next segment is detected", () => {
        const doc = docFromRecords([
            { start: 10, duration: 15, text: "a" },
            { start: 20, end: 30, text: "b" }
        ]);
        const overlaps = byType(doc.validation, ISSUE_TYPES.TIMESTAMP_OVERLAP);
        return overlaps.length === 1 && overlaps[0].startSeconds === 20 &&
            overlaps[0].endSeconds === 25;
    });
}

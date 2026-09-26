// ==========================================================
// devtools-stage5-tests.js
// Stage 5: transcript format parser completion — TXT, SRT, and
// VTT parsers producing canonical TranscriptDocuments through
// the existing parser architecture, plus downstream
// verification (validate -> chunk -> export -> analysis).
//
// Conventions: determinism is checked by comparing semantic
// structure (segment ids, texts, timestamps), never the random
// document id. Malformed input must fail predictably or leave a
// validator-visible condition — never silently become a clean
// transcript.
// ==========================================================

import { parse as parseTxt } from "../transcript/formats/txt.js";
import { parse as parseSrt } from "../transcript/formats/srt.js";
import { parse as parseVtt } from "../transcript/formats/vtt.js";
import { clockToSeconds } from "../transcript/clock.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { validateTranscript, ISSUE_TYPES } from "../transcript/validator.js";
import { chunkDocument } from "../transcript/chunker.js";
import { exportTranscript } from "../transcript/export.js";
import { createFileAcquisition, TRANSCRIPT_SCHEMA_VERSION } from "../transcript/model.js";
import { createAnalyzer } from "../analysis/analyzer.js";
import { createAnalysisRequest } from "../analysis/contracts.js";
import { createQuestionExtractor } from "../analysis/deterministic-extractor.js";

function docFromText(rawText, format, filename = `sample.${format}`) {
    return buildTranscriptDocument({
        rawText, format, filename,
        size: rawText.length, acquisition: createFileAcquisition()
    });
}

// Semantic fingerprint of a parse result: ids, text, timestamps,
// speakers — everything deterministic, excluding random doc ids.
function fingerprint(result) {
    return JSON.stringify(result.segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        start: segment.start,
        end: segment.end,
        speaker: segment.speaker,
        cueId: segment.source.cueId,
        sequence: segment.source.sequence
    })));
}

export function addStage5Tests(add) {

    // ---------- clock.js ----------

    add("stage5: clockToSeconds parses HH:MM:SS,mmm", () =>
        clockToSeconds("00:00:01,000") === 1 && clockToSeconds("01:02:03.500") === 3723.5);

    add("stage5: clockToSeconds parses MM:SS.mmm (VTT form)", () =>
        clockToSeconds("00:01.000") === 1 && clockToSeconds("10:00") === 600);

    add("stage5: clockToSeconds tolerates surrounding whitespace", () =>
        clockToSeconds("  00:00:02,000  ") === 2);

    add("stage5: clockToSeconds rejects uninterpretable values", () =>
        clockToSeconds("garbage") === null && clockToSeconds("99:99:99,000") === null &&
        clockToSeconds("00:00:61,000") === null && clockToSeconds("") === null &&
        clockToSeconds(null) === null && clockToSeconds(12) === null);

    // ---------- TXT ----------

    add("stage5: txt parses plain multiline text without timestamps", () => {
        const result = parseTxt("Hello everyone.\n\nToday we're going to talk about...\n");
        if (result.status !== "complete" || result.segments.length !== 2) return false;
        const [first, second] = result.segments;
        return first.text === "Hello everyone." && second.text === "Today we're going to talk about..." &&
            first.start.status === "missing" && first.start.seconds === null &&
            first.end.status === "missing" &&
            first.speaker.source === "unknown" && second.speaker.source === "unknown";
    });

    add("stage5: txt parses bracket and bare timestamp prefixes", () => {
        const result = parseTxt("[00:00:01] hi\n02:14:37 hello\n");
        if (result.status !== "complete" || result.segments.length !== 2) return false;
        const [first, second] = result.segments;
        return first.start.raw === "[00:00:01]" && first.start.seconds === 1 && first.start.status === "parsed" &&
            first.text === "hi" &&
            second.start.raw === "02:14:37" && second.start.seconds === 8077 && second.text === "hello" &&
            first.end.status === "missing" && second.end.status === "missing";
    });

    add("stage5: txt recognizes unambiguous speaker labels", () => {
        const result = parseTxt("Oda: What's going on?\nDanny: Nothing much.\n");
        if (result.status !== "complete" || result.segments.length !== 2) return false;
        const [first, second] = result.segments;
        return first.speaker.raw === "Oda" && first.speaker.value === "Oda" && first.speaker.source === "explicit" &&
            first.text === "What's going on?" &&
            second.speaker.value === "Danny" && second.text === "Nothing much.";
    });

    add("stage5: txt does not infer speakers from ambiguous text", () => {
        const result = parseTxt("hello: world\na very long speaker label indeed: x\nSpeaker1: x\n");
        return result.status === "complete" && result.segments.length === 3 &&
            result.segments.every((segment) => segment.speaker.source === "unknown") &&
            result.segments[0].text === "hello: world" &&
            result.segments[1].text === "a very long speaker label indeed: x" &&
            result.segments[2].text === "Speaker1: x";
    });

    add("stage5: txt combines timestamp and speaker prefixes", () => {
        const result = parseTxt("[00:00:01] Streamer: hello chat\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const [segment] = result.segments;
        return segment.start.seconds === 1 && segment.speaker.value === "Streamer" &&
            segment.text === "hello chat" &&
            segment.derived.removedPrefix === "[00:00:01] Streamer: ";
    });

    add("stage5: txt fails on empty and whitespace-only input", () =>
        parseTxt("").status === "failed" && parseTxt("  \n\t\n ").status === "failed");

    add("stage5: txt handles CRLF, LF, and mixed line endings", () => {
        const result = parseTxt("one\r\ntwo\nthree\r\nfour");
        return result.status === "complete" && result.segments.length === 4 &&
            result.segments.map((segment) => segment.text).join("|") === "one|two|three|four";
    });

    add("stage5: txt keeps spoken text verbatim (no cleanup)", () => {
        const line = "  well... um, REALLY?!   ";
        const result = parseTxt(`${line}\n`);
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].text === line;
    });

    add("stage5: txt keeps embedded timestamps in the text", () => {
        const result = parseTxt("remember 02:14:37 from earlier\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].text === "remember 02:14:37 from earlier" &&
            result.segments[0].start.status === "missing";
    });

    add("stage5: txt marks unparseable timestamp prefixes malformed", () => {
        const result = parseTxt("[99:99:99] hello\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const [segment] = result.segments;
        return segment.start.raw === "[99:99:99]" && segment.start.seconds === null &&
            segment.start.status === "malformed" && segment.text === "hello";
    });

    add("stage5: txt skips timestamp-only lines and notes it", () => {
        const result = parseTxt("[00:00:01]\nhello\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].text === "hello" && result.notes.length === 1 &&
            /no text/.test(result.notes[0]);
    });

    add("stage5: txt records line and offset provenance", () => {
        const rawText = "first\nsecond line\n";
        const result = parseTxt(rawText);
        if (result.status !== "complete" || result.segments.length !== 2) return false;
        const [first, second] = result.segments;
        return first.source.lines.start === 1 && first.source.lines.end === 1 &&
            rawText.slice(first.source.offsets.start, first.source.offsets.end) === "first" &&
            second.source.lines.start === 2 &&
            rawText.slice(second.source.offsets.start, second.source.offsets.end) === "second line";
    });

    add("stage5: txt handles very long lines as one segment", () => {
        const long = `x${"y".repeat(5000)}z`;
        const result = parseTxt(`${long}\n`);
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].text === long;
    });

    add("stage5: txt parse is deterministic", () => {
        const rawText = "[00:00:01] Oda: hello?\nplain line\n";
        return fingerprint(parseTxt(rawText)) === fingerprint(parseTxt(rawText));
    });

    // ---------- SRT ----------

    add("stage5: srt parses a standard cue", () => {
        const result = parseSrt("1\n00:00:01,000 --> 00:00:04,000\nHello everyone.\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const [segment] = result.segments;
        return segment.id === "seg-000000" && segment.source.cueId === "1" &&
            segment.source.sequence === 0 &&
            segment.start.raw === "00:00:01,000" && segment.start.seconds === 1 &&
            segment.start.status === "parsed" &&
            segment.end.raw === "00:00:04,000" && segment.end.seconds === 4 &&
            segment.text === "Hello everyone.";
    });

    add("stage5: srt preserves multiline cue text", () => {
        const result = parseSrt("1\n00:00:01,000 --> 00:00:04,000\nHello\nworld\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].text === "Hello\nworld";
    });

    add("stage5: srt parses multiple cues in source order", () => {
        const result = parseSrt("1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:03,000 --> 00:00:04,000\nb\n");
        return result.status === "complete" && result.segments.length === 2 &&
            result.segments[0].text === "a" && result.segments[1].text === "b" &&
            result.segments[0].source.sequence === 0 && result.segments[1].source.sequence === 1;
    });

    add("stage5: srt tolerates cue numbering gaps and wrong numbers", () => {
        const result = parseSrt("7\n00:00:01,000 --> 00:00:02,000\na\n\n99\n00:00:03,000 --> 00:00:04,000\nb\n");
        return result.status === "complete" && result.segments.length === 2 &&
            result.segments[0].source.cueId === "7" && result.segments[1].source.cueId === "99" &&
            result.segments[0].id === "seg-000000" && result.segments[1].id === "seg-000001";
    });

    add("stage5: srt cue numbers never become canonical segment ids", () => {
        const result = parseSrt("42\n00:00:01,000 --> 00:00:02,000\na\n");
        return result.status === "complete" && result.segments[0].id === "seg-000000" &&
            result.segments[0].source.cueId === "42";
    });

    add("stage5: srt tolerates a missing cue number", () => {
        const result = parseSrt("00:00:01,000 --> 00:00:02,000\nno number here\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].source.cueId === null && result.segments[0].text === "no number here";
    });

    add("stage5: srt tolerates whitespace variations", () => {
        const result = parseSrt("1\n  00:00:01,000-->00:00:02,000  \nspaced\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].start.seconds === 1 && result.segments[0].end.seconds === 2;
    });

    add("stage5: srt handles CRLF and LF line endings", () => {
        const crlf = parseSrt("1\r\n00:00:01,000 --> 00:00:02,000\r\na\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nb\r\n");
        const lf = parseSrt("1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:03,000 --> 00:00:04,000\nb\n");
        return crlf.status === "complete" && lf.status === "complete" &&
            fingerprint(crlf) === fingerprint(lf);
    });

    add("stage5: srt marks bad timestamps malformed instead of repairing them", () => {
        const result = parseSrt("1\n99:99:99,000 --> 00:00:04,000\nhi\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const [segment] = result.segments;
        return segment.start.raw === "99:99:99,000" && segment.start.seconds === null &&
            segment.start.status === "malformed" &&
            segment.end.seconds === 4 && segment.text === "hi";
    });

    add("stage5: srt marks incomplete timestamp ranges malformed", () => {
        const result = parseSrt("1\n00:00:01,000 -->\nhi\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const [segment] = result.segments;
        return segment.start.seconds === 1 && segment.end.seconds === null &&
            segment.end.status === "malformed";
    });

    add("stage5: srt preserves overlapping cues without rejecting them", () => {
        const result = parseSrt(
            "1\n00:00:01,000 --> 00:00:10,000\nlong cue\n\n2\n00:00:05,000 --> 00:00:06,000\noverlap\n");
        return result.status === "complete" && result.segments.length === 2 &&
            result.segments[0].text === "long cue" && result.segments[1].text === "overlap";
    });

    add("stage5: srt keeps zero-length cues", () => {
        const result = parseSrt("1\n00:00:05,000 --> 00:00:05,000\ninstant\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].start.seconds === 5 && result.segments[0].end.seconds === 5;
    });

    add("stage5: srt keeps cues with missing text for the validator to report", () => {
        const result = parseSrt("1\n00:00:01,000 --> 00:00:02,000\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const doc = docFromText("1\n00:00:01,000 --> 00:00:02,000\n", "srt");
        const report = validateTranscript(doc);
        return result.segments[0].text === "" && report.valid === true &&
            report.issues.some((issue) => issue.type === ISSUE_TYPES.SEGMENT_EMPTY);
    });

    add("stage5: srt fails deterministically on garbage input", () => {
        const result = parseSrt("1\ngarbage timestamp\nHello\n");
        return result.status === "failed" && result.segments.length === 0 && result.notes.length > 0;
    });

    add("stage5: srt fails on empty input", () =>
        parseSrt("").status === "failed" && parseSrt("\n\n").status === "failed");

    add("stage5: srt keeps cue text verbatim including markup", () => {
        const result = parseSrt("1\n00:00:01,000 --> 00:00:02,000\n<script>alert(1)</script>\n");
        return result.status === "complete" && result.segments[0].text === "<script>alert(1)</script>";
    });

    add("stage5: srt records block line and offset provenance", () => {
        const rawText = "1\n00:00:01,000 --> 00:00:02,000\nhi\n";
        const result = parseSrt(rawText);
        if (result.status !== "complete") return false;
        const [segment] = result.segments;
        return segment.source.lines.start === 1 && segment.source.lines.end === 3 &&
            rawText.slice(segment.source.offsets.start, segment.source.offsets.end) === rawText.trimEnd();
    });

    add("stage5: srt parse is deterministic", () => {
        const rawText = "3\n00:00:01,000 --> 00:00:02,000\na\n\n1\n00:00:03,000 --> 00:00:04,000\nb\n";
        return fingerprint(parseSrt(rawText)) === fingerprint(parseSrt(rawText));
    });

    // ---------- VTT ----------

    add("stage5: vtt requires the WEBVTT header", () => {
        const result = parseVtt("00:00:01.000 --> 00:00:02.000\nhi\n");
        return result.status === "failed" && result.notes.some((note) => /WEBVTT/.test(note));
    });

    add("stage5: vtt parses a standard cue", () => {
        const result = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello everyone.\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const [segment] = result.segments;
        return segment.id === "seg-000000" && segment.source.cueId === null &&
            segment.start.raw === "00:00:01.000" && segment.start.seconds === 1 &&
            segment.end.raw === "00:00:04.000" && segment.end.seconds === 4 &&
            segment.text === "Hello everyone.";
    });

    add("stage5: vtt parses HH:MM:SS.mmm timestamps", () => {
        const result = parseVtt("WEBVTT\n\n01:02:03.500 --> 01:02:05.000\nhi\n");
        return result.status === "complete" &&
            result.segments[0].start.seconds === 3723.5 && result.segments[0].end.seconds === 3725;
    });

    add("stage5: vtt keeps cue identifiers as cueId, never as segment id", () => {
        const result = parseVtt("WEBVTT\n\ncue-1\n00:00:01.000 --> 00:00:02.000\nhi\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].source.cueId === "cue-1" && result.segments[0].id === "seg-000000";
    });

    add("stage5: vtt tolerates header metadata", () => {
        const result = parseVtt("WEBVTT Kind: captions\n\n00:00:01.000 --> 00:00:02.000\nhi\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].text === "hi";
    });

    add("stage5: vtt skips NOTE, STYLE, and REGION blocks", () => {
        const result = parseVtt(
            "WEBVTT\n\nNOTE this is a note\nspanning lines\n\n" +
            "STYLE\n::cue { color: white }\n\n" +
            "REGION\nid:fred\n\n" +
            "00:00:01.000 --> 00:00:02.000\nkept\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].text === "kept" && result.notes.length === 0;
    });

    add("stage5: vtt keeps line numbers accurate past skipped blocks", () => {
        const result = parseVtt("WEBVTT\n\nNOTE a note\n\n00:00:01.000 --> 00:00:02.000\nhi\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].source.lines.start === 5 && result.segments[0].source.lines.end === 6;
    });

    add("stage5: vtt tolerates cue settings after the end timestamp", () => {
        const result = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:0%\nhi\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].end.seconds === 2 && result.segments[0].text === "hi";
    });

    add("stage5: vtt maps <v Speaker> to an explicit speaker", () => {
        const result = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v Streamer>hello & welcome\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const [segment] = result.segments;
        return segment.speaker.raw === "<v Streamer>" && segment.speaker.value === "Streamer" &&
            segment.speaker.source === "explicit" &&
            segment.text === "<v Streamer>hello & welcome" &&
            segment.derived.strippedText === "hello & welcome";
    });

    add("stage5: vtt keeps other cue markup verbatim in text", () => {
        const result = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<b>bold</b> and <i>italic</i>\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].text === "<b>bold</b> and <i>italic</i>" &&
            result.segments[0].speaker.source === "unknown";
    });

    add("stage5: vtt preserves multiline cue text", () => {
        const result = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nline one\nline two\n");
        return result.status === "complete" && result.segments[0].text === "line one\nline two";
    });

    add("stage5: vtt marks bad timestamps malformed", () => {
        const result = parseVtt("WEBVTT\n\n00:00:01.000 --> garbage\nhi\n");
        if (result.status !== "complete" || result.segments.length !== 1) return false;
        const [segment] = result.segments;
        return segment.start.seconds === 1 && segment.end.raw === "garbage" &&
            segment.end.seconds === null && segment.end.status === "malformed";
    });

    add("stage5: vtt fails on header-only files", () => {
        const result = parseVtt("WEBVTT\n");
        return result.status === "failed" && result.segments.length === 0;
    });

    add("stage5: vtt fails on empty input", () =>
        parseVtt("").status === "failed");

    add("stage5: vtt handles CRLF line endings", () => {
        const result = parseVtt("WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nhi\r\n");
        return result.status === "complete" && result.segments.length === 1 &&
            result.segments[0].start.seconds === 1;
    });

    add("stage5: vtt parse is deterministic", () => {
        const rawText = "WEBVTT\n\ncue-9\n00:00:01.000 --> 00:00:02.000\n<v A>x</v>\n";
        return fingerprint(parseVtt(rawText)) === fingerprint(parseVtt(rawText));
    });

    // ---------- Cross-format ----------

    add("stage5: equivalent srt/vtt fixtures produce equivalent segment content", () => {
        const srtText = "1\n00:00:01,000 --> 00:00:04,000\nHello everyone.\n\n" +
            "2\n00:00:04,500 --> 00:00:07,000\nWelcome back.\n";
        const vttText = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello everyone.\n\n" +
            "00:00:04.500 --> 00:00:07.000\nWelcome back.\n";
        const srt = parseSrt(srtText);
        const vtt = parseVtt(vttText);
        if (srt.status !== "complete" || vtt.status !== "complete") return false;
        const content = (result) => result.segments.map((segment) => ({
            text: segment.text,
            startSeconds: segment.start.seconds,
            endSeconds: segment.end.seconds
        }));
        return JSON.stringify(content(srt)) === JSON.stringify(content(vtt));
    });

    add("stage5: all formats produce canonical TranscriptDocuments", () => {
        const fixtures = {
            txt: "Hello everyone.\nWelcome back.\n",
            srt: "1\n00:00:01,000 --> 00:00:04,000\nHello everyone.\n\n2\n00:00:04,500 --> 00:00:07,000\nWelcome back.\n",
            vtt: "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello everyone.\n\n00:00:04.500 --> 00:00:07.000\nWelcome back.\n"
        };
        return Object.entries(fixtures).every(([format, rawText]) => {
            const doc = docFromText(rawText, format);
            return doc.schemaVersion === TRANSCRIPT_SCHEMA_VERSION &&
                doc.parse.status === "complete" && doc.processing.parsed === true &&
                doc.segments.length === 2 && doc.validation.valid === true &&
                Object.isFrozen(doc) && typeof doc.id === "string";
        });
    });

    // ---------- Downstream integration ----------

    add("stage5: txt flows through validate and chunk with the timestamp-less fallback", () => {
        const doc = docFromText("Hello everyone.\nWelcome back.\nHow are you?\n", "txt");
        // Missing timestamps are info-only: valid, but reported.
        if (doc.validation.valid !== true ||
            !doc.validation.issues.some((issue) => issue.type === ISSUE_TYPES.TIMESTAMP_MISSING)) return false;
        const chunked = chunkDocument(doc);
        return chunked.chunks.length === 1 && chunked.chunks[0].id === "chunk-000000" &&
            chunked.chunks[0].transcriptId === doc.id &&
            JSON.stringify(chunked.chunks[0].segmentIds) ===
                JSON.stringify(doc.segments.map((segment) => segment.id)) &&
            doc.chunks.length === 0; // source document never mutated
    });

    add("stage5: srt flows through validate, chunk, and JSON export", () => {
        const rawText = "1\n00:00:01,000 --> 00:00:04,000\nHello?\n\n" +
            "2\n00:10:04,500 --> 00:10:07,000\nWelcome back.\n";
        const doc = docFromText(rawText, "srt");
        if (doc.validation.status !== "passed") return false;
        const chunked = chunkDocument(doc);
        if (chunked.chunks.length !== 2) return false;
        const exported = exportTranscript(doc, "json");
        const parsed = JSON.parse(exported);
        return Array.isArray(parsed.segments) && parsed.segments.length === 2 &&
            parsed.segments[0].text === "Hello?" && parsed.segments[0].start === 1;
    });

    add("stage5: srt flows through analysis with traceable evidence", async () => {
        const rawText = "1\n00:00:01,000 --> 00:00:04,000\nHello?\n\n" +
            "2\n00:00:04,500 --> 00:00:07,000\nWelcome back.\n";
        const doc = chunkDocument(docFromText(rawText, "srt"));
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({ transcriptId: doc.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, doc);
        const known = new Set(doc.segments.map((segment) => segment.id));
        return result.evidence.length === 1 &&
            result.evidence[0].sourceRef.transcriptId === doc.id &&
            result.evidence[0].sourceRef.segmentIds.length === 1 &&
            known.has(result.evidence[0].sourceRef.segmentIds[0]) &&
            result.evidence[0].content.quote.includes("?") &&
            result.evidence[0].provenance === "source-observed";
    });

    add("stage5: vtt flows through validate, chunk, export, and analysis", async () => {
        const rawText = "WEBVTT\n\ncue-a\n00:00:01.000 --> 00:00:04.000\n<v Host>Ready?\n\n" +
            "00:00:05.000 --> 00:00:07.000\nLet's begin.\n";
        const doc = docFromText(rawText, "vtt");
        if (doc.validation.status !== "passed") return false;
        const chunked = chunkDocument(doc);
        if (chunked.chunks.length !== 1) return false;
        const exported = JSON.parse(exportTranscript(doc, "json"));
        if (exported.segments.length !== 2) return false;
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({ transcriptId: doc.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, doc);
        return result.evidence.length === 1 &&
            result.evidence[0].sourceRef.segmentIds[0] === "seg-000000" &&
            result.evidence[0].content.quote.includes("Ready?");
    });

    add("stage5: txt analysis works over chunk-scoped requests", async () => {
        const lines = [];
        for (let i = 0; i < 40; i++) lines.push(`line ${i}${i === 25 ? "?" : ""}`);
        const doc = chunkDocument(docFromText(`${lines.join("\n")}\n`, "txt"),
            { windowSeconds: 60, overlapSeconds: 10 });
        // Timestamp-less lines all fall back to effective time 0, so
        // every segment lands in the first chunk.
        const chunk = doc.chunks[0];
        const analyzer = createAnalyzer({ extract: createQuestionExtractor() });
        const request = createAnalysisRequest({
            transcriptId: doc.id,
            scope: { type: "partial", segmentIds: [...chunk.segmentIds] },
            chunkId: chunk.id
        });
        const result = await analyzer.analyze(request, doc);
        return result.evidence.length === 1 &&
            result.evidence[0].sourceRef.segmentIds[0] === "seg-000025";
    });

    add("stage5: failed parses surface through the pipeline as validation warnings", () => {
        const doc = docFromText("WEBVTT\n", "vtt");
        return doc.parse.status === "failed" && doc.processing.parsed === false &&
            doc.validation.valid === true &&
            doc.validation.issues.some((issue) => issue.type === ISSUE_TYPES.QUALITY_CONCERN);
    });

    add("stage5: malformed srt timestamps surface as validator warnings", () => {
        const doc = docFromText("1\n99:99:99,000 --> 00:00:04,000\nhi\n", "srt");
        return doc.parse.status === "complete" && doc.validation.valid === true &&
            doc.validation.issues.some((issue) => issue.type === ISSUE_TYPES.TIMESTAMP_MALFORMED);
    });

    add("stage5: failed parses keep the raw evidence byte-for-byte", () => {
        const rawText = "1\ngarbage timestamp\nHello\n";
        const doc = docFromText(rawText, "srt");
        return doc.parse.status === "failed" && doc.rawText === rawText &&
            doc.segments.length === 0 && doc.parse.notes.length > 0;
    });

}

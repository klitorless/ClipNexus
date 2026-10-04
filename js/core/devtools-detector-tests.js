// ==========================================================
// devtools-detector-tests.js
// Responsibility: self-tests for the deterministic detector
// layer (js/analysis/detectors/): hype, question, keyword,
// reaction, emphasis, phrase, the runDetectors runner, and
// the analyzer-seam extractor.
//
// Deterministic: no network, no AI, no timers, no random.
// Registered by devtools.js via addDetectorTests(add).
// ==========================================================

import { runDetectors, resolveDetectorConfig, DETECTOR_TYPE } from "../analysis/detectors/index.js";
import { createDetectorExtractor } from "../analysis/detectors/extractor.js";
import { createAnalyzer } from "../analysis/analyzer.js";
import { createAnalysisRequest } from "../analysis/contracts.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";

// Minimal segment view, shaped like the analyzer's payload.
function seg(id, text, seconds = null) {
    return {
        id,
        text,
        start: { raw: null, seconds, status: seconds === null ? "missing" : "parsed" },
        end: { raw: null, seconds: null, status: "missing" },
        speaker: { raw: null, value: null, source: "unknown" }
    };
}

function run(text, config = {}, id = "seg-000001", seconds = 10.5) {
    return runDetectors([seg(id, text, seconds)], config);
}

function byType(signals, type) {
    return signals.filter((signal) => signal.detector === type);
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function addDetectorTests(add) {
    // ---------- Hype ----------

    add("detectors: hype scores a strong phrase at +3", () => {
        const [signal] = byType(run("Oh my god, that landing!"), "hype");
        return Boolean(signal) && signal.score === 3 &&
            deepEqual(signal.signals, ["oh my god"]);
    });

    add("detectors: hype scores a medium phrase at +2", () => {
        const [signal] = byType(run("No way that happened"), "hype");
        return Boolean(signal) && signal.score === 2;
    });

    add("detectors: hype sums distinct phrases and drops subsumed weak ones", () => {
        // "that's insane" (+3) subsumes bare "insane" (+1); "wow" (+1) survives.
        const [signal] = byType(run("Wow, that's insane!"), "hype");
        return Boolean(signal) && signal.score === 4 &&
            deepEqual(signal.signals, ["that's insane", "wow"]);
    });

    add("detectors: hype matching is case-insensitive", () => {
        const [signal] = byType(run("HOLY SHIT"), "hype");
        return Boolean(signal) && signal.score === 3;
    });

    add("detectors: hype does not fire on ordinary text", () => {
        return run("The meeting starts at noon tomorrow.").length === 0;
    });

    add("detectors: hype score is deterministic across runs", () => {
        const text = "Oh my god, no way, that's insane!";
        return deepEqual(run(text), run(text)) &&
            byType(run(text), "hype")[0].score === 8;
    });

    add("detectors: hype respects sensitivity thresholds", () => {
        // "wow" scores 1: silent on normal (threshold 2), fires on high (threshold 1).
        const normal = byType(run("Wow.", { hype: { sensitivity: "high" } }), "hype");
        const quiet = byType(run("Wow."), "hype");
        return normal.length === 1 && quiet.length === 0;
    });

    // ---------- Question ----------

    add("detectors: question fires on an explicit question mark", () => {
        const [signal] = byType(run("Are you coming?"), "question");
        return Boolean(signal) && signal.signals.includes("?");
    });

    add("detectors: question fires on question-word sentence structure", () => {
        const [signal] = byType(run("How does this engine work"), "question");
        return Boolean(signal) && signal.signals.includes("question-word:how");
    });

    add("detectors: question ignores question words mid-sentence", () => {
        return byType(run("I know what you did last summer"), "question").length === 0;
    });

    add("detectors: question overlaps with hype and reaction", () => {
        const signals = run("What the hell, are you kidding me?!");
        return byType(signals, "question").length === 1 &&
            byType(signals, "reaction").length === 1 &&
            byType(signals, "hype").length === 1;
    });

    add("detectors: question matching is case-insensitive", () => {
        const [signal] = byType(run("WHY IS THIS HAPPENING?"), "question");
        return Boolean(signal);
    });

    add("detectors: question needs at least three words for structure", () => {
        return byType(run("Why me"), "question").length === 0;
    });

    // ---------- Keyword ----------

    const kw = { keyword: { keywords: ["BMW", "turbo", "engine failure"] } };

    add("detectors: keyword matches an exact word case-insensitively", () => {
        const [signal] = byType(run("I love my bmw", kw), "keyword");
        return Boolean(signal) && deepEqual(signal.signals, ["BMW"]);
    });

    add("detectors: keyword matches a multi-word phrase", () => {
        const [signal] = byType(run("Total engine failure on lap three", kw), "keyword");
        return Boolean(signal) && signal.signals.includes("engine failure");
    });

    add("detectors: keyword reports every configured keyword that matched", () => {
        const [signal] = byType(run("BMW turbo upgrade", kw), "keyword");
        return Boolean(signal) && deepEqual(signal.signals, ["BMW", "turbo"]);
    });

    add("detectors: keyword never matches inside another word", () => {
        return byType(run("The communication was unclear", { keyword: { keywords: ["cat"] } }), "keyword").length === 0;
    });

    add("detectors: keyword scores repeated occurrences", () => {
        const [signal] = byType(run("turbo turbo turbo", kw), "keyword");
        return Boolean(signal) && signal.score === 3 &&
            deepEqual(signal.signals, ["turbo"]);
    });

    add("detectors: keyword is silent with no configured keywords", () => {
        return byType(run("BMW turbo"), "keyword").length === 0;
    });

    // ---------- Reaction ----------

    add("detectors: reaction fires on a strong reaction phrase", () => {
        const [signal] = byType(run("Oh shit, look at that!"), "reaction");
        return Boolean(signal) && signal.score === 1 &&
            signal.signals.includes("oh shit");
    });

    add("detectors: reaction counts multiple distinct phrases", () => {
        const [signal] = byType(run("What?! No! That's crazy!"), "reaction");
        return Boolean(signal) && signal.score === 3;
    });

    add("detectors: reaction overlaps with hype by design", () => {
        const signals = run("What just happened?!");
        return byType(signals, "reaction").length === 1 &&
            byType(signals, "hype").length === 1;
    });

    add("detectors: reaction does not fire on ordinary text", () => {
        return byType(run("Please review the document tomorrow."), "reaction").length === 0;
    });

    // ---------- Emphasis ----------

    add("detectors: emphasis fires on consecutive repeated words", () => {
        const [signal] = byType(run("no no no, don't do it"), "emphasis");
        return Boolean(signal) && signal.signals.some((s) => s.startsWith('repeated-word:"no"'));
    });

    add("detectors: emphasis fires on repeated punctuation", () => {
        const [signal] = byType(run("Look out!!!"), "emphasis");
        return Boolean(signal) && signal.signals.some((s) => s.includes("!!!"));
    });

    add("detectors: emphasis fires on ALL CAPS", () => {
        const [signal] = byType(run("OH MY GOD LOOK"), "emphasis");
        return Boolean(signal) && signal.signals.includes("all-caps");
    });

    add("detectors: emphasis stays silent on normalized lowercase text", () => {
        return byType(run("oh my god look at that"), "emphasis").length === 0;
    });

    add("detectors: emphasis ignores a lone double mark", () => {
        return byType(run("Really?!"), "emphasis").length === 0;
    });

    add("detectors: emphasis does not fire on ordinary text", () => {
        return byType(run("The quick brown fox jumps."), "emphasis").length === 0;
    });

    // ---------- Phrase ----------

    const ph = { phrase: { phrases: ["you won't believe", "watch this"] } };

    add("detectors: phrase matches an exact configured phrase", () => {
        const [signal] = byType(run("Watch this next part", ph), "phrase");
        return Boolean(signal) && deepEqual(signal.signals, ["watch this"]);
    });

    add("detectors: phrase matching is case-insensitive", () => {
        const [signal] = byType(run("YOU WON'T BELIEVE what happened", ph), "phrase");
        return Boolean(signal) && signal.signals.includes("you won't believe");
    });

    add("detectors: phrase reports multiple configured phrases", () => {
        const [signal] = byType(run("You won't believe this — watch this", ph), "phrase");
        return Boolean(signal) && signal.signals.length === 2;
    });

    add("detectors: phrase is silent with no configured phrases", () => {
        return byType(run("watch this"), "phrase").length === 0;
    });

    add("detectors: phrase does not fire on a near miss", () => {
        return byType(run("watch the throne", ph), "phrase").length === 0;
    });

    // ---------- Runner: robustness and determinism ----------

    add("detectors: empty segment list yields no signals", () => {
        return runDetectors([]).length === 0;
    });

    add("detectors: empty and whitespace-only segments are skipped", () => {
        const signals = runDetectors([seg("seg-000001", ""), seg("seg-000002", "   ")]);
        return signals.length === 0;
    });

    add("detectors: malformed segments are skipped without throwing", () => {
        const signals = runDetectors([null, undefined, { id: "seg-1" }, { text: "wow" }]);
        return signals.length === 0;
    });

    add("detectors: one segment can produce signals from several detectors", () => {
        const signals = run("OH MY GOD! NO WAY!!!");
        const types = signals.map((s) => s.detector).sort();
        return types.includes("hype") && types.includes("emphasis") &&
            types.length === new Set(types).size;
    });

    add("detectors: detectors never suppress each other", () => {
        // Hype, reaction, and emphasis all fire here by design.
        const signals = run("OH MY GOD NO WAY!!!");
        return byType(signals, "hype").length === 1 &&
            byType(signals, "emphasis").length === 1;
    });

    add("detectors: signals preserve segment ids and timestamps", () => {
        const [signal] = byType(run("Oh my god", {}, "seg-000142", 482.35), "hype");
        return signal.segmentId === "seg-000142" &&
            signal.timestampSeconds === 482.35 &&
            signal.quote === "Oh my god";
    });

    add("detectors: signals are frozen", () => {
        const [signal] = run("Oh my god");
        return Object.isFrozen(signal) && Object.isFrozen(signal.signals);
    });

    add("detectors: output order is segment order, then detector order", () => {
        const signals = runDetectors([
            seg("seg-000001", "What?! No way!"),
            seg("seg-000002", "Oh my god")
        ]);
        const keys = signals.map((s) => `${s.segmentId}:${s.detector}`);
        return deepEqual(keys, [
            "seg-000001:hype",
            "seg-000001:question",
            "seg-000001:reaction",
            "seg-000002:hype"
        ]);
    });

    add("detectors: a disabled detector never fires", () => {
        return byType(run("Oh my god", { hype: { enabled: false } }), "hype").length === 0;
    });

    add("detectors: unknown detector keys throw", () => {
        try {
            runDetectors([seg("seg-1", "wow")], { nope: {} });
            return false;
        } catch {
            return true;
        }
    });

    add("detectors: unknown sensitivity values throw", () => {
        try {
            runDetectors([seg("seg-1", "wow")], { hype: { sensitivity: "extreme" } });
            return false;
        } catch {
            return true;
        }
    });

    // ---------- Extractor: analyzer-seam integration ----------

    function transcriptWith(texts) {
        const rawText = JSON.stringify(texts.map((text, i) => ({
            start: i * 10, end: i * 10 + 5, text
        })));
        return buildTranscriptDocument({
            rawText,
            format: "json",
            filename: "detectors.json",
            size: rawText.length,
            acquisition: createFileAcquisition()
        });
    }

    add("detectors: extractor converts signals to evidence on the analyzer seam", async () => {
        const document = transcriptWith(["Oh my god, no way!", "The meeting starts at noon."]);
        const analyzer = createAnalyzer({ extract: createDetectorExtractor() });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        const hype = result.evidence.filter((item) => item.content.detector === "hype");
        return result.evidence.length > 0 &&
            hype.length === 1 &&
            hype[0].id === `ev-hype-${document.segments[0].id}` &&
            hype[0].sourceRef.transcriptId === document.id &&
            deepEqual(hype[0].sourceRef.segmentIds, [document.segments[0].id]) &&
            hype[0].type === "text" &&
            hype[0].provenance === "source-observed" &&
            Array.isArray(hype[0].content.signals) &&
            hype[0].content.signals.length > 0;
    });

    add("detectors: extractor passes detector config through", async () => {
        const document = transcriptWith(["The BMW turbo failed."]);
        const analyzer = createAnalyzer({
            extract: createDetectorExtractor({ keyword: { keywords: ["BMW"] } })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        const keyword = result.evidence.filter((item) => item.content.detector === "keyword");
        return keyword.length === 1 && keyword[0].content.signals.includes("BMW");
    });

    add("detectors: extractor reports the heuristic limitation", async () => {
        const document = transcriptWith(["Wow."]);
        const analyzer = createAnalyzer({ extract: createDetectorExtractor() });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        return result.limitations.length === 1 &&
            result.limitations[0].includes("heuristic");
    });

    add("detectors: extractor never mutates the transcript", async () => {
        const document = transcriptWith(["Oh my god!"]);
        const before = JSON.stringify(document);
        const analyzer = createAnalyzer({ extract: createDetectorExtractor() });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        await analyzer.analyze(request, document);
        return JSON.stringify(document) === before;
    });
}

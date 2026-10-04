// ==========================================================
// devtools-analysis-builder-tests.js
// Responsibility: self-tests for the Analysis Builder UI
// (js/ui/analysis.js) and its integration with the
// canonical detector configuration.
//
// The builder is a configuration layer only: these tests
// prove it produces the canonical config shape, never
// classifies text, and survives re-renders. Deterministic:
// no network, no AI, no timers.
// Registered by devtools.js via addAnalysisBuilderTests(add).
// ==========================================================

import { renderAnalysisView, parseKeywordInput } from "../ui/analysis.js";
import {
    validateAnalysisConfig,
    runDetectors,
    DETECTOR_TYPE
} from "../analysis/detectors/index.js";
import { createDetectorExtractor } from "../analysis/detectors/extractor.js";
import { createAnalyzer } from "../analysis/analyzer.js";
import { createAnalysisRequest } from "../analysis/contracts.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";
import { createProject, withTranscript } from "./project.js";
import { QUESTION_WORDS } from "../analysis/detectors/question.js";
import { HYPE_PHRASES } from "../analysis/detectors/hype.js";
import { REACTION_PHRASES } from "../analysis/detectors/reaction.js";

function docWith(texts) {
    const rawText = JSON.stringify(texts.map((text, i) => ({
        start: i * 10, end: i * 10 + 5, text
    })));
    return buildTranscriptDocument({
        rawText,
        format: "json",
        filename: "builder.json",
        size: rawText.length,
        acquisition: createFileAcquisition()
    });
}

function renderBuilder(config = {}, onConfigChange = () => {}) {
    const mount = document.createElement("div");
    renderAnalysisView(mount, withTranscript(createProject(), docWith(["hello"])), {
        analysis: { status: "idle" },
        onAnalyze: () => {},
        builder: { config, onConfigChange }
    });
    return mount;
}

function sectionFor(mount, type) {
    return mount.querySelector(`details.builder-section[data-detector="${type}"]`);
}

function checkboxFor(mount, type) {
    const section = sectionFor(mount, type);
    return section ? section.querySelector('input[type="checkbox"]') : null;
}

function fireEvent(element, type) {
    const EventCtor = element.ownerDocument.defaultView.Event;
    element.dispatchEvent(new EventCtor(type, { bubbles: true }));
}

function setChecked(checkbox, checked) {
    checkbox.checked = checked;
    fireEvent(checkbox, "change");
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function addAnalysisBuilderTests(add) {
    // ---------- Builder rendering ----------

    add("builder: renders all six detector sections", () => {
        const mount = renderBuilder();
        const sections = mount.querySelectorAll("details.builder-section");
        if (sections.length !== 6) return false;
        return Object.values(DETECTOR_TYPE).every((type) =>
            sectionFor(mount, type) !== null &&
            sectionFor(mount, type).querySelector('input[type="checkbox"]') !== null);
    });

    add("builder: asks what the user is looking for, not about detectors", () => {
        const mount = renderBuilder();
        const text = mount.textContent;
        return text.includes("What are you looking for?") &&
            !text.toLowerCase().includes("configure the detector");
    });

    add("builder: keyword section reports no terms when empty", () => {
        const mount = renderBuilder();
        const status = sectionFor(mount, "keyword").querySelector(".builder-status");
        return status.textContent.includes("no terms");
    });

    add("builder: sections show enable state in their summary", () => {
        const mount = renderBuilder({ hype: { enabled: false } });
        const status = sectionFor(mount, "hype").querySelector(".builder-status");
        const onStatus = sectionFor(mount, "question").querySelector(".builder-status");
        return status.textContent === "Off" && onStatus.textContent.includes("On");
    });

    // ---------- Configuration output ----------

    add("builder: toggling a detector emits an enabled patch", () => {
        const received = [];
        const mount = renderBuilder({}, (type, patch) => received.push({ type, patch }));
        setChecked(checkboxFor(mount, "hype"), false);
        return received.length === 1 &&
            received[0].type === "hype" &&
            received[0].patch.enabled === false;
    });

    add("builder: multiple detectors can be configured independently", () => {
        const received = [];
        const mount = renderBuilder({}, (type, patch) => received.push({ type, patch }));
        setChecked(checkboxFor(mount, "hype"), false);
        setChecked(checkboxFor(mount, "emphasis"), false);
        return received.length === 2 &&
            received[0].type === "hype" && received[1].type === "emphasis";
    });

    add("builder: sensitivity radio emits a sensitivity patch", () => {
        const received = [];
        const mount = renderBuilder({}, (type, patch) => received.push({ type, patch }));
        const section = sectionFor(mount, "hype");
        const high = [...section.querySelectorAll('input[type="radio"]')]
            .find((radio) => radio.value === "high");
        high.checked = true;
        fireEvent(high, "change");
        return received.length === 1 &&
            received[0].type === "hype" &&
            received[0].patch.sensitivity === "high";
    });

    add("builder: keyword input parses comma-separated values", () => {
        const received = [];
        const mount = renderBuilder({}, (type, patch) => received.push({ type, patch }));
        const input = sectionFor(mount, "keyword").querySelector("#builder-keyword-input");
        input.value = "BMW, turbo , ,engine failure";
        fireEvent(input, "input");
        const last = received[received.length - 1];
        return last.type === "keyword" &&
            deepEqual(last.patch.keywords, ["BMW", "turbo", "engine failure"]);
    });

    add("builder: keyword input dedupes case-insensitively", () => {
        const received = [];
        const mount = renderBuilder({}, (type, patch) => received.push({ type, patch }));
        const input = sectionFor(mount, "keyword").querySelector("#builder-keyword-input");
        input.value = "BMW, bmw, TURBO";
        fireEvent(input, "input");
        const last = received[received.length - 1];
        return deepEqual(last.patch.keywords, ["BMW", "TURBO"]);
    });

    add("builder: phrase add appends to the phrase list", () => {
        const received = [];
        const mount = renderBuilder({}, (type, patch) => received.push({ type, patch }));
        const section = sectionFor(mount, "phrase");
        const input = section.querySelector("#builder-phrase-input");
        input.value = "watch this";
        section.querySelector(".builder-add-row .button").click();
        const last = received[received.length - 1];
        return last.type === "phrase" &&
            deepEqual(last.patch.phrases, ["watch this"]) &&
            section.textContent.includes("watch this");
    });

    add("builder: phrase remove drops the phrase", () => {
        const received = [];
        const mount = renderBuilder(
            { phrase: { enabled: true, phrases: ["alpha", "beta"] } },
            (type, patch) => received.push({ type, patch })
        );
        const section = sectionFor(mount, "phrase");
        const remove = [...section.querySelectorAll(".builder-phrase-list .button")]
            .find((button) => button.getAttribute("aria-label") === "Remove phrase alpha");
        remove.click();
        const last = received[received.length - 1];
        return last.type === "phrase" && deepEqual(last.patch.phrases, ["beta"]);
    });

    // ---------- No second copy of detector logic ----------

    add("builder: question vocabulary matches the detector module", () => {
        const mount = renderBuilder();
        const text = sectionFor(mount, "question").textContent.toLowerCase();
        return QUESTION_WORDS.every((word) => text.includes(word));
    });

    add("builder: hype vocabulary matches the detector module", () => {
        const mount = renderBuilder();
        const text = sectionFor(mount, "hype").textContent.toLowerCase();
        return HYPE_PHRASES.every((entry) => text.includes(entry.phrase));
    });

    add("builder: reaction vocabulary matches the detector module", () => {
        const mount = renderBuilder();
        const text = sectionFor(mount, "reaction").textContent.toLowerCase();
        return REACTION_PHRASES.every((phrase) => text.includes(phrase));
    });

    add("builder: keyword section states the inherent matching behavior", () => {
        const mount = renderBuilder();
        const text = sectionFor(mount, "keyword").textContent;
        return text.includes("case-insensitive") && text.includes("whole-word");
    });

    add("builder: builder renders no scores or evidence itself", () => {
        const mount = renderBuilder();
        const builderCard = mount.querySelector('[data-section="analysis-builder"]');
        return builderCard !== null &&
            mount.querySelectorAll('[data-section="evidence"]').length === 0 &&
            !/score:\s*\d/i.test(builderCard.textContent);
    });

    // ---------- Config survival ----------

    add("builder: configuration survives re-render", () => {
        const config = {
            hype: { enabled: false, sensitivity: "high" },
            keyword: { enabled: true, keywords: ["BMW"] }
        };
        const first = renderBuilder(config);
        const second = renderBuilder(config);
        const hypeBox = checkboxFor(second, "hype");
        const keywordInput = sectionFor(second, "keyword").querySelector("#builder-keyword-input");
        return hypeBox.checked === false &&
            checkboxFor(first, "hype").checked === false &&
            keywordInput.value === "BMW";
    });

    // ---------- Validation ----------

    add("builder: validation rejects all detectors disabled", () => {
        const config = {
            hype: { enabled: false },
            question: { enabled: false },
            keyword: { enabled: false },
            reaction: { enabled: false },
            emphasis: { enabled: false },
            phrase: { enabled: false }
        };
        const result = validateAnalysisConfig(config);
        return result.ok === false &&
            result.error === "Select at least one analysis type to search for.";
    });

    add("builder: validation rejects keyword enabled without terms", () => {
        const result = validateAnalysisConfig({ keyword: { enabled: true, keywords: [] } });
        return result.ok === false && result.error.includes("keyword");
    });

    add("builder: validation rejects phrase enabled without terms", () => {
        const result = validateAnalysisConfig({ phrase: { enabled: true, phrases: [] } });
        const other = validateAnalysisConfig({});
        return result.ok === false && result.error.includes("phrase") &&
            other.ok === true;
    });

    // ---------- UI config → analyzer (canonical format) ----------

    add("builder: UI-produced config feeds the extractor with no translation", async () => {
        // Collect config exactly as the builder emits it.
        let uiConfig = {};
        const mount = renderBuilder({}, (type, patch) => {
            uiConfig = { ...uiConfig, [type]: { ...(uiConfig[type] || {}), ...patch } };
        });
        setChecked(checkboxFor(mount, "hype"), false);
        const keywordInput = sectionFor(mount, "keyword").querySelector("#builder-keyword-input");
        setChecked(checkboxFor(mount, "keyword"), true);
        keywordInput.value = "BMW";
        fireEvent(keywordInput, "input");

        const document = docWith(["Oh my god, the BMW turbo failed."]);
        const analyzer = createAnalyzer({ extract: createDetectorExtractor(uiConfig) });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        const detectors = result.evidence.map((item) => item.content.detector);
        return !detectors.includes("hype") && detectors.includes("keyword");
    });

    add("builder: disabled detectors produce no evidence", async () => {
        const document = docWith(["Oh my god! What?! No way!!!"]);
        const analyzer = createAnalyzer({
            extract: createDetectorExtractor({
                hype: { enabled: false },
                question: { enabled: false },
                reaction: { enabled: false },
                emphasis: { enabled: false }
            })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        return result.evidence.length === 0;
    });

    add("builder: results are still canonical Evidence", async () => {
        const document = docWith(["Why is the turbo failing?"]);
        const analyzer = createAnalyzer({
            extract: createDetectorExtractor({ keyword: { enabled: true, keywords: ["turbo"] } })
        });
        const request = createAnalysisRequest({ transcriptId: document.id, scope: { type: "full" } });
        const result = await analyzer.analyze(request, document);
        return result.evidence.length > 0 && result.evidence.every((item) =>
            typeof item.id === "string" &&
            item.sourceRef.transcriptId === document.id &&
            Array.isArray(item.sourceRef.segmentIds) &&
            item.content.detector && typeof item.content.score === "number" &&
            Array.isArray(item.content.signals) && typeof item.content.quote === "string");
    });

    // ---------- parseKeywordInput unit ----------

    add("builder: parseKeywordInput handles edge cases", () => {
        return deepEqual(parseKeywordInput(""), []) &&
            deepEqual(parseKeywordInput("   "), []) &&
            deepEqual(parseKeywordInput("a,,b"), ["a", "b"]) &&
            deepEqual(parseKeywordInput(null), []);
    });
}

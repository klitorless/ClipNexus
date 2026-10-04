// ==========================================================
// analysis.js
// Responsibility: build the Analysis view — a minimal
// integration surface for the Stage 3 analyzer behind its
// extraction seam. The view is read-only: it renders scope
// controls, runs analysis through the onAnalyze callback wired
// in app.js, and displays the resulting evidence with
// transcript/segment traceability.
//
// SECURITY: transcript content and analysis output are
// untrusted. They are only ever inserted with textContent,
// never innerHTML.
// ==========================================================

import { createElement, createDetailList, createInfoCard } from "./dom.js";
import {
    DETECTOR_TYPE,
    SENSITIVITY,
    DEFAULT_DETECTOR_CONFIG
} from "../analysis/detectors/types.js";
import { HYPE_PHRASES } from "../analysis/detectors/hype.js";
import { QUESTION_WORDS } from "../analysis/detectors/question.js";
import { REACTION_PHRASES } from "../analysis/detectors/reaction.js";

function createEmptyCard() {
    const card = createElement("article", "card");
    card.append(
        createElement("h2", "card-title", "No transcript loaded"),
        createElement("p", "card-body",
            "Load a transcript first — from the Transcripts tab — then return here to run analysis.")
    );
    return card;
}

function describeChunk(chunk) {
    const seconds = Math.round(chunk.endSeconds - chunk.startSeconds);
    return `${chunk.id} — ${chunk.segmentIds.length} segment(s), ~${seconds}s window`;
}

function createScopeCard(transcript, onAnalyze) {
    const card = createElement("article", "card");
    card.dataset.section = "analysis-scope";
    card.append(createElement("h2", "card-title", "Run analysis"));
    card.append(createElement("p", "card-body",
        "Runs the analyzer with the deterministic transcript detectors " +
        "(hype, questions, keywords, reactions, emphasis, and phrases). " +
        "Results are traceable to transcript and segment ids."));

    const chunks = Array.isArray(transcript.chunks) ? transcript.chunks : [];

    const fullRadio = createElement("input", "");
    fullRadio.type = "radio";
    fullRadio.name = "analysis-scope";
    fullRadio.value = "full";
    fullRadio.checked = true;
    const fullLabel = createElement("label", "radio-label");
    fullLabel.append(fullRadio, createElement("span", "", `Full transcript (${transcript.segments.length} segments)`));

    const chunkRadio = createElement("input", "");
    chunkRadio.type = "radio";
    chunkRadio.name = "analysis-scope";
    chunkRadio.value = "chunk";
    chunkRadio.disabled = chunks.length === 0;
    const chunkSelect = createElement("select", "");
    chunks.forEach((chunk) => {
        const option = createElement("option", "", describeChunk(chunk));
        option.value = chunk.id;
        chunkSelect.append(option);
    });
    chunkSelect.disabled = chunks.length === 0;
    const chunkLabel = createElement("label", "radio-label");
    chunkLabel.append(chunkRadio, createElement("span", "",
        chunks.length === 0 ? "Chunk (no chunks available)" : "Chunk"), chunkSelect);

    const runButton = createElement("button", "button button-primary", "Run analysis");
    runButton.type = "button";
    runButton.addEventListener("click", () => {
        const scopeType = chunkRadio.checked && !chunkRadio.disabled ? "chunk" : "full";
        onAnalyze({
            scopeType,
            chunkId: scopeType === "chunk" ? chunkSelect.value : null
        });
    });

    card.append(fullLabel, chunkLabel, runButton);
    return card;
}

function createStatusCard(analysis) {
    if (analysis.status === "running") {
        return createInfoCard("Analysis running", "The analyzer is processing the selected scope.", "Working", "tag",
            { src: "./assets/brand/clipnexus-processing-scan.webp", alt: "", className: "brand-processing" });
    }
    if (analysis.status === "error") {
        return createInfoCard("Analysis failed", analysis.error || "Unknown error.", "Error", "tag tag-danger");
    }
    return null;
}

// ---------- Analysis builder ----------
//
// The builder is a CONFIGURATION layer only: it produces the
// canonical detector config consumed by runDetectors() via the
// analyzer. It never classifies text, scores, or matches — the
// vocabulary lists below are read from the detector modules
// for display, and every control maps to a real config field.
//
// Only capabilities the detectors actually support are
// exposed: per-detector enable + sensitivity, the keyword
// list, and the phrase list. Fixed vocabularies are shown
// read-only; case-insensitivity and whole-word matching are
// inherent detector behavior, not toggles.

const BUILDER_SECTIONS = [
    {
        type: DETECTOR_TYPE.QUESTION,
        title: "Questions",
        blurb: "Question-like segments: explicit question marks and question-word sentence structure.",
        vocabulary: [...QUESTION_WORDS],
        vocabNote: "The detector recognizes these question words (first word of the segment)."
    },
    {
        type: DETECTOR_TYPE.HYPE,
        title: "Hype",
        blurb: "Excitement and high-energy language. Stronger phrases score higher; sensitivity sets the cutoff.",
        vocabulary: HYPE_PHRASES.map((entry) => entry.phrase),
        vocabNote: "The detector's fixed phrase list."
    },
    {
        type: DETECTOR_TYPE.REACTION,
        title: "Reactions",
        blurb: "Strong reaction language. Separate from Hype — a segment may trigger both.",
        vocabulary: [...REACTION_PHRASES],
        vocabNote: "The detector's fixed phrase list."
    },
    {
        type: DETECTOR_TYPE.KEYWORD,
        title: "Keywords",
        blurb: "Your own keywords and phrases, comma-separated.",
        input: "keyword",
        sensitivity: false, // threshold is 1 at every sensitivity — the vocabulary is the control
        fixedNote: "Always case-insensitive · Always whole-word — “cat” never matches “communication”."
    },
    {
        type: DETECTOR_TYPE.EMPHASIS,
        title: "Emphasis",
        blurb: "Repeated words (“no no no”), repeated punctuation (“!!!”, “???”), and ALL CAPS.",
        fixedNote: "Capitalization and punctuation are never required — normalized transcripts simply yield no emphasis signal."
    },
    {
        type: DETECTOR_TYPE.PHRASE,
        title: "Custom Phrases",
        blurb: "Your own phrases to search for, e.g. “watch this”. Same matching rules as Keywords.",
        input: "phrase",
        sensitivity: false // threshold is 1 at every sensitivity — the vocabulary is the control
    }
];

function describeSensitivity(sensitivity) {
    if (sensitivity === SENSITIVITY.LOW) return "Low";
    if (sensitivity === SENSITIVITY.HIGH) return "High";
    return "Normal";
}

function resolveSectionConfig(config, type) {
    return { ...DEFAULT_DETECTOR_CONFIG[type], ...(config[type] || {}) };
}

// Comma-separated input → keyword list. Trims, drops empties,
// dedupes case-insensitively (matching is case-insensitive, so
// "BMW, bmw" would otherwise double-count).
export function parseKeywordInput(value) {
    const seen = new Set();
    const keywords = [];
    for (const part of String(value ?? "").split(",")) {
        const trimmed = part.trim();
        if (trimmed.length === 0 || seen.has(trimmed.toLowerCase())) continue;
        seen.add(trimmed.toLowerCase());
        keywords.push(trimmed);
    }
    return keywords;
}

function createEnableRow(type, title, options, onConfigChange, refreshStatus) {
    const checkbox = createElement("input", "");
    checkbox.type = "checkbox";
    checkbox.checked = options.enabled === true;
    checkbox.setAttribute("aria-label", `Enable ${title}`);
    checkbox.addEventListener("change", () => {
        onConfigChange(type, { enabled: checkbox.checked });
        refreshStatus();
    });
    const label = createElement("label", "check-label");
    label.append(checkbox, createElement("span", "", `Enable ${title}`));
    return label;
}

function createSensitivityFieldset(type, options, onConfigChange, refreshStatus) {
    const fieldset = createElement("fieldset", "builder-sensitivity");
    fieldset.append(createElement("legend", "", "Sensitivity"));
    for (const value of [SENSITIVITY.LOW, SENSITIVITY.NORMAL, SENSITIVITY.HIGH]) {
        const radio = createElement("input", "");
        radio.type = "radio";
        radio.name = `sensitivity-${type}`;
        radio.value = value;
        radio.checked = options.sensitivity === value;
        radio.addEventListener("change", () => {
            onConfigChange(type, { sensitivity: value });
            refreshStatus();
        });
        const label = createElement("label", "radio-label");
        label.append(radio, createElement("span", "", describeSensitivity(value)));
        fieldset.append(label);
    }
    return fieldset;
}

function createVocabularyNote(vocabulary, note) {
    const wrap = createElement("p", "builder-note", `${note} `);
    wrap.append(createElement("span", "builder-vocab", vocabulary.join(", ")));
    return wrap;
}

function createKeywordInput(options, onConfigChange, refreshStatus) {
    const wrap = createElement("div", "builder-field");
    const input = createElement("input", "text-input");
    input.type = "text";
    input.id = "builder-keyword-input";
    input.placeholder = "BMW, turbo, engine failure";
    input.autocomplete = "off";
    input.value = (options.keywords || []).join(", ");
    const label = createElement("label", "builder-label");
    label.setAttribute("for", "builder-keyword-input");
    label.textContent = "Keywords (comma-separated)";
    input.setAttribute("aria-describedby", "builder-keyword-note");
    input.addEventListener("input", () => {
        onConfigChange(DETECTOR_TYPE.KEYWORD, { keywords: parseKeywordInput(input.value) });
        refreshStatus();
    });
    const note = createElement("p", "builder-note");
    note.id = "builder-keyword-note";
    note.textContent = "Always case-insensitive · Always whole-word — “cat” never matches “communication”.";
    wrap.append(label, input, note);
    return wrap;
}

function createPhraseList(configRef, onConfigChange, refreshStatus) {
    const wrap = createElement("div", "builder-field");
    const label = createElement("span", "builder-label", "Phrases");
    label.id = "builder-phrase-label";
    const list = createElement("ul", "builder-phrase-list");
    list.setAttribute("aria-labelledby", "builder-phrase-label");

    const currentPhrases = () => {
        const section = (configRef() || {})[DETECTOR_TYPE.PHRASE] || {};
        return Array.isArray(section.phrases) ? section.phrases : [];
    };

    const renderList = (phrases) => {
        list.replaceChildren();
        phrases.forEach((phrase) => {
            const item = createElement("li", "");
            const remove = createElement("button", "button button-small", "Remove");
            remove.type = "button";
            remove.setAttribute("aria-label", `Remove phrase ${phrase}`);
            remove.addEventListener("click", () => {
                const next = currentPhrases().filter((entry) => entry !== phrase);
                onConfigChange(DETECTOR_TYPE.PHRASE, { phrases: next });
                renderList(next);
                refreshStatus();
            });
            item.append(createElement("span", "", phrase), remove);
            list.append(item);
        });
        if (phrases.length === 0) {
            list.append(createElement("li", "builder-empty", "No phrases yet."));
        }
    };
    renderList(currentPhrases());

    const input = createElement("input", "text-input");
    input.type = "text";
    input.id = "builder-phrase-input";
    input.placeholder = "you won't believe this";
    input.autocomplete = "off";
    const addRow = createElement("div", "builder-add-row");
    const addButton = createElement("button", "button", "Add phrase");
    addButton.type = "button";
    const commitAdd = () => {
        const value = input.value.trim();
        if (value.length === 0) return;
        const current = currentPhrases();
        if (current.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
            input.value = "";
            return;
        }
        const next = [...current, value];
        onConfigChange(DETECTOR_TYPE.PHRASE, { phrases: next });
        renderList(next);
        refreshStatus();
        input.value = "";
        input.focus();
    };
    addButton.addEventListener("click", commitAdd);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            commitAdd();
        }
    });
    addRow.append(input, addButton);
    wrap.append(label, list, addRow);
    return wrap;
}

function createBuilderSection(descriptor, liveConfig, onConfigChange) {
    const { type, title } = descriptor;
    const details = createElement("details", "builder-section");
    details.dataset.detector = type;
    const summary = createElement("summary", "builder-summary");
    const status = createElement("span", "builder-status", "");
    summary.append(createElement("span", "builder-name", title), status);
    details.append(summary);

    const body = createElement("div", "builder-controls");
    // liveConfig is shared by reference and mutated in place by
    // the card's change handler, so sections always read fresh
    // values without a re-render.
    const configRef = () => liveConfig;
    const refreshStatus = () => {
        const options = resolveSectionConfig(liveConfig, type);
        if (options.enabled !== true) {
            status.textContent = "Off";
            return;
        }
        // Sections without a sensitivity control show no
        // sensitivity in their status either.
        const sensitivity = descriptor.sensitivity === false
            ? ""
            : ` · ${describeSensitivity(options.sensitivity)}`;
        // A term-based detector with no terms is effectively
        // idle (runDetectors skips empty term lists); say so.
        const terms = type === DETECTOR_TYPE.KEYWORD ? (options.keywords || [])
            : type === DETECTOR_TYPE.PHRASE ? (options.phrases || [])
            : null;
        const idle = Array.isArray(terms) && terms.length === 0 ? " · no terms" : "";
        status.textContent = `On${sensitivity}${idle}`;
    };

    const options = resolveSectionConfig(liveConfig, type);
    body.append(createEnableRow(type, title, options, onConfigChange, refreshStatus));
    // Sensitivity is only exposed where it changes detector
    // behavior (score thresholds). Keyword/phrase emit on any
    // match at every sensitivity — their vocabulary is the
    // control, so no sensitivity UI is shown.
    if (descriptor.sensitivity !== false) {
        body.append(createSensitivityFieldset(type, options, onConfigChange, refreshStatus));
    }
    body.append(createElement("p", "builder-note", descriptor.blurb));
    if (descriptor.vocabulary) {
        body.append(createVocabularyNote(descriptor.vocabulary, descriptor.vocabNote));
    }
    if (descriptor.fixedNote) {
        body.append(createElement("p", "builder-note", descriptor.fixedNote));
    }
    if (descriptor.input === "keyword") {
        body.append(createKeywordInput(options, onConfigChange, refreshStatus));
    }
    if (descriptor.input === "phrase") {
        body.append(createPhraseList(configRef, onConfigChange, refreshStatus));
    }
    refreshStatus();
    details.append(body);
    return details;
}

function createBuilderCard(config, onConfigChange) {
    const card = createElement("article", "card");
    card.dataset.section = "analysis-builder";
    card.append(createElement("h2", "card-title", "What are you looking for?"));
    card.append(createElement("p", "card-body",
        "Choose which detectors run when you tap Run analysis. " +
        "The builder only configures the analysis — matching and scoring stay in the detector layer."));
    // Shared, mutable view of the committed config: every
    // section reads and writes through this one object, so
    // handlers never close over stale state. The canonical
    // config itself lives in app state (see onConfigChange).
    const liveConfig = { ...(config || {}) };
    const wrappedOnChange = (type, patch) => {
        liveConfig[type] = { ...(liveConfig[type] || {}), ...patch };
        onConfigChange(type, patch);
    };
    for (const descriptor of BUILDER_SECTIONS) {
        card.append(createBuilderSection(descriptor, liveConfig, wrappedOnChange));
    }
    return card;
}

// Every evidence item is shown with its traceability: type,
// provenance, reliability, transcript id, and segment ids.
// Detector evidence additionally shows which detector fired,
// its score, and the matched signals — the explainability the
// detector layer guarantees. Analysis is never displayed as
// anonymous detached text.
// ---------- Evidence timestamp navigation ----------
//
// Evidence references transcript segments through
// sourceRef.segmentIds. The seek target is the first
// referenced segment with a valid numeric start time
// (segment.start.seconds — the canonical transcript
// timestamp). Multi-segment evidence uses the FIRST valid
// segment; a richer navigation policy can replace this
// later. Timestamps are never derived from quote text,
// scores, evidence ids, or array positions — and never
// fabricated: no valid segment start means no seek target.

/**
 * Resolve the seek target (seconds) for an evidence item,
 * or null when no referenced segment has a valid start.
 * Pure and deterministic.
 */
export function resolveEvidenceTimestamp(evidence, transcript) {
    const segmentIds = evidence && evidence.sourceRef && evidence.sourceRef.segmentIds;
    const segments = transcript && transcript.segments;
    if (!Array.isArray(segmentIds) || !Array.isArray(segments)) return null;
    const byId = new Map();
    for (const segment of segments) {
        if (segment && typeof segment.id === "string") byId.set(segment.id, segment);
    }
    for (const id of segmentIds) {
        const segment = byId.get(id);
        const seconds = segment && segment.start ? segment.start.seconds : undefined;
        if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
            return seconds;
        }
    }
    return null;
}

/**
 * Human-readable timestamp: "MM:SS" under an hour,
 * "HH:MM:SS" at or above. Rounds to whole seconds;
 * never negative.
 */
export function formatTimestamp(totalSeconds) {
    const total = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    return hours > 0 ? `${String(hours).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Spoken timestamp for accessible labels:
 * "1 minute 23 seconds", "8 seconds", "1 hour 2 minutes".
 */
export function describeTimestamp(totalSeconds) {
    const total = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    if (seconds > 0 || parts.length === 0) {
        parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
    }
    return parts.join(" ");
}

function createEvidenceCard(evidence, index, seekContext = null) {
    const card = createElement("article", "card");
    card.dataset.section = "evidence";
    card.append(createElement("span", "tag", "Evidence"));
    card.append(createElement("h2", "card-title", `Evidence ${index + 1}`));
    const details = [
        ["Type", evidence.type],
        ["Provenance", evidence.provenance],
        ["Reliability", evidence.reliability],
        ["Transcript", evidence.sourceRef.transcriptId],
        ["Segments", evidence.sourceRef.segmentIds.join(", ")]
    ];
    const content = evidence.content || {};
    if (typeof content.detector === "string") {
        details.push(["Detector", content.detector]);
        details.push(["Score", String(content.score)]);
        details.push(["Signals", (content.signals || []).join("; ")]);
    }
    card.append(createDetailList(details));
    // Timestamp navigation: a real button, only when the
    // evidence resolves to a transcript timestamp AND a
    // playable video exists. The click hands seconds to the
    // app's player coordinator — this view never touches
    // iframes, drivers, or postMessage.
    if (seekContext && seekContext.playerAvailable &&
        typeof seekContext.onSeekTimestamp === "function") {
        const seconds = resolveEvidenceTimestamp(evidence, seekContext.transcript);
        if (seconds !== null) {
            const seekButton = createElement(
                "button", "button button-small timestamp-button",
                `▶ ${formatTimestamp(seconds)}`
            );
            seekButton.type = "button";
            seekButton.setAttribute("aria-label", `Seek player to ${describeTimestamp(seconds)}`);
            seekButton.addEventListener("click", () => seekContext.onSeekTimestamp(seconds));
            card.append(seekButton);
        }
    }
    const quote = evidence.content && evidence.content.quote !== undefined
        ? String(evidence.content.quote)
        : JSON.stringify(evidence.content);
    card.append(createElement("h3", "card-subtitle", "Content"));
    card.append(createElement("pre", "evidence-quote", quote));
    return card;
}

function createResultsCard(request, result) {
    const card = createElement("article", "card");
    card.dataset.section = "analysis-result";
    card.append(createElement("span", "tag", "Result"));
    card.append(createElement("h2", "card-title", "Analysis result"));
    const scopeText = request.chunkId
        ? `chunk ${request.chunkId} (${request.scope.segmentIds.length} segments)`
        : `full transcript (${request.scope.type})`;
    card.append(createDetailList([
        ["Request", request.id],
        ["Scope", scopeText],
        ["Evidence items", String(result.evidence.length)]
    ]));
    result.observations.forEach((observation) => {
        card.append(createElement("p", "card-body", String(observation)));
    });
    result.limitations.forEach((limitation) => {
        card.append(createElement("p", "card-body", `Limitation: ${String(limitation)}`));
    });
    return card;
}

function createAnalysisPlayerCard(player) {
    const card = createElement("article", "card preview-player");
    card.dataset.section = "analysis-player";
    card.append(
        createElement("span", "tag", "VOD player"),
        createElement("h2", "card-title", "Seek target")
    );
    if (player && player.available && player.mount) {
        card.append(createElement("p", "card-body",
            "Tap a timestamp on any evidence card to seek this player."));
        card.append(player.mount);
    } else {
        card.append(createElement("p", "card-body",
            "Load a video on the Dashboard to enable timestamp seeking."));
    }
    return card;
}

/**
 * @param {HTMLElement} mountElement
 * @param {object|null} project
 * @param {object|null} [analysisView]  { analysis, onAnalyze, builder, player, onSeekTimestamp }.
 *        analysis: { status: "idle"|"running"|"done"|"error", request?, result?, error? }.
 *        builder: { config, onConfigChange } | null — the analysis
 *        builder card. Omitted → scope controls only.
 *        player: { mount, available } | null — the embedded VOD
 *        player for timestamp seeking. The mount is a live
 *        element owned by the app's player coordinator;
 *        re-attaching it across re-renders never reloads the
 *        video. This view never creates iframes or builds
 *        embed URLs.
 *        onSeekTimestamp: (seconds) => void — provider-neutral
 *        seek request; the coordinator/controller owns how the
 *        seek is performed.
 *        Omitted entirely → scope controls only (read-only rendering).
 */
export function renderAnalysisView(mountElement, project, analysisView = null) {
    const transcript = project ? project.transcript : null;
    if (!transcript) {
        mountElement.replaceChildren(createEmptyCard());
        return;
    }

    const analysis = (analysisView && analysisView.analysis) || { status: "idle" };
    const onAnalyze = (analysisView && analysisView.onAnalyze) || (() => {});
    const builder = analysisView && analysisView.builder;
    const player = analysisView && analysisView.player;
    const onSeekTimestamp = analysisView && analysisView.onSeekTimestamp;

    const sections = [createScopeCard(transcript, onAnalyze)];
    if (builder) {
        sections.push(createBuilderCard(
            builder.config || {},
            typeof builder.onConfigChange === "function" ? builder.onConfigChange : () => {}
        ));
    }
    if (player) {
        sections.push(createAnalysisPlayerCard(player));
    }
    const statusCard = createStatusCard(analysis);
    if (statusCard) sections.push(statusCard);
    if (analysis.status === "done" && analysis.request && analysis.result) {
        sections.push(createResultsCard(analysis.request, analysis.result));
        const seekContext = onSeekTimestamp ? {
            transcript,
            playerAvailable: Boolean(player && player.available),
            onSeekTimestamp
        } : null;
        analysis.result.evidence.forEach((item, index) => {
            sections.push(createEvidenceCard(item, index, seekContext));
        });
    }
    mountElement.replaceChildren(...sections);
}

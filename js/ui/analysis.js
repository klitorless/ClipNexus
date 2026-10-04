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
        return createInfoCard("Analysis running", "The analyzer is processing the selected scope.", "Working", "tag");
    }
    if (analysis.status === "error") {
        return createInfoCard("Analysis failed", analysis.error || "Unknown error.", "Error", "tag tag-danger");
    }
    return null;
}

// Every evidence item is shown with its traceability: type,
// provenance, reliability, transcript id, and segment ids.
// Detector evidence additionally shows which detector fired,
// its score, and the matched signals — the explainability the
// detector layer guarantees. Analysis is never displayed as
// anonymous detached text.
function createEvidenceCard(evidence, index) {
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

/**
 * @param {HTMLElement} mountElement
 * @param {object|null} project
 * @param {object|null} [analysisView]  { analysis, onAnalyze }.
 *        analysis: { status: "idle"|"running"|"done"|"error", request?, result?, error? }.
 *        Omitted → scope controls only (read-only rendering).
 */
export function renderAnalysisView(mountElement, project, analysisView = null) {
    const transcript = project ? project.transcript : null;
    if (!transcript) {
        mountElement.replaceChildren(createEmptyCard());
        return;
    }

    const analysis = (analysisView && analysisView.analysis) || { status: "idle" };
    const onAnalyze = (analysisView && analysisView.onAnalyze) || (() => {});

    const sections = [createScopeCard(transcript, onAnalyze)];
    const statusCard = createStatusCard(analysis);
    if (statusCard) sections.push(statusCard);
    if (analysis.status === "done" && analysis.request && analysis.result) {
        sections.push(createResultsCard(analysis.request, analysis.result));
        analysis.result.evidence.forEach((item, index) => {
            sections.push(createEvidenceCard(item, index));
        });
    }
    mountElement.replaceChildren(...sections);
}

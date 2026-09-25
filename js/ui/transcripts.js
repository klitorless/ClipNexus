// ==========================================================
// transcripts.js
// Responsibility: build the Transcripts view for the project's
// canonical TranscriptDocument, headed by the linked video and
// (Stage 2A) the provider acquisition panel.
// Read-only; never modifies the project or document.
//
// SECURITY: transcript content is untrusted. It is only ever
// inserted with textContent, never innerHTML.
// ==========================================================

import { getFormatById } from "../transcript/formats.js";
import { createTranscriptSummaryCard } from "./dashboard.js";
import { createElement, createDetailList } from "./dom.js";
import { createLinkedVideoCard } from "./project-panel.js";
import { createAcquisitionPanel } from "./acquisition-panel.js";

const previewLineLimit = 30;

const statusLabels = {
    pending: "Pending",
    not_implemented: "Not implemented (Stage 2)",
    complete: "Complete",
    failed: "Failed",
    unvalidated: "Unvalidated",
    passed: "Passed",
    issues_found: "Issues found"
};

// Count lines without splitting (avoids copying the whole transcript).
function countLines(text) {
    if (text.length === 0) return 0;
    let lines = 1;
    let position = text.indexOf("\n");
    while (position !== -1) {
        lines += 1;
        position = text.indexOf("\n", position + 1);
    }
    // A final newline ends the last line; it does not start a new one.
    return text.endsWith("\n") ? lines - 1 : lines;
}

// Slice only the first N lines for display.
function getPreview(text, lineLimit) {
    let end = -1;
    for (let line = 0; line < lineLimit; line += 1) {
        end = text.indexOf("\n", end + 1);
        if (end === -1) return { preview: text, truncated: false };
    }
    return { preview: text.slice(0, end), truncated: end < text.length - 1 };
}

function createPipelineCard(transcript) {
    const card = createElement("article", "card");
    card.append(createElement("h2", "card-title", "Processing layers"));
    card.append(createDetailList([
        ["Parse", statusLabels[transcript.parse.status] || transcript.parse.status],
        ["Segments", transcript.segments.length],
        ["Validation", statusLabels[transcript.validation.status] || transcript.validation.status],
        ["Issues", transcript.validation.issues.length],
        ["Chunks", transcript.chunks.length]
    ]));
    transcript.parse.notes.forEach((note) => card.append(createElement("p", "card-body", note)));
    return card;
}

function createRawPreviewCard(rawText) {
    const card = createElement("article", "card");
    const { preview, truncated } = getPreview(rawText, previewLineLimit);

    card.append(createElement("span", "tag", "Source evidence"));
    card.append(createElement("h2", "card-title", "Raw transcript"));
    card.append(createElement("p", "card-body",
        truncated
            ? `First ${previewLineLimit} lines, exactly as loaded. Stored unmodified.`
            : "Full file, exactly as loaded. Stored unmodified."));
    card.append(createElement("pre", "raw-preview", preview));
    return card;
}

function createEmptyCard() {
    const card = createElement("article", "card");
    card.append(
        createElement("h2", "card-title", "No transcript loaded"),
        createElement("p", "card-body",
            "Use Upload Transcript to import a transcript file, or choose a provider above. " +
            "Imported files stay in this browser and are not uploaded anywhere.")
    );
    return card;
}

/**
 * @param {HTMLElement} mountElement
 * @param {object|null} project
 * @param {object|null} [acquisitionView]  { acquisition, providers, onSelectionChange, onAcquire }.
 *        Omitted → no acquisition panel (read-only rendering).
 */
export function renderTranscriptsView(mountElement, project, acquisitionView = null) {
    const transcript = project ? project.transcript : null;
    const header = [createLinkedVideoCard(project)];
    if (acquisitionView) header.push(createAcquisitionPanel({ project, ...acquisitionView }));

    if (!transcript) {
        mountElement.replaceChildren(...header, createEmptyCard());
        return;
    }

    const format = getFormatById(transcript.source.format);
    const sourceCard = createTranscriptSummaryCard(transcript, [
        ["Format", format ? format.label : transcript.source.format],
        ["Characters", transcript.rawText.length.toLocaleString()],
        ["Lines", countLines(transcript.rawText).toLocaleString()]
    ]);

    mountElement.replaceChildren(
        ...header,
        sourceCard,
        createPipelineCard(transcript),
        createRawPreviewCard(transcript.rawText)
    );
}

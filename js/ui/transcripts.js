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
import { ACQUISITION_TYPE, TIMESTAMP_STATUS } from "../transcript/model.js";

const previewLineLimit = 30;
const segmentPreviewLimit = 20;

const statusLabels = {
    pending: "Pending",
    not_implemented: "Not implemented yet",
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

// Display only: derived seconds → m:ss.mmm. Unknown values say so — never 0.
function formatTimestamp(timestamp) {
    if (timestamp.seconds === null) {
        return timestamp.status === TIMESTAMP_STATUS.MISSING ? "no time" : timestamp.status;
    }
    const total = timestamp.seconds;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = (total % 60).toFixed(3).padStart(6, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// Stage 2B: first parsed segments (derived data, shown as text only).
function createSegmentPreviewCard(segments) {
    const card = createElement("article", "card");
    card.dataset.section = "segments";
    card.append(createElement("span", "tag", "Derived"));
    card.append(createElement("h2", "card-title", "Parsed segments"));
    card.append(createElement("p", "card-body", segments.length > segmentPreviewLimit
        ? `First ${segmentPreviewLimit} of ${segments.length.toLocaleString()} segments. Times are derived from the raw values.`
        : "All segments. Times are derived from the raw values."));
    const list = createElement("ol", "segment-list");
    segments.slice(0, segmentPreviewLimit).forEach((segment) => {
        const item = createElement("li", "segment-item");
        item.append(createElement("span", "segment-time", formatTimestamp(segment.start)),
            createElement("span", "segment-text", segment.text));
        list.append(item);
    });
    card.append(list);
    return card;
}

function createRawPreviewCard(rawText, fromProvider) {
    const card = createElement("article", "card");
    const { preview, truncated } = getPreview(rawText, previewLineLimit);
    const origin = fromProvider
        ? "Provider text and timing values exactly as delivered, one record per line. Stored unmodified."
        : "Exactly as loaded. Stored unmodified.";

    card.append(createElement("span", "tag", "Source evidence"));
    card.append(createElement("h2", "card-title", "Raw transcript"));
    card.append(createElement("p", "card-body",
        truncated ? `First ${previewLineLimit} lines. ${origin}` : `Full transcript. ${origin}`));
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
        ...(transcript.segments.length ? [createSegmentPreviewCard(transcript.segments)] : []),
        createRawPreviewCard(transcript.rawText,
            Boolean(transcript.acquisition && transcript.acquisition.type === ACQUISITION_TYPE.PROVIDER))
    );
}

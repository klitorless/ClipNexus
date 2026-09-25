// ==========================================================
// dashboard.js
// Responsibility: build the Dashboard view (stats, project
// status, loaded transcript summary). Pure DOM building —
// receives data, returns elements.
// ==========================================================

import { createElement, createDetailList } from "./dom.js";

export function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function createStatCard(label, value) {
    const card = createElement("article", "card");
    card.append(
        createElement("p", "stat-label", label),
        createElement("p", "stat-value", String(value))
    );
    return card;
}

function createStatusCard() {
    const card = createElement("article", "card");
    card.append(
        createElement("span", "tag", "In progress"),
        createElement("h2", "card-title", "Stage 1 — Application Shell"),
        createElement(
            "p",
            "card-body",
            "Transcript parsing, validation, chunking, AI analysis, POI extraction, " +
            "event reconciliation, and clip construction will be added as independent modules."
        )
    );
    return card;
}

// Shared by Dashboard and Transcripts views.
// transcript: canonical TranscriptDocument (read-only).
// extraRows: optional [label, value] pairs appended to the details.
export function createTranscriptSummaryCard(transcript, extraRows = []) {
    const card = createElement("article", "card");
    card.append(
        createElement("h2", "card-title", "Loaded transcript"),
        createDetailList([
            ["Filename", transcript.source.filename],
            ["File size", formatFileSize(transcript.source.size)],
            ...extraRows
        ])
    );
    return card;
}

export function renderDashboard(mountElement, appState) {
    const transcript = appState.get("transcript");
    const transcriptCount = transcript ? 1 : 0;

    const stats = createElement("div", "stat-grid");
    stats.append(
        createStatCard("Transcripts", transcriptCount),
        createStatCard("POIs discovered", appState.get("pois").length),
        createStatCard("Clip candidates", appState.get("clips").length)
    );

    mountElement.replaceChildren(stats, createStatusCard());

    if (transcript) {
        mountElement.append(createTranscriptSummaryCard(transcript));
    }
}

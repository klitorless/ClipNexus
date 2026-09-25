// ==========================================================
// dashboard.js
// Responsibility: build the Dashboard view (video URL form,
// project card, stats, stage status, loaded transcript
// summary). Pure DOM building — receives data + callbacks,
// returns elements.
// ==========================================================

import { createElement, createDetailList } from "./dom.js";
import { createVideoUrlForm, createProjectCard } from "./project-panel.js";
import { createProvenanceRows } from "./provenance.js";

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
        createElement("span", "tag", "Current stage"),
        createElement("h2", "card-title", "Stage 2A — Transcript Acquisition Architecture"),
        createElement(
            "p",
            "card-body",
            "Available now: identify a YouTube video from its URL (including a start-time hint), " +
            "import a transcript file as raw source evidence, and choose a transcript provider, " +
            "language, and acquisition method on the Transcripts page."
        ),
        createElement(
            "p",
            "card-body",
            "Providers are architecture only: none is connected, so no transcript is retrieved from " +
            "the internet yet. Also not built: transcript parsing, video metadata, an embedded player, " +
            "AI analysis, POIs, and clips. Projects are lost when the page reloads."
        ),
        createElement(
            "p",
            "field-hint",
            "Completed: Stage 1.5 — Transcript Data Foundation · Stage 1.6 — Project & Video Foundation · " +
            "Stage 1.7 — Project & Video Foundation Hardening"
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
            ...createProvenanceRows(transcript.acquisition),
            ...(transcript.source.filename !== null ? [["Filename", transcript.source.filename]] : []),
            [transcript.source.filename !== null ? "File size" : "Size", formatFileSize(transcript.source.size)],
            ...extraRows
        ])
    );
    return card;
}

/**
 * @param {HTMLElement} mountElement
 * @param {object} appState
 * @param {{onVideoUrlSubmit: (url:string) => {ok:boolean, message:string}}} handlers
 */
export function renderDashboard(mountElement, appState, handlers) {
    const project = appState.get("project");
    const transcript = project ? project.transcript : null;

    const stats = createElement("div", "stat-grid");
    stats.append(
        createStatCard("Transcripts", transcript ? 1 : 0),
        createStatCard("POIs discovered", project ? project.pois.length : 0),
        createStatCard("Clip candidates", project ? project.clips.length : 0)
    );

    mountElement.replaceChildren(
        createVideoUrlForm({ onSubmit: handlers.onVideoUrlSubmit, notice: appState.get("ui").videoUrlNotice || null }),
        createProjectCard(project),
        stats,
        createStatusCard()
    );

    if (transcript) {
        mountElement.append(createTranscriptSummaryCard(transcript));
    }
}

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
        createElement("span", "tag", "About"),
        createElement("h2", "card-title", "What VOD Analyzer does"),
        createElement(
            "p",
            "card-body",
            "Load a YouTube video, then add its transcript — upload a file, or fetch captions " +
            "with your own Supadata API key on the Transcripts page. Transcripts are parsed into " +
            "timestamped segments and validated: ordering, overlaps, and timing problems are " +
            "reported instead of hidden. The Analysis tab surfaces question patterns with " +
            "traceable evidence, and the Clip Queue pairs an embedded video player with clip " +
            "candidates you can seek through, Keep, or Reject."
        ),
        createElement(
            "p",
            "card-body",
            "Not built yet: automatic moment detection, AI editing, and publishing. The review " +
            "queue fills in once candidates can be derived inside the app. Projects and API keys " +
            "are forgotten when the page reloads."
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
        createStatCard("Clip candidates", project ? project.clipSpecs.length : 0)
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

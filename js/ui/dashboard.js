// ==========================================================
// dashboard.js
// Responsibility: build the Dashboard view (stats, project
// status, loaded transcript summary). Pure DOM building —
// receives data, returns elements.
// ==========================================================

export function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
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
export function createTranscriptSummaryCard(transcript) {
    const card = createElement("article", "card");
    card.append(createElement("h2", "card-title", "Loaded transcript"));

    const details = createElement("dl", "detail-list");
    details.append(
        createElement("dt", "", "Filename"),
        createElement("dd", "", transcript.name),
        createElement("dt", "", "File size"),
        createElement("dd", "", formatFileSize(transcript.size))
    );
    card.append(details);
    return card;
}

export function renderDashboard(mountElement, appState) {
    const transcript = appState.get("transcript");
    const transcriptCount = transcript ? 1 : 0;

    const stats = createElement("div", "stat-grid");
    stats.append(
        createStatCard("Transcripts", transcriptCount),
        createStatCard("POIs discovered", 0),
        createStatCard("Clip candidates", 0)
    );

    mountElement.replaceChildren(stats, createStatusCard());

    if (transcript) {
        mountElement.append(createTranscriptSummaryCard(transcript));
    }
}

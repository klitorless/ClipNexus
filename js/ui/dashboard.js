// ==========================================================
// dashboard.js
// Responsibility: build the Dashboard view — the control
// center. Video URL form (primary action), project context
// hero, pipeline status, contextual next actions, the honest
// "about" card, and the loaded transcript summary.
//
// Pure DOM building — receives data + callbacks, returns
// elements. Every status shown comes from real application
// state; nothing is invented.
// ==========================================================

import { createElement, createDetailList } from "./dom.js";
import { createVideoUrlForm, createProjectCard } from "./project-panel.js";
import { createProvenanceRows } from "./provenance.js";
import { CLIP_DECISION, getClipDecision } from "../analysis/clip-decisions.js";

export function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function createStatusCard() {
    const card = createElement("article", "card");
    card.append(
        createElement("span", "tag", "About"),
        createElement("h2", "card-title", "What ClipNexus does"),
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

// Pipeline strip: one row per stage with a real count and an
// honest done/empty dot. No invented metrics.
function createPipelineCard(project) {
    const card = createElement("article", "card");
    card.append(createElement("h2", "card-title", "Project pipeline"));

    const transcript = project ? project.transcript : null;
    const pois = project ? project.pois.length : 0;
    const events = project ? project.events.length : 0;
    const specs = project ? project.clipSpecs.length : 0;
    const kept = project
        ? project.clipSpecs.filter((spec) => getClipDecision(project.clipDecisions, spec.id) === CLIP_DECISION.KEEP).length
        : 0;

    const rows = [
        {
            label: "Transcript",
            done: transcript !== null,
            detail: transcript ? `${transcript.segments.length.toLocaleString()} segments` : "Not loaded"
        },
        {
            label: "POIs",
            done: pois > 0,
            detail: pois > 0 ? `${pois} discovered` : "None yet"
        },
        {
            label: "Events",
            done: events > 0,
            detail: events > 0 ? `${events} reconciled` : "None yet"
        },
        {
            label: "Clip candidates",
            done: specs > 0,
            detail: specs > 0 ? `${specs} candidates · ${kept} kept` : "None yet"
        }
    ];

    const list = createElement("ul", "pipeline-list");
    rows.forEach(({ label, done, detail }) => {
        const item = createElement("li", "pipeline-item");
        const dot = createElement("span", `pipeline-dot ${done ? "is-done" : "is-empty"}`, done ? "✓" : "○");
        dot.setAttribute("aria-hidden", "true");
        item.append(
            dot,
            createElement("span", "pipeline-label", label),
            createElement("span", "pipeline-detail", detail)
        );
        list.append(item);
    });
    card.append(list);
    return card;
}

// Next actions derived from real state. Each item links to the
// route where the action happens.
function createNextActionsCard(project) {
    const card = createElement("article", "card");
    card.append(createElement("h2", "card-title", "Next actions"));

    const transcript = project ? project.transcript : null;
    const specs = project ? project.clipSpecs : [];
    const undecided = specs.filter((spec) =>
        getClipDecision(project.clipDecisions, spec.id) === null).length;

    const actions = [];
    if (!project || !project.video) {
        actions.push({
            link: null, text: "Load a video",
            hint: "Enter a YouTube URL in the form above to start a project."
        });
    } else if (!transcript) {
        actions.push({
            link: "#transcripts", text: "Add a transcript",
            hint: "Upload a file or fetch captions with a provider key."
        });
    } else {
        if (project.pois.length === 0) {
            actions.push({
                link: "#analysis", text: "Run analysis",
                hint: "Surface question patterns with traceable evidence."
            });
        }
        if (undecided > 0) {
            actions.push({
                link: "#clips", text: `Review ${undecided} candidate${undecided === 1 ? "" : "s"}`,
                hint: "Watch each moment, then Keep or Reject it."
            });
        } else if (specs.length > 0) {
            actions.push({
                link: null, text: "All candidates reviewed",
                hint: "Reset a decision in the Clip Queue to revisit it."
            });
        }
    }

    if (actions.length === 0) {
        card.append(createElement("p", "card-body", "Nothing pending."));
        return card;
    }

    const list = createElement("ul", "action-list");
    actions.forEach(({ link, text, hint }) => {
        const item = createElement("li", "action-item");
        if (link) {
            const anchor = createElement("a", "action-link", text);
            anchor.href = link;
            item.append(anchor);
        } else {
            item.append(createElement("span", "pipeline-label", text));
        }
        item.append(createElement("span", "action-hint", hint));
        list.append(item);
    });
    card.append(list);
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

    mountElement.replaceChildren(
        createVideoUrlForm({
            onSubmit: handlers.onVideoUrlSubmit,
            notice: appState.get("ui").videoUrlNotice || null,
            apiKey: handlers.youTubeApiKey || null
        }),
        createProjectCard(project),
        createPipelineCard(project),
        createNextActionsCard(project),
        createStatusCard()
    );

    if (transcript) {
        mountElement.append(createTranscriptSummaryCard(transcript));
    }
}

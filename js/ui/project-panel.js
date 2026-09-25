// ==========================================================
// project-panel.js
// Responsibility: build the Video URL form and the Project
// card. Displays only what is actually known; unknown values
// are shown as "Not loaded" (display text, never stored).
//
// SECURITY: URL input is untrusted. It is only read from the
// input's .value and displayed with textContent. No links or
// images are created from it.
// ==========================================================

import { createElement, createDetailList } from "./dom.js";
import { getProjectStage, PROJECT_STAGE } from "../core/project.js";
import { getPlatformLabel } from "../video/video-resolver.js";

const notLoaded = "Not loaded";

const stageLabels = {
    [PROJECT_STAGE.NONE]: "No project",
    [PROJECT_STAGE.CREATED]: "Project created",
    [PROJECT_STAGE.VIDEO_IDENTIFIED]: "Video identified",
    [PROJECT_STAGE.TRANSCRIPT_ATTACHED]: "Transcript attached (no video)",
    [PROJECT_STAGE.VIDEO_AND_TRANSCRIPT]: "Video identified · Transcript attached"
};

const metadataStatusLabels = {
    unknown: "Not requested (metadata loading not implemented yet)"
};

/**
 * @param {object} options
 * @param {(url:string) => {ok:boolean, message:string}} options.onSubmit
 *        Called with the raw input value. Returns a message to show.
 * @param {{ok:boolean, message:string}|null} [options.notice]
 *        Last result to show after a re-render.
 */
export function createVideoUrlForm({ onSubmit, notice = null }) {
    const form = createElement("form", "card url-form");
    form.noValidate = true;

    const label = createElement("label", "field-label", "Video URL");
    label.htmlFor = "video-url-input";

    const row = createElement("div", "field-row");
    const input = createElement("input", "text-input");
    Object.assign(input, {
        id: "video-url-input",
        type: "text",
        inputMode: "url",
        autocomplete: "off",
        spellcheck: false,
        placeholder: "https://www.youtube.com/watch?v=…"
    });
    input.setAttribute("autocapitalize", "off");

    const button = createElement("button", "button button-primary", "Load Video");
    button.type = "submit";
    row.append(input, button);

    const message = createElement("p", "field-message");
    message.setAttribute("role", "status");

    const showNotice = (result) => {
        message.textContent = result.message;
        message.classList.toggle("is-error", !result.ok);
    };
    if (notice) showNotice(notice);

    form.append(label, row, message);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        showNotice(onSubmit(input.value));
    });
    return form;
}

function describeVideoRows(video) {
    if (!video) return [["Video", notLoaded]];
    const { identity, metadata } = video;
    return [
        ["Platform", getPlatformLabel(identity.platform)],
        ["Video ID", identity.videoId],
        ["Canonical URL", identity.canonicalUrl],
        ["Title", metadata.title ?? notLoaded],
        ["Duration", metadata.durationSeconds ?? notLoaded],
        ["Metadata", metadataStatusLabels[metadata.status] || metadata.status]
    ];
}

function describeTranscriptRow(transcript) {
    if (!transcript) return ["Transcript", notLoaded];
    return ["Transcript", transcript.source.filename];
}

export function createProjectCard(project) {
    const card = createElement("article", "card");
    card.append(createElement("h2", "card-title", "Project"));

    if (!project) {
        card.append(createElement("p", "card-body", "No video loaded. Enter a video URL to start a project."));
        return card;
    }

    card.append(createDetailList([
        ["Status", stageLabels[getProjectStage(project)]],
        ...describeVideoRows(project.video),
        describeTranscriptRow(project.transcript)
    ]));
    return card;
}

// ==========================================================
// project-panel.js
// Responsibility: build the Video URL form (with its inline
// replace confirmation), the Project card, and the Linked
// video card shown on the Transcripts page. Displays only what is actually known; unknown values
// are shown as "Not loaded" (display text, never stored).
//
// SECURITY: URL input is untrusted. It is only read from the
// input's .value and displayed with textContent. No links or
// images are created from it. Source URLs are shown as text,
// never as clickable links, and no iframe is ever created.
// ==========================================================

import { createElement, createDetailList } from "./dom.js";
import { getPlatformLabel } from "../video/video-resolver.js";

const notLoaded = "Not loaded";

const metadataStatusLabels = {
    unknown: "Not available yet",
    loading: "Loading…",
    loaded: "Loaded",
    unavailable: "Not available",
    failed: "Could not load"
};

/**
 * @param {object} options
 * @param {(url:string) => object} options.onSubmit
 *        Called with the raw input value. Returns a notice:
 *        {ok, message} or {ok, confirm:true, message, onConfirm, onCancel}.
 * @param {{ok:boolean, message:string}|null} [options.notice]
 *        Last result to show after a re-render.
 * @param {object|null} [options.apiKey]
 *        Optional YouTube Data API key controls:
 *        { ready:boolean, onSave:(value)=>boolean, onClear:()=>void }.
 *        The key is held in memory for the page session only and is
 *        used solely to fetch video titles from YouTube.
 */
export function createVideoUrlForm({ onSubmit, notice = null, apiKey = null, bare = false }) {
    // bare: render without the card chrome so a caller can wrap the
    // form in its own card (e.g. the Dashboard "Create Project"
    // intake card).
    const form = createElement("form", bare ? "url-form" : "card url-form");
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

    const confirmPanel = createElement("div", "confirm-panel");
    confirmPanel.setAttribute("role", "alertdialog");
    confirmPanel.setAttribute("aria-label", "Replace current project?");
    confirmPanel.hidden = true;

    const setBusy = (busy) => {
        input.disabled = busy;
        button.disabled = busy;
    };

    const showNotice = (result) => {
        confirmPanel.hidden = true;
        confirmPanel.replaceChildren();
        setBusy(false);
        message.textContent = result.message;
        message.classList.toggle("is-error", !result.ok);
        if (result.confirm) showConfirmation(result);
    };

    // Inline confirmation (no native dialog: some Android WebViews block it).
    function showConfirmation(result) {
        message.textContent = "";
        const text = createElement("p", "card-body", result.message);
        const actions = createElement("div", "field-row");
        const cancel = createElement("button", "button", "Cancel");
        const replace = createElement("button", "button button-danger", "Replace Project");
        cancel.type = "button";
        replace.type = "button";
        cancel.addEventListener("click", () => showNotice(result.onCancel()));
        replace.addEventListener("click", () => showNotice(result.onConfirm()));
        actions.append(cancel, replace);
        confirmPanel.append(text, actions);
        confirmPanel.hidden = false;
        setBusy(true);
        cancel.focus();
    }

    if (notice) showNotice(notice);

    form.append(label, row, message, confirmPanel);
    if (apiKey) form.append(createYouTubeKeyField(apiKey));
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        showNotice(onSubmit(input.value));
    });
    return form;
}

// Optional YouTube Data API key. Same security posture as the
// provider credential fields: the key is never rendered back into
// the DOM, is held in memory for the page session only, and is
// used solely to fetch video titles. (File import is a planned
// later step; it will call the same onSave.)
function createYouTubeKeyField({ ready, onSave, onClear }) {
    const group = createElement("div", "field-group");
    group.dataset.section = "youtube-api-key";

    const label = createElement("label", "field-label", "YouTube Data API key (optional)");
    label.htmlFor = "youtube-api-key-input";
    group.append(label);

    if (ready) {
        const status = createElement("p", "credential-status", "Key entered for this page session.");
        const row = createElement("div", "field-row");
        const forget = createElement("button", "button", "Forget Key");
        forget.type = "button";
        forget.addEventListener("click", onClear);
        row.append(forget);
        group.append(status, row);
    } else {
        const row = createElement("div", "field-row");
        const input = createElement("input", "text-input");
        Object.assign(input, {
            id: "youtube-api-key-input",
            type: "password",
            autocomplete: "off",
            spellcheck: false,
            placeholder: "Paste your YouTube Data API key"
        });
        input.setAttribute("autocapitalize", "off");
        input.maxLength = 512;
        const save = createElement("button", "button", "Use Key");
        save.type = "button";
        const message = createElement("p", "field-hint field-error");
        message.setAttribute("role", "alert");
        message.hidden = true;
        save.addEventListener("click", () => {
            const accepted = onSave(input.value);
            input.value = "";                              // never keep it in the DOM
            if (accepted) return;
            message.textContent = "That does not look like an API key (no spaces, up to 512 characters).";
            message.hidden = false;
        });
        row.append(input, save);
        group.append(row, message);
    }

    group.append(createElement("p", "field-hint",
        "Shows the video's title next to its video ID. Without a key, ClipNexus keeps using the video ID and everything else works the same."));
    return group;
}

// "1:02:03" style display for a whole number of seconds.
function formatClock(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function describeStartPosition(startPosition) {
    if (!startPosition) return "None in URL";
    if (startPosition.seconds === null) {
        return `Not usable (${startPosition.status}: "${startPosition.raw}")`;
    }
    return `${formatClock(startPosition.seconds)} (${startPosition.seconds} s, from URL, unverified)`;
}

function describeVideoRows(video) {
    if (!video) return [["Video", notLoaded]];
    const { identity, metadata } = video;
    return [
        ["Video ID", identity.videoId],
        ["Canonical URL", identity.canonicalUrl],
        ["Start hint", describeStartPosition(video.startPosition)],
        ["Duration", metadata.durationSeconds === null ? "Not available yet" : formatClock(metadata.durationSeconds)],
        ["Metadata", metadataStatusLabels[metadata.status] || metadata.status]
    ];
}

function metadataTagClass(status) {
    if (status === "loaded") return "tag tag-success";
    if (status === "failed") return "tag tag-danger";
    return "tag tag-muted";
}

export function createProjectCard(project) {
    const card = createElement("article", "card");
    card.dataset.section = "project";

    if (!project || !project.video) {
        card.append(createElement("h2", "card-title", "Project"));
        card.append(createElement("p", "card-body", "No video loaded. Enter a video URL above to start a project."));
        return card;
    }

    const { identity, metadata } = project.video;
    const hero = createElement("div", "video-hero");

    const top = createElement("div", "video-hero-top");
    const icon = createElement("span", "video-hero-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▶";
    const titleBlock = createElement("div", "");
    titleBlock.append(
        createElement("h2", "video-hero-title", metadata.title ?? "Untitled video"),
        createElement("p", "video-hero-meta",
            `${getPlatformLabel(identity.platform)} · ${identity.videoId}`)
    );
    top.append(icon, titleBlock);

    const tags = createElement("div", "video-hero-tags");
    tags.append(
        createElement("span", "tag", getPlatformLabel(identity.platform)),
        createElement("span", metadataTagClass(metadata.status),
            metadata.status === "loaded" ? "Title loaded"
            : metadata.status === "loading" ? "Loading title…"
            : metadata.status === "failed" ? "Title unavailable"
            : "Title not loaded")
    );
    if (project.transcript) {
        tags.append(createElement("span", "tag tag-success", "Transcript attached"));
    }

    hero.append(top, tags);
    card.append(hero);
    card.append(createDetailList(describeVideoRows(project.video)));
    return card;
}

const alignmentLabels = {
    unverified: "Unverified — transcript times not confirmed to match this video"
};

// Transcripts page: which VOD this transcript belongs to.
export function createLinkedVideoCard(project) {
    const card = createElement("article", "card");
    card.dataset.section = "linked-video";
    card.append(createElement("span", "tag", "Project"));
    card.append(createElement("h2", "card-title", "Linked video"));

    if (!project || !project.video) {
        card.append(createElement("p", "card-body",
            "No video linked. Enter a video URL on the Dashboard to link this transcript to a VOD."));
        return card;
    }

    const { identity, metadata } = project.video;
    card.append(createDetailList([
        ["Platform", getPlatformLabel(identity.platform)],
        ["Video ID", identity.videoId],
        ["Title", metadata.title ?? notLoaded],
        ["Source", identity.canonicalUrl],
        ["Start hint", describeStartPosition(project.video.startPosition)],
        ["Time alignment", alignmentLabels[project.alignment.status] || project.alignment.status]
    ]));
    return card;
}

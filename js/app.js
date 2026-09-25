// ==========================================================
// app.js
// Responsibility: application entry point. Wires modules
// together (state, router, sidebar, views) and handles local
// transcript file loading. Contains no parsing or analysis.
//
// Privacy: files are read with File.text() and kept only in
// memory in this browser tab. Nothing is sent anywhere.
// ==========================================================

import { state } from "./core/state.js";
import { routes, startRouter, navigate } from "./core/router.js";
import { renderSidebar, setActiveNavItem } from "./ui/sidebar.js";
import { renderDashboard, createTranscriptSummaryCard } from "./ui/dashboard.js";

const supportedExtensions = ["txt", "srt", "vtt", "json"];

const elements = {
    sidebar: document.getElementById("sidebar-mount"),
    pageTitle: document.getElementById("page-title"),
    content: document.getElementById("content-mount"),
    uploadButton: document.getElementById("upload-button"),
    fileInput: document.getElementById("transcript-file-input")
};

// ---------- Views ----------

// Simple card used by sections that are not built yet.
function createInfoCard(title, bodyText, tagText, tagClass = "tag") {
    const card = document.createElement("article");
    card.className = "card";

    if (tagText) {
        const tag = document.createElement("span");
        tag.className = tagClass;
        tag.textContent = tagText;
        card.append(tag);
    }

    const heading = document.createElement("h2");
    heading.className = "card-title";
    heading.textContent = title;

    const body = document.createElement("p");
    body.className = "card-body";
    body.textContent = bodyText;

    card.append(heading, body);
    return card;
}

function renderTranscriptsView(mount) {
    const transcript = state.get("transcript");
    if (!transcript) {
        mount.replaceChildren(createInfoCard(
            "No transcript loaded",
            "Use Upload Transcript to select a .txt, .srt, .vtt, or .json file. " +
            "The file stays in this browser and is not uploaded anywhere."
        ));
        return;
    }
    mount.replaceChildren(
        createTranscriptSummaryCard(transcript),
        createInfoCard(
            "Transcript preview",
            "Parsing is not implemented yet. The raw file is held in memory for the next stage.",
            "Placeholder"
        )
    );
}

const placeholderText = {
    pois: "Evidence-supported Points of Interest will appear here.",
    events: "Reconciled event arcs across transcript windows will appear here.",
    clips: "Clip candidates prepared for human review will appear here.",
    analysis: "Provider-agnostic AI analysis runs will be managed here.",
    settings: "Analysis window, overlap, and provider settings will live here."
};

function renderPlaceholderView(mount, routeId) {
    mount.replaceChildren(createInfoCard("Not built yet", placeholderText[routeId], "Stage 1"));
}

function renderView(routeId) {
    const route = routes.find((item) => item.id === routeId);
    elements.pageTitle.textContent = route ? route.label : "Dashboard";
    document.title = `${elements.pageTitle.textContent} · VOD Analyzer`;

    if (routeId === "dashboard") renderDashboard(elements.content, state);
    else if (routeId === "transcripts") renderTranscriptsView(elements.content);
    else renderPlaceholderView(elements.content, routeId);

    setActiveNavItem(elements.sidebar, routeId);
}

// ---------- File loading ----------

function getExtension(fileName) {
    const parts = fileName.toLowerCase().split(".");
    return parts.length > 1 ? parts.pop() : "";
}

function showUploadError(message) {
    elements.content.prepend(
        createInfoCard("Could not load file", message, "Error", "tag tag-danger")
    );
}

async function handleFileSelected(event) {
    const file = event.target.files[0];
    event.target.value = ""; // Allow re-selecting the same file later.
    if (!file) return;

    if (!supportedExtensions.includes(getExtension(file.name))) {
        showUploadError(`Unsupported file type. Use: ${supportedExtensions.join(", ")}.`);
        return;
    }

    try {
        const rawText = await file.text();
        state.set("transcript", { name: file.name, size: file.size, rawText });
        navigate("transcripts");
    } catch (error) {
        showUploadError("The file could not be read in this browser.");
    }
}

// ---------- Startup ----------

function init() {
    // Modules loaded successfully, so remove the load warning.
    document.getElementById("load-check")?.remove();

    renderSidebar(elements.sidebar);

    elements.uploadButton.addEventListener("click", () => elements.fileInput.click());
    elements.fileInput.addEventListener("change", handleFileSelected);

    // Re-render whenever route or transcript changes.
    state.subscribe((key) => {
        if (key === "route" || key === "transcript") renderView(state.get("route"));
    });

    startRouter();
}

init();

// ==========================================================
// app.js
// Responsibility: application COORDINATOR. Wires modules
// together (state, router, sidebar, views) and runs the
// file-loading flow:
//
//   file selected → determine format → parser → validator
//   → store canonical TranscriptDocument → render
//
// Contains no parsing, validation, or analysis logic.
//
// Privacy: files are read with File.text() and kept only in
// memory in this browser tab. Nothing is sent anywhere.
// ==========================================================

import { state } from "./core/state.js";
import { routes, startRouter, navigate } from "./core/router.js";
import { AppError, reportError } from "./core/errors.js";
import { installDevtools } from "./core/devtools.js";
import { getFormatForFilename, getAcceptAttribute, describeSupportedExtensions } from "./transcript/formats.js";
import { parseTranscript } from "./transcript/parser.js";
import { validateTranscript } from "./transcript/validator.js";
import { withDerivedLayer, deepFreeze } from "./transcript/model.js";
import { renderSidebar, setActiveNavItem } from "./ui/sidebar.js";
import { renderDashboard } from "./ui/dashboard.js";
import { renderTranscriptsView } from "./ui/transcripts.js";
import { createInfoCard } from "./ui/dom.js";

const elements = {
    sidebar: document.getElementById("sidebar-mount"),
    pageTitle: document.getElementById("page-title"),
    content: document.getElementById("content-mount"),
    uploadButton: document.getElementById("upload-button"),
    fileInput: document.getElementById("transcript-file-input")
};

// ---------- Views ----------

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
    else if (routeId === "transcripts") renderTranscriptsView(elements.content, state.get("transcript"));
    else renderPlaceholderView(elements.content, routeId);

    setActiveNavItem(elements.sidebar, routeId);
}

// ---------- File loading ----------

function showUserError(message) {
    elements.content.prepend(
        createInfoCard("Could not load file", message, "Error", "tag tag-danger")
    );
}

async function readFileText(file) {
    try {
        return await file.text();
    } catch (cause) {
        throw new AppError("file_read_failed", "The file could not be read in this browser.",
            { filename: file.name, size: file.size }, cause);
    }
}

// Runs the Stage 1.5 pipeline for one file and returns a frozen document.
async function buildTranscriptDocument(file) {
    const format = getFormatForFilename(file.name);
    if (!format) {
        throw new AppError("unsupported_format",
            `Unsupported file type. Use: ${describeSupportedExtensions()}.`,
            { filename: file.name });
    }

    const rawText = await readFileText(file);
    const parsed = parseTranscript({
        rawText,
        format: format.id,
        filename: file.name,
        size: file.size,
        lastModified: file.lastModified
    });

    // Validation observes; its report is attached as a NEW layer.
    const report = validateTranscript(parsed);
    return deepFreeze(withDerivedLayer(parsed, {
        validation: {
            status: report.status,
            validatedAt: report.validatedAt,
            checks: report.checks,
            issues: report.issues
        },
        processing: { validated: report.valid !== null }
    }));
}

async function handleFileSelected(event) {
    const file = event.target.files[0];
    event.target.value = ""; // Allow re-selecting the same file later.
    if (!file) return;

    try {
        const transcript = await buildTranscriptDocument(file);
        state.set("transcript", transcript);
        navigate("transcripts");
    } catch (error) {
        showUserError(reportError(error, "Transcript load"));
    }
}

// ---------- Startup ----------

function init() {
    // Modules loaded successfully, so remove the load warning.
    document.getElementById("load-check")?.remove();

    renderSidebar(elements.sidebar);

    // Upload control reads its accepted types from formats.js.
    elements.fileInput.accept = getAcceptAttribute();
    elements.uploadButton.addEventListener("click", () => elements.fileInput.click());
    elements.fileInput.addEventListener("change", handleFileSelected);

    // Re-render whenever route or transcript changes.
    state.subscribe((key) => {
        if (key === "route" || key === "transcript") renderView(state.get("route"));
    });

    installDevtools(state);
    startRouter();
}

init();

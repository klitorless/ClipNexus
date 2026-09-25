// ==========================================================
// app.js
// Responsibility: application COORDINATOR. Wires modules
// together (state, router, sidebar, views) and runs two flows:
//
//   URL entered → video resolver → project (video identity)
//   → state → render
//
//   file selected → determine format → parser → validator
//   → attach TranscriptDocument to project → state → render
//
// Contains no URL parsing, platform-specific, transcript
// parsing, validation, or analysis logic.
//
// Privacy: files are read with File.text() and kept only in
// memory in this browser tab. Nothing is sent anywhere.
// ==========================================================

import { state } from "./core/state.js";
import { routes, startRouter, navigate } from "./core/router.js";
import { AppError, reportError } from "./core/errors.js";
import { installDevtools } from "./core/devtools.js";
import { createProject, withTranscript, applyVideoIdentity } from "./core/project.js";
import { resolveVideoUrl, getPlatformLabel } from "./video/video-resolver.js";
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

    const project = state.get("project");
    if (routeId === "dashboard") renderDashboard(elements.content, state, { onVideoUrlSubmit: handleVideoUrlSubmit });
    else if (routeId === "transcripts") renderTranscriptsView(elements.content, project ? project.transcript : null);
    else renderPlaceholderView(elements.content, routeId);

    setActiveNavItem(elements.sidebar, routeId);
}

// ---------- Video URL ----------

const videoOutcomeMessages = {
    created: "Video identified. Project created.",
    attached: "Video identified and added to the current project.",
    unchanged: "This video is already loaded.",
    replaced: "Video identified. Started a new project — the previous transcript belonged to a different video."
};

// Remember the last result so it survives the re-render.
function setVideoUrlNotice(notice) {
    state.set("ui", { ...state.get("ui"), videoUrlNotice: notice });
}

// Returns {ok, message} for the form to display. Nothing is fetched.
function handleVideoUrlSubmit(inputValue) {
    const result = resolveVideoUrl(inputValue);
    if (!result.success) {
        const { code, message, detail } = result.error;
        const notice = { ok: false, message: reportError(new AppError(code, message, detail), "Video URL") };
        setVideoUrlNotice(notice);
        return notice;
    }

    const { project, outcome } = applyVideoIdentity(state.get("project"), result.video);
    const label = getPlatformLabel(result.video.platform);
    const notice = { ok: true, message: `${videoOutcomeMessages[outcome]} (${label} · ${result.video.videoId})` };
    setVideoUrlNotice(notice);
    if (outcome !== "unchanged") state.set("project", project);
    return notice;
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
        const project = state.get("project") || createProject();
        setVideoUrlNotice(null); // Earlier URL message no longer describes the latest action.
        state.set("project", withTranscript(project, transcript));
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

    // Re-render whenever route or project changes.
    state.subscribe((key) => {
        if (key === "route" || key === "project") renderView(state.get("route"));
    });

    installDevtools(state);
    startRouter();
}

init();

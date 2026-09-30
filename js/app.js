// ==========================================================
// app.js
// Responsibility: application COORDINATOR. Wires modules
// together (state, router, sidebar, views) and runs two flows:
//
//   URL entered → video resolver → project (video identity)
//   → state → render
//
//   file selected → determine format → pipeline (parser →
//   validator) → attach TranscriptDocument to project → state
//
//   provider chosen → provider manager → AcquisitionResult
//   → success: pipeline → attach to project
//   → failure: project untouched; attempt state shows the error
//     and offers other providers (never switched automatically)
//
// Contains no URL parsing, platform-specific, provider-specific,
// transcript parsing, validation, or analysis logic.
//
// Privacy: files are read with File.text() and kept only in
// memory in this browser tab. Nothing is sent anywhere.
// ==========================================================

import { state } from "./core/state.js";
import { routes, startRouter, navigate } from "./core/router.js";
import { AppError, reportError } from "./core/errors.js";
import { installDevtools } from "./core/devtools.js";
import { createProject, withTranscript, applyVideoIdentity, finalizeVideoChange,
    setClipDecision, clearClipDecision, withVideoMetadata } from "./core/project.js";
import { resolveVideoUrl, getPlatformLabel } from "./video/video-resolver.js";
import { METADATA_STATUS } from "./video/video-model.js";
import { fetchYouTubeTitle, METADATA_ERROR_CODES } from "./video/metadata-provider.js";
import { getFormatForFilename, getAcceptAttribute, describeSupportedExtensions } from "./transcript/formats.js";
import { buildTranscriptDocument, buildAcquiredTranscript } from "./transcript/pipeline.js";
import { chunkDocument } from "./transcript/chunker.js";
import { exportTranscript } from "./transcript/export.js";
import { createFileAcquisition } from "./transcript/model.js";
import { transcriptProviders } from "./transcript/providers/default-providers.js";
import { providerCredentials } from "./transcript/providers/credentials.js";
import { acquireTranscript, applyAcquisitionToProject } from "./transcript/providers/manager.js";
import {
    createAcquisitionState, withSelection, beginAttempt, completeAttempt, resetAttempt, isCurrentAttemptResult
} from "./transcript/providers/acquisition-state.js";
import { renderSidebar, setActiveNavItem } from "./ui/sidebar.js";
import { renderDashboard } from "./ui/dashboard.js";
import { renderTranscriptsView } from "./ui/transcripts.js";
import { renderAnalysisView } from "./ui/analysis.js";
import { downloadTextFile } from "./ui/download.js";
import { createInfoCard } from "./ui/dom.js";
import { createAnalyzer } from "./analysis/analyzer.js";
import { createAnalysisRequest } from "./analysis/contracts.js";
import { createQuestionExtractor } from "./analysis/deterministic-extractor.js";
import { createPlayerController } from "./video/player/controller.js";
import { youtubePlayerDriver } from "./video/player/drivers/youtube.js";
import { renderClipsView } from "./ui/clips.js";

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
    settings: "Analysis window, overlap, and provider settings will live here."
};

function renderPlaceholderView(mount, routeId) {
    mount.replaceChildren(createInfoCard("Not built yet", placeholderText[routeId], "Stage 1"));
}

function renderView(routeId) {
    // The embedded player lives only on the clips route: every
    // other route must remain iframe-free (Stage 10 security
    // boundary).
    if (routeId !== "clips") teardownPlayer();

    const route = routes.find((item) => item.id === routeId);
    elements.pageTitle.textContent = route ? route.label : "Dashboard";
    document.title = `${elements.pageTitle.textContent} · VOD Analyzer`;

    const project = state.get("project");
    if (routeId === "dashboard") renderDashboard(elements.content, state, {
        onVideoUrlSubmit: handleVideoUrlSubmit,
        youTubeApiKey: {
            ready: providerCredentials.has(YOUTUBE_API_KEY_ID),
            onSave: handleYouTubeKeySave,
            onClear: handleYouTubeKeyClear
        }
    });
    else if (routeId === "transcripts") renderTranscriptsView(elements.content, project, {
        acquisition: getAcquisition(),
        providers: transcriptProviders.list(),
        onSelectionChange: handleAcquisitionSelection,
        onAcquire: handleAcquireTranscript,
        credentialReady: (providerId) => providerCredentials.has(providerId),
        onCredentialChange: handleCredentialChange
    }, {
        onExportTranscript: handleExportTranscript,
        exportNotice: getExportNotice()
    });
    else if (routeId === "analysis") renderAnalysisView(elements.content, project, {
        analysis: getAnalysis(),
        onAnalyze: handleAnalyze
    });
    else if (routeId === "clips") renderClipsRoute();
    else renderPlaceholderView(elements.content, routeId);

    setActiveNavItem(elements.sidebar, routeId);
}

// ---------- Video URL ----------

const videoOutcomeMessages = {
    created: "Video identified. Project created.",
    attached: "Video identified and added to the current project.",
    unchanged: "This video is already loaded.",
    start_position_updated: "Same video. Start-position hint updated; transcript kept.",
    replaced: "Video identified. Started a new project for this video.",
    cancelled: "Kept the current project. Nothing was changed."
};

const replaceConfirmationMessage =
    "A different video was entered. The current project contains a transcript. " +
    "Replacing it discards the current transcript and project from this session. Replace the current project?";

// Remember the last result so it survives the re-render.
function setVideoUrlNotice(notice) {
    state.set("ui", { ...state.get("ui"), videoUrlNotice: notice });
}

function describeOutcome(outcome, identity) {
    // Cancelled: don't name the rejected video as if it were loaded.
    if (outcome === "cancelled") return videoOutcomeMessages.cancelled;
    const label = getPlatformLabel(identity.platform);
    return `${videoOutcomeMessages[outcome]} (${label} · ${identity.videoId})`;
}

// Store the chosen project and return the notice to show.
function commitVideoPlan(videoPlan, confirmed, identity) {
    const current = state.get("project");
    const next = finalizeVideoChange(current, videoPlan, { confirmed });
    const outcome = next === current && videoPlan.requiresConfirmation ? "cancelled" : videoPlan.outcome;
    const notice = { ok: true, message: describeOutcome(outcome, identity) };
    setVideoUrlNotice(notice);
    // A different project makes any earlier attempt irrelevant.
    if (!current || next.id !== current.id) setAcquisition(resetAttempt(getAcquisition()));
    if (next !== current) state.set("project", next);
    if (next !== current) requestVideoTitle(next);
    return notice;
}

// Returns a notice for the form. A confirmation notice carries
// onConfirm/onCancel callbacks; nothing changes until one is chosen.
// Nothing is fetched.
function handleVideoUrlSubmit(inputValue) {
    const result = resolveVideoUrl(inputValue);
    if (!result.success) {
        const { code, message, detail } = result.error;
        const notice = { ok: false, message: reportError(new AppError(code, message, detail), "Video URL") };
        setVideoUrlNotice(notice);
        return notice;
    }

    const videoPlan = applyVideoIdentity(state.get("project"), result.video, result.startPosition);
    if (!videoPlan.requiresConfirmation) return commitVideoPlan(videoPlan, true, result.video);

    return {
        ok: true,
        confirm: true,
        message: replaceConfirmationMessage,
        onConfirm: () => commitVideoPlan(videoPlan, true, result.video),
        onCancel: () => commitVideoPlan(videoPlan, false, result.video)
    };
}

// ---------- File loading ----------

function showUserError(message) {
    showNoticeCard("Could not load file", message, "Error", "tag tag-danger");
}

// Non-blocking notice (e.g. a derived layer failed but the
// transcript itself loaded). Prepend after any navigation or
// re-render, which would otherwise wipe it.
function showNoticeCard(title, message, tagText, tagClass) {
    elements.content.prepend(
        createInfoCard(title, message, tagText, tagClass)
    );
}

// Chunking is a derived layer: the pipeline document is never
// mutated. Returns { document, error } — when chunking fails,
// the transcript still loads unchunked and the failure is
// reported distinctly as AppError("chunking_failed").
function chunkTranscriptDocument(transcript) {
    try {
        return { document: chunkDocument(transcript), error: null };
    } catch (cause) {
        const error = new AppError("chunking_failed",
            "The transcript was loaded, but chunking failed. Chunk-based analysis is unavailable.",
            { transcriptId: transcript && transcript.id ? transcript.id : null }, cause);
        return { document: transcript, error };
    }
}

async function readFileText(file) {
    try {
        return await file.text();
    } catch (cause) {
        throw new AppError("file_read_failed", "The file could not be read in this browser.",
            { filename: file.name, size: file.size }, cause);
    }
}

// Runs the shared pipeline for one file and returns a frozen document.
async function buildFileTranscript(file) {
    const format = getFormatForFilename(file.name);
    if (!format) {
        throw new AppError("unsupported_format",
            `Unsupported file type. Use: ${describeSupportedExtensions()}.`,
            { filename: file.name });
    }

    const rawText = await readFileText(file);
    return buildTranscriptDocument({
        rawText,
        format: format.id,
        filename: file.name,
        size: file.size,
        lastModified: file.lastModified,
        acquisition: createFileAcquisition()
    });
}

async function handleFileSelected(event) {
    const file = event.target.files[0];
    event.target.value = ""; // Allow re-selecting the same file later.
    if (!file) return;

    try {
        const transcript = await buildFileTranscript(file);
        const chunked = chunkTranscriptDocument(transcript);
        const project = state.get("project") || createProject();
        setVideoUrlNotice(null); // Earlier URL message no longer describes the latest action.
        setAcquisition(resetAttempt(getAcquisition())); // An earlier provider result no longer describes the transcript.
        setExportNotice(null); // An earlier export notice no longer describes the transcript.
        setAnalysis({ status: "idle" }); // Earlier analysis results described a different transcript.
        state.set("project", withTranscript(project, chunked.document));
        navigate("transcripts");
        if (chunked.error) {
            showNoticeCard("Chunking failed",
                reportError(chunked.error, "Transcript load"), "Warning", "tag");
        }
    } catch (error) {
        showUserError(reportError(error, "Transcript load"));
    }
}

// ---------- Provider acquisition ----------

let attemptCounter = 0;

function getAcquisition() {
    return state.get("ui").transcriptAcquisition;
}

// Attempt state lives in state.ui (never in the project). Setting ui
// does not re-render by itself, so views are refreshed explicitly.
function setAcquisition(next) {
    state.set("ui", { ...state.get("ui"), transcriptAcquisition: next });
}

function refreshTranscriptsView() {
    if (state.get("route") === "transcripts") renderView("transcripts");
}

// Selection changes are recorded silently; the panel updates itself.
function handleAcquisitionSelection(changes) {
    setAcquisition(withSelection(getAcquisition(), changes));
}

// Stage 2B: API keys go to the in-memory store only (never to state,
// storage, logs, or the DOM). value null = forget. Returns acceptance.
function handleCredentialChange(providerId, value) {
    if (value === null) { providerCredentials.clear(providerId); return true; }
    return providerCredentials.set(providerId, value);
}

// ---------- YouTube Data API key (video titles) ----------

// Held in the same in-memory credential store as the provider keys:
// page session only, never persisted, rendered, or logged. It is
// sent only to www.googleapis.com, and only for video title metadata.
// (A planned later step adds file import; it will call the same
// save/clear functions below.)
const YOUTUBE_API_KEY_ID = "youtube-data-api";

function getYouTubeApiKey() {
    return providerCredentials.read(YOUTUBE_API_KEY_ID);
}

function handleYouTubeKeySave(value) {
    const accepted = providerCredentials.set(YOUTUBE_API_KEY_ID, value);
    if (accepted) {
        renderView(state.get("route"));          // show "entered for this page session"
        requestVideoTitle(state.get("project")); // a video may already be linked
    }
    return accepted;
}

function handleYouTubeKeyClear() {
    providerCredentials.clear(YOUTUBE_API_KEY_ID);
    renderView(state.get("route"));
}

// Fetch the linked video's title when a key is available and no
// metadata has been acquired yet. Fire-and-forget: the result is
// applied only if the same video is still linked when it resolves.
function requestVideoTitle(project) {
    const video = project && project.video;
    if (!video || video.identity.platform !== "youtube") return;
    if (video.metadata.status !== METADATA_STATUS.UNKNOWN) return;
    const apiKey = getYouTubeApiKey();
    if (!apiKey) return;

    const projectId = project.id;
    const { platform, videoId } = video.identity;
    state.set("project", withVideoMetadata(project, { status: METADATA_STATUS.LOADING }));
    fetchYouTubeTitle(videoId, apiKey).then(
        ({ title }) => applyTitleResult(projectId, platform, videoId, {
            status: METADATA_STATUS.LOADED,
            title,
            provider: YOUTUBE_API_KEY_ID,
            retrievedAt: new Date().toISOString()
        }),
        (error) => applyTitleResult(projectId, platform, videoId, {
            status: error && error.code === METADATA_ERROR_CODES.NOT_FOUND
                ? METADATA_STATUS.UNAVAILABLE
                : METADATA_STATUS.FAILED
        })
    );
}

// Applies a title result only when the project still links the same
// video; a replaced project makes the in-flight result irrelevant.
function applyTitleResult(projectId, platform, videoId, patch) {
    const current = state.get("project");
    if (!current || current.id !== projectId) return;
    const video = current.video;
    if (!video || video.identity.platform !== platform || video.identity.videoId !== videoId) return;
    if (video.metadata.status !== METADATA_STATUS.LOADING) return;
    state.set("project", withVideoMetadata(current, patch));
}

// override.providerId: "Try Again" / "Try With <provider>" — an explicit
// user choice. The chosen provider becomes the selection, so the form
// and provenance always agree about which provider was used.
async function handleAcquireTranscript(override = {}) {
    const project = state.get("project");
    let acquisition = withSelection(getAcquisition(), override);
    const { providerId, language, method } = acquisition.selection;
    const found = transcriptProviders.get(providerId);
    const attemptId = ++attemptCounter;

    acquisition = beginAttempt(acquisition, {
        id: attemptId,
        providerName: found.success ? found.provider.name : String(providerId),
        projectId: project ? project.id : null
    });
    setAcquisition(acquisition);
    refreshTranscriptsView();

    const result = await acquireTranscript({
        registry: transcriptProviders, providerId, video: project ? project.video : null, options: { language, method }
    });

    // The project may have changed while waiting; apply to the CURRENT one.
    // A reset (new project, file upload) or newer attempt makes this result stale.
    const current = state.get("project");
    if (!isCurrentAttemptResult(getAcquisition(), attemptId, current, project)) return;
    const applied = applyAcquisitionToProject(current, result, buildAcquiredTranscript);

    if (applied.error) {
        console.warn("[VOD Analyzer] Transcript acquisition", applied.error.code, applied.error.detail);
        setAcquisition(completeAttempt(getAcquisition(), attemptId, { error: applied.error }));
        refreshTranscriptsView(); // project untouched
        return;
    }
    setAcquisition(completeAttempt(getAcquisition(), attemptId, { source: result.source }));
    setExportNotice(null); // The transcript was replaced; an earlier export notice no longer applies.
    setAnalysis({ status: "idle" }); // Earlier analysis results described a different transcript.
    const chunked = chunkTranscriptDocument(applied.project.transcript);
    state.set("project", withTranscript(applied.project, chunked.document)); // triggers render
    if (chunked.error) {
        showNoticeCard("Chunking failed",
            reportError(chunked.error, "Transcript acquisition"), "Warning", "tag");
    }
}

// ---------- Transcript export ----------

function getExportNotice() {
    const ui = state.get("ui");
    return (ui && ui.exportNotice) || null;
}

function setExportNotice(notice) {
    state.set("ui", { ...state.get("ui"), exportNotice: notice });
}

// Stage 4: export the canonical transcript through the existing
// JSON exporter. The exporter never mutates state; the only
// browser effect is the download itself.
function handleExportTranscript() {
    const project = state.get("project");
    const transcript = project ? project.transcript : null;
    if (!transcript) {
        setExportNotice({ ok: false, message: "No transcript is loaded." });
        refreshTranscriptsView();
        return;
    }
    try {
        const text = exportTranscript(transcript, "json");
        downloadTextFile(`${transcript.id}.json`, text);
        setExportNotice({
            ok: true,
            message: `Exported ${transcript.segments.length} segment(s) as JSON (${text.length.toLocaleString()} characters).`
        });
    } catch (error) {
        setExportNotice({ ok: false, message: reportError(error, "Transcript export") });
    }
    refreshTranscriptsView();
}

// ---------- Analysis ----------

// Stage 4: the analyzer runs behind its extraction seam with a
// deterministic, rule-based extractor. No AI, no network, no
// ranking — an integration probe that proves scoped transcript
// material reaches the extractor and evidence stays traceable.
const analyzer = createAnalyzer({ extract: createQuestionExtractor() });

function getAnalysis() {
    const ui = state.get("ui");
    return (ui && ui.analysis) || { status: "idle" };
}

function setAnalysis(next) {
    state.set("ui", { ...state.get("ui"), analysis: next });
}

function refreshAnalysisView() {
    if (state.get("route") === "analysis") renderView("analysis");
}

// Build the AnalysisRequest for the requested scope. Chunk scope
// is scope.type "partial" over the chunk's segment ids plus the
// chunkId; the analyzer owns scope validation and rejects
// anything outside the contract.
function buildAnalysisRequest(transcript, scopeType, chunkId) {
    if (scopeType === "chunk") {
        const chunks = Array.isArray(transcript.chunks) ? transcript.chunks : [];
        const chunk = chunks.find((entry) => entry && entry.id === chunkId) || null;
        if (!chunk) {
            throw new AppError("unknown_chunk_id",
                "The selected chunk is no longer available. Reload the transcript and try again.",
                { chunkId });
        }
        return createAnalysisRequest({
            transcriptId: transcript.id,
            scope: { type: "partial", segmentIds: [...chunk.segmentIds] },
            chunkId: chunk.id
        });
    }
    return createAnalysisRequest({
        transcriptId: transcript.id,
        scope: { type: "full" }
    });
}

async function handleAnalyze({ scopeType, chunkId }) {
    const project = state.get("project");
    const transcript = project ? project.transcript : null;
    if (!transcript) {
        setAnalysis({ status: "error", error: "No transcript is loaded." });
        refreshAnalysisView();
        return;
    }
    setAnalysis({ status: "running" });
    refreshAnalysisView();
    try {
        const request = buildAnalysisRequest(transcript, scopeType, chunkId);
        const result = await analyzer.analyze(request, transcript);
        setAnalysis({ status: "done", request, result });
    } catch (error) {
        setAnalysis({ status: "error", error: reportError(error, "Analysis") });
    }
    refreshAnalysisView();
}

// ---------- Embedded player + clip review (Stage 10) ----------
//
// The player controller is a LIVE object (it owns the iframe, the
// readiness handshake, and the seek queue). It never enters the
// frozen Project or serializable state — this coordinator owns it.
// The iframe mount is a persistent element: re-renders re-attach
// the SAME mount, so KEEP/REJECT decisions (which replace the
// project and re-render) do not reload the video.
const playerHost = {
    controller: null,
    platform: null,
    videoId: null,
    mount: null,
    hintHonoredFor: null // "platform:videoId" the startPosition hint was honored for
};

function getPlayerMount() {
    if (!playerHost.mount) {
        playerHost.mount = document.createElement("div");
        playerHost.mount.className = "player-mount";
    }
    return playerHost.mount;
}

function teardownPlayer() {
    if (playerHost.controller) {
        playerHost.controller.destroy();
        playerHost.controller = null;
    }
    playerHost.platform = null;
    playerHost.videoId = null;
    playerHost.hintHonoredFor = null;
}

function describePlayerUnavailable(project) {
    if (!project || !project.video) return "no-video";
    if (!youtubePlayerDriver.canPlayVideo(project.video.identity)) return "unsupported-platform";
    return null;
}

// Ensure the embedded player matches the current project. Creates
// the controller for a playable video identity, recreates it when
// the video changes, and never creates an iframe without a usable
// canonical identity. Returns the controller or null.
function syncPlayerForClips(project) {
    const mount = getPlayerMount();
    const video = project ? project.video : null;
    const identity = video ? video.identity : null;
    const matches = identity !== null && playerHost.platform === identity.platform &&
        playerHost.videoId === identity.videoId;

    if (!matches) teardownPlayer();

    if (identity !== null && playerHost.controller === null) {
        if (!youtubePlayerDriver.canPlayVideo(identity)) return null;
        playerHost.controller = createPlayerController({
            driver: youtubePlayerDriver,
            identity,
            mountElement: mount,
            host: { document, window }
        });
        playerHost.platform = identity.platform;
        playerHost.videoId = identity.videoId;
        // Honor a valid start-position hint once per video. The
        // controller queues the seek until the player is ready, so
        // it is never silently lost. No hint is ever invented.
        const hintSeconds = video.startPosition ? video.startPosition.seconds : null;
        const hintKey = `${identity.platform}:${identity.videoId}`;
        if (typeof hintSeconds === "number" && playerHost.hintHonoredFor !== hintKey) {
            playerHost.hintHonoredFor = hintKey;
            playerHost.controller.seek(hintSeconds);
        }
    }
    return playerHost.controller;
}

// Current review target. Ephemeral UI state (like acquisition and
// analysis status): selecting a candidate never mutates ClipSpecs.
function getClipReview() {
    const ui = state.get("ui");
    return (ui && ui.clipReview) || { currentCandidateId: null };
}

function setClipReview(next) {
    state.set("ui", { ...state.get("ui"), clipReview: next });
}

function refreshClipsView() {
    if (state.get("route") === "clips") renderView("clips");
}

function renderClipsRoute() {
    const project = state.get("project");
    const controller = syncPlayerForClips(project);
    renderClipsView(elements.content, project, {
        playerMount: getPlayerMount(),
        playerAvailable: controller !== null,
        playerUnavailableReason: controller !== null ? null : describePlayerUnavailable(project),
        currentCandidateId: getClipReview().currentCandidateId,
        onSelectCandidate: handleSelectCandidate,
        onKeep: handleKeepCandidate,
        onReject: handleRejectCandidate,
        onClearDecision: handleClearClipDecision
    });
}

// Select the candidate as the current review target and seek the
// embedded player to its startSeconds. Selection is recorded even
// when seeking is unavailable; seeking never mutates the ClipSpec.
function handleSelectCandidate(clipSpecId) {
    const project = state.get("project");
    if (!project) return;
    const spec = project.clipSpecs.find((entry) => entry.id === clipSpecId);
    if (!spec) return;
    setClipReview({ currentCandidateId: clipSpecId });
    const controller = playerHost.controller;
    const transcriptOk = project.transcript !== null && spec.transcriptId === project.transcript.id;
    if (controller !== null && transcriptOk && typeof spec.startSeconds === "number") {
        try {
            controller.seek(spec.startSeconds);
        } catch (error) {
            console.warn("[VOD Analyzer] Clip seek failed", error.code || error);
        }
    }
    refreshClipsView();
}

function recordClipDecision(clipSpecId, decision) {
    const project = state.get("project");
    if (!project) return;
    try {
        // A new project triggers the subscriber re-render; the
        // persistent player mount keeps the video loaded.
        state.set("project", setClipDecision(project, clipSpecId, decision));
    } catch (error) {
        console.warn("[VOD Analyzer] Clip decision rejected", error.code || error);
    }
}

function handleKeepCandidate(clipSpecId) {
    recordClipDecision(clipSpecId, "keep");
}

function handleRejectCandidate(clipSpecId) {
    recordClipDecision(clipSpecId, "reject");
}

function handleClearClipDecision(clipSpecId) {
    const project = state.get("project");
    if (!project) return;
    const next = clearClipDecision(project, clipSpecId);
    if (next !== project) state.set("project", next);
}

// ---------- Startup ----------

function init() {
    // Modules loaded successfully, so remove the load warning.
    document.getElementById("load-check")?.remove();

    renderSidebar(elements.sidebar);

    const firstProvider = transcriptProviders.listSelectable()[0];
    setAcquisition(createAcquisitionState({ providerId: firstProvider ? firstProvider.id : null }));

    // Upload control reads its accepted types from formats.js.
    elements.fileInput.accept = getAcceptAttribute();
    elements.uploadButton.addEventListener("click", () => elements.fileInput.click());
    elements.fileInput.addEventListener("change", handleFileSelected);

    // Re-render whenever route or project changes.
    state.subscribe((key) => {
        if (key === "route" || key === "project") renderView(state.get("route"));
    });

    installDevtools(state, { providers: transcriptProviders, refresh: () => renderView(state.get("route")) });
    startRouter();
}

init();

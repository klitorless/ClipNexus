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
import { transcriptProviders, AUTOMATIC_PROVIDER_IDS } from "./transcript/providers/default-providers.js";
import { providerCredentials } from "./transcript/providers/credentials.js";
import { acquireTranscript, acquireTranscriptWithFallback, applyAcquisitionToProject } from "./transcript/providers/manager.js";
import { METHOD_PREFERENCE } from "./transcript/providers/provider.js";
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
import { createDetectorExtractor } from "./analysis/detectors/extractor.js";
import { validateAnalysisConfig } from "./analysis/detectors/index.js";
import { createPlayerCoordinator } from "./video/player/coordinator.js";
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

// The POI/Event placeholders show where the route sits in the
// evidence chain, with real counts from the current project —
// no invented data, just the honest pipeline position.
function renderPlaceholderView(mount, routeId) {
    const project = state.get("project");
    const cards = [createInfoCard("Not built yet", placeholderText[routeId], "Stage 1")];
    if (project && (routeId === "pois" || routeId === "events")) {
        const chain = [
            `Transcript: ${project.transcript ? `${project.transcript.segments.length} segments` : "not loaded"}`,
            `POIs: ${project.pois.length}`,
            `Events: ${project.events.length}`,
            `Clip candidates: ${project.clipSpecs.length}`
        ].join("  →  ");
        cards.push(createInfoCard("Evidence chain", chain, "Pipeline"));
    }
    mount.replaceChildren(...cards);
}

function renderView(routeId) {
    // Each embedded player lives only on its own route: leaving a
    // route tears its player down so no hidden iframe keeps running
    // behind other views. Every route other than dashboard and
    // clips remains iframe-free (Stage 10 security boundary,
    // extended to the dashboard preview).
    if (routeId !== "clips") {
        clipsPlayer.teardown();
        clipsHintHonoredFor = null;
    }
    if (routeId !== "dashboard") dashboardPlayer.teardown();

    const route = routes.find((item) => item.id === routeId);
    elements.pageTitle.textContent = route ? route.label : "Dashboard";
    document.title = `${elements.pageTitle.textContent} · ClipNexus`;

    const project = state.get("project");
    if (routeId === "dashboard") {
        const dashboardController = syncPlayerForDashboard(project);
        renderDashboard(elements.content, state, {
            onVideoUrlSubmit: handleVideoUrlSubmit,
            youTubeApiKey: {
                ready: providerCredentials.has(YOUTUBE_API_KEY_ID),
                onSave: handleYouTubeKeySave,
                onClear: handleYouTubeKeyClear
            },
            player: {
                mount: dashboardPlayer.getMount(playerRuntimeHost()),
                available: dashboardController !== null,
                unavailableReason: dashboardController !== null ? null : describePlayerUnavailable(project)
            }
        });
    }
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
        onAnalyze: handleAnalyze,
        builder: {
            config: getAnalysisConfig(),
            onConfigChange: handleAnalysisConfigChange
        }
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

// Outcomes that link a (possibly new) video to the project.
const AUTO_ACQUIRE_OUTCOMES = new Set(["created", "attached", "replaced"]);

// Automatic captions run only for a newly linked YouTube video with
// no transcript yet — never over a user-uploaded transcript, and
// never for a platform no provider supports.
function shouldAutoAcquireTranscript(project, outcome) {
    if (!AUTO_ACQUIRE_OUTCOMES.has(outcome)) return false;
    const video = project ? project.video : null;
    return Boolean(video) && video.identity.platform === "youtube" && project.transcript === null;
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
    if (next !== current && shouldAutoAcquireTranscript(next, outcome)) {
        // The Dashboard tries the no-key captions automatically; the
        // notice below is replaced when the attempt finishes.
        const acquiring = { ok: true, message: "Video found. Getting transcript…" };
        setVideoUrlNotice(acquiring);
        runDashboardAutoAcquisition(next, ++dashboardAcquisitionSeq);
        return acquiring;
    }
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

// ---------- Automatic transcript acquisition (Dashboard) ----------
//
// After a YouTube VOD is linked on the Dashboard, the app tries the
// no-key YouTube captions first, then the authenticated Supadata
// provider (which runs only when its key is already in the
// in-memory store). This is separate from the Transcripts page's
// manual acquisition state: it never changes the user's provider
// selection, and the Transcripts page stays the explicit override
// surface ("Personal Supadata key").
//
// Stale guards: a newer video load supersedes an in-flight attempt
// (dashboardAcquisitionSeq), and a result is applied only to the
// project it started for. Failures never touch the project.

let dashboardAcquisitionSeq = 0;

// Persist the notice and, when the Dashboard is showing, update the
// visible form message in place — a full re-render would wipe what
// the user is typing into the URL field.
function updateDashboardNotice(notice) {
    setVideoUrlNotice(notice);
    if (state.get("route") !== "dashboard") return;
    const message = elements.content.querySelector("[data-section=\"create-project\"] .field-message");
    if (message) {
        message.textContent = notice.message;
        message.classList.toggle("is-error", !notice.ok);
    }
}

async function runDashboardAutoAcquisition(project, seq) {
    const projectId = project.id;
    const result = await acquireTranscriptWithFallback({
        registry: transcriptProviders,
        providerIds: AUTOMATIC_PROVIDER_IDS,
        video: project.video,
        options: { language: null, method: METHOD_PREFERENCE.ANY }
    });
    if (seq !== dashboardAcquisitionSeq) return;                          // superseded by a newer load
    const current = state.get("project");
    if (!current || current.id !== projectId || !current.video) return;   // project changed

    if (!result.success) {
        console.warn("[VOD Analyzer] Automatic transcript acquisition", result.error.code, result.error.detail);
        updateDashboardNotice({
            ok: false,
            message: `Automatic captions unavailable: ${result.error.message} ` +
                "You can upload a file or use a provider key on the Transcripts page."
        });
        return;
    }

    const applied = applyAcquisitionToProject(current, result, buildAcquiredTranscript);
    if (applied.error) {
        console.warn("[VOD Analyzer] Automatic transcript acquisition", applied.error.code, applied.error.detail);
        updateDashboardNotice({
            ok: false,
            message: `Automatic captions unavailable: ${applied.error.message} ` +
                "You can upload a file or use a provider key on the Transcripts page."
        });
        return;
    }

    // A provider may report the video's title and/or duration as a
    // side-channel (the caption service's X-Video-Title and
    // X-Video-Duration headers). Apply them through the same immutable
    // metadata path as the Data API key flow — but only when no metadata
    // has been acquired yet, so a key result is never overwritten and
    // this never re-triggers that flow.
    let projectForTranscript = applied.project;
    const hasTitle = typeof result.videoTitle === "string" && result.videoTitle.length > 0;
    const hasDuration = Number.isInteger(result.videoDurationSeconds) && result.videoDurationSeconds >= 0;
    if ((hasTitle || hasDuration) &&
        projectForTranscript.video && projectForTranscript.video.metadata.status === METADATA_STATUS.UNKNOWN) {
        projectForTranscript = withVideoMetadata(projectForTranscript, {
            status: METADATA_STATUS.LOADED,
            ...(hasTitle ? { title: result.videoTitle } : {}),
            ...(hasDuration ? { durationSeconds: result.videoDurationSeconds } : {}),
            provider: result.source.providerId,
            retrievedAt: result.source.retrievedAt
        });
    }

    const chunked = chunkTranscriptDocument(projectForTranscript.transcript);
    // state.set("project") re-renders the Dashboard: the pipeline
    // strip and transcript summary update, and the preview player
    // mount is re-attached (not reloaded).
    state.set("project", withTranscript(projectForTranscript, chunked.document));
    setExportNotice(null);            // an earlier export notice no longer applies
    setAnalysis({ status: "idle" });   // earlier analysis described a different transcript
    const count = chunked.document.segments.length;
    updateDashboardNotice({
        ok: true,
        message: `Transcript ready — ${count} segment${count === 1 ? "" : "s"} from ${result.source.providerName}.`
    });
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

// The analyzer runs behind its extraction seam with the
// deterministic detector suite (hype, question, keyword,
// reaction, emphasis, phrase). No AI, no network, no
// ranking — detectors produce explainable signals as
// Stage 3 evidence; reconciliation into POIs/events happens
// in the existing downstream architecture.
//
// The detector configuration lives in ui state
// (ui.analysisConfig, partial — resolveDetectorConfig()
// fills the defaults). The Analysis builder card edits it;
// each run constructs a fresh extractor from the current
// config, so there is exactly one analysis execution path.

// Canonical detector config, as edited by the Analysis
// builder. Partial: detectors not mentioned fall back to
// DEFAULT_DETECTOR_CONFIG.
function getAnalysisConfig() {
    const ui = state.get("ui");
    return (ui && ui.analysisConfig) || {};
}

function handleAnalysisConfigChange(detectorType, patch) {
    const ui = state.get("ui") || {};
    const current = ui.analysisConfig || {};
    const next = {
        ...current,
        [detectorType]: { ...(current[detectorType] || {}), ...patch }
    };
    // ui-only state: the subscriber re-renders on route/project
    // changes only, so builder inputs never lose focus here.
    state.set("ui", { ...ui, analysisConfig: next });
}

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
    const config = getAnalysisConfig();
    const validation = validateAnalysisConfig(config);
    if (!validation.ok) {
        setAnalysis({ status: "error", error: validation.error });
        refreshAnalysisView();
        return;
    }
    setAnalysis({ status: "running" });
    refreshAnalysisView();
    try {
        const request = buildAnalysisRequest(transcript, scopeType, chunkId);
        // One execution path: a fresh extractor per run, built
        // from the builder's canonical config.
        const analyzer = createAnalyzer({ extract: createDetectorExtractor(config) });
        const result = await analyzer.analyze(request, transcript);
        setAnalysis({ status: "done", request, result });
    } catch (error) {
        setAnalysis({ status: "error", error: reportError(error, "Analysis") });
    }
    refreshAnalysisView();
}

// ---------- Embedded players (Stage 10 + Dashboard preview) ----------
//
// The player controller is a LIVE object (it owns the iframe, the
// readiness handshake, and the seek queue). It never enters the
// frozen Project or serializable state — the coordinators own it.
// One coordinator per player-showing route (Clips review, Dashboard
// preview); both share the provider-neutral coordinator mechanism
// in js/video/player/coordinator.js instead of duplicating player
// logic. The iframe mount is a persistent element: re-renders
// re-attach the SAME mount, so KEEP/REJECT decisions (which replace
// the project and re-render) do not reload the video.
const clipsPlayer = createPlayerCoordinator({ driver: youtubePlayerDriver });
const dashboardPlayer = createPlayerCoordinator({ driver: youtubePlayerDriver });

// "platform:videoId" the clips start-position hint was honored for.
// Reset whenever the clips player is torn down.
let clipsHintHonoredFor = null;

function playerRuntimeHost() {
    return { document, window };
}

function describePlayerUnavailable(project) {
    if (!project || !project.video) return "no-video";
    if (!youtubePlayerDriver.canPlayVideo(project.video.identity)) return "unsupported-platform";
    return null;
}

// Ensure the Clips embedded player matches the current project.
// Shared sync plus the Clips-only start-position hint: a valid
// hint is honored once per video. The controller queues the seek
// until the player is ready, so it is never silently lost. No hint
// is ever invented.
function syncPlayerForClips(project) {
    const video = project ? project.video : null;
    const identity = video ? video.identity : null;
    const controller = clipsPlayer.sync(identity, playerRuntimeHost());
    if (controller !== null && video) {
        const hintSeconds = video.startPosition ? video.startPosition.seconds : null;
        const hintKey = `${identity.platform}:${identity.videoId}`;
        if (typeof hintSeconds === "number" && clipsHintHonoredFor !== hintKey) {
            clipsHintHonoredFor = hintKey;
            controller.seek(hintSeconds);
        }
    }
    return controller;
}

// Ensure the Dashboard preview player matches the current project.
// Same coordinator mechanism as Clips, but a plain preview: no
// candidate seeking, no start-position hint — it simply loads the
// resolved VOD.
function syncPlayerForDashboard(project) {
    const video = project ? project.video : null;
    const identity = video ? video.identity : null;
    return dashboardPlayer.sync(identity, playerRuntimeHost());
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
        playerMount: clipsPlayer.getMount(playerRuntimeHost()),
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
    const controller = clipsPlayer.controller;
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

// ==========================================================
// clips.js
// Responsibility: build the Clip Queue view — the Stage 10
// human-review surface. Embedded VOD player on top, ClipSpec
// candidate cards below it.
//
// The view is a pure DOM builder: it receives the project plus
// a coordinator-owned player mount (a LIVE element owned by
// js/app.js — the view NEVER creates iframes itself) and a set
// of callbacks. It never mutates ClipSpecs, decisions, or the
// project; every state change flows through the callbacks.
//
// Interaction contract:
//   - "Review & seek" selects the candidate as the current
//     review target AND seeks the player to startSeconds.
//     Seeking and deciding are independent operations.
//   - KEEP / REJECT record a human decision on the project;
//     the candidate list re-renders with the decision visible.
//   - A null startSeconds never seeks: the control is disabled
//     and the missing timestamp is stated plainly.
//   - Playback is never auto-stopped at endSeconds (Stage 10).
//
// SECURITY: candidate data is untrusted. It is only ever
// inserted with textContent (via createElement/createDetailList),
// never innerHTML.
// ==========================================================

import { createElement, createDetailList, createInfoCard } from "./dom.js";
import { formatTimestamp } from "./transcripts.js";
import { TIMESTAMP_STATUS } from "../transcript/model.js";
import { getClipDecision, CLIP_DECISION } from "../analysis/clip-decisions.js";
import { ALIGNMENT_STATUS } from "../core/project.js";

// Display only: canonical seconds -> the project's established
// m:ss.mmm form. Null (unknown) is never rendered as zero.
function formatClipSeconds(seconds) {
    return formatTimestamp(seconds === null
        ? { seconds: null, status: TIMESTAMP_STATUS.MISSING }
        : { seconds, status: TIMESTAMP_STATUS.PARSED });
}

// Why a candidate cannot seek. Pure and unit-testable.
export function describeSeekDisabledReason(reason) {
    switch (reason) {
        case "no-player":
            return "Seeking is unavailable: no embedded player is loaded for this project.";
        case "transcript-mismatch":
            return "Seeking is unavailable: this candidate was derived from a different transcript than the one currently loaded.";
        case "no-timestamp":
            return "Seeking is unavailable: this candidate has no start timestamp (time unknown).";
        default:
            return "Seeking is unavailable.";
    }
}

// Pure candidate view-model: everything the card needs that can
// be derived without the DOM. context: { decision, playerAvailable,
// transcriptId, currentCandidateId }.
export function describeCandidate(clipSpec, context = {}) {
    const {
        decision = null,
        playerAvailable = false,
        transcriptId = null,
        currentCandidateId = null
    } = context;
    const startSeconds = clipSpec.startSeconds;
    const endSeconds = clipSpec.endSeconds;
    let seekDisabledReason = null;
    if (!playerAvailable) {
        seekDisabledReason = "no-player";
    } else if (transcriptId === null || clipSpec.transcriptId !== transcriptId) {
        seekDisabledReason = "transcript-mismatch";
    } else if (startSeconds === null) {
        seekDisabledReason = "no-timestamp";
    }
    return {
        id: clipSpec.id,
        rangeLabel: `${formatClipSeconds(startSeconds)} → ${formatClipSeconds(endSeconds)}`,
        startLabel: formatClipSeconds(startSeconds),
        endLabel: formatClipSeconds(endSeconds),
        decision,
        isCurrent: currentCandidateId === clipSpec.id,
        canSeek: seekDisabledReason === null,
        seekDisabledReason,
        eventId: clipSpec.eventId,
        poiCount: Array.isArray(clipSpec.poiIds) ? clipSpec.poiIds.length : 0,
        deriverId: clipSpec.derivation ? clipSpec.derivation.deriverId : null
    };
}

function createPlayerCard(playerMount, playerAvailable, playerUnavailableReason) {
    const card = createElement("article", "card");
    card.dataset.section = "player";
    card.append(createElement("span", "tag", "VOD review"));
    card.append(createElement("h2", "card-title", "VOD player"));
    if (playerAvailable && playerMount) {
        // The mount is a live element owned by the application
        // coordinator; re-attaching the same element across
        // re-renders preserves the iframe (no reload on
        // KEEP/REJECT). This view never creates iframes.
        card.append(playerMount);
    } else {
        const message = playerUnavailableReason === "unsupported-platform"
            ? "Embedded playback is not supported for this video platform yet."
            : "No video is loaded. Add a video URL on the Dashboard to enable the embedded player.";
        card.append(createElement("p", "card-body", message));
    }
    return card;
}

function createAlignmentCard(project) {
    const status = project.alignment ? project.alignment.status : ALIGNMENT_STATUS.UNVERIFIED;
    const body = status === ALIGNMENT_STATUS.UNVERIFIED
        ? "Time alignment is unverified: candidate timestamps are transcript times, assumed — but not proven — to match video time. No offset is applied and none is invented. Confirm each moment yourself in the player above."
        : `Time alignment: ${status}.`;
    const card = createElement("article", "card");
    card.dataset.section = "alignment";
    card.append(createElement("span", "tag", "Alignment"));
    card.append(createElement("h2", "card-title", "Timestamp alignment"));
    card.append(createElement("p", "card-body", body));
    return card;
}

function decisionTag(decision) {
    if (decision === CLIP_DECISION.KEEP) return ["Kept", "tag"];
    if (decision === CLIP_DECISION.REJECT) return ["Rejected", "tag tag-danger"];
    return ["Unreviewed", "tag tag-muted"];
}

function createCandidateCard(clipSpec, index, project, handlers) {
    const vm = describeCandidate(clipSpec, {
        decision: getClipDecision(project.clipDecisions, clipSpec.id),
        playerAvailable: handlers.playerAvailable,
        transcriptId: project.transcript ? project.transcript.id : null,
        currentCandidateId: handlers.currentCandidateId
    });

    const card = createElement("article", "card");
    card.dataset.section = "candidate";
    card.dataset.clipSpecId = clipSpec.id;
    if (vm.isCurrent) card.classList.add("is-current");

    const [tagText, tagClass] = decisionTag(vm.decision);
    card.append(createElement("span", tagClass, tagText));
    card.append(createElement("h2", "card-title",
        `Candidate ${index + 1}${vm.isCurrent ? " — reviewing" : ""}`));
    card.append(createDetailList([
        ["Time", vm.rangeLabel],
        ["ClipSpec", clipSpec.id],
        ["Event", vm.eventId],
        ["Source POIs", String(vm.poiCount)],
        ["Derived by", vm.deriverId === null ? "unknown" : vm.deriverId]
    ]));

    const controls = createElement("div", "candidate-controls");

    const seekButton = createElement("button", "button button-primary", "Review & seek");
    seekButton.type = "button";
    seekButton.disabled = !vm.canSeek;
    seekButton.addEventListener("click", () => handlers.onSelectCandidate(clipSpec.id));

    const keepButton = createElement("button", "button",
        vm.decision === CLIP_DECISION.KEEP ? "Kept ✓" : "Keep");
    keepButton.type = "button";
    keepButton.disabled = vm.decision === CLIP_DECISION.KEEP;
    keepButton.addEventListener("click", () => handlers.onKeep(clipSpec.id));

    const rejectButton = createElement("button", "button button-danger",
        vm.decision === CLIP_DECISION.REJECT ? "Rejected ✓" : "Reject");
    rejectButton.type = "button";
    rejectButton.disabled = vm.decision === CLIP_DECISION.REJECT;
    rejectButton.addEventListener("click", () => handlers.onReject(clipSpec.id));

    const clearButton = createElement("button", "button", "Reset");
    clearButton.type = "button";
    clearButton.disabled = vm.decision === null;
    clearButton.title = "Clear this decision (back to unreviewed)";
    clearButton.addEventListener("click", () => handlers.onClearDecision(clipSpec.id));

    controls.append(seekButton, keepButton, rejectButton, clearButton);
    card.append(controls);

    if (!vm.canSeek) {
        card.append(createElement("p", "card-body", describeSeekDisabledReason(vm.seekDisabledReason)));
    }
    return card;
}

/**
 * @param {HTMLElement} mountElement
 * @param {object|null} project
 * @param {object} [view]
 *   playerMount: live coordinator-owned element holding the player iframe (or empty)
 *   playerAvailable: boolean — a player controller exists for this project
 *   playerUnavailableReason: "no-video" | "unsupported-platform" | null
 *   currentCandidateId: ClipSpec id of the current review target (ephemeral) or null
 *   onSelectCandidate(id): select + seek; onKeep(id); onReject(id); onClearDecision(id)
 */
export function renderClipsView(mountElement, project, view = {}) {
    const {
        playerMount = null,
        playerAvailable = false,
        playerUnavailableReason = null,
        currentCandidateId = null,
        onSelectCandidate = () => {},
        onKeep = () => {},
        onReject = () => {},
        onClearDecision = () => {}
    } = view;

    if (!project) {
        mountElement.replaceChildren(
            createInfoCard("No project", "Load a video or a transcript first, then return here to review clip candidates.", "Empty"));
        return;
    }

    const handlers = { playerAvailable, currentCandidateId, onSelectCandidate, onKeep, onReject, onClearDecision };
    const sections = [
        createPlayerCard(playerMount, playerAvailable, playerUnavailableReason),
        createAlignmentCard(project)
    ];

    const specs = Array.isArray(project.clipSpecs) ? project.clipSpecs : [];
    if (specs.length === 0) {
        sections.push(createInfoCard("No clip candidates",
            "Clip candidates appear here once ClipSpecs are derived from Events (Stage 9).", "Empty"));
    } else {
        specs.forEach((spec, index) => sections.push(createCandidateCard(spec, index, project, handlers)));
    }
    mountElement.replaceChildren(...sections);
}

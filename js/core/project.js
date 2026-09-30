// ==========================================================
// project.js
// Responsibility: define the PROJECT — the container that
// connects one video to its transcript and, in later stages,
// to analysis, POIs, events, and clips.
//
//   PROJECT
//   ├── video       identity + metadata   (js/video/video-model.js)
//   ├── transcript  TranscriptDocument    (js/transcript/model.js)
//   ├── alignment   how transcript time maps to video time
//   ├── analysis    reserved
//   ├── pois        normalized POIs (Stage 7: withPois)
//   ├── events       reconciled Events (Stage 8: withEvents)
//   ├── clipSpecs    derived ClipSpecs (Stage 9: withClipSpecs)
//   ├── clipDecisions human KEEP/REJECT review decisions over
//   │                ClipSpec candidates (Stage 10:
//   │                withClipDecisions / setClipDecision)
//   └── clips        reserved
//
// The transcript is stored by reference, unchanged. Video data
// is NOT copied into the transcript or its segments. A future
// POI traces: project.id → video.identity → transcript.id
// → segment ids → segment timestamps (→ alignment → seekTo).
//
// Projects are frozen. Every change returns a NEW project.
// ==========================================================

import { createRandomId } from "./ids.js";
import { AppError } from "./errors.js";
import { deepFreeze } from "../transcript/model.js";
import { assertPoi } from "../analysis/pois.js";
import { assertEvent } from "../analysis/events.js";
import { assertClipSpec } from "../analysis/clip-spec.js";
import {
    assertClipDecision, createClipDecision, normalizeClipDecisions,
    getKeptClipSpecIds
} from "../analysis/clip-decisions.js";
import { createVideo, isSameVideo, isSameStartPosition, withStartPosition, withMetadata } from "../video/video-model.js";

export const PROJECT_SCHEMA_VERSION = 1;

// Lifecycle stages, derived from contents (never stored).
export const PROJECT_STAGE = Object.freeze({
    NONE: "none",
    CREATED: "created",
    VIDEO_IDENTIFIED: "video_identified",
    TRANSCRIPT_ATTACHED: "transcript_attached",
    VIDEO_AND_TRANSCRIPT: "video_and_transcript"
});

// ---------- Time alignment ----------
//
// Answers ONE question: do transcript timestamps correspond to
// positions on this video's timeline (and with what offset)?
//
// status:
//   "unverified"  The relationship has NOT been established. This is
//                 the only status used through Stage 1.7. Having
//                 timestamps, a plausible duration, or a URL "?t="
//                 is NOT evidence of alignment.
//   "assumed"     (future) A documented basis exists (recorded in
//                 `method`) but nothing has independently checked it.
//   "verified"    (future) Defined evidence (recorded in `evidence`)
//                 establishes the relationship. Requires verifiedAt.
//
// method:        null until a future stage defines named methods.
// evidence:      [] until a future stage defines evidence records.
//                Never filled with placeholder or implied evidence.
// offsetSeconds: video time = transcript time + offsetSeconds.
//                null = unknown (NOT zero).
// verifiedAt:    ISO string, only when status is "verified".
export const ALIGNMENT_STATUS = Object.freeze({
    UNVERIFIED: "unverified",
    ASSUMED: "assumed",
    VERIFIED: "verified"
});

export function createUnverifiedAlignment() {
    return {
        status: ALIGNMENT_STATUS.UNVERIFIED,
        method: null,
        evidence: [],
        offsetSeconds: null,
        verifiedAt: null
    };
}

export function createProject() {
    const now = new Date().toISOString();
    return deepFreeze({
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: createRandomId("project"),
        createdAt: now,
        updatedAt: now,

        video: null,                              // Video or null
        transcript: null,                         // TranscriptDocument or null
        alignment: createUnverifiedAlignment(),

        analysis: { status: "not_implemented" },  // reserved
        pois: [],                                 // reserved
        events: [],                               // reserved
        clipSpecs: [],                            // reserved
        clipDecisions: [],                        // human review decisions (Stage 10)
        clips: []                                 // reserved
    });
}

function withChanges(project, changes) {
    return deepFreeze({ ...project, ...changes, updatedAt: new Date().toISOString() });
}

// Attach a transcript. The document is stored as-is (same object).
export function withTranscript(project, transcriptDocument) {
    return withChanges(project, {
        transcript: transcriptDocument,
        alignment: createUnverifiedAlignment()
    });
}

// Update the linked video's metadata through the immutable update
// path. Used by the metadata provider after a title fetch resolves.
export function withVideoMetadata(project, patch) {
    if (!project || !project.video) return project;
    return withChanges(project, { video: withMetadata(project.video, patch) });
}

// Stage 7: attach normalized POIs. Every entry must already be a
// canonical, frozen POI (createPoi / extractPois output); the
// project does not normalize provider output. The project stays
// frozen; this returns a NEW project.
export function withPois(project, pois) {
    if (!Array.isArray(pois)) {
        throw new AppError("invalid_pois", "withPois needs an array of POIs.", { pois });
    }
    return withChanges(project, { pois: pois.map(assertPoi) });
}

// Stage 8: attach reconciled Events. Every entry must already be
// a canonical, frozen Event (createEvent / reconcilePois
// output); the project does not normalize reconciler output.
// The project stays frozen; this returns a NEW project.
export function withEvents(project, events) {
    if (!Array.isArray(events)) {
        throw new AppError("invalid_events", "withEvents needs an array of Events.", { events });
    }
    return withChanges(project, { events: events.map(assertEvent) });
}

// Stage 9: attach derived ClipSpecs. Every entry must already be
// a canonical, frozen ClipSpec (createClipSpec / deriveClipSpecs
// output); the project does not normalize deriver output.
// The project stays frozen; this returns a NEW project.
export function withClipSpecs(project, clipSpecs) {
    if (!Array.isArray(clipSpecs)) {
        throw new AppError("invalid_clip_specs", "withClipSpecs needs an array of ClipSpecs.", { clipSpecs });
    }
    return withChanges(project, { clipSpecs: clipSpecs.map(assertClipSpec) });
}

// Stage 10: attach human review decisions over ClipSpec
// candidates. Every entry must already be a canonical, frozen
// ClipDecision (createClipDecision output); unknown ClipSpec ids
// are rejected. This replaces the whole decision set — the
// project stays frozen and a NEW project is returned.
export function withClipDecisions(project, decisions) {
    const knownIds = project.clipSpecs.map((spec) => spec.id);
    return withChanges(project, { clipDecisions: normalizeClipDecisions(decisions, knownIds) });
}

// Stage 10: record one human decision ("keep" or "reject") for a
// ClipSpec candidate. Unknown ClipSpec ids and invalid decision
// values are rejected. Replaces any earlier decision for the
// same candidate, so KEEP ↔ REJECT transitions are allowed. The
// project stays frozen; this returns a NEW project.
export function setClipDecision(project, clipSpecId, decision, { decidedAt } = {}) {
    const knownIds = project.clipSpecs.map((spec) => spec.id);
    if (!knownIds.includes(clipSpecId)) {
        throw new AppError("unknown_clip_spec",
            "Cannot record a decision for an unknown ClipSpec.", { clipSpecId });
    }
    const remaining = project.clipDecisions.filter((entry) => entry.clipSpecId !== clipSpecId);
    remaining.push(createClipDecision({ clipSpecId, decision, decidedAt }));
    return withChanges(project, { clipDecisions: remaining });
}

// Stage 10: reset one candidate to unreviewed by removing its
// decision. When there is no decision to remove, the project is
// returned unchanged (the same object — nothing happened).
export function clearClipDecision(project, clipSpecId) {
    const remaining = project.clipDecisions.filter((entry) => entry.clipSpecId !== clipSpecId);
    if (remaining.length === project.clipDecisions.length) return project;
    return withChanges(project, { clipDecisions: remaining });
}

// Stage 10: the kept ClipSpecs — the deterministic input future
// clip-generation stages consume. Order follows
// project.clipSpecs, so the same project always yields the same
// list. The ClipSpecs themselves are untouched.
export function getKeptClipSpecs(project) {
    const keptIds = new Set(getKeptClipSpecIds(project.clipDecisions));
    return project.clipSpecs.filter((spec) => keptIds.has(spec.id));
}

/**
 * Plan the effect of a resolved video on the current project.
 * Pure: never changes currentProject; nothing is applied until the
 * caller stores `project` (use finalizeVideoChange for replacements).
 *
 *   no project                     → new project ("created")
 *   project without a video        → attach video, keep transcript ("attached")
 *   SAME video, same/no new hint   → unchanged ("unchanged")
 *   SAME video, new "?t=" hint     → update only video.startPosition
 *                                    ("start_position_updated")
 *   DIFFERENT video                → new project ("replaced"). If the current
 *                                    project holds a transcript,
 *                                    requiresConfirmation is true.
 *
 * A URL without any time parameter leaves an existing hint in place:
 * it carries no new information about start position.
 *
 * @returns {{project:object, outcome:string, requiresConfirmation:boolean}}
 */
export function applyVideoIdentity(currentProject, identity, startPosition = null) {
    const plan = (project, outcome, requiresConfirmation = false) =>
        ({ project, outcome, requiresConfirmation });

    if (!currentProject) {
        return plan(withChanges(createProject(), { video: createVideo(identity, startPosition) }), "created");
    }
    if (!currentProject.video) {
        return plan(withChanges(currentProject, { video: createVideo(identity, startPosition) }), "attached");
    }

    const current = currentProject.video;
    if (isSameVideo(current, { identity })) {
        if (startPosition === null || isSameStartPosition(current.startPosition, startPosition)) {
            return plan(currentProject, "unchanged");
        }
        return plan(withChanges(currentProject, { video: withStartPosition(current, startPosition) }),
            "start_position_updated");
    }

    const replacement = withChanges(createProject(), { video: createVideo(identity, startPosition) });
    return plan(replacement, "replaced", currentProject.transcript !== null);
}

/**
 * Decide which project to keep after a plan that may need confirmation.
 * confirmed=false on a confirmation-required plan returns the current
 * project untouched (the same object).
 */
export function finalizeVideoChange(currentProject, videoPlan, { confirmed }) {
    if (videoPlan.requiresConfirmation && !confirmed) return currentProject;
    return videoPlan.project;
}

export function getProjectStage(project) {
    if (!project) return PROJECT_STAGE.NONE;
    if (project.video && project.transcript) return PROJECT_STAGE.VIDEO_AND_TRANSCRIPT;
    if (project.video) return PROJECT_STAGE.VIDEO_IDENTIFIED;
    if (project.transcript) return PROJECT_STAGE.TRANSCRIPT_ATTACHED;
    return PROJECT_STAGE.CREATED;
}

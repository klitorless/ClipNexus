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
//   └── pois / events / clips  reserved
//
// The transcript is stored by reference, unchanged. Video data
// is NOT copied into the transcript or its segments. A future
// POI traces: project.id → video.identity → transcript.id
// → segment ids → segment timestamps (→ alignment → seekTo).
//
// Projects are frozen. Every change returns a NEW project.
// ==========================================================

import { createRandomId } from "./ids.js";
import { deepFreeze } from "../transcript/model.js";
import { createVideo, isSameVideo, isSameStartPosition, withStartPosition } from "../video/video-model.js";

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

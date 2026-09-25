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
import { createVideo, isSameVideo } from "../video/video-model.js";

export const PROJECT_SCHEMA_VERSION = 1;

// Lifecycle stages, derived from contents (never stored).
export const PROJECT_STAGE = Object.freeze({
    NONE: "none",
    CREATED: "created",
    VIDEO_IDENTIFIED: "video_identified",
    TRANSCRIPT_ATTACHED: "transcript_attached",
    VIDEO_AND_TRANSCRIPT: "video_and_transcript"
});

// alignment.status values:
//   "unverified"  no evidence yet that transcript time == video time
//   "assumed"     treated as equal without verification   (future)
//   "verified"    confirmed (e.g. transcript from this video) (future)
export const ALIGNMENT_STATUS = Object.freeze({
    UNVERIFIED: "unverified",
    ASSUMED: "assumed",
    VERIFIED: "verified"
});

function createUnverifiedAlignment() {
    return { status: ALIGNMENT_STATUS.UNVERIFIED, offsetSeconds: null };
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
 * Apply a resolved video identity to the current project.
 *
 * Rules:
 *   no project                     → new project with this video ("created")
 *   project without a video        → attach video, keep transcript ("attached")
 *   project with the SAME video    → unchanged ("unchanged")
 *   project with a DIFFERENT video → new project; the old transcript
 *                                    belonged to another video ("replaced")
 *
 * @returns {{project:object, outcome:"created"|"attached"|"unchanged"|"replaced"}}
 */
export function applyVideoIdentity(currentProject, identity) {
    const video = createVideo(identity);

    if (!currentProject) {
        return { project: withChanges(createProject(), { video }), outcome: "created" };
    }
    if (!currentProject.video) {
        return { project: withChanges(currentProject, { video }), outcome: "attached" };
    }
    if (isSameVideo(currentProject.video, video)) {
        return { project: currentProject, outcome: "unchanged" };
    }
    return { project: withChanges(createProject(), { video }), outcome: "replaced" };
}

export function getProjectStage(project) {
    if (!project) return PROJECT_STAGE.NONE;
    if (project.video && project.transcript) return PROJECT_STAGE.VIDEO_AND_TRANSCRIPT;
    if (project.video) return PROJECT_STAGE.VIDEO_IDENTIFIED;
    if (project.transcript) return PROJECT_STAGE.TRANSCRIPT_ATTACHED;
    return PROJECT_STAGE.CREATED;
}

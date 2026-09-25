// ==========================================================
// devtools-project-tests.js
// Responsibility: Stage 1.6 self-tests (project model, video
// model, URL resolver, transcript ↔ project relationship).
// Registered by devtools.js via addProjectTests(add, state).
// Pure: never touches application state.
// ==========================================================

import { createProject, withTranscript, applyVideoIdentity, getProjectStage, PROJECT_STAGE } from "./project.js";
import { resolveVideoUrl } from "../video/video-resolver.js";
import { METADATA_STATUS } from "../video/video-model.js";
import { parseTranscript } from "../transcript/parser.js";

const videoId = "dQw4w9WgXcQ";
const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

// Equivalent URL forms that must resolve to the same identity.
const equivalentUrls = [
    `https://www.youtube.com/watch?v=${videoId}`,
    `https://youtube.com/watch?v=${videoId}`,
    `https://m.youtube.com/watch?v=${videoId}&t=42s&si=abc`,
    `https://www.youtube.com/watch?feature=share&v=${videoId}&list=PL123`,
    `https://youtu.be/${videoId}`,
    `https://youtu.be/${videoId}?t=90`,
    `https://www.youtube.com/embed/${videoId}?start=10`,
    `https://www.youtube-nocookie.com/embed/${videoId}`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/live/${videoId}`,
    `HTTPS://WWW.YOUTUBE.COM/watch?v=${videoId}`,
    `  youtu.be/${videoId}  `
];

// [input, expected error code]
const invalidUrls = [
    ["", "empty_url"],
    ["   ", "empty_url"],
    ["not a url", "malformed_url"],
    ["https://", "malformed_url"],
    ["javascript:alert(1)", "unsupported_protocol"],
    ["data:text/html,<b>x</b>", "unsupported_protocol"],
    ["ftp://youtube.com/watch?v=dQw4w9WgXcQ", "unsupported_protocol"],
    ["https://user:pw@youtube.com/watch?v=dQw4w9WgXcQ", "malformed_url"],
    ["https://vimeo.com/123456", "unsupported_platform"],
    ["https://www.twitch.tv/videos/123456789", "unsupported_platform"],
    ["https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "unsupported_platform"],
    ["https://www.youtube.com/", "missing_video_id"],
    ["https://www.youtube.com/@somechannel", "missing_video_id"],
    ["https://www.youtube.com/playlist?list=PL123", "missing_video_id"],
    ["https://www.youtube.com/watch?v=", "missing_video_id"],
    ["https://www.youtube.com/watch?v=short", "invalid_video_id"],
    ["https://youtu.be/<script>alert(1)</script>", "invalid_video_id"]
];

function resolveOrNull(url) {
    const result = resolveVideoUrl(url);
    return result.success ? result.video : null;
}

function sampleTranscript() {
    const rawText = "1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n";
    return parseTranscript({ rawText, format: "srt", filename: "vod.srt", size: rawText.length });
}

export function addProjectTests(add) {
    add("project: created with id, timestamps, empty containers", () => {
        const project = createProject();
        return /^project-/.test(project.id) && project.createdAt === project.updatedAt &&
            !Number.isNaN(Date.parse(project.createdAt)) &&
            project.video === null && project.transcript === null &&
            project.analysis.status === "not_implemented" &&
            project.pois.length === 0 && project.events.length === 0 && project.clips.length === 0 &&
            getProjectStage(project) === PROJECT_STAGE.CREATED && getProjectStage(null) === PROJECT_STAGE.NONE;
    });

    add("project: is frozen", () => {
        const project = createProject();
        return Object.isFrozen(project) && Object.isFrozen(project.pois) && Object.isFrozen(project.alignment);
    });

    add("resolver: common YouTube forms resolve", () =>
        equivalentUrls.every((url) => resolveVideoUrl(url).success === true));

    add("resolver: equivalent URLs share one identity", () =>
        equivalentUrls.every((url) => {
            const video = resolveOrNull(url);
            return video && video.platform === "youtube" && video.videoId === videoId &&
                video.canonicalUrl === canonicalUrl;
        }));

    add("resolver: identity is stable across calls", () => {
        const first = resolveOrNull(`https://youtu.be/${videoId}`);
        const second = resolveOrNull(`https://youtu.be/${videoId}`);
        return JSON.stringify(first) === JSON.stringify(second);
    });

    add("resolver: keeps the URL exactly as entered", () =>
        resolveOrNull(`  youtu.be/${videoId}  `).url === `  youtu.be/${videoId}  `);

    add("resolver: invalid URLs fail with the right code", () =>
        invalidUrls.every(([input, code]) => {
            const result = resolveVideoUrl(input);
            return result.success === false && result.error.code === code &&
                typeof result.error.message === "string" && !("video" in result);
        }));

    add("resolver: non-string input fails cleanly", () =>
        [null, undefined, 42, {}].every((input) => resolveVideoUrl(input).success === false));

    add("video: identity known, metadata null (not invented)", () => {
        const { project } = applyVideoIdentity(null, resolveOrNull(canonicalUrl));
        const { metadata } = project.video;
        return project.video.identity.videoId === videoId &&
            metadata.title === null && metadata.thumbnailUrl === null && metadata.durationSeconds === null &&
            metadata.status === METADATA_STATUS.UNKNOWN &&
            getProjectStage(project) === PROJECT_STAGE.VIDEO_IDENTIFIED;
    });

    add("project: video lifecycle outcomes", () => {
        const first = applyVideoIdentity(null, resolveOrNull(canonicalUrl));
        const same = applyVideoIdentity(first.project, resolveOrNull(`https://youtu.be/${videoId}`));
        const other = applyVideoIdentity(first.project, resolveOrNull("https://youtu.be/aaaaaaaaaaa"));
        const attached = applyVideoIdentity(createProject(), resolveOrNull(canonicalUrl));
        return first.outcome === "created" && same.outcome === "unchanged" && same.project === first.project &&
            other.outcome === "replaced" && other.project.id !== first.project.id &&
            attached.outcome === "attached";
    });

    add("transcript: belongs to project without video duplication", () => {
        const transcript = sampleTranscript();
        const before = JSON.stringify(transcript);
        const { project } = applyVideoIdentity(null, resolveOrNull(canonicalUrl));
        const linked = withTranscript(project, transcript);
        const serialized = JSON.stringify(linked.transcript);
        return linked.transcript === transcript &&          // same object, not a copy
            JSON.stringify(transcript) === before &&        // unchanged
            !serialized.includes(videoId) && !("video" in transcript) &&
            linked.video === project.video && linked !== project &&
            getProjectStage(linked) === PROJECT_STAGE.VIDEO_AND_TRANSCRIPT;
    });

    add("transcript: attaching first keeps it when video is added", () => {
        const transcript = sampleTranscript();
        const withTx = withTranscript(createProject(), transcript);
        const { project, outcome } = applyVideoIdentity(withTx, resolveOrNull(canonicalUrl));
        return outcome === "attached" && project.transcript === transcript &&
            project.transcript.rawText === "1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n";
    });

    add("alignment: transcript↔video time is unverified, not assumed", () => {
        const linked = withTranscript(createProject(), sampleTranscript());
        return linked.alignment.status === "unverified" && linked.alignment.offsetSeconds === null;
    });
}

// ==========================================================
// devtools-project-tests.js
// Responsibility: Stage 1.6 + 1.7 self-tests (project model,
// video model, URL resolver, start-position hint, replacement
// confirmation, alignment state, linked-video UI).
// Registered by devtools.js via addProjectTests(add, state).
// Pure: never touches application state. UI checks render into
// detached elements that are never attached to the page.
// ==========================================================

import {
    createProject, withTranscript, applyVideoIdentity, finalizeVideoChange, getProjectStage, PROJECT_STAGE
} from "./project.js";
import { renderTranscriptsView } from "../ui/transcripts.js";
import { renderDashboard } from "../ui/dashboard.js";
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

// ---------- Stage 1.7 ----------

// [URL, expected seconds]
const validStartUrls = [
    [`https://www.youtube.com/watch?v=${videoId}&t=120`, 120],
    [`https://youtu.be/${videoId}?t=120s`, 120],
    [`https://youtu.be/${videoId}?t=1m20s`, 80],
    [`https://www.youtube.com/watch?v=${videoId}&t=1h2m3s`, 3723],
    [`https://www.youtube.com/watch?t=45&v=${videoId}`, 45],
    [`https://www.youtube.com/watch?v=${videoId}#t=2m`, 120],
    [`https://www.youtube.com/embed/${videoId}?start=10`, 10],
    [`https://youtu.be/${videoId}?t=0`, 0]
];

// [URL, expected status] — resolution must still succeed.
const invalidStartUrls = [
    [`https://youtu.be/${videoId}?t=abc`, "malformed"],
    [`https://youtu.be/${videoId}?t=`, "malformed"],
    [`https://youtu.be/${videoId}?t=1m20`, "malformed"],
    [`https://youtu.be/${videoId}?t=1x`, "malformed"],
    [`https://youtu.be/${videoId}?t=-5`, "malformed"],
    [`https://youtu.be/${videoId}?t=1.5`, "malformed"],
    [`https://youtu.be/${videoId}?t=20s1m`, "malformed"],
    [`https://youtu.be/${videoId}?t=99999999999999999999`, "malformed"],
    [`https://youtu.be/${videoId}?t=10&t=20`, "ambiguous"]
];

function resolveFull(url) {
    const result = resolveVideoUrl(url);
    if (!result.success) throw new Error(`did not resolve: ${url}`);
    return result;
}

function planFor(project, url) {
    const { video, startPosition } = resolveFull(url);
    return applyVideoIdentity(project, video, startPosition);
}

function projectWithVideoAndTranscript(url = canonicalUrl) {
    return withTranscript(planFor(null, url).project, sampleTranscript());
}

function renderDetached(render) {
    const mount = document.createElement("div");
    render(mount);
    return mount;
}

function hasNoUnsafeElements(mount) {
    return mount.querySelectorAll("a, iframe, img, video, script").length === 0;
}

export function addStage17Tests(add) {
    add("start hint: t formats normalize to seconds", () =>
        validStartUrls.every(([url, seconds]) => {
            const hint = resolveFull(url).startPosition;
            return hint && hint.status === "parsed" && hint.seconds === seconds;
        }));

    add("start hint: uses Stage 1.5 timestamp shape, unverified, frozen", () => {
        const url = `https://youtu.be/${videoId}?t=1m20s&si=abc`;
        const hint = resolveFull(url).startPosition;
        return hint.raw === "1m20s" && hint.seconds === 80 && hint.source === "url" &&
            hint.verified === false && hint.sourceUrl === url && Object.isFrozen(hint);
    });

    add("start hint: none in URL gives null (not zero)", () =>
        resolveFull(canonicalUrl).startPosition === null);

    add("start hint: invalid values never become positions", () =>
        invalidStartUrls.every(([url, status]) => {
            const result = resolveVideoUrl(url);
            return result.success && result.video.videoId === videoId &&
                result.startPosition.status === status && result.startPosition.seconds === null;
        }));

    add("start hint: not part of identity; canonical URL has no t", () => {
        const a = resolveFull(`https://youtube.com/watch?v=${videoId}&t=120`);
        const b = resolveFull(`https://youtube.com/watch?v=${videoId}&t=300`);
        const c = resolveFull(`https://youtu.be/${videoId}?t=120`);
        const same = (x, y) => x.video.platform === y.video.platform &&
            x.video.videoId === y.video.videoId && x.video.canonicalUrl === y.video.canonicalUrl;
        return same(a, b) && same(a, c) && a.video.canonicalUrl === canonicalUrl &&
            !a.video.canonicalUrl.includes("t=") && !("startPosition" in a.video);
    });

    add("start hint: original URL preserved exactly", () => {
        const url = `https://youtu.be/${videoId}?t=1m20s&si=SOMETHING`;
        return resolveFull(url).video.url === url;
    });

    add("same video + new t: hint updated, project and transcript kept", () => {
        const project = projectWithVideoAndTranscript(`https://youtu.be/${videoId}?t=10`);
        const plan = planFor(project, `https://www.youtube.com/watch?v=${videoId}&t=300`);
        return plan.outcome === "start_position_updated" && !plan.requiresConfirmation &&
            plan.project.id === project.id && plan.project.transcript === project.transcript &&
            plan.project.video.identity === project.video.identity &&
            plan.project.video.startPosition.seconds === 300 &&
            project.video.startPosition.seconds === 10;              // old project untouched
    });

    add("same video without t: unchanged, hint and transcript kept", () => {
        const project = projectWithVideoAndTranscript(`https://youtu.be/${videoId}?t=10`);
        const plan = planFor(project, `https://youtu.be/${videoId}`);
        return plan.outcome === "unchanged" && plan.project === project &&
            plan.project.video.startPosition.seconds === 10;
    });

    add("replace: no transcript → no confirmation needed", () => {
        const project = planFor(null, canonicalUrl).project;
        const plan = planFor(project, "https://youtu.be/aaaaaaaaaaa");
        return plan.outcome === "replaced" && plan.requiresConfirmation === false &&
            finalizeVideoChange(project, plan, { confirmed: false }) === plan.project;
    });

    add("replace: transcript present → confirmation required", () => {
        const project = projectWithVideoAndTranscript();
        const plan = planFor(project, "https://youtu.be/aaaaaaaaaaa");
        return plan.outcome === "replaced" && plan.requiresConfirmation === true &&
            plan.project.transcript === null;
    });

    add("replace: Cancel keeps the current project unchanged", () => {
        const project = projectWithVideoAndTranscript();
        const before = JSON.stringify(project);
        const plan = planFor(project, "https://youtu.be/aaaaaaaaaaa");
        const kept = finalizeVideoChange(project, plan, { confirmed: false });
        return kept === project && JSON.stringify(kept) === before &&
            kept.transcript !== null && kept.video.identity.videoId === videoId;
    });

    add("replace: Replace creates a clean project for the new video", () => {
        const project = projectWithVideoAndTranscript();
        const plan = planFor(project, "https://youtu.be/aaaaaaaaaaa?t=5");
        const next = finalizeVideoChange(project, plan, { confirmed: true });
        return next === plan.project && next.id !== project.id && next.transcript === null &&
            next.video.identity.videoId === "aaaaaaaaaaa" && next.video.startPosition.seconds === 5 &&
            project.transcript !== null;                              // old object untouched
    });

    add("alignment: unverified with no method or evidence, in every path", () => {
        const withVideo = planFor(null, `https://youtu.be/${videoId}?t=90`).project;
        const both = withTranscript(withVideo, sampleTranscript());
        const hintUpdated = planFor(both, `https://youtu.be/${videoId}?t=120`).project;
        return [createProject(), withVideo, both, hintUpdated].every(({ alignment }) =>
            alignment.status === "unverified" && alignment.method === null &&
            Array.isArray(alignment.evidence) && alignment.evidence.length === 0 &&
            Object.isFrozen(alignment.evidence) &&
            alignment.offsetSeconds === null && alignment.verifiedAt === null);
    });

    add("transcripts page: linked video renders from project, safely", () => {
        const hostile = `https://youtu.be/${videoId}?t=<img/src=x/onerror=alert(1)>`;
        const project = withTranscript(planFor(null, hostile).project, sampleTranscript());
        const mount = renderDetached((element) => renderTranscriptsView(element, project));
        const card = mount.querySelector("[data-section='linked-video']");
        const text = card ? card.textContent : "";
        const empty = renderDetached((element) => renderTranscriptsView(element, createProject()));
        return card !== null && mount.firstElementChild === card &&
            text.includes("YouTube") && text.includes(videoId) && text.includes("Not loaded") &&
            text.includes(canonicalUrl) && text.includes("Unverified") &&
            hasNoUnsafeElements(mount) &&
            empty.textContent.includes("No video linked");
    });

    add("dashboard: status card describes Stage 1.7", () => {
        const stubState = { get: (key) => (key === "ui" ? {} : null) };
        const mount = renderDetached((element) =>
            renderDashboard(element, stubState, { onVideoUrlSubmit: () => ({ ok: true, message: "" }) }));
        const text = mount.textContent;
        return text.includes("Stage 1.7 — Project & Video Foundation") &&
            !text.includes("Stage 1 — Application Shell");
    });
}

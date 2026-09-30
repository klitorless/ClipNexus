// ==========================================================
// devtools-metadata-tests.js
// Video metadata (title) via the YouTube Data API.
//
// Covered: fetchYouTubeTitle's request shape (title-only fields,
// encoded id/key), the typed failure vocabulary (bad key,
// not found, network, unexpected), withMetadata's immutable merge,
// and withVideoMetadata's project-level update path.
//
// No real network: every test injects a mock fetchFn. No DOM.
// ==========================================================

import {
    fetchYouTubeTitle, MetadataError, METADATA_ERROR_CODES
} from "../video/metadata-provider.js";
import {
    createVideo, createVideoIdentity, withMetadata, METADATA_STATUS
} from "../video/video-model.js";
import { createProject, withVideoMetadata, applyVideoIdentity, finalizeVideoChange } from "./project.js";

export function addMetadataTests(add) {

    function mockFetch({ status = 200, body = {} } = {}) {
        const calls = [];
        const fetchFn = (url, init) => {
            calls.push({ url, init });
            return Promise.resolve({
                status,
                ok: status >= 200 && status < 300,
                json: () => Promise.resolve(body)
            });
        };
        return { fetchFn, calls };
    }

    function titleBody(title) {
        return { items: [{ snippet: { title } }] };
    }

    async function expectMetadataError(promise, expectedCode) {
        try {
            await promise;
        } catch (error) {
            if (!(error instanceof MetadataError)) {
                throw new Error(`expected MetadataError, got ${error && error.constructor && error.constructor.name}`);
            }
            if (error.code !== expectedCode) {
                throw new Error(`expected code ${expectedCode}, got ${error.code}`);
            }
            return true;
        }
        throw new Error(`expected MetadataError(${expectedCode}), but the call succeeded`);
    }

    function makeVideo() {
        return createVideo(createVideoIdentity({
            platform: "youtube",
            videoId: "dQw4w9WgXcQ",
            canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        }));
    }

    add("metadata: fetchYouTubeTitle returns the trimmed title", async () => {
        const { fetchFn } = mockFetch({ body: titleBody("  Never Gonna Give You Up  ") });
        const result = await fetchYouTubeTitle("dQw4w9WgXcQ", "KEY123", { fetchFn });
        if (result.title !== "Never Gonna Give You Up") throw new Error(`wrong title: ${result.title}`);
        return true;
    });

    add("metadata: request targets the videos endpoint with title-only fields", async () => {
        const { fetchFn, calls } = mockFetch({ body: titleBody("T") });
        await fetchYouTubeTitle("abc 123", "K&E=Y", { fetchFn });
        if (calls.length !== 1) throw new Error("expected exactly one request");
        const url = calls[0].url;
        if (!url.startsWith("https://www.googleapis.com/youtube/v3/videos?")) {
            throw new Error(`wrong endpoint: ${url}`);
        }
        if (!url.includes("id=abc%20123")) throw new Error(`video id not encoded: ${url}`);
        if (!url.includes("key=K%26E%3DY")) throw new Error(`api key not encoded: ${url}`);
        if (!url.includes("fields=")) throw new Error(`fields param missing: ${url}`);
        if (url.includes("contentDetails") || url.includes("statistics")) {
            throw new Error(`requests more than the title: ${url}`);
        }
        return true;
    });

    add("metadata: 403 is a bad-key error", async () => {
        const { fetchFn } = mockFetch({ status: 403 });
        return expectMetadataError(
            fetchYouTubeTitle("dQw4w9WgXcQ", "BAD", { fetchFn }),
            METADATA_ERROR_CODES.BAD_KEY);
    });

    add("metadata: 401 is a bad-key error", async () => {
        const { fetchFn } = mockFetch({ status: 401 });
        return expectMetadataError(
            fetchYouTubeTitle("dQw4w9WgXcQ", "BAD", { fetchFn }),
            METADATA_ERROR_CODES.BAD_KEY);
    });

    add("metadata: 404 is a not-found error", async () => {
        const { fetchFn } = mockFetch({ status: 404 });
        return expectMetadataError(
            fetchYouTubeTitle("missing", "KEY", { fetchFn }),
            METADATA_ERROR_CODES.NOT_FOUND);
    });

    add("metadata: 200 with no items is a not-found error", async () => {
        const { fetchFn } = mockFetch({ body: { items: [] } });
        return expectMetadataError(
            fetchYouTubeTitle("private", "KEY", { fetchFn }),
            METADATA_ERROR_CODES.NOT_FOUND);
    });

    add("metadata: 200 with an unusable title is a not-found error", async () => {
        const { fetchFn } = mockFetch({ body: titleBody("   ") });
        return expectMetadataError(
            fetchYouTubeTitle("dQw4w9WgXcQ", "KEY", { fetchFn }),
            METADATA_ERROR_CODES.NOT_FOUND);
    });

    add("metadata: a thrown fetch is a network error", async () => {
        const fetchFn = () => Promise.reject(new TypeError("fetch failed"));
        return expectMetadataError(
            fetchYouTubeTitle("dQw4w9WgXcQ", "KEY", { fetchFn }),
            METADATA_ERROR_CODES.NETWORK);
    });

    add("metadata: an unreadable body is an unexpected error", async () => {
        const fetchFn = () => Promise.resolve({
            status: 200, ok: true, json: () => Promise.reject(new Error("bad json"))
        });
        return expectMetadataError(
            fetchYouTubeTitle("dQw4w9WgXcQ", "KEY", { fetchFn }),
            METADATA_ERROR_CODES.UNEXPECTED);
    });

    add("metadata: missing video id or key is an unexpected error", async () => {
        const { fetchFn, calls } = mockFetch({ body: titleBody("T") });
        await expectMetadataError(
            fetchYouTubeTitle("", "KEY", { fetchFn }),
            METADATA_ERROR_CODES.UNEXPECTED);
        await expectMetadataError(
            fetchYouTubeTitle("dQw4w9WgXcQ", "  ", { fetchFn }),
            METADATA_ERROR_CODES.UNEXPECTED);
        if (calls.length !== 0) throw new Error("no request should have been made");
        return true;
    });

    add("metadata: the key never appears in an error", async () => {
        const { fetchFn } = mockFetch({ status: 403 });
        try {
            await fetchYouTubeTitle("dQw4w9WgXcQ", "SUPERSECRETKEY", { fetchFn });
        } catch (error) {
            const text = `${error.message} ${JSON.stringify(error.detail)}`;
            if (text.includes("SUPERSECRETKEY")) throw new Error("key leaked into error");
            return true;
        }
        throw new Error("expected an error");
    });

    add("metadata: withMetadata merges the patch and keeps identity", () => {
        const video = makeVideo();
        const updated = withMetadata(video, {
            status: METADATA_STATUS.LOADED, title: "A Title",
            provider: "youtube-data-api", retrievedAt: "2026-09-30T00:00:00.000Z"
        });
        if (updated.metadata.title !== "A Title") throw new Error("title not merged");
        if (updated.metadata.status !== METADATA_STATUS.LOADED) throw new Error("status not merged");
        if (updated.metadata.provider !== "youtube-data-api") throw new Error("provider not merged");
        if (updated.identity !== video.identity) throw new Error("identity must be kept by reference");
        if (updated.startPosition !== video.startPosition) throw new Error("startPosition must be kept");
        if (!Object.isFrozen(updated) || !Object.isFrozen(updated.metadata)) {
            throw new Error("result must be frozen");
        }
        if (video.metadata.title !== null || video.metadata.status !== METADATA_STATUS.UNKNOWN) {
            throw new Error("original video was mutated");
        }
        return true;
    });

    add("metadata: withVideoMetadata updates the project through the immutable path", () => {
        const video = makeVideo();
        const empty = createProject();
        const plan = applyVideoIdentity(empty, video.identity, null);
        const project = finalizeVideoChange(empty, plan, { confirmed: true });
        const next = withVideoMetadata(project, { status: METADATA_STATUS.LOADED, title: "A Title" });
        if (next === project) throw new Error("must return a new project");
        if (next.video.metadata.title !== "A Title") throw new Error("title not applied");
        if (next.video.metadata.status !== METADATA_STATUS.LOADED) throw new Error("status not applied");
        if (next.video.identity !== project.video.identity) throw new Error("identity must be kept by reference");
        if (project.video.metadata.title !== null) throw new Error("original project was mutated");
        return true;
    });

    add("metadata: withVideoMetadata is a no-op without a video", () => {
        const project = createProject();
        const next = withVideoMetadata(project, { status: METADATA_STATUS.LOADED });
        if (next !== project) throw new Error("must return the same project when there is no video");
        return true;
    });
}

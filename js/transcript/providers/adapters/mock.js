// ==========================================================
// adapters/mock.js
// Responsibility: DETERMINISTIC fake providers for self-tests
// and for previewing the acquisition UI from the console
// (vodAnalyzer.registerMockProviders()). Never registered by
// default. No network, no randomness, no real transcripts —
// every mock is named "Mock …" so its provenance is obvious.
//
// behavior:
//   "success"    returns { rawText, format, method, language, sourceId }
//   "fail"       returns { success:false, error:{ code: errorCode } }
//   "throw"      the adapter throws
//   "hang"       never settles (tests the manager timeout)
//   "raw"        returns `response` verbatim (tests normalization)
// ==========================================================

import { defineProvider, PROVIDER_STATUS } from "../provider.js";

export const MOCK_TRANSCRIPT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nMock transcript line (test data)\n";

export function createMockProvider({
    id, name = `Mock ${id}`, behavior = "success", enabled = true,
    errorCode = "TRANSCRIPT_UNAVAILABLE", errorDetail = {}, response = null,
    rawText = MOCK_TRANSCRIPT, format = "vtt", method = "native", language = null, sourceId = null,
    capabilities = { platforms: ["youtube"], nativeCaptions: true, generatedTranscript: true, languageSelection: true },
    onCall = null, delayMs = 0
}) {
    async function getTranscript(video, options) {
        if (onCall) onCall(video, options);
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (behavior === "throw") throw new Error("mock adapter failure");
        if (behavior === "hang") return new Promise(() => {});
        if (behavior === "raw") return response;
        if (behavior === "fail") return { success: false, error: { code: errorCode, detail: errorDetail } };
        return {
            success: true,
            transcript: { rawText, format },
            source: { method, language: language ?? options.language, sourceId: sourceId ?? `mock:${video.videoId}` }
        };
    }
    return defineProvider({
        id, name, description: "Deterministic test provider (no network).",
        status: PROVIDER_STATUS.AVAILABLE, enabled, capabilities, getTranscript
    });
}

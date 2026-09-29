// ==========================================================
// poi-providers/mock.js
// Responsibility: DETERMINISTIC mock POI extraction providers
// for self-tests. Never registered anywhere by default. No
// network, no AI, no randomness — every mock is named
// "Mock …" so its provenance is obvious.
//
// behavior:
//   "success"    returns candidates from a fixed textual rule
//   "fail"       returns { success:false, error:{ code: errorCode } }
//   "throw"      getPois throws
//   "raw"        returns `response` verbatim (tests normalization)
//
// The success rule: a segment whose text contains "?" becomes a
// "question" POI; a segment whose text contains "!" becomes a
// "highlight" POI. That is the entire rule. Times and segment
// references come from the real extraction input, so the mock
// exercises temporal validation, identity, and provenance.
// ==========================================================

import { definePoiProvider, POI_PROVIDER_STATUS } from "./provider.js";

function truncate(text, limit = 48) {
    const clean = text.trim().replace(/\s+/g, " ");
    return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

function candidatesFromInput(input) {
    const candidates = [];
    for (const segment of input.segments) {
        const text = typeof segment.text === "string" ? segment.text : "";
        const base = {
            startSeconds: segment.start.seconds,
            endSeconds: segment.end.seconds,
            segmentIds: [segment.id]
        };
        if (text.includes("?")) {
            candidates.push({
                ...base,
                type: "question",
                label: `Question asked: "${truncate(text)}"`,
                providerRef: `question-${segment.id}`
            });
        } else if (text.includes("!")) {
            candidates.push({
                ...base,
                type: "highlight",
                label: `Emphatic moment: "${truncate(text)}"`,
                providerRef: `highlight-${segment.id}`
            });
        }
    }
    return candidates;
}

export function createMockPoiProvider({
    id = "mock-poi-provider",
    name = "Mock POI provider",
    behavior = "success",
    errorCode = "PROVIDER_ERROR",
    response = null
} = {}) {
    async function getPois(input) {
        if (behavior === "throw") throw new Error("mock POI provider failure");
        if (behavior === "raw") return response;
        if (behavior === "fail") return { success: false, error: { code: errorCode } };
        return { success: true, candidates: candidatesFromInput(input) };
    }
    return definePoiProvider({
        id,
        name,
        description: "Deterministic mock POI extractor (no network, no AI).",
        status: POI_PROVIDER_STATUS.AVAILABLE,
        getPois
    });
}

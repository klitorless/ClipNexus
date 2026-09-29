// ==========================================================
// poi-providers/provider.js
// Responsibility: the PROVIDER-NEUTRAL POI EXTRACTION CONTRACT
// and the normalization boundary. Nothing outside
// js/analysis/poi-providers/ ever sees a provider-specific
// response.
//
// The core application depends on this contract, never on a
// specific extraction implementation (AI or otherwise).
//
// ---- What a provider module defines (via definePoiProvider) ----
//   id, name, description        strings
//   status                       "available" | "not_implemented"
//   getPois(extractionInput) → Promise<ProviderPoiResponse>
//       extractionInput: the curated, frozen view built by
//       buildPoiExtractionInput() — transcriptId plus the
//       in-scope segments with their canonical temporal views.
//       Providers never receive the TranscriptDocument itself
//       and cannot depend on its internal layout.
//
// ---- ProviderPoiResponse (what a provider returns) ----
//   { success: true, candidates: [ ... ] }
//   { success: false, error: { code: <POI_EXTRACTION_ERROR_CODES>,
//                              message?: string, detail?: {} } }
//
//   A candidate is a CLAIM, not a POI: the domain validates and
//   normalizes it. The candidate shape is:
//
//     { type: "highlight"|"question"|"speaker_change"|"other",
//       label: string,                       // human-readable
//       startSeconds: number|null,           // finite >= 0, or null
//       endSeconds: number|null,             // null, or >= startSeconds
//       segmentIds: string[],               // ≥1 id, must exist
//       providerRef?: string }               // provider's own label
//
//   Extra fields are dropped at the boundary — they never reach
//   the canonical POI.
//
// ---- ExtractionOutcome (what the rest of the app sees) ----
//   see normalizeProviderPois() below.
// ==========================================================

import { AppError } from "../../core/errors.js";
import { deepFreeze, TIMESTAMP_STATUS } from "../../transcript/model.js";
import { createPoi, createPoiId, POI_SCHEMA_VERSION } from "../pois.js";
import {
    createPoiExtractionFailure,
    isPoiExtractionErrorCode,
    POI_EXTRACTION_ERROR_CODES
} from "./errors.js";

export const POI_PROVIDER_STATUS = Object.freeze({
    AVAILABLE: "available",
    NOT_IMPLEMENTED: "not_implemented"
});

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

export function isValidPoiProvider(provider) {
    return Boolean(provider) &&
        nonEmptyString(provider.id) && /^[a-z0-9-]+$/.test(provider.id) &&
        nonEmptyString(provider.name) &&
        typeof provider.description === "string" &&
        Object.values(POI_PROVIDER_STATUS).includes(provider.status) &&
        typeof provider.getPois === "function";
}

/** Providers call this so every POI provider has the same frozen shape. */
export function definePoiProvider({ id, name, description = "", status, getPois }) {
    return Object.freeze({ id, name, description, status, getPois });
}

// UI-safe view of a provider: data only, no functions.
export function describePoiProvider(provider) {
    return deepFreeze({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        status: provider.status
    });
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------- Extraction input ----------
//
// The documented view handed to a provider's getPois(). Curated
// from the TranscriptDocument so a provider never needs the
// document's internal layout and can never observe anything
// outside the transcript under extraction. Temporal views keep
// the canonical { seconds, status } pair (Stage 6 semantics:
// a provider must not invent times from missing/malformed
// timestamps — and the domain rejects whatever it invents
// anyway). The input is frozen and built fresh on every
// extractPois() call.

function timestampView(timestamp) {
    return {
        seconds: timestamp && Number.isFinite(timestamp.seconds) ? timestamp.seconds : null,
        status: timestamp && typeof timestamp.status === "string"
            ? timestamp.status
            : TIMESTAMP_STATUS.MISSING
    };
}

function segmentView(segment) {
    return {
        id: segment.id,
        text: typeof segment.text === "string" ? segment.text : "",
        start: timestampView(segment.start),
        end: timestampView(segment.end),
        speaker: {
            value: segment.speaker && typeof segment.speaker.value === "string"
                ? segment.speaker.value : null,
            source: segment.speaker && typeof segment.speaker.source === "string"
                ? segment.speaker.source : null
        }
    };
}

function assertDocumentShape(document) {
    if (!document || typeof document !== "object" ||
            typeof document.id !== "string" || document.id.length === 0 ||
            !Array.isArray(document.segments)) {
        throw new AppError("invalid_transcript_document",
            "POI extraction needs a TranscriptDocument.", {});
    }
    return document;
}

export function buildPoiExtractionInput(document) {
    assertDocumentShape(document);
    return deepFreeze({
        transcriptId: document.id,
        segments: document.segments.map(segmentView)
    });
}

function knownSegmentIds(document) {
    const ids = new Set();
    for (const segment of document.segments) {
        if (segment && typeof segment.id === "string") ids.add(segment.id);
    }
    return ids;
}

// ---------- Normalization boundary ----------
//
// Turn anything a provider returned into an ExtractionOutcome:
//
//   { success: true, pois: [ canonical, frozen POIs ] }
//   { success: false, error: { code, message, retryable,
//                              providerId, detail } }
//
// providerId/providerName come from the provider descriptor,
// never from the response, so a provider cannot misattribute
// its output. Canonical ids are assigned deterministically
// (poi-000000, …) in candidate order. Evidence is checked
// against the transcript: every candidate segment id must
// exist, and the candidate transcript must be the document
// under extraction. Provider-specific fields are dropped.

function normalizeCandidate(candidate, { index, provider, transcriptId, known, extractedAt }) {
    if (!isPlainObject(candidate)) {
        throw new AppError("malformed_provider_pois",
            "POI provider returned a candidate that is not an object.", { index });
    }
    const segmentIds = candidate.segmentIds;
    if (!Array.isArray(segmentIds) || segmentIds.length === 0) {
        throw new AppError("malformed_provider_pois",
            "POI candidate needs at least one segment id.", { index });
    }
    for (const segmentId of segmentIds) {
        if (!known.has(segmentId)) {
            throw new AppError("unknown_segment_id",
                "POI candidate references a segment that does not exist.", { index, segmentId });
        }
    }
    // Only the documented candidate fields cross the boundary.
    // Everything else (scores, vendor blobs, raw model output)
    // is dropped here.
    return createPoi({
        id: createPoiId(index),
        transcriptId,
        type: candidate.type,
        label: candidate.label,
        startSeconds: candidate.startSeconds === undefined ? null : candidate.startSeconds,
        endSeconds: candidate.endSeconds === undefined ? null : candidate.endSeconds,
        sourceRef: { transcriptId, segmentIds },
        provenance: {
            providerId: provider.id,
            providerName: provider.name,
            extractedAt,
            candidateIndex: index,
            providerRef: typeof candidate.providerRef === "string" &&
                candidate.providerRef.length > 0 ? candidate.providerRef : null
        },
        schemaVersion: POI_SCHEMA_VERSION
    });
}

export function normalizeProviderPois(response, { provider, transcript }) {
    if (!isValidPoiProvider(provider)) {
        throw new AppError("invalid_poi_provider",
            "POI extraction needs a valid provider.", { providerId: provider && provider.id });
    }
    const document = assertDocumentShape(transcript);
    const context = (detail) => ({ providerId: provider.id, detail });

    if (!isPlainObject(response) || typeof response.success !== "boolean") {
        return createPoiExtractionFailure(POI_EXTRACTION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "response is not a ProviderPoiResponse" }));
    }

    if (response.success === false) {
        const error = isPlainObject(response.error) ? response.error : {};
        const code = isPoiExtractionErrorCode(error.code) ? error.code : POI_EXTRACTION_ERROR_CODES.UNKNOWN_ERROR;
        const detail = { ...(isPlainObject(error.detail) ? error.detail : {}) };
        if (!isPoiExtractionErrorCode(error.code)) detail.originalCode = String(error.code);
        return createPoiExtractionFailure(code, context(detail));
    }

    const candidates = response.candidates;
    if (!Array.isArray(candidates)) {
        return createPoiExtractionFailure(POI_EXTRACTION_ERROR_CODES.MALFORMED_RESPONSE,
            context({ reason: "missing candidates array" }));
    }

    const known = knownSegmentIds(document);
    const extractedAt = new Date().toISOString();
    const pois = candidates.map((candidate, index) =>
        normalizeCandidate(candidate, {
            index, provider, transcriptId: document.id, known, extractedAt
        }));
    return deepFreeze({ success: true, pois });
}

/**
 * Run one POI extraction: build the provider input, call the
 * provider, normalize the result. A provider that throws is
 * reported as PROVIDER_ERROR — failures never propagate as raw
 * exceptions and never produce partial POI lists.
 *
 * @param {object} provider   definePoiProvider() result
 * @param {object} transcript TranscriptDocument (read-only)
 * @returns {Promise<{success:true, pois:Array}|{success:false, error:Object}>}
 */
export async function extractPois(provider, transcript) {
    if (!isValidPoiProvider(provider)) {
        throw new AppError("invalid_poi_provider",
            "POI extraction needs a valid provider.", { providerId: provider && provider.id });
    }
    const document = assertDocumentShape(transcript);
    const input = buildPoiExtractionInput(document);
    let response;
    try {
        response = await provider.getPois(input);
    } catch (error) {
        return createPoiExtractionFailure(POI_EXTRACTION_ERROR_CODES.PROVIDER_ERROR, {
            providerId: provider.id,
            detail: { causeMessage: error instanceof Error ? error.message : String(error) }
        });
    }
    return normalizeProviderPois(response, { provider, transcript: document });
}

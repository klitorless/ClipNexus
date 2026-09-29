// ==========================================================
// devtools-stage7-tests.js
// Stage 7: provider-neutral POI extraction + evidence
// contract. Canonical POI domain, deterministic extraction
// input, provider contract, normalization boundary, mock
// provider, and project integration — no AI, no network.
// ==========================================================

import { AppError } from "./errors.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";
import { createPoi, assertPoi, createPoiId, POI_TYPE, POI_SCHEMA_VERSION } from "../analysis/pois.js";
import {
    definePoiProvider,
    isValidPoiProvider,
    describePoiProvider,
    buildPoiExtractionInput,
    normalizeProviderPois,
    extractPois,
    POI_PROVIDER_STATUS
} from "../analysis/poi-providers/provider.js";
import {
    POI_EXTRACTION_ERROR_CODES,
    isPoiExtractionErrorCode
} from "../analysis/poi-providers/errors.js";
import { createMockPoiProvider } from "../analysis/poi-providers/mock.js";
import { createProject, withPois } from "./project.js";

export function addStage7Tests(add) {

    function docFromRecords(records, filename = "vod.json") {
        const rawText = JSON.stringify(records);
        return buildTranscriptDocument({
            rawText, format: "json", filename,
            size: rawText.length, acquisition: createFileAcquisition()
        });
    }

    function sampleDoc() {
        return docFromRecords([
            { start: 10, end: 20, text: "welcome back?" },
            { start: 30, end: 40, text: "watch this!" },
            { start: 50, end: 60, text: "moving on" }
        ]);
    }

    function validPoiInput(overrides = {}) {
        return {
            transcriptId: "tx-1",
            type: POI_TYPE.HIGHLIGHT,
            label: "A highlight",
            startSeconds: 10,
            endSeconds: 20,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000000"] },
            provenance: { providerId: "mock-poi-provider" },
            ...overrides
        };
    }

    function throwsAppError(action, code) {
        try { action(); return false; }
        catch (error) {
            return error instanceof AppError && (code === undefined || error.code === code);
        }
    }

    // extractedAt stamps the extraction run, so determinism
    // comparisons ignore it; everything else must be identical.
    function withoutRunStamp(pois) {
        return pois.map((poi) => ({
            ...poi,
            provenance: { ...poi.provenance, extractedAt: "run-stamp" }
        }));
    }

    // ---------- Domain ----------

    add("stage7: valid POI is created frozen with the canonical shape", () => {
        const poi = createPoi(validPoiInput());
        return Object.isFrozen(poi) && Object.isFrozen(poi.sourceRef) &&
            Object.isFrozen(poi.provenance) && poi.schemaVersion === POI_SCHEMA_VERSION &&
            poi.type === "highlight" && poi.startSeconds === 10 && poi.endSeconds === 20 &&
            poi.sourceRef.segmentIds[0] === "seg-000000" &&
            poi.provenance.providerId === "mock-poi-provider" &&
            typeof poi.id === "string" && poi.id.startsWith("poi-");
    });

    add("stage7: POI ids are deterministic", () =>
        createPoiId(0) === "poi-000000" && createPoiId(3) === "poi-000003" &&
        createPoiId(123) === "poi-000123");

    add("stage7: missing id gets a generated poi- id", () => {
        const poi = createPoi(validPoiInput());
        return poi.id.startsWith("poi-") && poi.id.length > 4;
    });

    add("stage7: empty id is rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({ id: "" })), "invalid_poi"));

    add("stage7: unknown type is rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({ type: "plot_twist" })), "invalid_poi"));

    add("stage7: empty label is rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({ label: "  ".trim() })), "invalid_poi"));

    add("stage7: negative startSeconds is rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({ startSeconds: -1 })), "invalid_poi_time"));

    add("stage7: non-finite temporal values are rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({ startSeconds: NaN })), "invalid_poi_time") &&
        throwsAppError(() => createPoi(validPoiInput({ startSeconds: Infinity })), "invalid_poi_time") &&
        throwsAppError(() => createPoi(validPoiInput({ startSeconds: "10" })), "invalid_poi_time"));

    add("stage7: reversed range is rejected, never repaired", () =>
        throwsAppError(() => createPoi(validPoiInput({ startSeconds: 20, endSeconds: 10 })),
            "invalid_poi_time"));

    add("stage7: zero-length range is valid", () => {
        const poi = createPoi(validPoiInput({ startSeconds: 10, endSeconds: 10 }));
        return poi.startSeconds === 10 && poi.endSeconds === 10;
    });

    add("stage7: end without start is rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({ startSeconds: null, endSeconds: 20 })),
            "invalid_poi_time"));

    add("stage7: null temporal anchors are valid (evidence-located POI)", () => {
        const poi = createPoi(validPoiInput({ startSeconds: null, endSeconds: null }));
        return poi.startSeconds === null && poi.endSeconds === null;
    });

    add("stage7: empty segmentIds are rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({
            sourceRef: { transcriptId: "tx-1", segmentIds: [] }
        })), "invalid_poi"));

    add("stage7: sourceRef transcriptId mismatch is rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({
            sourceRef: { transcriptId: "tx-other", segmentIds: ["seg-000000"] }
        })), "invalid_poi"));

    add("stage7: missing provenance providerId is rejected", () =>
        throwsAppError(() => createPoi(validPoiInput({ provenance: {} })), "invalid_poi_provenance"));

    add("stage7: POI does not alias caller arrays", () => {
        const segmentIds = ["seg-000000"];
        const poi = createPoi(validPoiInput({
            sourceRef: { transcriptId: "tx-1", segmentIds }
        }));
        segmentIds.push("seg-000001");
        return poi.sourceRef.segmentIds.length === 1 &&
            Object.isFrozen(poi.sourceRef.segmentIds);
    });

    add("stage7: mutating a POI throws (strict mode)", () => {
        const poi = createPoi(validPoiInput());
        try { poi.label = "changed"; return false; }
        catch (error) { return error instanceof TypeError; }
    });

    add("stage7: assertPoi validates and returns the input unchanged", () => {
        const input = validPoiInput({ id: "poi-000009" });
        const result = assertPoi(input);
        return result === input &&
            throwsAppError(() => assertPoi(validPoiInput({ type: "nope" })), "invalid_poi");
    });

    // ---------- Provider contract ----------

    add("stage7: mock provider satisfies the provider contract", () => {
        const provider = createMockPoiProvider({});
        return isValidPoiProvider(provider) && Object.isFrozen(provider) &&
            provider.status === POI_PROVIDER_STATUS.AVAILABLE &&
            typeof provider.getPois === "function";
    });

    add("stage7: invalid provider descriptors are rejected", () =>
        isValidPoiProvider(null) === false &&
        isValidPoiProvider({ id: "x", name: "X", description: "", status: "available" }) === false &&
        isValidPoiProvider(definePoiProvider({
            id: "Bad ID", name: "Bad", status: POI_PROVIDER_STATUS.AVAILABLE,
            getPois: async () => ({ success: true, candidates: [] })
        })) === false);

    add("stage7: describePoiProvider exposes data only, no functions", () => {
        const view = describePoiProvider(createMockPoiProvider({}));
        return Object.isFrozen(view) && view.id === "mock-poi-provider" &&
            typeof view.getPois === "undefined";
    });

    add("stage7: mock provider finds questions and highlights deterministically", async () => {
        const provider = createMockPoiProvider({});
        const document = sampleDoc();
        const first = await extractPois(provider, document);
        const second = await extractPois(provider, document);
        return first.success === true && second.success === true &&
            first.pois.length === 2 && second.pois.length === 2 &&
            first.pois[0].type === "question" && first.pois[1].type === "highlight" &&
            JSON.stringify(withoutRunStamp(first.pois)) ===
                JSON.stringify(withoutRunStamp(second.pois));
    });

    add("stage7: extractPois normalizes candidates into canonical POIs", async () => {
        const outcome = await extractPois(createMockPoiProvider({}), sampleDoc());
        if (outcome.success !== true || outcome.pois.length !== 2) return false;
        const [question, highlight] = outcome.pois;
        return question.id === "poi-000000" && highlight.id === "poi-000001" &&
            Object.isFrozen(question) &&
            question.transcriptId === outcome.pois[0].sourceRef.transcriptId &&
            question.startSeconds === 10 && question.endSeconds === 20 &&
            highlight.startSeconds === 30 && highlight.endSeconds === 40 &&
            JSON.stringify(question.sourceRef.segmentIds) === JSON.stringify(["seg-000000"]);
    });

    add("stage7: provenance is stamped from the provider descriptor", async () => {
        const outcome = await extractPois(
            createMockPoiProvider({ id: "mock-x", name: "Mock X" }), sampleDoc());
        const poi = outcome.pois[0];
        return poi.provenance.providerId === "mock-x" &&
            poi.provenance.providerName === "Mock X" &&
            poi.provenance.candidateIndex === 0 &&
            poi.provenance.providerRef === "question-seg-000000" &&
            !Number.isNaN(Date.parse(poi.provenance.extractedAt));
    });

    add("stage7: provider failure is a failure outcome, not an exception", async () => {
        const outcome = await extractPois(
            createMockPoiProvider({ behavior: "fail", errorCode: "NOT_IMPLEMENTED" }), sampleDoc());
        return outcome.success === false &&
            outcome.error.code === POI_EXTRACTION_ERROR_CODES.NOT_IMPLEMENTED &&
            outcome.error.providerId === "mock-poi-provider" &&
            isPoiExtractionErrorCode(outcome.error.code);
    });

    add("stage7: throwing provider becomes PROVIDER_ERROR", async () => {
        const outcome = await extractPois(
            createMockPoiProvider({ behavior: "throw" }), sampleDoc());
        return outcome.success === false &&
            outcome.error.code === POI_EXTRACTION_ERROR_CODES.PROVIDER_ERROR &&
            typeof outcome.error.message === "string";
    });

    add("stage7: malformed provider response becomes MALFORMED_RESPONSE", async () => {
        const bad = await extractPois(
            createMockPoiProvider({ behavior: "raw", response: { success: true } }), sampleDoc());
        const notObject = await extractPois(
            createMockPoiProvider({ behavior: "raw", response: null }), sampleDoc());
        return bad.success === false &&
            bad.error.code === POI_EXTRACTION_ERROR_CODES.MALFORMED_RESPONSE &&
            notObject.success === false &&
            notObject.error.code === POI_EXTRACTION_ERROR_CODES.MALFORMED_RESPONSE;
    });

    add("stage7: unknown error code becomes UNKNOWN_ERROR with originalCode", async () => {
        const outcome = await extractPois(
            createMockPoiProvider({ behavior: "fail", errorCode: "VENDOR_418" }), sampleDoc());
        return outcome.success === false &&
            outcome.error.code === POI_EXTRACTION_ERROR_CODES.UNKNOWN_ERROR &&
            outcome.error.detail.originalCode === "VENDOR_418";
    });

    add("stage7: extraction input is a frozen curated view", () => {
        const doc = sampleDoc();
        const input = buildPoiExtractionInput(doc);
        const segment = input.segments[0];
        return Object.isFrozen(input) && Object.isFrozen(input.segments) &&
            Object.isFrozen(segment) &&
            input.transcriptId === doc.id &&
            segment.id === "seg-000000" && segment.text === "welcome back?" &&
            segment.start.seconds === 10 && segment.end.seconds === 20 &&
            !("rawText" in input) && !("offsets" in segment) && !("cueId" in segment);
    });

    add("stage7: extractPois rejects an invalid provider loudly", async () => {
        try {
            await extractPois({ id: "nope" }, sampleDoc());
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "invalid_poi_provider";
        }
    });

    add("stage7: extractPois does not mutate the transcript document", async () => {
        const doc = sampleDoc();
        const before = JSON.stringify(doc);
        await extractPois(createMockPoiProvider({}), doc);
        return JSON.stringify(doc) === before;
    });

    // ---------- Evidence ----------

    add("stage7: POI evidence references real transcript segments", async () => {
        const doc = sampleDoc();
        const outcome = await extractPois(createMockPoiProvider({}), doc);
        const known = new Set(doc.segments.map((segment) => segment.id));
        return outcome.success === true && outcome.pois.length > 0 &&
            outcome.pois.every((poi) =>
                poi.sourceRef.transcriptId === doc.id &&
                poi.sourceRef.segmentIds.length > 0 &&
                poi.sourceRef.segmentIds.every((id) => known.has(id)));
    });

    add("stage7: nonexistent segment reference is rejected", async () => {
        const doc = sampleDoc();
        const provider = createMockPoiProvider({});
        const evil = {
            ...provider,
            getPois: async () => ({
                success: true,
                candidates: [{
                    type: "highlight",
                    label: "ghost",
                    startSeconds: 1,
                    endSeconds: 2,
                    segmentIds: ["seg-999999"]
                }]
            })
        };
        try {
            await extractPois(evil, doc);
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "unknown_segment_id";
        }
    });

    add("stage7: evidence stays traceable after normalization", async () => {
        const doc = sampleDoc();
        const outcome = await extractPois(createMockPoiProvider({}), doc);
        const question = outcome.pois.find((poi) => poi.type === "question");
        const segment = doc.segments.find((entry) =>
            entry.id === question.sourceRef.segmentIds[0]);
        return segment.text === "welcome back?" &&
            question.startSeconds === segment.start.seconds &&
            question.endSeconds === segment.end.seconds;
    });

    // ---------- Normalization ----------

    add("stage7: valid provider output becomes a valid POI", () => {
        const doc = sampleDoc();
        const outcome = normalizeProviderPois({
            success: true,
            candidates: [{
                type: "speaker_change",
                label: "New speaker takes over",
                startSeconds: 50,
                endSeconds: null,
                segmentIds: ["seg-000002"],
                providerRef: "sc-1"
            }]
        }, { provider: createMockPoiProvider({}), transcript: doc });
        const [poi] = outcome.pois;
        return outcome.success === true && outcome.pois.length === 1 &&
            poi.id === "poi-000000" && poi.type === "speaker_change" &&
            poi.endSeconds === null && poi.provenance.providerRef === "sc-1";
    });

    add("stage7: malformed candidate is rejected", () => {
        const doc = sampleDoc();
        const provider = createMockPoiProvider({});
        return throwsAppError(() => normalizeProviderPois({
            success: true,
            candidates: [{ type: "highlight", startSeconds: 1, segmentIds: ["seg-000000"] }]
        }, { provider, transcript: doc }), "invalid_poi");
    });

    add("stage7: provider-specific fields do not leak into the canonical POI", () => {
        const doc = sampleDoc();
        const outcome = normalizeProviderPois({
            success: true,
            candidates: [{
                type: "highlight",
                label: "leak test",
                startSeconds: 10,
                endSeconds: 20,
                segmentIds: ["seg-000000"],
                confidenceScore: 0.99,
                vendorBlob: { model: "x-9000" },
                rawModelOutput: "…"
            }]
        }, { provider: createMockPoiProvider({}), transcript: doc });
        const [poi] = outcome.pois;
        const keys = new Set(Object.keys(poi));
        const expected = new Set(["schemaVersion", "id", "transcriptId", "type", "label",
            "startSeconds", "endSeconds", "sourceRef", "provenance"]);
        return outcome.success === true &&
            keys.size === expected.size && [...keys].every((key) => expected.has(key)) &&
            !("confidenceScore" in poi) && !("vendorBlob" in poi) && !("rawModelOutput" in poi);
    });

    add("stage7: same provider output twice yields identical POIs", () => {
        const doc = sampleDoc();
        const provider = createMockPoiProvider({});
        const response = {
            success: true,
            candidates: [{
                type: "highlight", label: "stable", startSeconds: 10, endSeconds: 20,
                segmentIds: ["seg-000000"]
            }]
        };
        const first = normalizeProviderPois(response, { provider, transcript: doc });
        const second = normalizeProviderPois(response, { provider, transcript: doc });
        return JSON.stringify(withoutRunStamp(first.pois)) ===
                JSON.stringify(withoutRunStamp(second.pois)) &&
            first.pois[0].id === "poi-000000";
    });

    // ---------- Integration ----------

    add("stage7: withPois attaches POIs to a project immutably", async () => {
        const doc = sampleDoc();
        const outcome = await extractPois(createMockPoiProvider({}), doc);
        const project = createProject();
        const next = withPois(project, outcome.pois);
        return next !== project && project.pois.length === 0 &&
            next.pois.length === 2 && Object.isFrozen(next) && Object.isFrozen(next.pois) &&
            next.pois[0].sourceRef.transcriptId === doc.id;
    });

    add("stage7: withPois rejects non-array and invalid POIs", () => {
        const project = createProject();
        const badArray = throwsAppError(() => withPois(project, "nope"), "invalid_pois");
        const badPoi = throwsAppError(() =>
            withPois(project, [validPoiInput({ type: "nope", id: "poi-000000" })]), "invalid_poi");
        return badArray && badPoi && project.pois.length === 0;
    });

    add("stage7: end-to-end transcript → POIs → project stays traceable", async () => {
        const doc = sampleDoc();
        const outcome = await extractPois(createMockPoiProvider({}), doc);
        if (outcome.success !== true) return false;
        const project = withPois(createProject(), outcome.pois);
        return project.pois.every((poi) => {
            const segment = doc.segments.find((entry) =>
                entry.id === poi.sourceRef.segmentIds[0]);
            return !!segment && poi.sourceRef.transcriptId === doc.id &&
                doc.rawText.includes(segment.text);
        });
    });
}

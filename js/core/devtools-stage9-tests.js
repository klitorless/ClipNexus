// ==========================================================
// devtools-stage9-tests.js
// Stage 9: canonical ClipSpec architecture. ClipSpec domain,
// deterministic ClipSpec ids, temporal + event/POI reference
// validation, the provider-neutral derivation contract,
// normalization boundary, deterministic mock deriver, and
// project integration — no AI, no ranking, no scoring, no
// network, no heuristics.
// ==========================================================

import { AppError } from "./errors.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";
import {
    createClipSpec, assertClipSpec, createClipSpecId,
    CLIP_SPEC_SCHEMA_VERSION
} from "../analysis/clip-spec.js";
import {
    defineClipSpecDeriver,
    isValidClipSpecDeriver,
    describeClipSpecDeriver,
    buildDerivationInput,
    normalizeDeriverClipSpecs,
    deriveClipSpecs,
    DERIVER_STATUS
} from "../analysis/clip-spec-derivers/deriver.js";
import {
    CLIP_SPEC_DERIVATION_ERROR_CODES,
    isClipSpecDerivationErrorCode
} from "../analysis/clip-spec-derivers/errors.js";
import { createMockClipSpecDeriver } from "../analysis/clip-spec-derivers/mock.js";
import { createEvent } from "../analysis/events.js";
import { createMockEventReconciler } from "../analysis/event-reconcilers/mock.js";
import { reconcilePois } from "../analysis/event-reconcilers/reconciler.js";
import { createPoi } from "../analysis/pois.js";
import { extractPois } from "../analysis/poi-providers/provider.js";
import { createMockPoiProvider } from "../analysis/poi-providers/mock.js";
import { createProject, withClipSpecs } from "./project.js";

export function addStage9Tests(add) {

    function docFromRecords(records, filename = "vod.json") {
        const rawText = JSON.stringify(records);
        return buildTranscriptDocument({
            rawText, format: "json", filename,
            size: rawText.length, acquisition: createFileAcquisition()
        });
    }

    // Canonical POI built directly, for precise control over
    // temporals and evidence without going through extraction.
    function poi(overrides = {}) {
        return createPoi({
            id: "poi-000000",
            transcriptId: "tx-1",
            type: "highlight",
            label: "A highlight",
            startSeconds: 10,
            endSeconds: 20,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000000"] },
            provenance: { providerId: "mock-poi-provider" },
            ...overrides
        });
    }

    // Canonical Event built directly, for precise control over
    // temporals and references without going through
    // reconciliation.
    function event(overrides = {}) {
        return createEvent({
            id: "event-000000",
            transcriptId: "tx-1",
            type: "single",
            label: "A moment",
            startSeconds: 10,
            endSeconds: 20,
            poiIds: ["poi-000000"],
            derivation: { reconcilerId: "mock-event-reconciler" },
            ...overrides
        });
    }

    function validClipSpecInput(overrides = {}) {
        return {
            transcriptId: "tx-1",
            eventId: "event-000000",
            startSeconds: 10,
            endSeconds: 20,
            poiIds: ["poi-000000"],
            derivation: { deriverId: "mock-clip-spec-deriver" },
            ...overrides
        };
    }

    function validDeriver() {
        return createMockClipSpecDeriver({});
    }

    function throwsCode(action, code) {
        try { action(); return false; }
        catch (error) { return error instanceof AppError && error.code === code; }
    }

    // ---------- 1. canonical ClipSpec creation ----------

    add("stage9: createClipSpec builds a canonical ClipSpec", () => {
        const spec = createClipSpec(validClipSpecInput());
        return spec.schemaVersion === CLIP_SPEC_SCHEMA_VERSION &&
            typeof spec.id === "string" && spec.id.length > 0 &&
            spec.transcriptId === "tx-1" &&
            spec.eventId === "event-000000" &&
            spec.startSeconds === 10 && spec.endSeconds === 20 &&
            Array.isArray(spec.poiIds) && spec.poiIds.length === 1 &&
            spec.poiIds[0] === "poi-000000" &&
            spec.derivation.deriverId === "mock-clip-spec-deriver";
    });

    // ---------- 2. deterministic ids ----------

    add("stage9: createClipSpecId is deterministic", () => {
        return createClipSpecId(0) === "clip-000000" &&
            createClipSpecId(1) === "clip-000001" &&
            createClipSpecId(41) === "clip-000041";
    });

    add("stage9: normalization assigns deterministic ids in candidate order", async () => {
        const events = [
            event({ id: "event-000000" }),
            event({ id: "event-000001", startSeconds: 40, endSeconds: 50, poiIds: ["poi-000001"] })
        ];
        const first = await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events });
        const second = await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events });
        return first.success === true && second.success === true &&
            first.clipSpecs[0].id === "clip-000000" &&
            first.clipSpecs[1].id === "clip-000001" &&
            second.clipSpecs[0].id === first.clipSpecs[0].id &&
            second.clipSpecs[1].id === first.clipSpecs[1].id;
    });

    // ---------- 3. schemaVersion ----------

    add("stage9: schemaVersion is emitted as the domain constant", () => {
        const spec = createClipSpec(validClipSpecInput({ schemaVersion: 999 }));
        return spec.schemaVersion === CLIP_SPEC_SCHEMA_VERSION &&
            CLIP_SPEC_SCHEMA_VERSION === 1;
    });

    add("stage9: non-numeric schemaVersion is rejected", () => {
        return throwsCode(() => createClipSpec(validClipSpecInput({ schemaVersion: "1" })), "invalid_clip_spec");
    });

    // ---------- 4. deep immutability ----------

    add("stage9: ClipSpec is deeply frozen", () => {
        const input = validClipSpecInput();
        const spec = createClipSpec(input);
        let topLevel = false;
        let nested = false;
        let arrayPush = false;
        try { spec.label = "x"; } catch { topLevel = true; }
        try { spec.derivation.deriverId = "x"; } catch { nested = true; }
        try { spec.poiIds.push("poi-000001"); } catch { arrayPush = true; }
        return Object.isFrozen(spec) && Object.isFrozen(spec.derivation) &&
            Object.isFrozen(spec.poiIds) && topLevel && nested && arrayPush;
    });

    add("stage9: ClipSpec does not alias caller arrays", () => {
        const poiIds = ["poi-000000"];
        const spec = createClipSpec(validClipSpecInput({ poiIds }));
        poiIds.push("poi-000001");
        return spec.poiIds.length === 1 && spec.poiIds[0] === "poi-000000";
    });

    add("stage9: assertClipSpec validates without rebuilding", () => {
        const input = validClipSpecInput();
        return assertClipSpec(input) === input &&
            throwsCode(() => assertClipSpec(validClipSpecInput({ eventId: "" })), "invalid_clip_spec");
    });

    // ---------- 5. valid temporal boundaries ----------

    add("stage9: valid temporal boundaries are accepted", () => {
        const normal = createClipSpec(validClipSpecInput({ startSeconds: 0, endSeconds: 90 }));
        const zeroLength = createClipSpec(validClipSpecInput({ startSeconds: 42, endSeconds: 42 }));
        return normal.startSeconds === 0 && normal.endSeconds === 90 &&
            zeroLength.startSeconds === 42 && zeroLength.endSeconds === 42;
    });

    // ---------- 6. invalid temporal boundaries ----------

    add("stage9: reversed ranges are rejected, never repaired", () => {
        return throwsCode(() => createClipSpec(validClipSpecInput({ startSeconds: 30, endSeconds: 10 })),
            "invalid_clip_spec_time");
    });

    add("stage9: end without start is rejected", () => {
        return throwsCode(() => createClipSpec(validClipSpecInput({ startSeconds: null, endSeconds: 10 })),
            "invalid_clip_spec_time");
    });

    add("stage9: non-finite or negative temporals are rejected", () => {
        return throwsCode(() => createClipSpec(validClipSpecInput({ startSeconds: -1 })), "invalid_clip_spec_time") &&
            throwsCode(() => createClipSpec(validClipSpecInput({ startSeconds: NaN })), "invalid_clip_spec_time") &&
            throwsCode(() => createClipSpec(validClipSpecInput({ endSeconds: Infinity })), "invalid_clip_spec_time") &&
            throwsCode(() => createClipSpec(validClipSpecInput({ startSeconds: "10" })), "invalid_clip_spec_time");
    });

    // ---------- 7. null/unknown temporal values ----------

    add("stage9: null temporals are preserved as unknown, never zero", () => {
        const spec = createClipSpec(validClipSpecInput({ startSeconds: null, endSeconds: null }));
        return spec.startSeconds === null && spec.endSeconds === null;
    });

    add("stage9: missing temporals default to null, not zero", () => {
        const input = validClipSpecInput();
        delete input.startSeconds;
        delete input.endSeconds;
        const spec = createClipSpec(input);
        return spec.startSeconds === null && spec.endSeconds === null;
    });

    // ---------- 8. event reference validation ----------

    add("stage9: missing eventId is rejected", () => {
        return throwsCode(() => createClipSpec(validClipSpecInput({ eventId: "" })), "invalid_clip_spec") &&
            throwsCode(() => createClipSpec(validClipSpecInput({ eventId: undefined })), "invalid_clip_spec");
    });

    add("stage9: normalization rejects candidates referencing unknown Events", async () => {
        const deriver = createMockClipSpecDeriver({
            behavior: "raw",
            response: {
                success: true,
                clipSpecs: [{ eventId: "event-999999", startSeconds: 10, endSeconds: 20, poiIds: ["poi-000000"] }]
            }
        });
        let threw = false;
        try {
            await deriveClipSpecs(deriver, { transcriptId: "tx-1", events: [event()] });
        } catch (error) {
            threw = error instanceof AppError && error.code === "unknown_event_id";
        }
        return threw;
    });

    add("stage9: Events from the wrong transcript context are rejected", async () => {
        const foreign = event({ id: "event-000000", transcriptId: "tx-other" });
        let threw = false;
        try {
            await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events: [foreign] });
        } catch (error) {
            threw = error instanceof AppError && error.code === "wrong_transcript_context";
        }
        return threw;
    });

    add("stage9: duplicate Event ids are rejected", async () => {
        let threw = false;
        try {
            await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events: [event(), event()] });
        } catch (error) {
            threw = error instanceof AppError && error.code === "duplicate_event_id";
        }
        return threw;
    });

    // ---------- 9. POI reference preservation ----------

    add("stage9: POI ids are preserved from the Event, never invented", async () => {
        const outcome = await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events: [event()] });
        return outcome.success === true &&
            outcome.clipSpecs.length === 1 &&
            outcome.clipSpecs[0].poiIds.length === 1 &&
            outcome.clipSpecs[0].poiIds[0] === "poi-000000";
    });

    add("stage9: candidates referencing POIs outside their Event are rejected", async () => {
        const deriver = createMockClipSpecDeriver({
            behavior: "raw",
            response: {
                success: true,
                clipSpecs: [{ eventId: "event-000000", startSeconds: 10, endSeconds: 20, poiIds: ["poi-999999"] }]
            }
        });
        let threw = false;
        try {
            await deriveClipSpecs(deriver, { transcriptId: "tx-1", events: [event()] });
        } catch (error) {
            threw = error instanceof AppError && error.code === "invalid_poi_reference";
        }
        return threw;
    });

    add("stage9: duplicate POI references are rejected", () => {
        return throwsCode(() => createClipSpec(validClipSpecInput({ poiIds: ["poi-000000", "poi-000000"] })),
            "invalid_clip_spec");
    });

    add("stage9: empty or malformed POI references are rejected", () => {
        return throwsCode(() => createClipSpec(validClipSpecInput({ poiIds: [] })), "invalid_clip_spec") &&
            throwsCode(() => createClipSpec(validClipSpecInput({ poiIds: [""] })), "invalid_clip_spec") &&
            throwsCode(() => createClipSpec(validClipSpecInput({ poiIds: "poi-000000" })), "invalid_clip_spec");
    });

    // ---------- 10. provenance/derivation metadata ----------

    add("stage9: derivation metadata has the documented shape", async () => {
        const outcome = await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events: [event()] });
        const derivation = outcome.clipSpecs[0].derivation;
        return derivation.deriverId === "mock-clip-spec-deriver" &&
            derivation.deriverName === "Mock ClipSpec deriver" &&
            typeof derivation.derivedAt === "string" && !Number.isNaN(Date.parse(derivation.derivedAt)) &&
            derivation.candidateIndex === 0 &&
            derivation.deriverRef === "mock-clip-0";
    });

    add("stage9: derivation identity comes from the descriptor, never the response", async () => {
        const deriver = createMockClipSpecDeriver({
            id: "real-deriver",
            name: "Real Deriver",
            behavior: "raw",
            response: {
                success: true,
                clipSpecs: [{
                    eventId: "event-000000", startSeconds: 10, endSeconds: 20, poiIds: ["poi-000000"],
                    deriverId: "impostor", deriverName: "Impostor"
                }]
            }
        });
        const outcome = await deriveClipSpecs(deriver, { transcriptId: "tx-1", events: [event()] });
        return outcome.success === true &&
            outcome.clipSpecs[0].derivation.deriverId === "real-deriver" &&
            outcome.clipSpecs[0].derivation.deriverName === "Real Deriver";
    });

    add("stage9: derivation requires a deriverId", () => {
        return throwsCode(() => createClipSpec(validClipSpecInput({ derivation: {} })),
            "invalid_clip_spec_derivation");
    });

    // ---------- 11. rejection of duplicated embedded objects ----------

    add("stage9: embedded Event/POI objects are dropped at the boundary", async () => {
        const embeddedEvent = event();
        const embeddedPoi = poi();
        const deriver = createMockClipSpecDeriver({
            behavior: "raw",
            response: {
                success: true,
                clipSpecs: [{
                    eventId: "event-000000", startSeconds: 10, endSeconds: 20, poiIds: ["poi-000000"],
                    event: embeddedEvent, pois: [embeddedPoi], score: 0.99, modelOutput: { ranking: 1 }
                }]
            }
        });
        const outcome = await deriveClipSpecs(deriver, { transcriptId: "tx-1", events: [event()] });
        const spec = outcome.clipSpecs[0];
        return outcome.success === true &&
            !("event" in spec) && !("pois" in spec) &&
            !("score" in spec) && !("modelOutput" in spec) &&
            spec.eventId === "event-000000" && spec.poiIds[0] === "poi-000000";
    });

    // ---------- 12. deterministic normalization ----------

    add("stage9: identical derivations produce identical ClipSpecs", async () => {
        const events = [event({ id: "event-000000" }), event({ id: "event-000001", startSeconds: 50, endSeconds: 60, poiIds: ["poi-000001"] })];
        const first = await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events });
        const second = await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events });
        // derivedAt stamps the normalization run, so it is
        // blanked before comparing: everything else must be
        // byte-identical across runs.
        const canonical = (outcome) => JSON.stringify(outcome.clipSpecs.map((spec) => ({
            ...spec, derivation: { ...spec.derivation, derivedAt: "T" }
        })));
        return first.success === true && second.success === true &&
            canonical(first) === canonical(second);
    });

    // ---------- 13. failure normalization ----------

    add("stage9: deriver failure becomes a normalized failure record", async () => {
        const outcome = await deriveClipSpecs(createMockClipSpecDeriver({ behavior: "fail" }),
            { transcriptId: "tx-1", events: [event()] });
        return outcome.success === false &&
            outcome.error.code === "PROVIDER_ERROR" &&
            outcome.error.deriverId === "mock-clip-spec-deriver" &&
            typeof outcome.error.retryable === "boolean";
    });

    add("stage9: throwing deriver becomes PROVIDER_ERROR, never a raw exception", async () => {
        const outcome = await deriveClipSpecs(createMockClipSpecDeriver({ behavior: "throw" }),
            { transcriptId: "tx-1", events: [event()] });
        return outcome.success === false && outcome.error.code === "PROVIDER_ERROR";
    });

    add("stage9: malformed deriver responses become MALFORMED_RESPONSE", async () => {
        const forShapes = [
            createMockClipSpecDeriver({ behavior: "raw", response: null }),
            createMockClipSpecDeriver({ behavior: "raw", response: { success: true } }),
            createMockClipSpecDeriver({ behavior: "raw", response: { success: "yes", clipSpecs: [] } })
        ];
        for (const deriver of forShapes) {
            const outcome = await deriveClipSpecs(deriver, { transcriptId: "tx-1", events: [event()] });
            if (outcome.success !== false || outcome.error.code !== "MALFORMED_RESPONSE") return false;
        }
        return true;
    });

    add("stage9: failed derivation produces no partial canonical ClipSpecs", async () => {
        const deriver = createMockClipSpecDeriver({
            behavior: "raw",
            response: {
                success: true,
                clipSpecs: [
                    { eventId: "event-000000", startSeconds: 10, endSeconds: 20, poiIds: ["poi-000000"] },
                    { eventId: "event-000000", startSeconds: 30, endSeconds: 10, poiIds: ["poi-000000"] } // reversed
                ]
            }
        });
        let threw = false;
        try {
            await deriveClipSpecs(deriver, { transcriptId: "tx-1", events: [event()] });
        } catch (error) {
            threw = error instanceof AppError;
        }
        return threw;
    });

    add("stage9: unknown failure codes become UNKNOWN_ERROR with the original kept", async () => {
        const outcome = await deriveClipSpecs(
            createMockClipSpecDeriver({ behavior: "fail", errorCode: "BOGUS_CODE" }),
            { transcriptId: "tx-1", events: [event()] });
        return outcome.success === false &&
            outcome.error.code === "UNKNOWN_ERROR" &&
            outcome.error.detail.originalCode === "BOGUS_CODE";
    });

    add("stage9: deriver contract helpers validate shape", () => {
        const deriver = validDeriver();
        const bad = { id: "x" };
        return isValidClipSpecDeriver(deriver) === true &&
            isValidClipSpecDeriver(bad) === false &&
            isValidClipSpecDeriver(null) === false &&
            describeClipSpecDeriver(deriver).id === deriver.id &&
            typeof describeClipSpecDeriver(deriver).derive === "undefined" &&
            DERIVER_STATUS.AVAILABLE === "available" &&
            isClipSpecDerivationErrorCode("PROVIDER_ERROR") === true &&
            isClipSpecDerivationErrorCode("NOPE") === false;
    });

    add("stage9: invalid deriver is rejected before any derivation", async () => {
        let threw = false;
        try {
            await deriveClipSpecs({ id: "x" }, { transcriptId: "tx-1", events: [event()] });
        } catch (error) {
            threw = error instanceof AppError && error.code === "invalid_clip_spec_deriver";
        }
        return threw;
    });

    add("stage9: buildDerivationInput hands derivers a frozen curated view", () => {
        const input = buildDerivationInput({ transcriptId: "tx-1", events: [event()] });
        return Object.isFrozen(input) && Object.isFrozen(input.events) &&
            input.transcriptId === "tx-1" &&
            input.events[0].id === "event-000000" &&
            input.events[0].poiIds[0] === "poi-000000" &&
            !("derivation" in input.events[0]); // reconciler internals stay behind
    });

    // ---------- 14. immutable Project integration ----------

    add("stage9: withClipSpecs attaches ClipSpecs immutably", () => {
        const project = createProject();
        const spec = createClipSpec(validClipSpecInput());
        const updated = withClipSpecs(project, [spec]);
        return updated !== project &&
            Object.isFrozen(updated) &&
            updated.clipSpecs.length === 1 &&
            updated.clipSpecs[0].id === spec.id &&
            project.clipSpecs.length === 0; // original untouched
    });

    add("stage9: withClipSpecs validates every entry", () => {
        const project = createProject();
        const bad = { ...validClipSpecInput(), eventId: "" };
        return throwsCode(() => withClipSpecs(project, [bad]), "invalid_clip_spec") &&
            throwsCode(() => withClipSpecs(project, "nope"), "invalid_clip_specs");
    });

    add("stage9: withClipSpecs chains with withPois/withEvents", () => {
        const withPoisProject = createProject();
        const spec = createClipSpec(validClipSpecInput());
        const updated = withClipSpecs(withPoisProject, [spec]);
        return Array.isArray(updated.pois) && Array.isArray(updated.events) &&
            updated.clipSpecs.length === 1;
    });

    // ---------- 15. traceability: ClipSpec → Event → POI → transcript ----------

    add("stage9: ClipSpec traces back to transcript segments end to end", async () => {
        const doc = docFromRecords([
            { start: 10, end: 15, text: "first?" },
            { start: 40, end: 45, text: "second!" }
        ]);
        const poiOutcome = await extractPois(createMockPoiProvider({}), doc);
        if (poiOutcome.success !== true) return false;
        const eventOutcome = await reconcilePois(createMockEventReconciler({}), {
            transcriptId: doc.id, pois: poiOutcome.pois
        });
        if (eventOutcome.success !== true || eventOutcome.events.length === 0) return false;
        const specOutcome = await deriveClipSpecs(createMockClipSpecDeriver({}), {
            transcriptId: doc.id, events: eventOutcome.events
        });
        if (specOutcome.success !== true || specOutcome.clipSpecs.length === 0) return false;

        const spec = specOutcome.clipSpecs[0];
        // ClipSpec → Event
        const evt = eventOutcome.events.find((candidate) => candidate.id === spec.eventId);
        if (!evt) return false;
        // Event → POI(s)
        const referencedPois = evt.poiIds.map((poiId) =>
            poiOutcome.pois.find((candidate) => candidate.id === poiId));
        if (referencedPois.some((candidate) => !candidate)) return false;
        // POI → sourceRef → segment ids → TranscriptDocument
        const segmentIds = referencedPois.flatMap((candidate) => candidate.sourceRef.segmentIds);
        const docSegments = new Set(doc.segments.map((segment) => segment.id));
        const allResolve = segmentIds.every((segmentId) => docSegments.has(segmentId));
        // ClipSpec preserves the Event's POI references exactly
        const preserved = JSON.stringify([...spec.poiIds].sort()) ===
            JSON.stringify([...evt.poiIds].sort());
        return allResolve && preserved && spec.transcriptId === doc.id;
    });

    // ---------- 16. malformed candidates ----------

    add("stage9: malformed candidates are rejected deterministically", async () => {
        const shapes = [
            "not-an-object",
            42,
            null,
            {},
            { eventId: "event-000000" },                       // missing poiIds
            { eventId: "", startSeconds: 10, endSeconds: 20, poiIds: ["poi-000000"] },
            { eventId: "event-000000", startSeconds: 10, endSeconds: 20 } // missing poiIds
        ];
        for (const shape of shapes) {
            const deriver = createMockClipSpecDeriver({
                behavior: "raw",
                response: { success: true, clipSpecs: [shape] }
            });
            let threw = false;
            try {
                await deriveClipSpecs(deriver, { transcriptId: "tx-1", events: [event()] });
            } catch (error) {
                threw = error instanceof AppError;
            }
            if (!threw) return false;
        }
        return true;
    });

    // ---------- 17. no provider-specific fields leak ----------

    add("stage9: canonical ClipSpec contains only documented fields", async () => {
        const outcome = await deriveClipSpecs(validDeriver(), { transcriptId: "tx-1", events: [event()] });
        const spec = outcome.clipSpecs[0];
        const topLevel = Object.keys(spec).sort();
        const expected = ["derivation", "endSeconds", "eventId", "id", "poiIds", "schemaVersion", "startSeconds", "transcriptId"].sort();
        const derivationKeys = Object.keys(spec.derivation).sort();
        const expectedDerivation = ["candidateIndex", "derivedAt", "deriverId", "deriverName", "deriverRef"].sort();
        return JSON.stringify(topLevel) === JSON.stringify(expected) &&
            JSON.stringify(derivationKeys) === JSON.stringify(expectedDerivation);
    });

    add("stage9: defineClipSpecDeriver freezes the deriver shape", () => {
        const deriver = defineClipSpecDeriver({
            id: "test-deriver", name: "Test", status: DERIVER_STATUS.AVAILABLE,
            derive: async () => ({ success: true, clipSpecs: [] })
        });
        return Object.isFrozen(deriver) && typeof deriver.derive === "function";
    });
}

// ==========================================================
// devtools-stage8-tests.js
// Stage 8: event reconciliation. Canonical Event domain,
// deterministic Event ids, POI-reference validation, the
// provider-neutral reconciliation contract, normalization
// boundary, deterministic mock reconciler, and project
// integration — no AI, no network, no heuristics.
// ==========================================================

import { AppError } from "./errors.js";
import { buildTranscriptDocument } from "../transcript/pipeline.js";
import { createFileAcquisition } from "../transcript/model.js";
import {
    createEvent, assertEvent, createEventId,
    EVENT_TYPE, EVENT_RULE, EVENT_SCHEMA_VERSION
} from "../analysis/events.js";
import {
    defineEventReconciler,
    isValidEventReconciler,
    describeEventReconciler,
    buildReconciliationInput,
    normalizeReconcilerEvents,
    reconcilePois,
    RECONCILER_STATUS
} from "../analysis/event-reconcilers/reconciler.js";
import {
    EVENT_RECONCILIATION_ERROR_CODES,
    isEventReconciliationErrorCode
} from "../analysis/event-reconcilers/errors.js";
import { createMockEventReconciler } from "../analysis/event-reconcilers/mock.js";
import { createPoi } from "../analysis/pois.js";
import { extractPois } from "../analysis/poi-providers/provider.js";
import { createMockPoiProvider } from "../analysis/poi-providers/mock.js";
import { createProject, withEvents } from "./project.js";

export function addStage8Tests(add) {

    function docFromRecords(records, filename = "vod.json") {
        const rawText = JSON.stringify(records);
        return buildTranscriptDocument({
            rawText, format: "json", filename,
            size: rawText.length, acquisition: createFileAcquisition()
        });
    }

    async function poisFromDoc(doc) {
        const outcome = await extractPois(createMockPoiProvider({}), doc);
        if (outcome.success !== true) throw new Error("unexpected POI extraction failure");
        return outcome.pois;
    }

    // Canonical POIs built directly, for precise control over
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

    function validEventInput(overrides = {}) {
        return {
            transcriptId: "tx-1",
            type: EVENT_TYPE.SINGLE,
            label: "A moment",
            startSeconds: 10,
            endSeconds: 20,
            poiIds: ["poi-000000"],
            derivation: { reconcilerId: "mock-event-reconciler" },
            ...overrides
        };
    }

    function throwsAppError(action, code) {
        try { action(); return false; }
        catch (error) {
            return error instanceof AppError && (code === undefined || error.code === code);
        }
    }

    // reconciledAt stamps the reconciliation run, so determinism
    // comparisons ignore it; everything else must be identical.
    function withoutRunStamp(events) {
        return events.map((event) => ({
            ...event,
            derivation: { ...event.derivation, reconciledAt: "run-stamp" }
        }));
    }

    // ---------- Domain ----------

    add("stage8: valid Event is created frozen with the canonical shape", () => {
        const event = createEvent(validEventInput());
        return Object.isFrozen(event) && Object.isFrozen(event.poiIds) &&
            Object.isFrozen(event.derivation) &&
            event.schemaVersion === EVENT_SCHEMA_VERSION &&
            event.type === "single" && event.startSeconds === 10 && event.endSeconds === 20 &&
            event.poiIds.length === 1 && event.poiIds[0] === "poi-000000" &&
            event.derivation.reconcilerId === "mock-event-reconciler" &&
            event.derivation.rule === "none" &&
            typeof event.id === "string" && event.id.startsWith("event-");
    });

    add("stage8: Event ids are deterministic", () =>
        createEventId(0) === "event-000000" && createEventId(3) === "event-000003" &&
        createEventId(123) === "event-000123");

    add("stage8: missing id gets a generated event- id", () => {
        const event = createEvent(validEventInput());
        return event.id.startsWith("event-") && event.id.length > 6;
    });

    add("stage8: empty id is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ id: "" })), "invalid_event"));

    add("stage8: unknown type is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ type: "plot_twist" })), "invalid_event"));

    add("stage8: valid categories are single and grouped", () => {
        const single = createEvent(validEventInput({ type: "single", poiIds: ["poi-000000"] }));
        const grouped = createEvent(validEventInput({
            type: "grouped", poiIds: ["poi-000000", "poi-000001"]
        }));
        return single.type === "single" && grouped.type === "grouped" &&
            Object.keys(EVENT_TYPE).length === 2;
    });

    add("stage8: empty label is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ label: "" })), "invalid_event"));

    add("stage8: negative startSeconds is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ startSeconds: -1 })), "invalid_event_time"));

    add("stage8: non-finite temporal values are rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ startSeconds: NaN })), "invalid_event_time") &&
        throwsAppError(() => createEvent(validEventInput({ startSeconds: Infinity })), "invalid_event_time") &&
        throwsAppError(() => createEvent(validEventInput({ startSeconds: "10" })), "invalid_event_time"));

    add("stage8: reversed range is rejected, never repaired", () =>
        throwsAppError(() => createEvent(validEventInput({ startSeconds: 20, endSeconds: 10 })),
            "invalid_event_time"));

    add("stage8: zero-length range is valid", () => {
        const event = createEvent(validEventInput({ startSeconds: 10, endSeconds: 10 }));
        return event.startSeconds === 10 && event.endSeconds === 10;
    });

    add("stage8: end without start is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ startSeconds: null, endSeconds: 20 })),
            "invalid_event_time"));

    add("stage8: null temporal anchors are valid (evidence-located Event)", () => {
        const event = createEvent(validEventInput({ startSeconds: null, endSeconds: null }));
        return event.startSeconds === null && event.endSeconds === null;
    });

    add("stage8: empty poiIds are rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ poiIds: [] })), "invalid_event"));

    add("stage8: non-string poiIds are rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ poiIds: [42] })), "invalid_event"));

    add("stage8: duplicate poiIds are rejected", () =>
        throwsAppError(() => createEvent(validEventInput({
            type: "grouped", poiIds: ["poi-000000", "poi-000000"]
        })), "invalid_event"));

    add("stage8: single event with two POIs is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({
            type: "single", poiIds: ["poi-000000", "poi-000001"]
        })), "invalid_event"));

    add("stage8: grouped event with one POI is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({
            type: "grouped", poiIds: ["poi-000000"]
        })), "invalid_event"));

    add("stage8: missing derivation reconcilerId is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({ derivation: {} })),
            "invalid_event_derivation"));

    add("stage8: unknown derivation rule is rejected", () =>
        throwsAppError(() => createEvent(validEventInput({
            derivation: { reconcilerId: "mock-event-reconciler", rule: "vibes" }
        })), "invalid_event_derivation"));

    add("stage8: Event does not alias caller arrays", () => {
        const poiIds = ["poi-000000"];
        const event = createEvent(validEventInput({ poiIds }));
        poiIds.push("poi-000001");
        return event.poiIds.length === 1 && Object.isFrozen(event.poiIds);
    });

    add("stage8: mutating an Event throws (strict mode)", () => {
        const event = createEvent(validEventInput());
        try { event.label = "changed"; return false; }
        catch (error) { return error instanceof TypeError; }
    });

    add("stage8: assertEvent validates and returns the input unchanged", () => {
        const input = validEventInput({ id: "event-000009" });
        const result = assertEvent(input);
        return result === input &&
            throwsAppError(() => assertEvent(validEventInput({ type: "nope" })), "invalid_event");
    });

    // ---------- Reconciler contract ----------

    add("stage8: mock reconciler satisfies the reconciler contract", () => {
        const reconciler = createMockEventReconciler({});
        return isValidEventReconciler(reconciler) && Object.isFrozen(reconciler) &&
            reconciler.status === RECONCILER_STATUS.AVAILABLE &&
            typeof reconciler.reconcile === "function";
    });

    add("stage8: invalid reconciler descriptors are rejected", () =>
        isValidEventReconciler(null) === false &&
        isValidEventReconciler({ id: "x", name: "X", description: "", status: "available" }) === false &&
        isValidEventReconciler(defineEventReconciler({
            id: "Bad ID", name: "Bad", status: RECONCILER_STATUS.AVAILABLE,
            reconcile: async () => ({ success: true, events: [] })
        })) === false);

    add("stage8: describeEventReconciler exposes data only, no functions", () => {
        const view = describeEventReconciler(createMockEventReconciler({}));
        return Object.isFrozen(view) && view.id === "mock-event-reconciler" &&
            typeof view.reconcile === "undefined";
    });

    add("stage8: reconciliation input is a frozen curated view", () => {
        const input = buildReconciliationInput({
            transcriptId: "tx-1",
            pois: [poi({ id: "poi-000000" })]
        });
        const view = input.pois[0];
        const viewKeys = new Set(Object.keys(view));
        const expected = new Set(["id", "type", "label", "startSeconds", "endSeconds", "segmentIds"]);
        return Object.isFrozen(input) && Object.isFrozen(input.pois) && Object.isFrozen(view) &&
            input.transcriptId === "tx-1" &&
            viewKeys.size === expected.size && [...viewKeys].every((key) => expected.has(key)) &&
            !("provenance" in view) && !("sourceRef" in view);
    });

    add("stage8: reconcilePois is deterministic", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 15, end: 25, text: "second!" },
            { start: 50, end: 60, text: "third?" }
        ]);
        const pois = await poisFromDoc(doc);
        const reconciler = createMockEventReconciler({});
        const first = await reconcilePois(reconciler, { transcriptId: doc.id, pois });
        const second = await reconcilePois(reconciler, { transcriptId: doc.id, pois });
        return first.success === true && second.success === true &&
            JSON.stringify(withoutRunStamp(first.events)) ===
                JSON.stringify(withoutRunStamp(second.events));
    });

    add("stage8: reconcilePois rejects an invalid reconciler loudly", async () => {
        try {
            await reconcilePois({ id: "nope" }, { transcriptId: "tx-1", pois: [] });
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "invalid_event_reconciler";
        }
    });

    add("stage8: reconcilePois does not mutate POIs or the transcript document", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 15, end: 25, text: "second!" }
        ]);
        const pois = await poisFromDoc(doc);
        const beforePois = JSON.stringify(pois);
        const beforeDoc = JSON.stringify(doc);
        await reconcilePois(createMockEventReconciler({}), { transcriptId: doc.id, pois });
        return JSON.stringify(pois) === beforePois && JSON.stringify(doc) === beforeDoc;
    });

    // ---------- Deterministic grouping ----------

    add("stage8: overlapping POIs group into one event", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 15, end: 25, text: "second!" }
        ]);
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: doc.id, pois: await poisFromDoc(doc) });
        if (outcome.success !== true || outcome.events.length !== 1) return false;
        const [event] = outcome.events;
        return event.id === "event-000000" && event.type === "grouped" &&
            event.poiIds.length === 2 &&
            event.startSeconds === 10 && event.endSeconds === 25 &&
            event.derivation.rule === EVENT_RULE.TEMPORAL_OVERLAP;
    });

    add("stage8: adjacent POIs group (exact touching only)", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 20, end: 30, text: "second?" }
        ]);
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: doc.id, pois: await poisFromDoc(doc) });
        if (outcome.success !== true || outcome.events.length !== 1) return false;
        const [event] = outcome.events;
        return event.type === "grouped" &&
            event.startSeconds === 10 && event.endSeconds === 30 &&
            event.derivation.rule === EVENT_RULE.TEMPORAL_ADJACENCY;
    });

    add("stage8: nearly-touching POIs do not group", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 21, end: 30, text: "second?" }
        ]);
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: doc.id, pois: await poisFromDoc(doc) });
        return outcome.success === true && outcome.events.length === 2 &&
            outcome.events.every((event) => event.type === "single");
    });

    add("stage8: POIs sharing evidence group", async () => {
        const first = poi({ id: "poi-000000", startSeconds: 10, endSeconds: 20,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000000"] } });
        const second = poi({ id: "poi-000001", startSeconds: 50, endSeconds: 60,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000000"] } });
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: "tx-1", pois: [first, second] });
        if (outcome.success !== true || outcome.events.length !== 1) return false;
        const [event] = outcome.events;
        return event.type === "grouped" &&
            event.startSeconds === 10 && event.endSeconds === 60 &&
            event.derivation.rule === EVENT_RULE.SHARED_EVIDENCE;
    });

    add("stage8: disjoint POIs stay separate single events", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 50, end: 60, text: "second?" }
        ]);
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: doc.id, pois: await poisFromDoc(doc) });
        if (outcome.success !== true || outcome.events.length !== 2) return false;
        const [first, second] = outcome.events;
        return first.type === "single" && second.type === "single" &&
            first.id === "event-000000" && second.id === "event-000001" &&
            first.poiIds[0] === "poi-000000" && second.poiIds[0] === "poi-000001" &&
            first.startSeconds === 10 && first.endSeconds === 20 &&
            second.startSeconds === 50 && second.endSeconds === 60;
    });

    add("stage8: grouped event temporals are earliest start / latest end", async () => {
        const first = poi({ id: "poi-000000", startSeconds: 30, endSeconds: 35,
            label: "later start", sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000000"] } });
        const second = poi({ id: "poi-000001", startSeconds: 10, endSeconds: 90,
            label: "earlier start", sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000001"] } });
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: "tx-1", pois: [first, second] });
        if (outcome.success !== true || outcome.events.length !== 1) return false;
        const [event] = outcome.events;
        return event.startSeconds === 10 && event.endSeconds === 90 &&
            event.derivation.rule === EVENT_RULE.TEMPORAL_OVERLAP;
    });

    add("stage8: single event inherits its POI temporals exactly", async () => {
        const doc = docFromRecords([{ start: 10, end: 20, text: "only?" }]);
        const pois = await poisFromDoc(doc);
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: doc.id, pois });
        if (outcome.success !== true || outcome.events.length !== 1) return false;
        const [event] = outcome.events;
        return event.type === "single" &&
            event.startSeconds === pois[0].startSeconds &&
            event.endSeconds === pois[0].endSeconds &&
            event.derivation.rule === EVENT_RULE.NONE;
    });

    add("stage8: null-temporal POIs group only by shared evidence", async () => {
        const sharedA = poi({ id: "poi-000000", startSeconds: null, endSeconds: null,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000000"] } });
        const sharedB = poi({ id: "poi-000001", startSeconds: null, endSeconds: null,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000000"] } });
        const grouped = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: "tx-1", pois: [sharedA, sharedB] });
        const loneA = poi({ id: "poi-000002", startSeconds: null, endSeconds: null,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000001"] } });
        const separate = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: "tx-1", pois: [sharedA, loneA] });
        return grouped.success === true && grouped.events.length === 1 &&
            grouped.events[0].type === "grouped" &&
            grouped.events[0].startSeconds === null && grouped.events[0].endSeconds === null &&
            grouped.events[0].derivation.rule === EVENT_RULE.SHARED_EVIDENCE &&
            separate.success === true && separate.events.length === 2 &&
            separate.events.every((event) => event.type === "single");
    });

    add("stage8: multiple distinct rules are recorded as multiple", async () => {
        // A[10,20] overlaps B[15,25]; B shares seg-000001 with C[50,60].
        const a = poi({ id: "poi-000000", startSeconds: 10, endSeconds: 20,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000000"] } });
        const b = poi({ id: "poi-000001", startSeconds: 15, endSeconds: 25,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000001"] } });
        const c = poi({ id: "poi-000002", startSeconds: 50, endSeconds: 60,
            sourceRef: { transcriptId: "tx-1", segmentIds: ["seg-000001"] } });
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: "tx-1", pois: [a, b, c] });
        if (outcome.success !== true || outcome.events.length !== 1) return false;
        const [event] = outcome.events;
        return event.type === "grouped" && event.poiIds.length === 3 &&
            event.startSeconds === 10 && event.endSeconds === 60 &&
            event.derivation.rule === EVENT_RULE.MULTIPLE;
    });

    // ---------- Normalization + failures ----------

    add("stage8: reconciler failure is a failure outcome, not an exception", async () => {
        const outcome = await reconcilePois(
            createMockEventReconciler({ behavior: "fail", errorCode: "NOT_IMPLEMENTED" }),
            { transcriptId: "tx-1", pois: [poi({ id: "poi-000000" })] });
        return outcome.success === false &&
            outcome.error.code === EVENT_RECONCILIATION_ERROR_CODES.NOT_IMPLEMENTED &&
            outcome.error.reconcilerId === "mock-event-reconciler" &&
            isEventReconciliationErrorCode(outcome.error.code) &&
            !("events" in outcome);
    });

    add("stage8: throwing reconciler becomes PROVIDER_ERROR", async () => {
        const outcome = await reconcilePois(
            createMockEventReconciler({ behavior: "throw" }),
            { transcriptId: "tx-1", pois: [poi({ id: "poi-000000" })] });
        return outcome.success === false &&
            outcome.error.code === EVENT_RECONCILIATION_ERROR_CODES.PROVIDER_ERROR &&
            typeof outcome.error.message === "string";
    });

    add("stage8: malformed reconciler response becomes MALFORMED_RESPONSE", async () => {
        const bad = await reconcilePois(
            createMockEventReconciler({ behavior: "raw", response: { success: true } }),
            { transcriptId: "tx-1", pois: [poi({ id: "poi-000000" })] });
        const notObject = await reconcilePois(
            createMockEventReconciler({ behavior: "raw", response: null }),
            { transcriptId: "tx-1", pois: [poi({ id: "poi-000000" })] });
        return bad.success === false &&
            bad.error.code === EVENT_RECONCILIATION_ERROR_CODES.MALFORMED_RESPONSE &&
            notObject.success === false &&
            notObject.error.code === EVENT_RECONCILIATION_ERROR_CODES.MALFORMED_RESPONSE;
    });

    add("stage8: unknown error code becomes UNKNOWN_ERROR with originalCode", async () => {
        const outcome = await reconcilePois(
            createMockEventReconciler({ behavior: "fail", errorCode: "VENDOR_418" }),
            { transcriptId: "tx-1", pois: [poi({ id: "poi-000000" })] });
        return outcome.success === false &&
            outcome.error.code === EVENT_RECONCILIATION_ERROR_CODES.UNKNOWN_ERROR &&
            outcome.error.detail.originalCode === "VENDOR_418";
    });

    add("stage8: empty reconciliation returns no events", async () => {
        const outcome = await reconcilePois(
            createMockEventReconciler({ behavior: "empty" }),
            { transcriptId: "tx-1", pois: [poi({ id: "poi-000000" })] });
        return outcome.success === true && Array.isArray(outcome.events) &&
            outcome.events.length === 0;
    });

    add("stage8: empty POI set reconciles to no events", async () => {
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: "tx-1", pois: [] });
        return outcome.success === true && outcome.events.length === 0;
    });

    // ---------- POI reference validation ----------

    add("stage8: missing POI reference is rejected", async () => {
        try {
            await reconcilePois(
                createMockEventReconciler({
                    behavior: "raw",
                    response: {
                        success: true,
                        events: [{
                            type: "single", label: "ghost", startSeconds: 1, endSeconds: 2,
                            poiIds: ["poi-999999"]
                        }]
                    }
                }),
                { transcriptId: "tx-1", pois: [poi({ id: "poi-000000" })] });
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "unknown_poi_id";
        }
    });

    add("stage8: POI from the wrong transcript context is rejected", async () => {
        const doc = docFromRecords([{ start: 10, end: 20, text: "first?" }]);
        const pois = await poisFromDoc(doc);
        try {
            await reconcilePois(createMockEventReconciler({}),
                { transcriptId: "tx-other", pois });
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === "wrong_transcript_context";
        }
    });

    add("stage8: malformed candidate is rejected", async () => {
        const pois = [poi({ id: "poi-000000" })];
        const missingLabel = throwsAppError(() => normalizeReconcilerEvents({
            success: true,
            events: [{ type: "single", startSeconds: 1, poiIds: ["poi-000000"] }]
        }, { reconciler: createMockEventReconciler({}), transcriptId: "tx-1", pois }),
            "invalid_event");
        const typeCountMismatch = throwsAppError(() => normalizeReconcilerEvents({
            success: true,
            events: [{
                type: "single", label: "x", startSeconds: 1, endSeconds: 2,
                poiIds: ["poi-000000", "poi-000001"]
            }]
        }, {
            reconciler: createMockEventReconciler({}), transcriptId: "tx-1",
            pois: [poi({ id: "poi-000000" }), poi({ id: "poi-000001" })]
        }), "invalid_event");
        return missingLabel && typeCountMismatch;
    });

    add("stage8: duplicate POI reference in one event is rejected", () =>
        throwsAppError(() => normalizeReconcilerEvents({
            success: true,
            events: [{
                type: "grouped", label: "dup", startSeconds: 1, endSeconds: 2,
                poiIds: ["poi-000000", "poi-000000"]
            }]
        }, {
            reconciler: createMockEventReconciler({}), transcriptId: "tx-1",
            pois: [poi({ id: "poi-000000" })]
        }), "invalid_poi_reference"));

    add("stage8: reconciler-specific fields do not leak into the canonical Event", () => {
        const outcome = normalizeReconcilerEvents({
            success: true,
            events: [{
                type: "single",
                label: "leak test",
                startSeconds: 10,
                endSeconds: 20,
                poiIds: ["poi-000000"],
                confidenceScore: 0.99,
                vendorBlob: { model: "x-9000" },
                heuristic: "vibes"
            }]
        }, {
            reconciler: createMockEventReconciler({}), transcriptId: "tx-1",
            pois: [poi({ id: "poi-000000" })]
        });
        const [event] = outcome.events;
        const keys = new Set(Object.keys(event));
        const expected = new Set(["schemaVersion", "id", "transcriptId", "type", "label",
            "startSeconds", "endSeconds", "poiIds", "derivation"]);
        return outcome.success === true &&
            keys.size === expected.size && [...keys].every((key) => expected.has(key)) &&
            !("confidenceScore" in event) && !("vendorBlob" in event) && !("heuristic" in event);
    });

    add("stage8: derivation is stamped from the reconciler descriptor", async () => {
        const doc = docFromRecords([{ start: 10, end: 20, text: "only?" }]);
        const outcome = await reconcilePois(
            createMockEventReconciler({ id: "mock-x", name: "Mock X" }),
            { transcriptId: doc.id, pois: await poisFromDoc(doc) });
        const event = outcome.events[0];
        return event.derivation.reconcilerId === "mock-x" &&
            event.derivation.reconcilerName === "Mock X" &&
            event.derivation.candidateIndex === 0 &&
            event.derivation.reconcilerRef === "mock-group-0" &&
            !Number.isNaN(Date.parse(event.derivation.reconciledAt));
    });

    // ---------- Evidence traceability ----------

    add("stage8: Event → POI → transcript traceability holds", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 15, end: 25, text: "second!" },
            { start: 50, end: 60, text: "third?" }
        ]);
        const pois = await poisFromDoc(doc);
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: doc.id, pois });
        if (outcome.success !== true) return false;
        const byPoiId = new Map(pois.map((entry) => [entry.id, entry]));
        const segmentIds = new Set(doc.segments.map((segment) => segment.id));
        return outcome.events.length > 0 && outcome.events.every((event) =>
            event.transcriptId === doc.id &&
            event.poiIds.length > 0 &&
            event.poiIds.every((poiId) => {
                const referenced = byPoiId.get(poiId);
                return !!referenced &&
                    referenced.transcriptId === doc.id &&
                    referenced.sourceRef.segmentIds.length > 0 &&
                    referenced.sourceRef.segmentIds.every((id) => segmentIds.has(id));
            }));
    });

    // ---------- Project integration ----------

    add("stage8: withEvents attaches Events to a project immutably", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 50, end: 60, text: "second?" }
        ]);
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: doc.id, pois: await poisFromDoc(doc) });
        const project = createProject();
        const next = withEvents(project, outcome.events);
        return next !== project && project.events.length === 0 &&
            next.events.length === 2 && Object.isFrozen(next) && Object.isFrozen(next.events) &&
            next.events[0].transcriptId === doc.id &&
            next.events[0].poiIds[0] === "poi-000000";
    });

    add("stage8: withEvents rejects non-array and invalid Events", () => {
        const project = createProject();
        const badArray = throwsAppError(() => withEvents(project, "nope"), "invalid_events");
        const badEvent = throwsAppError(() =>
            withEvents(project, [validEventInput({ type: "nope", id: "event-000000" })]),
            "invalid_event");
        return badArray && badEvent && project.events.length === 0;
    });

    add("stage8: end-to-end transcript → POIs → Events → project stays traceable", async () => {
        const doc = docFromRecords([
            { start: 10, end: 20, text: "first?" },
            { start: 15, end: 25, text: "second!" }
        ]);
        const pois = await poisFromDoc(doc);
        const outcome = await reconcilePois(createMockEventReconciler({}),
            { transcriptId: doc.id, pois });
        if (outcome.success !== true) return false;
        const project = withEvents(createProject(), outcome.events);
        const byPoiId = new Map(pois.map((entry) => [entry.id, entry]));
        return project.events.length === 1 && project.events[0].type === "grouped" &&
            project.events.every((event) => event.poiIds.every((poiId) => {
                const referenced = byPoiId.get(poiId);
                return !!referenced &&
                    referenced.sourceRef.segmentIds.every((id) =>
                        doc.segments.some((segment) => segment.id === id)) &&
                    doc.rawText.includes(
                        doc.segments.find((segment) =>
                            segment.id === referenced.sourceRef.segmentIds[0]).text);
            }));
    });
}

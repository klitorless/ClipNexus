// ==========================================================
// event-reconcilers/mock.js
// Responsibility: DETERMINISTIC mock event reconcilers for
// self-tests. Never registered anywhere by default. No
// network, no AI, no randomness, no heuristics — every mock is
// named "Mock …" so its provenance is obvious.
//
// behavior:
//   "success"    groups POIs by deterministic relationships
//   "empty"      returns { success:true, events: [] }
//   "fail"       returns { success:false, error:{ code: errorCode } }
//   "throw"      reconcile throws
//   "raw"        returns `response` verbatim (tests normalization)
//
// The success rule groups POIs with a union-find over exactly
// three observable, deterministic relationships:
//
//   - temporal_overlap:   both POIs have closed temporal ranges
//                         and their intersection is strictly
//                         larger than a point
//                         (max(startA,startB) < min(endA,endB))
//   - temporal_adjacency: both POIs have closed ranges touching
//                         at exactly one point
//                         (max(startA,startB) === min(endA,endB)).
//                         "Close" is not adjacent.
//   - shared_evidence:    the POIs cite at least one common
//                         segment id
//
// Singleton groups become "single" events; multi-POI groups
// become "grouped" events with derivation.rule naming the
// distinct relationship(s) that formed the group ("multiple"
// when more than one distinct rule fired).
//
// TEMPORAL DERIVATION (documented rule): a grouped Event's
// start is the earliest non-null startSeconds among its POIs,
// its end the latest non-null endSeconds; when no POI offers
// a start (or end), the Event's start (or end) is null —
// evidence-located only. Single events inherit their POI's
// temporals exactly. Timestamps are never invented.
// ==========================================================

import { defineEventReconciler, RECONCILER_STATUS } from "./reconciler.js";
import { EVENT_TYPE, EVENT_RULE } from "../events.js";

function truncate(text, limit = 40) {
    const clean = String(text).trim().replace(/\s+/g, " ");
    return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

function closedRange(poi) {
    return poi.startSeconds !== null && poi.endSeconds !== null;
}

function relatedBy(fired, a, b) {
    // Both POIs need closed temporal ranges for time-based
    // relationships. Touching at exactly one point is
    // temporal_adjacency; any strictly larger intersection
    // (including a zero-length point strictly inside a range)
    // is temporal_overlap.
    if (closedRange(a) && closedRange(b)) {
        const lo = Math.max(a.startSeconds, b.startSeconds);
        const hi = Math.min(a.endSeconds, b.endSeconds);
        if (lo < hi) {
            fired.add(EVENT_RULE.TEMPORAL_OVERLAP);
            return true;
        }
        if (lo === hi) {
            fired.add(EVENT_RULE.TEMPORAL_ADJACENCY);
            return true;
        }
    }
    // shared_evidence: at least one common segment id
    const ids = new Set(a.segmentIds);
    if (b.segmentIds.some((id) => ids.has(id))) {
        fired.add(EVENT_RULE.SHARED_EVIDENCE);
        return true;
    }
    return false;
}

function groupPois(pois) {
    // Deterministic union-find: process POIs in input order.
    const parent = pois.map((_, index) => index);
    const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    const union = (a, b) => { parent[find(a)] = find(b); };

    const pairRules = []; // { i, j, rules } — merged into group rules below
    for (let i = 0; i < pois.length; i++) {
        for (let j = i + 1; j < pois.length; j++) {
            const fired = new Set();
            if (relatedBy(fired, pois[i], pois[j])) {
                union(i, j);
                pairRules.push({ i, j, rules: fired });
            }
        }
    }

    const members = new Map(); // root -> POI views, in input order
    for (let i = 0; i < pois.length; i++) {
        const root = find(i);
        if (!members.has(root)) members.set(root, []);
        members.get(root).push(pois[i]);
    }
    const rules = new Map(); // root -> distinct rules that formed the group
    for (const { i, rules: fired } of pairRules) {
        const root = find(i);
        if (!rules.has(root)) rules.set(root, new Set());
        for (const rule of fired) rules.get(root).add(rule);
    }
    return { members, rules };
}

function deriveTemporals(group) {
    const starts = group.map((poi) => poi.startSeconds).filter((value) => value !== null);
    const ends = group.map((poi) => poi.endSeconds).filter((value) => value !== null);
    return {
        startSeconds: starts.length > 0 ? Math.min(...starts) : null,
        endSeconds: ends.length > 0 ? Math.max(...ends) : null
    };
}

function groupRule(group, ruleSet) {
    if (group.length < 2) return EVENT_RULE.NONE;
    const rules = ruleSet ? [...ruleSet] : [];
    if (rules.length === 1) return rules[0];
    return EVENT_RULE.MULTIPLE;
}

function candidatesFromInput(input) {
    const { members, rules } = groupPois(input.pois);
    const groups = [...members.entries()].map(([root, group]) => ({ group, rules: rules.get(root) }));
    // Deterministic order: earliest known start first (null
    // starts last), then input order of the first member.
    groups.sort((x, y) => {
        const sx = deriveTemporals(x.group).startSeconds;
        const sy = deriveTemporals(y.group).startSeconds;
        if (sx === null && sy === null) return 0;
        if (sx === null) return 1;
        if (sy === null) return -1;
        if (sx !== sy) return sx - sy;
        return input.pois.indexOf(x.group[0]) - input.pois.indexOf(y.group[0]);
    });

    return groups.map(({ group, rules: ruleSet }, candidateIndex) => {
        const { startSeconds, endSeconds } = deriveTemporals(group);
        const poiIds = group.map((poi) => poi.id);
        const single = group.length === 1;
        const labels = group.map((poi) => truncate(poi.label));
        return {
            type: single ? EVENT_TYPE.SINGLE : EVENT_TYPE.GROUPED,
            label: single ? labels[0] : `Grouped moment: ${labels.join(" + ")}`,
            startSeconds,
            endSeconds,
            poiIds,
            rule: groupRule(group, ruleSet),
            reconcilerRef: `mock-group-${candidateIndex}`
        };
    });
}

export function createMockEventReconciler({
    id = "mock-event-reconciler",
    name = "Mock event reconciler",
    behavior = "success",
    errorCode = "PROVIDER_ERROR",
    response = null
} = {}) {
    async function reconcile(input) {
        if (behavior === "throw") throw new Error("mock event reconciler failure");
        if (behavior === "raw") return response;
        if (behavior === "fail") return { success: false, error: { code: errorCode } };
        if (behavior === "empty") return { success: true, events: [] };
        return { success: true, events: candidatesFromInput(input) };
    }
    return defineEventReconciler({
        id,
        name,
        description: "Deterministic mock event reconciler (no network, no AI, no heuristics).",
        status: RECONCILER_STATUS.AVAILABLE,
        reconcile
    });
}

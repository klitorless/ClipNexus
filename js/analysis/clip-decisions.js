// ==========================================================
// clip-decisions.js
// Responsibility: define the CANONICAL CLIP DECISION model —
// the human review layer over ClipSpec candidates.
//
// A ClipDecision records ONE human judgment about ONE ClipSpec
// candidate: "keep" (the user selected it) or "reject" (the user
// discarded it). The ABSENCE of a decision means "unreviewed";
// there is no third stored value.
//
// ARCHITECTURAL RULE (Stage 10):
//
//   ClipSpec     = "the analysis system identified this candidate."
//   ClipDecision = "the human reviewed this candidate and chose
//                   KEEP or REJECT."
//
// These concepts are never collapsed. ClipSpecs stay immutable
// analysis artifacts; decisions live in a separate layer that
// references ClipSpec ids only and never copies or mutates the
// underlying evidence.
//
// CORE RULES (from the POI/Event/ClipSpec models and Stage 6–9
// contracts):
//   - ClipSpecs are referenced by id, never by array index
//   - decision values are a closed vocabulary ("keep"/"reject")
//   - unknown ClipSpec ids are rejected, never stored
//   - every object is frozen; arrays are copied, never aliased
//   - decidedAt stamps the review moment (ISO-8601); callers may
//     supply it for determinism, otherwise it defaults to now
//
// No workflow, no state machine, no scoring, no ranking: a
// decision is a fact about what the human chose.
// ==========================================================

import { AppError } from "../core/errors.js";
import { deepFreeze } from "../transcript/model.js";

export const CLIP_DECISION_SCHEMA_VERSION = 1;

// Canonical decision values. Absence of a record means
// "unreviewed" — it is never stored as a value.
export const CLIP_DECISION = Object.freeze({
    KEEP: "keep",
    REJECT: "reject"
});

// ---------- Small validators (mirrors clip-spec.js) ----------

function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}

function assertIsoTimestamp(value, code, message) {
    if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
        throw new AppError(code, message, { value });
    }
    return value;
}

function assertSchemaVersion(value, code) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new AppError(code, "schemaVersion must be a number.", { value });
    }
    return value;
}

function readClipDecisionFields(input = {}) {
    if (!isNonEmptyString(input.clipSpecId)) {
        throw new AppError("invalid_clip_decision",
            "ClipDecision needs a clipSpecId.", { value: input.clipSpecId });
    }
    if (input.decision !== CLIP_DECISION.KEEP && input.decision !== CLIP_DECISION.REJECT) {
        throw new AppError("invalid_clip_decision",
            'ClipDecision decision must be "keep" or "reject".', { value: input.decision });
    }
    const decidedAt = input.decidedAt === undefined
        ? new Date().toISOString()
        : assertIsoTimestamp(input.decidedAt,
            "invalid_clip_decision", "ClipDecision needs an ISO-8601 decidedAt.");
    assertSchemaVersion(
        input.schemaVersion === undefined ? CLIP_DECISION_SCHEMA_VERSION : input.schemaVersion,
        "invalid_clip_decision");

    return {
        schemaVersion: CLIP_DECISION_SCHEMA_VERSION,
        clipSpecId: input.clipSpecId,
        decision: input.decision,
        decidedAt
    };
}

/** Build a frozen, validated ClipDecision. */
export function createClipDecision(input) {
    return deepFreeze(readClipDecisionFields(input));
}

/** Validate a candidate ClipDecision object; returns it unchanged. */
export function assertClipDecision(input) {
    readClipDecisionFields(input); // throws on invalid; result discarded
    return input;
}

// ---------- Decision-set helpers ----------
//
// These operate on plain arrays of canonical ClipDecisions (the
// shape stored on the Project). They never touch ClipSpecs.

/**
 * The recorded decision for one candidate, or null when the
 * candidate is unreviewed (no decision recorded).
 */
export function getClipDecision(decisions, clipSpecId) {
    const list = Array.isArray(decisions) ? decisions : [];
    const found = list.find((entry) => entry && entry.clipSpecId === clipSpecId);
    return found ? found.decision : null;
}

/** ClipSpec ids the human kept, in decision-array order. */
export function getKeptClipSpecIds(decisions) {
    const list = Array.isArray(decisions) ? decisions : [];
    return list
        .filter((entry) => entry && entry.decision === CLIP_DECISION.KEEP)
        .map((entry) => entry.clipSpecId);
}

/**
 * Normalize a candidate decision list against the known ClipSpec
 * ids: every entry must already be a canonical ClipDecision, and
 * every clipSpecId must resolve to a known ClipSpec. Duplicates
 * collapse deterministically (last wins, first-appearance order).
 * Unknown ids are rejected, never stored.
 */
export function normalizeClipDecisions(decisions, knownClipSpecIds) {
    if (!Array.isArray(decisions)) {
        throw new AppError("invalid_clip_decisions",
            "Clip decisions must be an array.", { decisions });
    }
    const known = new Set(Array.isArray(knownClipSpecIds) ? knownClipSpecIds : []);
    const byId = new Map();
    const order = [];
    for (const candidate of decisions) {
        const valid = assertClipDecision(candidate);
        if (!known.has(valid.clipSpecId)) {
            throw new AppError("unknown_clip_spec",
                "ClipDecision references an unknown ClipSpec id.", { clipSpecId: valid.clipSpecId });
        }
        if (!byId.has(valid.clipSpecId)) order.push(valid.clipSpecId);
        byId.set(valid.clipSpecId, valid);
    }
    return order.map((id) => byId.get(id));
}

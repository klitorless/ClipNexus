// ==========================================================
// detectors/index.js
// Responsibility: run the detector suite over transcript
// segments and produce frozen, deterministic signals.
//
// A DetectorSignal is a plain, frozen record:
//
//   {
//     detector: "hype",
//     segmentId: "seg-000142",
//     timestampSeconds: 482.35,   // start.seconds, or null
//     score: 8,
//     signals: ["oh my god"],     // matched labels (explainability)
//     quote: "verbatim text"      // trimmed, never modified
//   }
//
// Rules:
//   - detectors run in DETECTOR_ORDER over segments in the
//     order given: output order is fully deterministic
//   - a segment may produce signals from several detectors;
//     detectors never suppress each other
//   - a detector emits at most one signal per segment
//   - malformed segments (no id) and empty text are skipped
//     silently — detectors observe, they do not validate
//   - the transcript is never mutated
// ==========================================================

import { deepFreeze } from "../../transcript/model.js";
import {
    DETECTOR_TYPE,
    DETECTOR_ORDER,
    resolveDetectorConfig,
    thresholdFor
} from "./types.js";
import { detectHype } from "./hype.js";
import { detectQuestion } from "./question.js";
import { detectKeyword } from "./keyword.js";
import { detectReaction } from "./reaction.js";
import { detectEmphasis } from "./emphasis.js";
import { detectPhrase } from "./phrase.js";

export { DETECTOR_TYPE, DETECTOR_ORDER, resolveDetectorConfig };

const DETECTORS = Object.freeze({
    [DETECTOR_TYPE.HYPE]: (segment, options) => detectHype(segment, options),
    [DETECTOR_TYPE.QUESTION]: (segment, options) => detectQuestion(segment, options),
    [DETECTOR_TYPE.KEYWORD]: (segment, options) => detectKeyword(segment, options.keywords),
    [DETECTOR_TYPE.REACTION]: (segment, options) => detectReaction(segment, options),
    [DETECTOR_TYPE.EMPHASIS]: (segment, options) => detectEmphasis(segment, options),
    [DETECTOR_TYPE.PHRASE]: (segment, options) => detectPhrase(segment, options.phrases)
});

function timestampSecondsOf(segment) {
    const seconds = segment && segment.start ? segment.start.seconds : null;
    return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null;
}

function toSignal(detector, segment, partial) {
    return deepFreeze({
        detector,
        segmentId: segment.id,
        timestampSeconds: timestampSecondsOf(segment),
        score: partial.score,
        signals: [...partial.signals],
        quote: String(segment.text ?? "").trim()
    });
}

function validSegment(segment) {
    return Boolean(segment) &&
        typeof segment.id === "string" &&
        segment.id.length > 0 &&
        typeof segment.text === "string" &&
        segment.text.trim().length > 0;
}

/**
 * Validate a user config for an analysis run. Returns
 * { ok: true } or { ok: false, error } with a user-facing
 * message. Pure: safe to call from UI code and tests.
 *
 * Rules:
 *   - at least one detector must be enabled
 *   - a term-based detector the user EXPLICITLY enabled with
 *     no terms is a user error; untouched defaults keep the
 *     historical silent skip (runDetectors ignores empty
 *     term lists), so a fresh default config always validates
 */
export function validateAnalysisConfig(userConfig = {}) {
    let config;
    try {
        config = resolveDetectorConfig(userConfig);
    } catch (error) {
        return { ok: false, error: "The analysis configuration is invalid." };
    }
    const user = userConfig || {};
    const anyEnabled = DETECTOR_ORDER.some((type) => config[type].enabled);
    if (!anyEnabled) {
        return { ok: false, error: "Select at least one analysis type to search for." };
    }
    const explicitOn = (section) => section && section.enabled === true;
    if (explicitOn(user[DETECTOR_TYPE.KEYWORD]) && config[DETECTOR_TYPE.KEYWORD].keywords.length === 0) {
        return { ok: false, error: "Add at least one keyword, or turn Keywords off." };
    }
    if (explicitOn(user[DETECTOR_TYPE.PHRASE]) && config[DETECTOR_TYPE.PHRASE].phrases.length === 0) {
        return { ok: false, error: "Add at least one phrase, or turn Custom Phrases off." };
    }
    return { ok: true };
}

/**
 * Run every enabled detector over the segments.
 *
 * @param {Array} segments  segment views { id, text, start: { seconds } }
 * @param {object} userConfig  partial detector config (merged over defaults)
 * @returns {Array} frozen DetectorSignals, deterministic order
 */
export function runDetectors(segments, userConfig = {}) {
    const config = resolveDetectorConfig(userConfig);
    const list = Array.isArray(segments) ? segments : [];
    const results = [];
    for (const segment of list) {
        if (!validSegment(segment)) continue;
        for (const type of DETECTOR_ORDER) {
            const options = config[type];
            if (!options.enabled) continue;
            if (type === DETECTOR_TYPE.KEYWORD && options.keywords.length === 0) continue;
            if (type === DETECTOR_TYPE.PHRASE && options.phrases.length === 0) continue;
            const partial = DETECTORS[type](segment, options);
            if (!partial) continue;
            if (partial.score < thresholdFor(type, options.sensitivity)) continue;
            results.push(toSignal(type, segment, partial));
        }
    }
    return deepFreeze(results);
}

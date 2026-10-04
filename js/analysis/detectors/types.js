// ==========================================================
// detectors/types.js
// Responsibility: the detector vocabulary — detector type ids,
// sensitivity levels, score thresholds, and the default
// configuration. All scoring rules live here or in the
// detector modules, never in UI or application code.
//
// A detector analyzes one transcript segment view
// { id, text, start: { seconds } } and returns either null
// (no signal) or a frozen DetectorSignal:
//
//   {
//     detector: "hype",            // DETECTOR_TYPE value
//     segmentId: "seg-000142",
//     timestampSeconds: 482.35,    // start.seconds, or null
//     score: 8,                    // deterministic, documented per detector
//     signals: ["oh my god"],      // matched signal labels (explainability)
//     quote: "verbatim text"       // trimmed segment text, never modified
//   }
//
// Detectors are independent: one segment may produce signals
// from several detectors. Reconciliation happens later in the
// event/POI architecture — never here.
// ==========================================================

export const DETECTOR_TYPE = Object.freeze({
    HYPE: "hype",
    QUESTION: "question",
    KEYWORD: "keyword",
    REACTION: "reaction",
    EMPHASIS: "emphasis",
    PHRASE: "phrase"
});

// Fixed run order. Deterministic output never depends on
// object key order or caller order.
export const DETECTOR_ORDER = Object.freeze([
    DETECTOR_TYPE.HYPE,
    DETECTOR_TYPE.QUESTION,
    DETECTOR_TYPE.KEYWORD,
    DETECTOR_TYPE.REACTION,
    DETECTOR_TYPE.EMPHASIS,
    DETECTOR_TYPE.PHRASE
]);

export const SENSITIVITY = Object.freeze({
    LOW: "low",
    NORMAL: "normal",
    HIGH: "high"
});

// Minimum score for a detector to emit a signal, by
// sensitivity. Keyword/phrase emit on any match (threshold 1)
// and ignore sensitivity — their selectivity comes from the
// configured vocabulary, not a score cutoff.
const SCORE_THRESHOLDS = Object.freeze({
    [DETECTOR_TYPE.HYPE]: { low: 4, normal: 2, high: 1 },
    [DETECTOR_TYPE.QUESTION]: { low: 2, normal: 1, high: 1 },
    [DETECTOR_TYPE.KEYWORD]: { low: 1, normal: 1, high: 1 },
    [DETECTOR_TYPE.REACTION]: { low: 2, normal: 1, high: 1 },
    [DETECTOR_TYPE.EMPHASIS]: { low: 4, normal: 2, high: 2 },
    [DETECTOR_TYPE.PHRASE]: { low: 1, normal: 1, high: 1 }
});

export function thresholdFor(detectorType, sensitivity) {
    const table = SCORE_THRESHOLDS[detectorType];
    if (!table) throw new Error(`Unknown detector type: ${detectorType}`);
    if (!Object.values(SENSITIVITY).includes(sensitivity)) {
        throw new Error(`Unknown sensitivity: ${sensitivity}`);
    }
    return table[sensitivity];
}

// Per-detector configuration. `enabled` toggles the detector;
// `sensitivity` selects the score threshold; keyword/phrase
// take user vocabularies. Arrays are replaced wholesale, never
// merged element-wise.
export const DEFAULT_DETECTOR_CONFIG = Object.freeze({
    [DETECTOR_TYPE.HYPE]: Object.freeze({ enabled: true, sensitivity: SENSITIVITY.NORMAL }),
    [DETECTOR_TYPE.QUESTION]: Object.freeze({ enabled: true, sensitivity: SENSITIVITY.NORMAL }),
    [DETECTOR_TYPE.KEYWORD]: Object.freeze({ enabled: true, sensitivity: SENSITIVITY.NORMAL, keywords: Object.freeze([]) }),
    [DETECTOR_TYPE.REACTION]: Object.freeze({ enabled: true, sensitivity: SENSITIVITY.NORMAL }),
    [DETECTOR_TYPE.EMPHASIS]: Object.freeze({ enabled: true, sensitivity: SENSITIVITY.NORMAL }),
    [DETECTOR_TYPE.PHRASE]: Object.freeze({ enabled: true, sensitivity: SENSITIVITY.NORMAL, phrases: Object.freeze([]) })
});

/**
 * Merge a partial user config over the defaults. Unknown
 * detector keys and unknown sensitivity values throw — a
 * misconfigured detector must fail loudly, not silently run
 * with defaults.
 */
export function resolveDetectorConfig(userConfig = {}) {
    if (userConfig === null || typeof userConfig !== "object" || Array.isArray(userConfig)) {
        throw new Error("Detector config must be an object.");
    }
    const resolved = {};
    for (const key of Object.keys(userConfig)) {
        if (!Object.values(DETECTOR_TYPE).includes(key)) {
            throw new Error(`Unknown detector in config: ${key}`);
        }
        const defaults = DEFAULT_DETECTOR_CONFIG[key];
        const override = userConfig[key] || {};
        const merged = { ...defaults, ...override };
        // Validate eagerly so bad config fails at setup, not mid-run.
        thresholdFor(key, merged.sensitivity);
        if (typeof merged.enabled !== "boolean") {
            throw new Error(`Detector "${key}" enabled must be a boolean.`);
        }
        resolved[key] = Object.freeze(merged);
    }
    return Object.freeze({ ...DEFAULT_DETECTOR_CONFIG, ...resolved });
}

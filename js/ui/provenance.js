// ==========================================================
// provenance.js
// Responsibility: turn a transcript acquisition record (or a
// normalized acquisition result's source) into display rows.
// Read-only. All values are untrusted and rendered as text.
// ==========================================================

import { ACQUISITION_TYPE } from "../transcript/model.js";
import { getLanguageLabel } from "../transcript/languages.js";
import { getPlatformLabel } from "../video/video-resolver.js";

const methodLabels = {
    native: "Native captions",
    generated: "Generated transcript",
    unknown: "Unknown"
};

export function describeMethod(method) {
    return methodLabels[method] || methodLabels.unknown;
}

function describeGenerated(generated) {
    if (generated === true) return "Yes (machine-generated)";
    if (generated === false) return "No (published with the video)";
    return "Unknown";
}

function describeLanguage(code) {
    return code ? `${getLanguageLabel(code)} (${code})` : "Unknown";
}

export function formatDateTime(iso) {
    if (!iso) return "Unknown";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

/**
 * Rows for a provider-acquired source (acquisition record or result.source).
 * @returns {Array<[string, string]>}
 */
export function createProviderSourceRows(source) {
    return [
        ["Provider", source.providerName || source.providerId || "Unknown"],
        ["Method", describeMethod(source.method)],
        ["Generated", describeGenerated(source.generated)],
        ["Language", describeLanguage(source.language)],
        ["Requested", source.requestedLanguage ? describeLanguage(source.requestedLanguage) : "Provider default"],
        ["Retrieved", formatDateTime(source.retrievedAt)],
        ["Provider source ID", source.sourceId || "Not provided"],
        ["Acquired for", source.video
            ? `${getPlatformLabel(source.video.platform)} · ${source.video.videoId}` : "Unknown"]
    ];
}

/** Rows describing where a canonical transcript came from. */
export function createProvenanceRows(acquisition) {
    if (!acquisition || acquisition.type === ACQUISITION_TYPE.UNKNOWN) return [["Source", "Unknown"]];
    if (acquisition.type === ACQUISITION_TYPE.FILE) return [["Source", "Imported file"]];
    return [["Source", "Transcript provider"], ...createProviderSourceRows(acquisition)];
}

/**
 * Plain-language notices where the provider's answer differs from, or is
 * less certain than, what was requested (Stage 2B). Never guesses.
 * @returns {string[]}
 */
export function createSourceNotices(source) {
    const notices = [];
    if (source.requestedLanguage && source.language && source.language !== source.requestedLanguage) {
        notices.push(`You asked for ${describeLanguage(source.requestedLanguage)}; ` +
            `the provider returned ${describeLanguage(source.language)}.`);
    } else if (source.requestedLanguage && !source.language) {
        notices.push(`You asked for ${describeLanguage(source.requestedLanguage)}; ` +
            "the provider did not report which language it returned.");
    }
    if (source.method === "unknown" || !methodLabels[source.method]) {
        notices.push("The provider did not report whether this is native captions or a generated transcript.");
    }
    return notices;
}

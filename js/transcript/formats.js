// ==========================================================
// formats.js
// Responsibility: SINGLE SOURCE OF TRUTH for supported
// transcript formats. Pure metadata + lookup helpers.
//
// Everything that needs to know "which formats exist"
// (upload control, file checks, parser dispatch) reads this.
// To add a format: add an entry here, add a module in
// ./formats/, and register it in parser.js.
// ==========================================================

export const TRANSCRIPT_FORMATS = Object.freeze([
    Object.freeze({
        id: "txt",
        label: "Plain text",
        extensions: Object.freeze(["txt"]),
        // Capabilities describe what the FORMAT can carry, not what a
        // given file actually contains. Validation reports the latter.
        hasTimestamps: "optional",
        hasEndTimes: false,
        hasSpeakers: "optional",
        description: "Free-form lines, optionally prefixed with timestamps or speaker names."
    }),
    Object.freeze({
        id: "srt",
        label: "SubRip (SRT)",
        extensions: Object.freeze(["srt"]),
        hasTimestamps: "required",
        hasEndTimes: true,
        hasSpeakers: "optional",
        description: "Numbered cues with HH:MM:SS,mmm --> HH:MM:SS,mmm ranges."
    }),
    Object.freeze({
        id: "vtt",
        label: "WebVTT",
        extensions: Object.freeze(["vtt"]),
        hasTimestamps: "required",
        hasEndTimes: true,
        hasSpeakers: "optional",
        description: "WEBVTT header, cues with HH:MM:SS.mmm ranges, optional <v Speaker> tags."
    }),
    Object.freeze({
        id: "json",
        label: "JSON",
        extensions: Object.freeze(["json"]),
        hasTimestamps: "optional",
        hasEndTimes: "optional",
        hasSpeakers: "optional",
        description: "Structured segment records (schema to be mapped in Stage 2)."
    })
]);

function getExtension(filename) {
    const lastDot = filename.lastIndexOf(".");
    return lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : "";
}

// Returns the format definition for a filename, or null if unsupported.
// Stage 1.5 decides by extension only; content sniffing is Stage 2.
export function getFormatForFilename(filename) {
    const extension = getExtension(filename);
    return TRANSCRIPT_FORMATS.find((format) => format.extensions.includes(extension)) || null;
}

export function getFormatById(formatId) {
    return TRANSCRIPT_FORMATS.find((format) => format.id === formatId) || null;
}

// Value for <input type="file" accept="...">, e.g. ".txt,.srt,.vtt,.json"
export function getAcceptAttribute() {
    return TRANSCRIPT_FORMATS
        .flatMap((format) => format.extensions)
        .map((extension) => `.${extension}`)
        .join(",");
}

// Human-readable list for messages, e.g. ".txt, .srt, .vtt, .json"
export function describeSupportedExtensions() {
    return getAcceptAttribute().split(",").join(", ");
}

// ==========================================================
// parser.js
// Responsibility: DISPATCHER. Takes a loaded file's raw text
// and format, selects the matching format module, and returns
// a canonical TranscriptDocument (see model.js).
//
//   raw text + format id
//        ↓
//   format module .parse(rawText)   (formats/*.js)
//        ↓
//   canonical TranscriptDocument   (frozen source layers)
//
// This file contains NO format-specific parsing. Each format's
// logic lives only in its own module.
// ==========================================================

import { getFormatById } from "./formats.js";
import { createTranscriptDocument, deepFreeze, PARSE_STATUS } from "./model.js";
import { AppError } from "../core/errors.js";
import * as txtFormat from "./formats/txt.js";
import * as srtFormat from "./formats/srt.js";
import * as vttFormat from "./formats/vtt.js";
import * as jsonFormat from "./formats/json.js";

// Format id -> parser module. Keys must match ids in formats.js.
const formatParsers = {
    [txtFormat.formatId]: txtFormat,
    [srtFormat.formatId]: srtFormat,
    [vttFormat.formatId]: vttFormat,
    [jsonFormat.formatId]: jsonFormat
};

function runFormatParser(formatModule, rawText) {
    try {
        return formatModule.parse(rawText);
    } catch (cause) {
        // A parser bug must not lose the raw evidence: record failure,
        // keep the document, let the UI and validator report it.
        return {
            status: PARSE_STATUS.FAILED,
            segments: [],
            notes: [`Parser error: ${cause && cause.message ? cause.message : String(cause)}`]
        };
    }
}

/**
 * Build a canonical TranscriptDocument from raw file contents.
 *
 * @param {object} input
 * @param {string} input.rawText       Exact file contents.
 * @param {string} input.format        Format id from formats.js.
 * @param {string} input.filename
 * @param {number} input.size          Bytes.
 * @param {number} [input.lastModified]
 * @param {object} [input.acquisition]   Provenance from model.js
 *                                       (createFileAcquisition / createProviderAcquisition).
 * @returns {object} Frozen TranscriptDocument.
 */
export function parseTranscript({ rawText, format, filename, size, lastModified = null, acquisition }) {
    const formatModule = formatParsers[format];
    if (!getFormatById(format) || !formatModule) {
        throw new AppError(
            "no_parser_for_format",
            "This file type is not supported.",
            { format, filename }
        );
    }

    const document = createTranscriptDocument({ filename, format, size, lastModified, rawText, acquisition });
    const result = runFormatParser(formatModule, rawText);

    document.parse = {
        status: result.status,
        parser: formatModule.formatId,
        notes: result.notes
    };
    document.segments = result.segments;
    document.processing.parsed = result.status === PARSE_STATUS.COMPLETE;

    // Freeze so later layers (validation, UI, console) cannot mutate
    // source evidence. Later layers attach via withDerivedLayer().
    return deepFreeze(document);
}

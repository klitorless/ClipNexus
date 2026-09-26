// ==========================================================
// pipeline.js
// Responsibility: the ONE path from raw transcript text to a
// frozen canonical TranscriptDocument, shared by file import
// and provider acquisition:
//
//   rawText + format + acquisition
//        ↓
//   parser (formats/*.js) → validator (observations)
//        ↓
//   frozen TranscriptDocument
//
// Callers supply provenance; this module never inspects where
// the text came from. (Moved from app.js in Stage 2A.)
// ==========================================================

import { parseTranscript } from "./parser.js";
import { validateTranscript } from "./validator.js";
import { withDerivedLayer, deepFreeze, createProviderAcquisition } from "./model.js";

export function buildTranscriptDocument({ rawText, format, filename, size, lastModified = null, acquisition }) {
    const parsed = parseTranscript({ rawText, format, filename, size, lastModified, acquisition });

    // Validation observes; its report is attached as a NEW layer.
    // The valid verdict travels with the report so the UI can
    // distinguish "passed" from "issues found" (errors present).
    const report = validateTranscript(parsed);
    return deepFreeze(withDerivedLayer(parsed, {
        validation: {
            status: report.status,
            valid: report.valid,
            validatedAt: report.validatedAt,
            checks: report.checks,
            issues: report.issues
        },
        processing: { validated: report.valid !== null }
    }));
}

function utf8ByteLength(text) {
    return new TextEncoder().encode(text).length;
}

/**
 * Build a document from a SUCCESSFUL normalized acquisition result
 * (providers/manager.js). rawText is stored exactly as delivered.
 */
export function buildAcquiredTranscript(result) {
    const { payload, source } = result;
    return buildTranscriptDocument({
        rawText: payload.rawText,
        format: payload.format,
        filename: null,                       // not a file
        size: utf8ByteLength(payload.rawText),
        lastModified: null,
        acquisition: createProviderAcquisition(source)
    });
}

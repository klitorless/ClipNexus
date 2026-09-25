// ==========================================================
// adapters/youtube-transcript-api.js
// Responsibility: PLACEHOLDER adapter for a future
// youtube-transcript-api style service (e.g. a local helper the
// user runs). Stage 2A performs NO network requests: this
// adapter always answers NOT_IMPLEMENTED.
//
// When implemented, service-specific handling stays in this file
// and is returned as an AdapterResponse (see ../provider.js).
// ==========================================================

import { defineProvider, PROVIDER_STATUS } from "../provider.js";
import { ACQUISITION_ERROR_CODES } from "../errors.js";

export const provider = defineProvider({
    id: "youtube-transcript-api",
    name: "youtube-transcript-api",
    description: "Caption-track retrieval service (placeholder — not connected in Stage 2A).",
    status: PROVIDER_STATUS.NOT_IMPLEMENTED,
    enabled: true,
    capabilities: {
        platforms: ["youtube"],
        nativeCaptions: true,
        generatedTranscript: true,
        languageSelection: true
    },
    async getTranscript() {
        return { success: false, error: { code: ACQUISITION_ERROR_CODES.NOT_IMPLEMENTED } };
    }
});

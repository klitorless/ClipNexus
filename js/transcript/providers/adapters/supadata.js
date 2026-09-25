// ==========================================================
// adapters/supadata.js
// Responsibility: PLACEHOLDER adapter for a future Supadata
// integration. Stage 2A performs NO network requests: this
// adapter always answers NOT_IMPLEMENTED.
//
// When implemented, all Supadata-specific request/response
// handling stays in this file and is returned as an
// AdapterResponse (see ../provider.js). Capabilities below are
// the intended ones and must be re-checked against the real API.
// ==========================================================

import { defineProvider, PROVIDER_STATUS } from "../provider.js";
import { ACQUISITION_ERROR_CODES } from "../errors.js";

export const provider = defineProvider({
    id: "supadata",
    name: "Supadata",
    description: "Hosted transcript API (placeholder — not connected in Stage 2A).",
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

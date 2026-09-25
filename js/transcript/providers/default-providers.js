// ==========================================================
// providers/default-providers.js
// Responsibility: the application's provider registry instance.
// Adding a provider = write adapters/<name>.js, add it here.
// No UI or coordinator code changes.
// ==========================================================

import { createProviderRegistry } from "./registry.js";
import { provider as supadata } from "./adapters/supadata.js";
import { provider as youtubeTranscriptApi } from "./adapters/youtube-transcript-api.js";

// Fresh registry with the built-in providers (tests use this so console
// additions such as vodAnalyzer.registerMockProviders() cannot affect them).
export function createDefaultProviderRegistry() {
    return createProviderRegistry([supadata, youtubeTranscriptApi]);
}

export const transcriptProviders = createDefaultProviderRegistry();

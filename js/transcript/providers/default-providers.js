// ==========================================================
// providers/default-providers.js
// Responsibility: the application's provider registry instance.
// Adding a provider = write adapters/<name>.js, add it here.
// No UI or coordinator code changes.
// ==========================================================

import { createProviderRegistry } from "./registry.js";
import { createSupadataProvider } from "./adapters/supadata.js";
import { providerCredentials } from "./credentials.js";
import { provider as youtubeTranscriptApi } from "./adapters/youtube-transcript-api.js";

// The one real provider (Stage 2B): real fetch + the in-memory key store.
const supadata = createSupadataProvider({
    fetchImpl: (url, init) => globalThis.fetch(url, init),
    credentials: providerCredentials
});

// Fresh registry with the built-in providers (tests use this so console
// additions such as vodAnalyzer.registerMockProviders() cannot affect them).
export function createDefaultProviderRegistry() {
    return createProviderRegistry([supadata, youtubeTranscriptApi]);
}

export const transcriptProviders = createDefaultProviderRegistry();

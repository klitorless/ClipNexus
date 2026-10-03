// ==========================================================
// providers/default-providers.js
// Responsibility: the application's provider registry instance.
// Adding a provider = write adapters/<name>.js, add it here.
// No UI or coordinator code changes.
// ==========================================================

import { createProviderRegistry } from "./registry.js";
import { createSupadataProvider } from "./adapters/supadata.js";
import { createYouTubeNativeProvider, YOUTUBE_NATIVE_ID } from "./adapters/youtube-native.js";
import { providerCredentials } from "./credentials.js";
import { provider as youtubeTranscriptApi } from "./adapters/youtube-transcript-api.js";

// The no-key provider (Stage 2C): real fetch, no credential. It tries
// YouTube's own caption tracks directly; where the browser cannot
// read YouTube responses it reports PROVIDER_UNAVAILABLE and the
// app falls back to the next provider.
const youtubeNative = createYouTubeNativeProvider({
    fetchImpl: (url, init) => globalThis.fetch(url, init)
});

// The one real provider (Stage 2B): real fetch + the in-memory key store.
const supadata = createSupadataProvider({
    fetchImpl: (url, init) => globalThis.fetch(url, init),
    credentials: providerCredentials
});

// Fresh registry with the built-in providers (tests use this so console
// additions such as vodAnalyzer.registerMockProviders() cannot affect them).
// Order matters: listSelectable()[0] is the default selection, and
// AUTOMATIC_PROVIDER_IDS is the Dashboard's no-key-first attempt order.
export function createDefaultProviderRegistry() {
    return createProviderRegistry([youtubeNative, supadata, youtubeTranscriptApi]);
}

export const transcriptProviders = createDefaultProviderRegistry();

// Automatic transcript acquisition (Dashboard VOD load): try the
// no-key YouTube captions first, then the authenticated Supadata
// provider (which needs its key in the in-memory store).
export const AUTOMATIC_PROVIDER_IDS = Object.freeze([YOUTUBE_NATIVE_ID, supadata.id]);

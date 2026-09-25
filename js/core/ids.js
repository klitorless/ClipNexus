// ==========================================================
// ids.js
// Responsibility: generate random, prefixed identifiers for
// top-level objects (projects, transcript documents).
// Deterministic ids (segments, issues) are NOT made here —
// they belong to their own models so they stay stable.
// ==========================================================

export function createRandomId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }
    // Fallback for non-secure contexts (e.g. some file:// setups).
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
}

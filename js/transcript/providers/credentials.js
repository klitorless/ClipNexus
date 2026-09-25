// ==========================================================
// providers/credentials.js  (Stage 2B)
// Responsibility: hold user-supplied provider credentials
// (e.g. an API key) IN MEMORY for the current page only.
//
// SECURITY RULES
//   - Never persisted: no localStorage, IndexedDB, cookies, or
//     application state. A page reload forgets every key.
//   - Never rendered, logged, or included in errors/provenance.
//     The UI only ever asks has(providerId).
//   - Only an adapter reads a value, and only to authenticate its
//     own provider request.
//   - Nothing here is a secret shipped with the app: keys are
//     typed in by the user at runtime. No key is ever hardcoded.
// ==========================================================

const MAX_LENGTH = 512;
// Printable ASCII without spaces: rejects pasted whitespace/newlines/control chars.
const credentialPattern = /^[\x21-\x7E]+$/;

export function isValidCredentialValue(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_LENGTH && credentialPattern.test(value);
}

export function createCredentialStore() {
    const values = new Map();
    return Object.freeze({
        /** @returns {boolean} true when stored */
        set(providerId, value) {
            const trimmed = typeof value === "string" ? value.trim() : value;
            if (typeof providerId !== "string" || !isValidCredentialValue(trimmed)) return false;
            values.set(providerId, trimmed);
            return true;
        },
        clear(providerId) {
            values.delete(providerId);
        },
        has(providerId) {
            return values.has(providerId);
        },
        // Adapters only. Returns the value or null.
        read(providerId) {
            return values.has(providerId) ? values.get(providerId) : null;
        },
        // Keeps accidental console/JSON inspection from printing keys.
        toJSON() {
            return { providers: [...values.keys()] };
        }
    });
}

// The app's store. Adapters receive it explicitly (see default-providers.js).
export const providerCredentials = createCredentialStore();

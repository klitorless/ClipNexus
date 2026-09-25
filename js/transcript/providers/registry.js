// ==========================================================
// providers/registry.js
// Responsibility: the CENTRAL list of transcript providers.
// The UI discovers providers through list(); nothing outside
// adapters/ names a specific provider.
//
//   register(provider)   add a provider (programming errors throw)
//   get(id)              { success, provider } | { success:false, error }
//   getSelectable(id)    like get(), but disabled → PROVIDER_DISABLED
//   list()               frozen descriptors (data only), in order
//   listSelectable()     descriptors of enabled providers
// ==========================================================

import { AppError } from "../../core/errors.js";
import { isValidProvider, describeProvider } from "./provider.js";
import { createAcquisitionError, ACQUISITION_ERROR_CODES } from "./errors.js";

export function createProviderRegistry(initialProviders = []) {
    const providers = new Map();

    function register(provider) {
        if (!isValidProvider(provider)) {
            throw new AppError("invalid_provider", "A transcript provider is misconfigured.",
                { id: provider && provider.id });
        }
        if (providers.has(provider.id)) {
            throw new AppError("duplicate_provider", "A transcript provider is registered twice.",
                { id: provider.id });
        }
        providers.set(provider.id, provider);
        return provider;
    }

    function get(id) {
        const provider = typeof id === "string" ? providers.get(id) : undefined;
        if (!provider) {
            return { success: false,
                error: createAcquisitionError(ACQUISITION_ERROR_CODES.PROVIDER_NOT_FOUND,
                    { providerId: typeof id === "string" ? id : null }) };
        }
        return { success: true, provider };
    }

    function getSelectable(id) {
        const found = get(id);
        if (found.success && !found.provider.enabled) {
            return { success: false,
                error: createAcquisitionError(ACQUISITION_ERROR_CODES.PROVIDER_DISABLED, { providerId: id }) };
        }
        return found;
    }

    const list = () => Object.freeze([...providers.values()].map(describeProvider));
    const listSelectable = () => Object.freeze(list().filter((item) => item.enabled));

    initialProviders.forEach(register);
    return Object.freeze({ register, get, getSelectable, list, listSelectable });
}

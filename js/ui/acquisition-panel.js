// ==========================================================
// acquisition-panel.js
// Responsibility: build the "Get transcript from a provider"
// card on the Transcripts page. Pure DOM building: receives the
// project, the current attempt state, and provider descriptors
// from the registry; reports user choices through callbacks.
//
// Designed around failure: every error view offers a way to
// try a DIFFERENT provider. The panel never switches providers
// by itself.
//
// SECURITY: provider names, errors, and provenance are untrusted
// and only ever set with textContent (via dom.js helpers).
// ==========================================================

import { createElement, createDetailList } from "./dom.js";
import { createProviderSourceRows, createSourceNotices } from "./provenance.js";
import { LANGUAGE_OPTIONS } from "../transcript/languages.js";
import { METHOD_PREFERENCE_OPTIONS, PROVIDER_STATUS } from "../transcript/providers/provider.js";
import { ACQUISITION_STATUS } from "../transcript/providers/acquisition-state.js";
import { getPlatformLabel } from "../video/video-resolver.js";

const yesNo = (flag) => (flag ? "yes" : "no");

// Honest availability (Stage 2B): registered ≠ implemented ≠ ready.
// Derived for display only — not a provider state.
export const AVAILABILITY = Object.freeze({
    AVAILABLE: Object.freeze({ key: "available", label: "Available" }),
    NEEDS_KEY: Object.freeze({ key: "needs-key", label: "Needs API key" }),
    NOT_IMPLEMENTED: Object.freeze({ key: "not-implemented", label: "Not implemented" }),
    DISABLED: Object.freeze({ key: "disabled", label: "Disabled" })
});

export function getAvailability(provider, credentialReady = () => false) {
    if (!provider.enabled) return AVAILABILITY.DISABLED;
    if (provider.status !== PROVIDER_STATUS.AVAILABLE) return AVAILABILITY.NOT_IMPLEMENTED;
    if (provider.credential && !credentialReady(provider.id)) return AVAILABILITY.NEEDS_KEY;
    return AVAILABILITY.AVAILABLE;
}

function providerOptionLabel(provider, credentialReady) {
    return `${provider.name} \u2014 ${getAvailability(provider, credentialReady).label}`;
}

const blockedReasons = {
    "needs-key": "Enter an API key for this provider to enable Get Transcript.",
    "not-implemented": "This provider is registered but not implemented yet, so it cannot retrieve transcripts.",
    "disabled": "This provider is disabled."
};

export function describeCapabilities(provider) {
    if (!provider) return "No provider selected.";
    const { capabilities } = provider;
    const platforms = capabilities.platforms.length
        ? capabilities.platforms.map(getPlatformLabel).join(", ") : "none";
    const status = provider.status === PROVIDER_STATUS.NOT_IMPLEMENTED ? "not implemented" : "implemented";
    return `${provider.description} Platforms: ${platforms} · native captions: ${yesNo(capabilities.nativeCaptions)}` +
        ` · generated: ${yesNo(capabilities.generatedTranscript)}` +
        ` · language choice: ${yesNo(capabilities.languageSelection)} · status: ${status}.`;
}

function createSelect(id, options, selectedValue) {
    const select = createElement("select", "select-input");
    select.id = id;
    options.forEach(({ value, label, disabled = false }) => {
        const option = createElement("option", "", label);
        option.value = value;
        option.disabled = disabled;
        option.selected = value === selectedValue;
        select.append(option);
    });
    return select;
}

function createField(labelText, control, hintText = null) {
    const field = createElement("div", "field-group");
    const label = createElement("label", "field-label", labelText);
    label.htmlFor = control.id;
    field.append(label, control);
    if (hintText !== null) field.append(createElement("p", "field-hint", hintText));
    return field;
}

// "" in a <select> stands for null (provider default language).
const toLanguageValue = (code) => (code === null ? "" : code);
const fromLanguageValue = (value) => (value === "" ? null : value);

function createErrorView({ attempt, providers, hasTranscript, onAcquire, credentialReady }) {
    const box = createElement("div", "acquire-alert");
    box.setAttribute("role", "alert");
    box.dataset.state = "error";
    box.append(
        createElement("span", "tag tag-danger", "Failed"),
        createElement("p", "acquire-heading", `${attempt.providerName} could not retrieve this transcript.`),
        createDetailList([
            ["Provider", attempt.providerName],
            ["Reason", attempt.error.message],
            ["Code", attempt.error.code],
            ["Retry", attempt.error.retryable ? "Trying again may help" : "Trying again is unlikely to help"]
        ])
    );
    if (hasTranscript) box.append(createElement("p", "card-body", "Your current transcript was not changed."));

    if (attempt.error.retryable) {
        const retry = createElement("button", "button", "Try Again");
        retry.type = "button";
        retry.dataset.action = "retry";
        retry.addEventListener("click", () => onAcquire({ providerId: attempt.providerId }));
        const retryRow = createElement("div", "field-row acquire-actions");
        retryRow.append(retry);
        box.append(retryRow);
    }

    // Only providers that can actually run right now are offered.
    const others = providers.filter((item) => item.id !== attempt.providerId &&
        getAvailability(item, credentialReady) === AVAILABILITY.AVAILABLE);
    if (others.length === 0) {
        box.append(createElement("p", "field-hint",
            "No other provider is available right now. You can still import a transcript file."));
        return box;
    }

    const switchSelect = createSelect("acq-switch-provider",
        others.map((item) => ({ value: item.id, label: item.name })), others[0].id);
    const switchButton = createElement("button", "button button-primary");
    switchButton.type = "button";
    switchButton.dataset.action = "switch";
    const nameFor = (id) => (others.find((item) => item.id === id) || others[0]).name;
    const syncLabel = () => { switchButton.textContent = `Try With ${nameFor(switchSelect.value)}`; };
    syncLabel();
    switchSelect.addEventListener("change", syncLabel);
    switchButton.addEventListener("click", () => onAcquire({ providerId: switchSelect.value }));

    const actions = createElement("div", "field-row acquire-actions");
    actions.append(switchButton);
    box.append(createField("Try another provider", switchSelect), actions);
    return box;
}

function createSuccessView(attempt) {
    const box = createElement("div", "acquire-success");
    box.setAttribute("role", "status");
    box.dataset.state = "success";
    box.append(
        createElement("span", "tag", "Transcript available"),
        createElement("p", "acquire-heading", `Transcript retrieved from ${attempt.source.providerName}.`),
        createDetailList(createProviderSourceRows(attempt.source))
    );
    createSourceNotices(attempt.source).forEach((notice) => {
        const note = createElement("p", "field-hint acquire-notice", notice);
        note.dataset.notice = "source";
        box.append(note);
    });
    return box;
}

// Key entry for providers that need a user-supplied credential. The value
// goes straight to onCredentialChange and is never rendered back.
function createCredentialField(provider, ready, { onCredentialChange, onChanged, disabled }) {
    const field = createElement("div", "field-group credential-field");
    field.dataset.section = "credential";
    const hint = createElement("p", "field-hint", provider.credential.hint);
    if (ready) {
        const status = createElement("p", "credential-status", `${provider.credential.label}: entered for this page session.`);
        status.dataset.credential = "ready";
        const clear = createElement("button", "button", "Forget Key");
        clear.type = "button";
        clear.dataset.action = "clear-credential";
        clear.disabled = disabled;
        clear.addEventListener("click", () => { onCredentialChange(provider.id, null); onChanged(); });
        const row = createElement("div", "field-row");
        row.append(clear);
        field.append(status, row, hint);
        return field;
    }
    const input = createElement("input", "text-input");
    input.id = "acq-credential";
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.maxLength = 512;
    input.disabled = disabled;
    const save = createElement("button", "button", "Use Key");
    save.type = "button";
    save.dataset.action = "set-credential";
    save.disabled = disabled;
    const message = createElement("p", "field-hint field-error");
    message.setAttribute("role", "alert");
    message.hidden = true;
    const submit = () => {
        const accepted = onCredentialChange(provider.id, input.value);
        input.value = "";                              // never keep it in the DOM
        if (accepted) { onChanged(); return; }
        message.textContent = "That does not look like an API key (no spaces, up to 512 characters).";
        message.hidden = false;
    };
    save.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
    const label = createElement("label", "field-label", provider.credential.label);
    label.htmlFor = input.id;
    const row = createElement("div", "field-row");
    row.append(input, save);
    field.append(label, row, message, hint);
    return field;
}

/**
 * @param {object} input
 * @param {object|null} input.project
 * @param {object} input.acquisition   state.ui.transcriptAcquisition
 * @param {Array<object>} input.providers   registry.list() descriptors
 * @param {(changes:object) => void} input.onSelectionChange
 * @param {(override?:object) => void} input.onAcquire
 * @param {(providerId:string) => boolean} [input.credentialReady]   Stage 2B
 * @param {(providerId:string, value:string|null) => boolean} [input.onCredentialChange]  Stage 2B
 */
export function createAcquisitionPanel({ project, acquisition, providers, onSelectionChange, onAcquire,
    credentialReady = () => false, onCredentialChange = () => false }) {
    const card = createElement("article", "card acquisition-panel");
    card.dataset.section = "acquisition";
    card.append(
        createElement("span", "tag", "Stage 2B"),
        createElement("h2", "card-title", "Get transcript from a provider"),
        createElement("p", "card-body",
            "Pick a provider to fetch the transcript for the linked video. Only providers marked " +
            "\u201cAvailable\u201d can run. The only network request is the one to the selected provider, " +
            "and it happens only when you press Get Transcript.")
    );

    if (!project || !project.video) {
        card.append(createElement("p", "card-body",
            "Link a video on the Dashboard first. Providers work from the identified video, not from a URL."));
        return card;
    }

    const { selection, status, attempt } = acquisition;
    const busy = status === ACQUISITION_STATUS.ACQUIRING;
    const byId = (id) => providers.find((item) => item.id === id) || null;

    const providerSelect = createSelect("acq-provider", providers.map((item) => ({
        value: item.id, label: providerOptionLabel(item, credentialReady), disabled: !item.enabled
    })), selection.providerId);
    const statusTag = createElement("span", "tag");
    statusTag.dataset.providerStatus = "";
    const capabilityHint = createElement("p", "field-hint");
    const providerField = createField("Transcript provider", providerSelect);
    providerField.append(statusTag, capabilityHint);
    const credentialSlot = createElement("div", "credential-slot");
    const blockedHint = createElement("p", "field-hint");
    blockedHint.dataset.state = "blocked";

    const languageSelect = createSelect("acq-language", LANGUAGE_OPTIONS.map(({ code, label }) => ({
        value: toLanguageValue(code), label
    })), toLanguageValue(selection.language));
    const methodSelect = createSelect("acq-method", METHOD_PREFERENCE_OPTIONS, selection.method);

    const getButton = createElement("button", "button button-primary acquire-button", "Get Transcript");

    // Updates everything that depends on the selected provider, in place.
    const syncProvider = () => {
        const provider = byId(providerSelect.value);
        const availability = provider ? getAvailability(provider, credentialReady) : AVAILABILITY.DISABLED;
        statusTag.textContent = availability.label;
        statusTag.dataset.providerStatus = availability.key;
        statusTag.className = availability === AVAILABILITY.AVAILABLE ? "tag" : "tag tag-muted";
        capabilityHint.textContent = describeCapabilities(provider);
        credentialSlot.replaceChildren();
        if (provider && provider.credential && provider.status === PROVIDER_STATUS.AVAILABLE && provider.enabled) {
            credentialSlot.append(createCredentialField(provider, credentialReady(provider.id),
                { onCredentialChange, onChanged: syncProvider, disabled: busy }));
        }
        getButton.disabled = busy || availability !== AVAILABILITY.AVAILABLE;
        blockedHint.textContent = blockedReasons[availability.key] || "";
        blockedHint.hidden = busy || availability === AVAILABILITY.AVAILABLE;
        [...providerSelect.options].forEach((option) => {
            const item = byId(option.value);
            if (item) option.textContent = providerOptionLabel(item, credentialReady);
        });
    };

    providerSelect.addEventListener("change", () => {
        onSelectionChange({ providerId: providerSelect.value });
        syncProvider();
    });
    languageSelect.addEventListener("change", () => onSelectionChange({ language: fromLanguageValue(languageSelect.value) }));
    methodSelect.addEventListener("change", () => onSelectionChange({ method: methodSelect.value }));

    getButton.type = "button";
    getButton.dataset.action = "acquire";
    getButton.addEventListener("click", () => onAcquire());

    [providerSelect, languageSelect, methodSelect].forEach((control) => { control.disabled = busy; });
    syncProvider();

    card.append(
        providerField,
        credentialSlot,
        createField("Language", languageSelect),
        createField("Acquisition", methodSelect)
    );
    if (project.transcript) {
        card.append(createElement("p", "field-hint",
            "A successful retrieval replaces the current transcript. A failed one never changes it."));
    }
    card.append(getButton, blockedHint);

    if (busy) {
        const progress = createElement("p", "acquire-progress", `Retrieving transcript\u2026 Provider: ${attempt.providerName}`);
        progress.setAttribute("role", "status");
        progress.dataset.state = "acquiring";
        getButton.setAttribute("aria-busy", "true");
        card.append(progress);
    } else if (status === ACQUISITION_STATUS.ERROR) {
        card.append(createErrorView({ attempt, providers, hasTranscript: project.transcript !== null, onAcquire, credentialReady }));
    } else if (status === ACQUISITION_STATUS.SUCCESS) {
        card.append(createSuccessView(attempt));
    }
    return card;
}

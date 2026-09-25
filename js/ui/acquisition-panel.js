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
import { createProviderSourceRows } from "./provenance.js";
import { LANGUAGE_OPTIONS } from "../transcript/languages.js";
import { METHOD_PREFERENCE_OPTIONS, PROVIDER_STATUS } from "../transcript/providers/provider.js";
import { ACQUISITION_STATUS } from "../transcript/providers/acquisition-state.js";
import { getPlatformLabel } from "../video/video-resolver.js";

const yesNo = (flag) => (flag ? "yes" : "no");

function providerOptionLabel(provider) {
    if (!provider.enabled) return `${provider.name} (disabled)`;
    if (provider.status === PROVIDER_STATUS.NOT_IMPLEMENTED) return `${provider.name} (not connected)`;
    return provider.name;
}

export function describeCapabilities(provider) {
    if (!provider) return "No provider selected.";
    const { capabilities } = provider;
    const platforms = capabilities.platforms.length
        ? capabilities.platforms.map(getPlatformLabel).join(", ") : "none";
    const status = provider.status === PROVIDER_STATUS.NOT_IMPLEMENTED ? "placeholder, not connected" : "available";
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

function createErrorView({ attempt, providers, hasTranscript, onAcquire }) {
    const box = createElement("div", "acquire-alert");
    box.setAttribute("role", "alert");
    box.dataset.state = "error";
    box.append(
        createElement("span", "tag tag-danger", "Failed"),
        createElement("p", "acquire-heading", `${attempt.providerName} could not retrieve this transcript.`),
        createDetailList([["Reason", attempt.error.message], ["Code", attempt.error.code]])
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
    } else {
        box.append(createElement("p", "field-hint", `Trying ${attempt.providerName} again is unlikely to help.`));
    }

    const others = providers.filter((item) => item.enabled && item.id !== attempt.providerId);
    if (others.length === 0) {
        box.append(createElement("p", "field-hint", "No other provider is available."));
        return box;
    }

    const switchSelect = createSelect("acq-switch-provider",
        others.map((item) => ({ value: item.id, label: providerOptionLabel(item) })), others[0].id);
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
    return box;
}

/**
 * @param {object} input
 * @param {object|null} input.project
 * @param {object} input.acquisition   state.ui.transcriptAcquisition
 * @param {Array<object>} input.providers   registry.list() descriptors
 * @param {(changes:object) => void} input.onSelectionChange
 * @param {(override?:object) => void} input.onAcquire
 */
export function createAcquisitionPanel({ project, acquisition, providers, onSelectionChange, onAcquire }) {
    const card = createElement("article", "card acquisition-panel");
    card.dataset.section = "acquisition";
    card.append(
        createElement("span", "tag", "Architecture only"),
        createElement("h2", "card-title", "Get transcript from a provider"),
        createElement("p", "card-body",
            "Stage 2A adds provider selection. No provider is connected yet, so the listed providers " +
            "answer \u201cnot implemented\u201d. Nothing is sent over the network.")
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
        value: item.id, label: providerOptionLabel(item), disabled: !item.enabled
    })), selection.providerId);
    const capabilityHint = createElement("p", "field-hint", describeCapabilities(byId(selection.providerId)));
    const providerField = createField("Transcript provider", providerSelect);
    providerField.append(capabilityHint);

    const languageSelect = createSelect("acq-language", LANGUAGE_OPTIONS.map(({ code, label }) => ({
        value: toLanguageValue(code), label
    })), toLanguageValue(selection.language));
    const methodSelect = createSelect("acq-method", METHOD_PREFERENCE_OPTIONS, selection.method);

    providerSelect.addEventListener("change", () => {
        capabilityHint.textContent = describeCapabilities(byId(providerSelect.value));
        onSelectionChange({ providerId: providerSelect.value });
    });
    languageSelect.addEventListener("change", () => onSelectionChange({ language: fromLanguageValue(languageSelect.value) }));
    methodSelect.addEventListener("change", () => onSelectionChange({ method: methodSelect.value }));

    const getButton = createElement("button", "button button-primary acquire-button", "Get Transcript");
    getButton.type = "button";
    getButton.dataset.action = "acquire";
    getButton.addEventListener("click", () => onAcquire());

    [providerSelect, languageSelect, methodSelect, getButton].forEach((control) => { control.disabled = busy; });
    if (providers.every((item) => !item.enabled)) getButton.disabled = true;

    card.append(
        providerField,
        createField("Language", languageSelect),
        createField("Acquisition", methodSelect)
    );
    if (project.transcript) {
        card.append(createElement("p", "field-hint",
            "A successful retrieval replaces the current transcript. A failed one never changes it."));
    }
    card.append(getButton);

    if (busy) {
        const progress = createElement("p", "acquire-progress", `Retrieving transcript\u2026 Provider: ${attempt.providerName}`);
        progress.setAttribute("role", "status");
        progress.dataset.state = "acquiring";
        getButton.setAttribute("aria-busy", "true");
        card.append(progress);
    } else if (status === ACQUISITION_STATUS.ERROR) {
        card.append(createErrorView({ attempt, providers, hasTranscript: project.transcript !== null, onAcquire }));
    } else if (status === ACQUISITION_STATUS.SUCCESS) {
        card.append(createSuccessView(attempt));
    }
    return card;
}

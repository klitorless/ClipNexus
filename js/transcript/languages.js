// ==========================================================
// languages.js
// Responsibility: language codes for transcript requests.
//
// language = null means "provider default" — the app never
// assumes English. Codes are BCP 47-style ("en", "pt-BR").
// The option list is a Stage 2A placeholder; real providers
// may later report the languages they actually offer.
// ==========================================================

export const LANGUAGE_OPTIONS = Object.freeze([
    Object.freeze({ code: null, label: "Provider default" }),
    Object.freeze({ code: "en", label: "English" }),
    Object.freeze({ code: "es", label: "Spanish" }),
    Object.freeze({ code: "fr", label: "French" }),
    Object.freeze({ code: "de", label: "German" }),
    Object.freeze({ code: "pt", label: "Portuguese" }),
    Object.freeze({ code: "it", label: "Italian" }),
    Object.freeze({ code: "ja", label: "Japanese" }),
    Object.freeze({ code: "ko", label: "Korean" }),
    Object.freeze({ code: "zh", label: "Chinese" })
]);

const languageCodePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function isValidLanguageCode(code) {
    return typeof code === "string" && code.length <= 35 && languageCodePattern.test(code);
}

// Display label; unknown-but-valid codes are shown as the code itself.
export function getLanguageLabel(code) {
    if (code === null || code === undefined) return "Unknown";
    const option = LANGUAGE_OPTIONS.find((item) => item.code === code);
    return option ? option.label : String(code);
}

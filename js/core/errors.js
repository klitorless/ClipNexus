// ==========================================================
// errors.js
// Responsibility: keep USER-FACING messages separate from
// DEVELOPER diagnostics. The UI only ever shows userMessage;
// technical detail goes to the browser console.
// ==========================================================

export class AppError extends Error {
    /**
     * @param {string} code         Stable machine-readable code, e.g. "unsupported_format".
     * @param {string} userMessage  Plain-language message safe to show in the UI.
     * @param {object} [detail]     Developer diagnostics (never rendered).
     * @param {Error}  [cause]      Underlying error, if any.
     */
    constructor(code, userMessage, detail = {}, cause = null) {
        super(userMessage);
        this.name = "AppError";
        this.code = code;
        this.userMessage = userMessage;
        this.detail = detail;
        this.cause = cause;
    }
}

const fallbackMessage = "Something went wrong. Check the browser console for details.";

/**
 * Log diagnostics for developers and return a safe message for users.
 * Accepts AppError or any unexpected error.
 */
export function reportError(error, context = "") {
    const isAppError = error instanceof AppError;
    const label = context ? `[VOD Analyzer] ${context}` : "[VOD Analyzer]";

    if (isAppError) {
        console.warn(label, error.code, error.detail, error.cause || "");
    } else {
        console.error(label, "Unexpected error:", error);
    }

    return isAppError ? error.userMessage : fallbackMessage;
}

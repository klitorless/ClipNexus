// ==========================================================
// download.js
// Responsibility: the smallest possible browser download for
// text the application generated (transcript export).
//
// No state, no UI copy, no serialization: the caller supplies
// the exact filename and string. Blob + object URL + a temporary
// anchor is the standard dependency-free download path.
// ==========================================================

/**
 * Trigger a browser download of a text string.
 *
 * @param {string} filename  e.g. "tx-abc123.json"
 * @param {string} text      Exact content to save (never modified).
 * @param {string} [mimeType="application/json"]
 */
export function downloadTextFile(filename, text, mimeType = "application/json") {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    try {
        link.href = url;
        link.download = filename;
        // The anchor must be in the document for the click to
        // start a download in every browser.
        document.body.appendChild(link);
        link.click();
    } finally {
        link.remove();
        // Revoke after the click has been dispatched; the delay
        // keeps browsers that fetch the blob asynchronously happy.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

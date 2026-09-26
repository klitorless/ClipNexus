// ==========================================================
// lines.js  (Stage 5 — shared source-line utility)
// Responsibility: split raw transcript text into lines while
// keeping every line's character offsets and 1-based line
// number, so format parsers can record exact traceability
// (lines/offsets) on each canonical segment.
//
// Handles CRLF, LF, CR, and mixed line endings. Offsets are
// UTF-16 code-unit indexes into the original rawText and cover
// the line content only (line breaks are excluded).
// ==========================================================

const lineBreakPattern = /\r\n|\r|\n/g;

/**
 * @param {string} rawText
 * @returns {Array<{ line:string, start:number, end:number, lineNumber:number }>}
 */
export function splitSourceLines(rawText) {
    const result = [];
    if (typeof rawText !== "string" || rawText.length === 0) return result;
    let position = 0;
    let lineNumber = 0;
    const matches = [...rawText.matchAll(lineBreakPattern)];
    let lastEnd = 0;
    for (const match of matches) {
        lineNumber += 1;
        result.push({
            line: rawText.slice(lastEnd, match.index),
            start: lastEnd,
            end: match.index,
            lineNumber
        });
        lastEnd = match.index + match[0].length;
    }
    // Trailing content after the last break, or the whole text when
    // there are no breaks. A final line break does not start a new
    // (empty) line.
    if (lastEnd < rawText.length) {
        lineNumber += 1;
        result.push({ line: rawText.slice(lastEnd), start: lastEnd, end: rawText.length, lineNumber });
    }
    return result;
}

/**
 * Group source lines into blocks separated by blank
 * (whitespace-only) lines. Returns block objects carrying the
 * absolute line entries, so positions stay accurate even when
 * blocks are skipped.
 */
export function groupIntoBlocks(lineEntries) {
    const blocks = [];
    let current = null;
    for (const entry of lineEntries) {
        if (entry.line.trim().length === 0) {
            current = null;
            continue;
        }
        if (!current) {
            current = { lines: [] };
            blocks.push(current);
        }
        current.lines.push(entry);
    }
    return blocks;
}

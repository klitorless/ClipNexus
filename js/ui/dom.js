// ==========================================================
// dom.js
// Responsibility: tiny shared DOM builders used by all views.
//
// SECURITY: every helper sets text with textContent. Nothing
// here uses innerHTML, so untrusted transcript content can
// never be interpreted as HTML or script.
// ==========================================================

export function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

// rows: array of [label, value] pairs -> <dl class="detail-list">
export function createDetailList(rows) {
    const list = createElement("dl", "detail-list");
    rows.forEach(([label, value]) => {
        list.append(createElement("dt", "", label), createElement("dd", "", String(value)));
    });
    return list;
}

// Simple titled card with an optional status tag and an optional
// brand illustration. image: { src, alt, className? } | null — kept
// optional so existing 4-argument callers are unaffected.
export function createInfoCard(title, bodyText, tagText, tagClass = "tag", image = null) {
    const card = createElement("article", "card");
    if (tagText) card.append(createElement("span", tagClass, tagText));
    if (image && image.src) {
        const img = document.createElement("img");
        img.className = image.className || "brand-empty";
        img.src = image.src;
        img.alt = image.alt || "";
        img.loading = "lazy";
        img.decoding = "async";
        card.append(img);
    }
    card.append(
        createElement("h2", "card-title", title),
        createElement("p", "card-body", bodyText)
    );
    return card;
}

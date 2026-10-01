// ==========================================================
// sidebar.js
// Responsibility: render the application sidebar — brand,
// section navigation with icons, and a session footer — and
// keep the active item highlighted. Uses plain hash links,
// so the router handles navigation.
//
// On mobile the brand and footer are hidden by CSS and the
// nav renders as the horizontal scroll strip; on desktop the
// sidebar is a full-height column.
// ==========================================================

import { routes } from "../core/router.js";

// Minimal stroke icons, one per route. Decorative: the link
// text carries the accessible name (aria-hidden on the svg).
const routeIcons = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    transcripts: '<path d="M6 2.5h8L19 8v13.5H6z"/><path d="M13.5 2.5V8H19"/><path d="M9 12.5h6M9 16h6"/>',
    pois: '<path d="M12 21s-6.5-5.4-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.6 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>',
    events: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
    clips: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 5v14M16.5 5v14M3 9.5h4.5M3 14.5h4.5M16.5 9.5H21M16.5 14.5H21"/>',
    analysis: '<path d="M4 20V10M10 20V4M16 20v-8M21 20H3"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>'
};

function createIcon(routeId) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("nav-icon");
    // Static allowlist of icon paths defined above — no user
    // content passes through here.
    svg.innerHTML = routeIcons[routeId] || routeIcons.dashboard;
    return svg;
}

function createBrand() {
    const brand = document.createElement("div");
    brand.className = "brand brand-in-sidebar";
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    mark.setAttribute("viewBox", "0 0 24 24");
    mark.setAttribute("width", "30");
    mark.setAttribute("height", "30");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "ClipNexus logo");
    mark.classList.add("brand-mark");
    const play = document.createElementNS("http://www.w3.org/2000/svg", "path");
    play.setAttribute("d", "M6 4.5v15l13-7.5z");
    play.setAttribute("fill", "currentColor");
    mark.append(play);
    const text = document.createElement("span");
    text.className = "brand-text";
    const name = document.createElement("span");
    name.className = "brand-name";
    name.textContent = "ClipNexus";
    const sub = document.createElement("span");
    sub.className = "brand-sub";
    sub.textContent = "VOD Transcript Analyzer";
    text.append(name, sub);
    brand.append(mark, text);
    return brand;
}

function createNavItem(route) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "nav-link";
    link.href = `#${route.id}`;
    link.dataset.route = route.id;
    link.append(createIcon(route.id));
    const label = document.createElement("span");
    label.textContent = route.label;
    link.append(label);
    item.append(link);
    return item;
}

function createFooter() {
    const footer = document.createElement("div");
    footer.className = "sidebar-footer";
    footer.textContent = "Projects and API keys live for this page session only — a reload forgets them.";
    return footer;
}

export function renderSidebar(mountElement) {
    const list = document.createElement("ul");
    list.className = "nav-list";
    routes.forEach((route) => list.append(createNavItem(route)));
    mountElement.replaceChildren(createBrand(), list, createFooter());
}

export function setActiveNavItem(mountElement, activeRouteId) {
    mountElement.querySelectorAll(".nav-link").forEach((link) => {
        const isActive = link.dataset.route === activeRouteId;
        link.classList.toggle("is-active", isActive);
        if (isActive) {
            link.setAttribute("aria-current", "page");
            // Keep the active item visible in the mobile scroll strip.
            link.scrollIntoView({ block: "nearest", inline: "nearest" });
        } else {
            link.removeAttribute("aria-current");
        }
    });
}

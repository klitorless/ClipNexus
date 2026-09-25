// ==========================================================
// sidebar.js
// Responsibility: render the section navigation and keep the
// active item highlighted. Uses plain hash links, so the
// router handles navigation.
// ==========================================================

import { routes } from "../core/router.js";

function createNavItem(route) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "nav-link";
    link.href = `#${route.id}`;
    link.dataset.route = route.id;
    link.textContent = route.label;
    item.append(link);
    return item;
}

export function renderSidebar(mountElement) {
    const list = document.createElement("ul");
    list.className = "nav-list";
    routes.forEach((route) => list.append(createNavItem(route)));
    mountElement.replaceChildren(list);
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

// ==========================================================
// router.js
// Responsibility: map the URL hash (#dashboard, #pois, ...)
// to a route name and write it into state. Views react to
// the "route" state change — no page reloads.
// ==========================================================

import { state } from "./state.js";

// Single source of truth for sections. The sidebar reads this too.
export const routes = [
    { id: "dashboard", label: "Dashboard" },
    { id: "transcripts", label: "Transcripts" },
    { id: "pois", label: "POIs" },
    { id: "events", label: "Event Arcs" },
    { id: "clips", label: "Clip Queue" },
    { id: "analysis", label: "Analysis" },
    { id: "settings", label: "Settings" }
];

const defaultRoute = "dashboard";

// Aliases that resolve to an existing route.
const aliases = { index: defaultRoute };

function resolveRoute(hash) {
    const name = hash.replace(/^#/, "").trim().toLowerCase();
    const resolved = aliases[name] || name;
    const exists = routes.some((route) => route.id === resolved);
    return exists ? resolved : defaultRoute;
}

function syncRouteFromHash() {
    state.set("route", resolveRoute(window.location.hash));
}

export function navigate(routeId) {
    // Setting the hash fires "hashchange", which updates state.
    window.location.hash = routeId;
}

export function startRouter() {
    window.addEventListener("hashchange", syncRouteFromHash);
    syncRouteFromHash();
}

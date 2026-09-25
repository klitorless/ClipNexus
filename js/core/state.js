// ==========================================================
// state.js
// Responsibility: hold application state and notify
// subscribers when it changes. No framework, no DOM access.
//
// Store whole objects with set(); do not mutate values in place.
// The transcript is a frozen TranscriptDocument (see
// js/transcript/model.js); new derived layers produce a new
// document object that replaces the old one via set().
// ==========================================================

const initialState = {
    route: "dashboard",

    project: {},        // Reserved: project metadata (later stage)
    transcript: null,   // Canonical TranscriptDocument or null
    analysis: {},       // Reserved: AI evidence analysis (later stage)
    pois: [],           // Reserved: POIs (later stage)
    events: [],         // Reserved: event arcs (later stage)
    clips: [],          // Reserved: clip candidates for human review (later stage)
    ui: {}              // Reserved: view preferences
};

function createState(startingValues) {
    const values = { ...startingValues };
    const listeners = new Set();

    function get(key) {
        return values[key];
    }

    // Update one key and notify all listeners with (key, value).
    function set(key, value) {
        values[key] = value;
        listeners.forEach((listener) => listener(key, value));
    }

    // Register a listener. Returns an unsubscribe function.
    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    return { get, set, subscribe };
}

export const state = createState(initialState);

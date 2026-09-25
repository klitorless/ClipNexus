// ==========================================================
// state.js
// Responsibility: hold application state and notify
// subscribers when it changes. No framework, no DOM access.
//
// Store whole objects with set(); do not mutate values in place.
// The project is a frozen Project (see js/core/project.js). It
// owns the video, the frozen TranscriptDocument, and the reserved
// analysis/POI/event/clip containers. Changes produce a NEW
// project object that replaces the old one via set("project").
// ==========================================================

const initialState = {
    route: "dashboard",
    project: null,      // Project or null (no project yet)
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

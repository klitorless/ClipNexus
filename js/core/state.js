// ==========================================================
// state.js
// Responsibility: hold application state and notify
// subscribers when it changes. No framework, no DOM access.
// ==========================================================

const initialState = {
    transcript: null,
    route: "dashboard"
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

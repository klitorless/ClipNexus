// ==========================================================
// guide.js
// Responsibility: render the "How to Use" guide — a
// step-by-step walkthrough of what ClipNexus currently does.
// Documents implemented behavior only: every step below
// maps to a real control in the app. Things not built yet
// are labeled as such, not described as features.
// ==========================================================

import { createElement, createInfoCard } from "./dom.js";

function step(number, title, paragraphs, bullets = null) {
    const card = createElement("article", "card");
    card.append(createElement("span", "tag", `Step ${number}`));
    card.append(createElement("h2", "card-title", title));
    for (const text of paragraphs) {
        card.append(createElement("p", "card-body", text));
    }
    if (bullets) {
        const list = createElement("ul", "help-list");
        for (const text of bullets) {
            list.append(createElement("li", "", text));
        }
        card.append(list);
    }
    return card;
}

export function renderGuideView(mountElement) {
    const sections = [
        step(1, "Load a video", [
            "On the Dashboard, paste a YouTube video URL into the video field and press Load Video. " +
            "ClipNexus creates a project, shows a VOD preview player, and immediately tries to fetch " +
            "the video's existing YouTube captions — no API key needed."
        ], [
            "If captions come back, the video's real title and duration are applied automatically.",
            "If they don't, you'll see an honest message explaining why — often YouTube throttling " +
            "the caption service, which is temporary. A Supadata API key bypasses that limit.",
            "The preview player lets you watch the video right on the Dashboard."
        ]),

        step(2, "Get a transcript", [
            "Open the Transcripts page and use the “Get transcript from a provider” card. " +
            "Pick a provider, optionally set a language and a caption method preference " +
            "(native, generated, or any), then press Get Transcript."
        ], [
            "YouTube native captions runs first and needs no key; Supadata is the automatic " +
            "fallback and needs your API key (free tier: 100 credits/month).",
            "While a caption request is queued you'll see live queue status: how many " +
            "requests are ahead of yours and the time until your request. Requests are " +
            "limited to 1 per user every 10 minutes so the shared service stays " +
            "within YouTube's limits.",
            "No captions on the video? Upload a transcript file instead — TXT, SRT, or VTT — " +
            "with the Upload Transcript button in the top bar.",
            "The loaded transcript can be downloaded as deterministic JSON from the Export card."
        ]),

        step(3, "Run analysis", [
            "Open the Analysis page and tell ClipNexus what to look for with the “What are you " +
            "looking for?” builder. Each section can be toggled on or off:"
        ], [
            "Questions, Hype, and Reactions use fixed vocabularies with a Low/Normal/High sensitivity.",
            "Keywords: your own comma-separated terms. Custom Phrases: your own exact phrases.",
            "Emphasis: detects emphasized speech, also with sensitivity control.",
            "Press Run Analysis. Every finding becomes an Evidence card that links back to the " +
            "exact transcript segment it came from — detectors find evidence, they don't decide clips."
        ]),

        step(4, "Seek through evidence", [
            "Evidence cards show a timestamp button (e.g. ▶ 01:23) whenever the finding traces " +
            "to a real transcript timestamp. Pressing it seeks the embedded player to that moment, " +
            "so you can watch the candidate in context. If no video is loaded, the button isn't shown."
        ]),

        step(5, "Review clip candidates", [
            "The Clip Queue pairs the embedded player with reviewable clip candidates. " +
            "Watch each candidate, seek through it, then Keep or Reject it. " +
            "Your decisions are the review — the app never auto-selects clips."
        ]),

        step(6, "Know what's not built yet", [
            "The POIs and Event Arcs pages currently show where they sit in the evidence chain " +
            "with live counts, but their extraction UIs are not built yet. " +
            "Settings is a placeholder. Automatic moment detection, AI editing, and publishing " +
            "are planned, not present."
        ], [
            "Projects, transcripts, and API keys live for this page session only — " +
            "reloading the page forgets them. Export anything you want to keep."
        ])
    ];

    mountElement.replaceChildren(
        createInfoCard(
            "How to use ClipNexus",
            "From loading a video to reviewing clip candidates — what each page does today.",
            "Guide",
            "tag"
        ),
        ...sections
    );
}

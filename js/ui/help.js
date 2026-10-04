// ==========================================================
// help.js
// Responsibility: render the Help & API Information view —
// product overview, API-key guidance, caption queue
// documentation and limitations, terms/licensing and contact
// placeholders. Pure DOM building; no network, no secrets.
//
// OWNER-PROVIDED INFORMATION still needed before public
// beta: support contact address (SUPPORT_CONTACT below),
// finalized Terms of Use text.
// ==========================================================

import { createElement, createInfoCard } from "./dom.js";

// TODO(owner): set the public support contact before the
// public beta. Rendered in the footer and the Contact
// section; null renders an honest "not yet configured" note.
export const SUPPORT_CONTACT = null;

function section(title, paragraphs) {
    const card = createElement("article", "card");
    card.append(createElement("h2", "card-title", title));
    for (const text of paragraphs) {
        card.append(createElement("p", "card-body", text));
    }
    return card;
}

function bulletSection(title, intro, bullets) {
    const card = createElement("article", "card");
    card.append(createElement("h2", "card-title", title));
    if (intro) card.append(createElement("p", "card-body", intro));
    const list = createElement("ul", "help-list");
    for (const text of bullets) {
        list.append(createElement("li", "", text));
    }
    card.append(list);
    return card;
}

export function renderHelpView(mountElement) {
    const sections = [];

    sections.push(section("What ClipNexus does", [
        "ClipNexus is a VOD analysis and clip-candidate discovery tool. " +
        "Link a video, acquire its transcript, and run deterministic detectors " +
        "that surface candidate moments — questions, hype, reactions, keywords, " +
        "emphasis, and your own custom phrases — as traceable evidence you can " +
        "seek through in the embedded player.",
        "Detectors find evidence; they do not decide what becomes a clip. " +
        "Every finding links back to the exact transcript segment it came from."
    ]));

    const apiCard = createElement("article", "card");
    apiCard.dataset.section = "api-keys";
    apiCard.append(createElement("h2", "card-title", "API keys"));
    apiCard.append(createElement("p", "card-body",
        "ClipNexus works without any API key. The keyless caption service fetches " +
        "a video's existing YouTube captions, and everything else runs locally in " +
        "your browser. API keys exist mainly for transcripts: a Supadata key is a hosted " +
        "transcript service — fetching transcripts is its whole purpose — and it bypasses " +
        "YouTube's adaptive caption throttling. Whenever a transcript fetch succeeds, " +
        "ClipNexus uses all the information the provider returns (video title, duration) " +
        "to fill in the video fields; for Supadata that means one extra metadata request " +
        "(1 credit) alongside the transcript."));
    const whyList = createElement("ul", "help-list");
    for (const text of [
        "YouTube Data API key: for the video's name only, and only if nothing else has " +
        "already provided it. The caption services supply the title when they can; the " +
        "Data API key is a fallback for when they cannot. Without a key, the app keeps " +
        "using the video ID and everything else works the same.",
        "Where to get one: in the Google Cloud Console, create or select a project, " +
        "enable the YouTube Data API v3, then create an API key under Credentials. " +
        "Google controls issuance, pricing, and quotas — not ClipNexus.",
        "How to enter it: on the Transcripts page, find \u201cYouTube Data API key " +
        "(optional)\u201d, paste the key, and press Use Key. Use Forget Key to clear it."
    ]) {
        whyList.append(createElement("li", "", text));
    }
    apiCard.append(whyList);
    sections.push(apiCard);

    sections.push(bulletSection("Quotas and limits", null, [
        "Your API provider controls your account's allowances, quotas, and rate limits. " +
        "Free allowances can change at any time — check your provider's console for " +
        "current numbers. ClipNexus does not guarantee unlimited or permanently free " +
        "third-party API usage.",
        "If a provider quota is exhausted, the affected feature degrades gracefully: " +
        "for example, video titles stop resolving while transcripts, analysis, and " +
        "playback keep working. The app reports the provider's error instead of " +
        "inventing data.",
        "ClipNexus's own caption request queue is separate from provider limits. " +
        "The queue smooths bursts against ClipNexus's caption service; YouTube's " +
        "own rate limits apply at the provider independently and can still reject " +
        "requests even when the queue is empty."
    ]));

    sections.push(bulletSection("YouTube rate limits & cooldowns",
        "The keyless caption service asks YouTube for a video's captions " +
        "directly. YouTube throttles automated requests to those endpoints — " +
        "that throttle is the most common reason automatic captions fail. " +
        "To stay within it, caption requests are limited to 1 per user " +
        "every 10 minutes, and excess requests wait in a fair queue instead " +
        "of being rejected.", [
        "The limit is set by YouTube: it is adaptive, varies over time, and " +
        "YouTube publishes no fixed cooldown number. ClipNexus does not " +
        "invent one — any wait time shown is an estimate, never a promise.",
        "While queued you see your position (“About N requests ahead of yours”) " +
        "and the time until your request (“Time til your request”) — the later " +
        "of the queue wait and your 10-minute slot.",
        "When throttled, the caption queue backs off automatically " +
        "(increasing delays between retries) and spaces its requests to " +
        "YouTube politely. Waiting a while before retrying usually helps.",
        "A Supadata API key bypasses this limit entirely, because Supadata " +
        "fetches transcripts through its own service rather than YouTube's " +
        "caption endpoints. Its free tier includes 100 credits per month " +
        "(a native transcript costs 1 credit, no card required) — pricing " +
        "can change, so check supadata.ai/pricing for current numbers. " +
        "Enter your key on the Transcripts page; it stays in memory for " +
        "this page session only."
    ]));

    sections.push(bulletSection("API-key security", null, [
        "Your key lives in memory for this page session only. Reloading the page " +
        "forgets it. It is never written to local storage, never rendered back " +
        "into the page, and never sent anywhere except the provider's own API.",
        "Never share your private API key with other people. Anyone holding it " +
        "can consume your provider quota.",
        "In your provider's console, restrict the key (for example to the " +
        "YouTube Data API v3, and to HTTP referrers you control) and rotate it " +
        "if you suspect it leaked."
    ]));

    sections.push(bulletSection("Caption queue and its limitations",
        "Caption requests go through an asynchronous queue on the ClipNexus caption " +
        "service, so bursts of requests are processed in order instead of all at once. " +
        "The Transcripts page shows live queue status while a request is active.", [
        "Transcript acquisition may be delayed when the service is busy. Wait " +
        "times shown are estimates, never guarantees.",
        "Third-party APIs impose their own quotas and rate limits on top of the queue.",
        "YouTube caption availability varies by video: some videos have no " +
        "captions at all.",
        "A queue does not guarantee that a transcript exists for your video.",
        "A request can fail even after reaching the front of the queue — for " +
        "example when YouTube rate-limits the service or the captions disappear.",
        "If a request fails, try again later or use another provider. A failed " +
        "request never changes your current transcript."
    ]));

    sections.push(section("Terms and licensing", [
        "The ClipNexus software is proprietary. See the LICENSE file included " +
        "with the distribution for the full terms.",
        "Public terms of use for the hosted service are not yet finalized and " +
        "will be published here before the public beta."
    ]));

    const contactCard = createElement("article", "card");
    contactCard.append(createElement("h2", "card-title", "Contact"));
    contactCard.append(createElement("p", "card-body", SUPPORT_CONTACT
        ? `Support: ${SUPPORT_CONTACT}`
        : "Support contact information will be published here before the public beta."));
    sections.push(contactCard);

    mountElement.replaceChildren(
        createInfoCard(
            "Help & API information",
            "How ClipNexus works, how API keys and the caption queue behave, and where to find the terms.",
            "Help",
            "tag"
        ),
        ...sections
    );
}

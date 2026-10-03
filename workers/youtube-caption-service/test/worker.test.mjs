// Deterministic tests for the youtube-caption-service Worker.
// All YouTube traffic is mocked — no live network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    createRequestHandler,
    selectTrack,
    timedTextXmlToVtt,
    decodeEntities,
    formatTimestamp
} from "../src/index.js";

const VID = "dQw4w9WgXcQ";
const BASE = "https://clipnexus-youtube-caption-test.klitorless.workers.dev";
const EN_MANUAL = {
    baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&caps=asr&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=999&sparams=ip,ipbits,expire,v,caps,xoaf,hl&signature=AAA&key=yt8",
    languageCode: "en",
    name: { simpleText: "English" }
};
const EN_ASR = {
    baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&caps=asr&xoaf=5&hl=en&kind=asr&ip=0.0.0.0&ipbits=0&expire=999&sparams=ip,ipbits,expire,v,caps,xoaf,hl&signature=BBB&key=yt8",
    languageCode: "en",
    name: { simpleText: "English (auto-generated)" },
    kind: "asr"
};
const KO_ASR = {
    baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&caps=asr&xoaf=5&hl=ko&kind=asr&ip=0.0.0.0&ipbits=0&expire=999&sparams=ip,ipbits,expire,v,caps,xoaf,hl&signature=CCC&key=yt8",
    languageCode: "ko",
    name: { simpleText: "Korean (auto-generated)" },
    kind: "asr"
};

const SAMPLE_XML =
    `<timedtext format="3"><body><p t="1360" d="1680"><s>Never gonna </s><s>give you up</s></p>` +
    `<p t="3040" d="2000">Fish &amp; Chips &lt;3 &quot;quoted&quot; &#65;&#x42;</p></body></timedtext>`;
const SAMPLE_VTT = "WEBVTT\n\n00:00:01.360 --> 00:00:03.040\nNever gonna give you up\n";

// Build a mock fetch. routes: { innertube: <tracks|null|"429"|"timeout">,
// watchPage: <tracks|null>, trackBody: <string>, trackStatus: <number> }.
// Captures every requested URL in calls[].
function mockFetch(routes) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push(String(url));
        const u = String(url);
        if (u.includes("youtubei/v1/player")) {
            if (routes.innertube === "429") return new Response("{}", { status: 429 });
            if (routes.innertube === "timeout") {
                const err = new Error("aborted");
                err.name = "AbortError";
                throw err;
            }
            const tracks = routes.innertube ?? null;
            return Response.json({
                captions: tracks
                    ? { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
                    : {}
            });
        }
        if (u.startsWith("https://www.youtube.com/watch")) {
            const tracks = routes.watchPage ?? null;
            const html = tracks
                ? `<html><script>var x = {"captionTracks":${JSON.stringify(tracks)}};</script></html>`
                : "<html><body>no captions here</body></html>";
            return new Response(html, { headers: { "Content-Type": "text/html" } });
        }
        // Caption track fetch.
        return new Response(routes.trackBody ?? "", { status: routes.trackStatus ?? 200 });
    };
    return { fetchImpl, calls };
}

const handlerFor = (routes, opts = {}) =>
    createRequestHandler({ fetchImpl: mockFetch(routes).fetchImpl, timeoutMs: opts.timeoutMs ?? 5000 });

const get = (handler, path) => handler(new Request(`${BASE}${path}`));
const options = (handler, path) =>
    handler(new Request(`${BASE}${path}`, { method: "OPTIONS" }));

async function errorBody(res) {
    const json = await res.json();
    return json.error.type;
}

// --- 1–4: routing, validation, and CORS on every error path ---

describe("routing and CORS", () => {
    it("1. OPTIONS returns CORS headers", async () => {
        const res = await options(handlerFor({}), "/youtube-transcript?v=" + VID);
        assert.equal(res.status, 204);
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
        assert.match(res.headers.get("Access-Control-Allow-Methods") || "", /GET/);
    });

    it("2. invalid video ID returns 400 + CORS", async () => {
        const res = await get(handlerFor({}), "/youtube-transcript?v=too-short");
        assert.equal(res.status, 400);
        assert.equal(await errorBody(res), "invalid-video-id");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("3. missing v returns 400 + CORS", async () => {
        const res = await get(handlerFor({}), "/youtube-transcript");
        assert.equal(res.status, 400);
        assert.equal(await errorBody(res), "invalid-video-id");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("4. unknown route returns 404 + CORS", async () => {
        const res = await get(handlerFor({}), "/nope");
        assert.equal(res.status, 404);
        assert.equal(await errorBody(res), "not-found");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("unsupported method returns 405 + CORS", async () => {
        const handler = handlerFor({});
        const res = await handler(new Request(`${BASE}/youtube-transcript?v=${VID}`, { method: "POST" }));
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("invalid lang returns 400 + CORS", async () => {
        const res = await get(handlerFor({}), `/youtube-transcript?v=${VID}&lang=!!!`);
        assert.equal(res.status, 400);
        assert.equal(await errorBody(res), "invalid-language");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });
});

// --- 5–8: track selection and verbatim baseUrl ---

describe("track selection", () => {
    it("5. manual caption track is preferred", () => {
        const track = selectTrack([EN_ASR, EN_MANUAL]);
        assert.equal(track, EN_MANUAL);
    });

    it("6. generated caption is selected when no manual track exists", () => {
        const track = selectTrack([EN_ASR]);
        assert.equal(track, EN_ASR);
    });

    it("7. English selection works when multiple tracks exist", () => {
        const de = { ...EN_MANUAL, languageCode: "de" };
        const deAsr = { ...EN_ASR, languageCode: "de" };
        // manual wins over generated regardless of language…
        assert.equal(selectTrack([de, EN_ASR]), de);
        // …but English is preferred among equivalent tracks.
        assert.equal(selectTrack([de, EN_MANUAL]), EN_MANUAL);
        assert.equal(selectTrack([deAsr, EN_ASR]), EN_ASR);
    });

    it("lang parameter prefers a matching track", () => {
        const track = selectTrack([EN_MANUAL, KO_ASR], "ko");
        assert.equal(track, KO_ASR);
        // manual still wins among matches
        assert.equal(selectTrack([EN_ASR, { ...KO_ASR, kind: undefined }], "ko").languageCode, "ko");
        // no match → null (caller reports track-unavailable)
        assert.equal(selectTrack([EN_MANUAL], "fr"), null);
    });

    it("8. exact YouTube baseUrl is fetched without reconstruction", async () => {
        const { fetchImpl, calls } = mockFetch({ innertube: [EN_MANUAL], trackBody: SAMPLE_VTT });
        const handler = createRequestHandler({ fetchImpl });
        const res = await get(handler, `/youtube-transcript?v=${VID}`);
        assert.equal(res.status, 200);
        const trackCall = calls.find((u) => u.includes("/api/timedtext"));
        assert.ok(trackCall, "expected the track URL to be fetched");
        assert.ok(
            trackCall.startsWith(EN_MANUAL.baseUrl),
            `baseUrl must be used verbatim, got: ${trackCall}`
        );
        assert.ok(trackCall.endsWith("&fmt=vtt"), "fmt=vtt must be appended raw");
    });

    it("17. arbitrary upstream URLs cannot be supplied by the caller", async () => {
        const evil = {
            baseUrl: "https://evil.example.com/steal?x=1",
            languageCode: "en"
        };
        const { fetchImpl, calls } = mockFetch({ innertube: [evil], trackBody: SAMPLE_VTT });
        const handler = createRequestHandler({ fetchImpl });
        // Extra query params are ignored: only v (+lang) shape the request.
        const res = await get(handler, `/youtube-transcript?v=${VID}&url=https://evil.example.com/`);
        assert.equal(res.status, 502);
        assert.equal(await errorBody(res), "malformed-response");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
        assert.ok(!calls.some((u) => u.includes("evil.example.com")), "must never fetch the evil host");
    });
});

// --- 9–13: caption body handling and provenance headers ---

describe("caption body and headers", () => {
    it("9. WebVTT passes through", async () => {
        const res = await get(
            handlerFor({ innertube: [EN_MANUAL], trackBody: SAMPLE_VTT }),
            `/youtube-transcript?v=${VID}`
        );
        assert.equal(res.status, 200);
        assert.match(res.headers.get("Content-Type") || "", /text\/vtt/);
        const body = await res.text();
        assert.ok(body.startsWith("WEBVTT"));
        assert.ok(body.includes("-->"));
        assert.equal(body, SAMPLE_VTT);
        assert.equal(res.headers.get("X-Caption-Format"), "vtt");
    });

    it("10. XML/SRV3 converts to valid WebVTT", async () => {
        const res = await get(
            handlerFor({ innertube: [EN_ASR], trackBody: SAMPLE_XML }),
            `/youtube-transcript?v=${VID}`
        );
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.ok(body.startsWith("WEBVTT\n"));
        assert.ok(body.includes("-->"));
        assert.ok(body.includes("00:00:01.360 --> 00:00:03.040"));
        assert.ok(body.includes("Never gonna give you up"));
        assert.equal(res.headers.get("X-Caption-Format"), "xml");
    });

    it("11. XML entities decode correctly", () => {
        const vtt = timedTextXmlToVtt(`<timedtext><body><p t="0" d="1000">A &amp; B &lt;C&gt; &quot;Q&quot; &#65;&#x42;</p></body></timedtext>`);
        assert.ok(vtt.includes('A & B <C> "Q" AB'), vtt);
        assert.equal(decodeEntities("&apos;"), "'");
    });

    it("12. caption metadata headers are emitted", async () => {
        const res = await get(
            handlerFor({ innertube: [EN_ASR], trackBody: SAMPLE_VTT }),
            `/youtube-transcript?v=${VID}`
        );
        assert.equal(res.headers.get("X-Caption-Language"), "en");
        assert.equal(res.headers.get("X-Caption-Generated"), "true");
        assert.equal(res.headers.get("X-Caption-Source"), "innertube");
    });

    it("manual tracks report X-Caption-Generated: false", async () => {
        const res = await get(
            handlerFor({ innertube: [EN_MANUAL, EN_ASR], trackBody: SAMPLE_VTT }),
            `/youtube-transcript?v=${VID}`
        );
        assert.equal(res.headers.get("X-Caption-Generated"), "false");
        assert.equal(res.headers.get("X-Caption-Language"), "en");
    });

    it("13. Access-Control-Expose-Headers is emitted on success", async () => {
        const res = await get(
            handlerFor({ innertube: [EN_MANUAL], trackBody: SAMPLE_VTT }),
            `/youtube-transcript?v=${VID}`
        );
        const exposed = res.headers.get("Access-Control-Expose-Headers") || "";
        for (const h of ["X-Caption-Language", "X-Caption-Generated", "X-Caption-Source", "X-Caption-Format"]) {
            assert.ok(exposed.includes(h), `exposed headers must include ${h}`);
        }
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });
});

// --- 14–16: upstream failure mapping ---

describe("error mapping", () => {
    it("14. upstream 429 becomes rate-limited", async () => {
        const res = await get(handlerFor({ innertube: "429" }), `/youtube-transcript?v=${VID}`);
        assert.equal(res.status, 429);
        assert.equal(await errorBody(res), "rate-limited");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("15. missing captions becomes transcript-unavailable", async () => {
        const res = await get(handlerFor({ innertube: null, watchPage: null }), `/youtube-transcript?v=${VID}`);
        assert.equal(res.status, 404);
        assert.equal(await errorBody(res), "transcript-unavailable");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("16. malformed caption data becomes malformed-response", async () => {
        const res = await get(
            handlerFor({ innertube: [EN_MANUAL], trackBody: "this is not vtt or xml {{{" }),
            `/youtube-transcript?v=${VID}`
        );
        assert.equal(res.status, 502);
        assert.equal(await errorBody(res), "malformed-response");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("upstream timeout becomes timeout", async () => {
        const res = await get(handlerFor({ innertube: "timeout" }), `/youtube-transcript?v=${VID}`);
        assert.equal(res.status, 504);
        assert.equal(await errorBody(res), "timeout");
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("watch-page fallback is used when InnerTube yields nothing", async () => {
        const res = await get(
            handlerFor({ innertube: null, watchPage: [EN_ASR], trackBody: SAMPLE_VTT }),
            `/youtube-transcript?v=${VID}`
        );
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("X-Caption-Source"), "watch-page");
        assert.equal(res.headers.get("X-Caption-Generated"), "true");
    });
});

// --- conversion unit checks ---

describe("timedTextXmlToVtt", () => {
    it("preserves order, timestamps, and unicode", () => {
        const vtt = timedTextXmlToVtt(
            `<timedtext><body>` +
            `<p t="5000" d="1000">second — café ☕</p>` +
            `<p t="1000" d="1000">first</p>` +
            `</body></timedtext>`
        );
        const first = vtt.indexOf("first");
        const second = vtt.indexOf("second");
        assert.ok(first !== -1 && second !== -1 && first < second, "cue order preserved");
        assert.ok(vtt.includes("00:00:01.000 --> 00:00:02.000"), vtt);
        assert.ok(vtt.includes("café ☕"), "unicode preserved");
    });

    it("supports the legacy <text> form", () => {
        const vtt = timedTextXmlToVtt(
            `<transcript><text start="1.36" dur="1.68">hello</text></transcript>`
        );
        assert.ok(vtt.startsWith("WEBVTT"));
        assert.ok(vtt.includes("00:00:01.360 --> 00:00:03.040"));
    });

    it("returns null when no cues parse", () => {
        assert.equal(timedTextXmlToVtt("<html>nope</html>"), null);
        assert.equal(timedTextXmlToVtt(""), null);
    });

    it("formats timestamps without inventing zeros", () => {
        assert.equal(formatTimestamp(0), "00:00:00.000");
        assert.equal(formatTimestamp(3723456), "01:02:03.456");
    });
});

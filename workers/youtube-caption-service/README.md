# clipnexus-youtube-caption-service

A self-contained, deployable Cloudflare Worker that serves YouTube captions
to ClipNexus as WebVTT — no YouTube API key, no Supadata, no video download,
no transcript storage.

## Endpoint

```
GET /youtube-transcript?v=VIDEO_ID[&lang=BCP47]
```

- `v` — required, exactly 11 characters matching `[A-Za-z0-9_-]{11}`.
- `lang` — optional BCP 47 language code (e.g. `en`, `ko`); prefers a
  matching caption track. Omit it for the deterministic default
  (manual captions first, English preferred).

Success: `200`, `Content-Type: text/vtt; charset=utf-8`, body starting
with `WEBVTT`, plus provenance headers:

- `X-Caption-Language` — the actual language code selected
- `X-Caption-Generated` — `true` for auto-generated, `false` for manual
- `X-Caption-Source` — `innertube` or `watch-page`
- `X-Caption-Format` — `vtt` (passed through) or `xml` (converted)
- `X-Video-Title` — the video's title, percent-encoded UTF-8 (omitted
  when unknown); taken from the player response's `videoDetails`
- `X-Video-Duration` — the video's length in whole seconds, plain
  digits (omitted when unknown); from `videoDetails.lengthSeconds`

Errors are JSON shaped like `{"error": {"type": "...", "message": "..."}}`
with types the ClipNexus client already understands:
`invalid-video-id` (400), `invalid-language` (400), `not-found` (404),
`transcript-unavailable` (404), `track-unavailable` (404),
`rate-limited` (429), `retrieval-failure` (502), `malformed-response`
(502), `timeout` (504). Unknown routes return 404; non-GET/OPTIONS
methods return 405.

## CORS

Every response — 200s, JSON errors, 404s, 405s — carries
`Access-Control-Allow-Origin: *`. Successful caption responses also
carry `Access-Control-Expose-Headers` listing the four `X-Caption-*`
headers. `OPTIONS` returns 204 with the preflight headers.

## How captions are retrieved

1. POST `https://www.youtube.com/youtubei/v1/player` (InnerTube, using
   YouTube's own public client key embedded in youtube.com's JavaScript)
   and read `captions.playerCaptionsTracklistRenderer.captionTracks`.
2. If that yields nothing, GET the canonical watch page and extract
   `"captionTracks"` from the embedded player response.
3. Select a track deterministically: manual/native first, auto-generated
   accepted; `lang` match wins when supplied; otherwise English
   preferred, else the first usable track.
4. Fetch the track's `baseUrl` **verbatim** (raw `&fmt=vtt` appended —
   never reconstructed, so YouTube's signature stays valid), allowing
   only YouTube timed-text hosts.
5. If YouTube returns WebVTT, pass it through unchanged; otherwise
   convert timed-text XML (srv3 or legacy transcript) to WebVTT —
   cue order, timestamps, text, and Unicode preserved; entities
   decoded; XML markup stripped; no summarization or rewriting.

## Deploy

```sh
cd workers/youtube-caption-service
npx wrangler login
npx wrangler deploy
```

The `wrangler.toml` name (`clipnexus-youtube-caption-test`) replaces the
existing Worker at the URL the ClipNexus client already uses, so no
client change is needed.

## Test

```sh
node --test test/
```

Deterministic tests mock all YouTube traffic — no live network.

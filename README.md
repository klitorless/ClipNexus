# VOD Analyzer

## Project

VOD Analyzer is a modular web application for analyzing long-form VOD transcripts. It will extract evidence-supported Points of Interest (POIs), identify event arcs, preserve context and source limitations, and help a human operator build short-form clip candidates.

The AI layer will **discover, describe, preserve, and trace** evidence. It will **not** guess, rank, or decide which clips the human should select. Final selection always happens in human review.

## Stages

| Stage | Scope | Status |
|---|---|---|
| Stage 1 | Frontend application shell | **Complete** |
| Stage 1.5 | Transcript architecture foundation | **Complete** |
| Stage 1.6 | Project + video foundation (URL → video identity) | **Complete** |
| Stage 1.7 | Hardening + architecture freeze (start hint, safe replace, alignment state) | **Complete** |
| Stage 2 | Transcript parsing, normalization, validation, and chunking | Not yet implemented |

Nothing after Stage 1.7 exists yet. Stage 1.7 is the architecture freeze before transcript acquisition begins (see [Frozen contracts](#frozen-contracts-after-stage-17)).
- **No format is actually parsed.** Uploaded files are loaded, stored, and shown as raw text, but every transcript currently has 0 segments, and validation runs no checks.
- **Pasting a video URL only identifies the video.** It does **not** fetch the title, thumbnail, or duration, retrieve or generate transcripts, or embed or play the video. Nothing is sent over the network.

## Current capabilities

- Modular frontend (HTML, CSS, vanilla JavaScript ES modules, no build step)
- Client-side hash navigation (`#dashboard`, `#transcripts`, `#pois`, `#events`, `#clips`, `#analysis`, `#settings`)
- Video URL input: YouTube links are resolved locally to a video identity (platform, video ID, canonical URL)
- YouTube `?t=` / `#t=` / embed `start=` kept as a separate, unverified start-position hint
- Inline confirmation before a different video replaces a project that holds a transcript
- Transcripts page shows the linked video (platform, ID, title status, source, start hint, alignment)
- A frozen `Project` in state that links the video and the transcript
- Transcript file selection for all supported formats
- Canonical, frozen `TranscriptDocument` stored inside the project
- Raw transcript preview (first 30 lines, rendered as plain text)
- Processing-layer status (parse, segments, validation, issues, chunks)
- User-facing errors kept separate from console diagnostics
- Browser-console self-tests (`vodAnalyzer.runSelfTests()`)
- Responsive layout (sidebar on desktop, scrollable strip on mobile)

## Supported formats

Defined once in `js/transcript/formats.js`. The upload control's `accept` list, file-type checks, and parser dispatch all read from it.

| Id | Extension | Timestamps | End times | Speakers |
|---|---|---|---|---|
| `txt` | `.txt` | optional | no | optional |
| `srt` | `.srt` | required | yes | optional |
| `vtt` | `.vtt` | required | yes | optional (`<v>` tags) |
| `json` | `.json` | optional | optional | optional |

Stage 1.5 picks the format by file extension only. Content-based detection is Stage 2.

## Canonical transcript model

Defined in `js/transcript/model.js` (schema version 1).

```js
TranscriptDocument {
    schemaVersion: 1,
    id: "tx-…",

    source: {                 // SOURCE: file facts
        filename, format, size, lastModified,
        encoding: "utf-8", loadedAt
    },

    rawText: "…",             // SOURCE EVIDENCE: exact file contents, never modified

    parse: {                  // DERIVED: parser layer
        status: "pending" | "not_implemented" | "complete" | "failed",
        parser: "srt",
        notes: []
    },

    segments: [Segment],      // DERIVED: parsed/normalized layer

    validation: {             // DERIVED: observations, never corrections
        status: "unvalidated" | "not_implemented" | "passed" | "issues_found",
        validatedAt, checks: [], issues: [ValidationIssue]
    },

    chunks: [],               // DERIVED: analysis windows (reference segment ids)

    processing: { parsed, validated, chunked }
}

Segment {
    id: "seg-000123",         // deterministic: same file → same ids
    index: 123,
    source: {                 // PROVENANCE
        format: "srt",
        sequence: 123,        // order in the source file
        cueId: "124",         // source's own identifier, verbatim
        lines:   { start, end },   // 1-based lines in rawText
        offsets: { start, end }    // character range in rawText
    },
    start: { raw: "01:23:45,500", seconds: 5025.5, status: "parsed" },
    end:   { raw: null,           seconds: null,   status: "missing" },
    speaker: { raw: "STREAMER", value: "Streamer", source: "explicit" | "inferred" | "unknown" },
    text: "exactly as in source",
    derived: {}               // future normalizer output; never overwrites the above
}

ValidationIssue {
    id: "issue-000000",
    type: "timestamp_reset",  // see ISSUE_TYPES in validator.js
    severity: "info" | "warning" | "error",
    startSeconds, endSeconds,
    segmentIds: ["seg-000123", "seg-000124"],
    message: "…",
    evidence: "short verbatim excerpt",
    source: { format: "srt", sequence: 123 }
}
```

Timestamp `status` values: `parsed`, `missing`, `malformed`, `ambiguous`.

Planned issue types: `timestamp_gap`, `timestamp_large_gap`, `timestamp_overlap`, `timestamp_reset`, `timestamp_jump`, `timestamp_malformed`, `timestamp_missing`, `timestamp_duplicate`, `speaker_missing`, `order_suspicious`, `segment_duplicate`, `segment_empty`, `section_missing`, `quality_concern`.

## Project model (Stage 1.6)

Defined in `js/core/project.js`. The project is the one container that will eventually connect everything:

```
VIDEO → TRANSCRIPT → ANALYSIS → POIs → EVENTS → CLIPS
```

```js
Project {
  schemaVersion: 1,
  id: "project-<uuid>",
  createdAt, updatedAt,           // ISO strings
  video: Video | null,            // see below
  transcript: TranscriptDocument | null,   // stored by reference, unchanged
  alignment: {                    // see "Time alignment" below
    status: "unverified", method: null, evidence: [],
    offsetSeconds: null, verifiedAt: null
  },
  analysis: { status: "not_implemented" },   // reserved
  pois: [], events: [], clips: []            // reserved
}
```

- Projects are deep-frozen. Every change (`withTranscript`, `applyVideoIdentity`) returns a **new** project.
- Lifecycle: no project → project created → video identified → transcript attached. A transcript can be uploaded before or after a URL is entered.
- Entering the **same** video again (any URL form) never creates a new project or drops the transcript. If the URL has a new time value, only `video.startPosition` changes. A URL with no time value leaves the existing hint alone.
- Entering a **different** video starts a new project, because the old transcript belonged to the other video. If the current project has a transcript, an inline confirmation (**Cancel** / **Replace Project**) appears first. Cancel leaves the current project exactly as it was, as the same object. Transcripts are never merged or carried over to another video.
- The decision is pure. `applyVideoIdentity()` returns a plan `{project, outcome, requiresConfirmation}`, and `finalizeVideoChange(current, plan, {confirmed})` picks what to keep. The coordinator only shows the prompt and stores the result.

### Time alignment

`project.alignment` answers one question: do transcript timestamps correspond to positions on this video's timeline, and with what offset?

| Status | Meaning | Used now? |
|---|---|---|
| `unverified` | The relationship has **not** been established | Yes — the only status through Stage 1.7 |
| `assumed` | A documented basis exists (recorded in `method`) but nothing independently checked it | Future |
| `verified` | Defined evidence (in `evidence`) establishes the relationship; `verifiedAt` is set | Future |

- `method: null` and `evidence: []` stay empty until a later stage defines what methods and evidence records are.
- Having timestamps, a plausible duration, or a URL `?t=` is **not** evidence of alignment: data existing is not the same as data proving alignment.
- `offsetSeconds: null` means unknown, not zero.

### Transcript ↔ video relationship

The transcript and its segments contain **no** video data. The project holds the link. A future POI will trace back through:

```
project.id → project.video.identity → project.transcript.id
→ segment ids → segment.start / segment.end (raw + seconds)
→ alignment → player.seekTo(seconds)
```

Stage 1.5 timestamps (`{ raw, seconds, status }`) are the only timestamp representation, and no second "video time" format was added.

## Video model (Stage 1.6)

Defined in `js/video/video-model.js`. **Identity** and **metadata** are kept strictly apart:

```js
Video {
  schemaVersion: 1,
  identity: {                     // WHICH video, known locally from the URL
    platform: "youtube",
    videoId: "dQw4w9WgXcQ",
    canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    url: "https://youtu.be/dQw4w9WgXcQ?t=5"   // exactly as entered (source evidence)
  },
  metadata: {                     // WHAT the video is like, filled in only by a future provider
    title: null, thumbnailUrl: null, durationSeconds: null,
    status: "unknown",            // unknown | loading | loaded | unavailable | failed
    provider: null, retrievedAt: null
  },
  startPosition: {                // optional HINT from the URL, or null. NOT identity.
    raw: "1m20s",                 // exact text from the URL (source)
    seconds: 80,                  // derived; null unless status is "parsed"
    status: "parsed",             // parsed | malformed | ambiguous  (Stage 1.5 timestamp statuses)
    source: "url",
    sourceUrl: "https://youtu.be/dQw4w9WgXcQ?t=1m20s",   // exact URL the hint came from
    verified: false               // never checked against the video
  }
}
```

`startPosition` reuses the Stage 1.5 timestamp shape `{raw, seconds, status}` (`createTimestamp`), so there is no second timestamp system. `identity.url` stays the URL that first identified the video. When the same video is re-entered with a new time, only `startPosition` (and its `sourceUrl`) changes.

`null` means "not acquired", not "empty". "Not loaded" in the UI is display text only and is never stored.

## URL resolver (Stage 1.6)

`js/video/video-resolver.js` exports `resolveVideoUrl(input)`. It is pure: no network, no DOM, and it never throws on bad input.

```js
{ success: true,  video: { platform, videoId, canonicalUrl, url }, startPosition: {...} | null }
{ success: false, error: { code, message, detail } }
```

Steps: trim → length/whitespace check → `new URL()` (`https://` assumed if no scheme is given) → only `http:`/`https:` allowed → no embedded credentials → platform adapter by hostname → video ID extraction and validation → canonical URL.

Error codes: `empty_url`, `url_too_long`, `malformed_url`, `unsupported_protocol`, `unsupported_platform`, `missing_video_id`, `invalid_video_id`.

### Supported platform: YouTube

`js/video/platforms/youtube.js` handles `youtube.com`, `www.`, `m.`, and `music.youtube.com` (`/watch?v=`, `/embed/`, `/shorts/`, `/live/`, `/v/`), `youtu.be/ID`, and `youtube-nocookie.com/embed/`. The ID must be 11 characters of `[A-Za-z0-9_-]`. Parameters that don't change identity (`si`, `list`, `feature`) are ignored.

Start-position hint: `t` (query or `#t=` fragment) and embed `start` accept `120`, `120s`, `1m20s`, and `1h2m3s` (units in h→m→s order). Anything else (`abc`, `1m20`, `1.5`, `-5`, empty, out-of-range) gives `status: "malformed"` with `seconds: null`. Conflicting values (`t=10&t=20`) give `status: "ambiguous"` with `seconds: null`. A bad time value never fails URL resolution and is never turned into a guessed position. The canonical URL never includes it. Channel, playlist, and search pages fail with `missing_video_id`. Look-alike hosts such as `youtube.com.evil.example` are rejected.

### Adding a platform later

Create `js/video/platforms/<name>.js` exporting `platformId`, `label`, `matchesHost(hostname)`, `extractVideoId(url)`, `buildCanonicalUrl(id)`, and optionally `extractStartPosition(url)`, then add it to `platformAdapters` in the resolver. The project model doesn't change. Twitch and other platforms are **not** implemented.

## Provenance philosophy

> Never silently replace source evidence with normalized or corrected data.

Every segment has to be traceable to the exact place in the file it came from: format, order, cue id, line range, and character offsets. The system keeps three things distinguishable:

1. **What the source contained**: `rawText`, `*.raw`, `text`, `source.*`
2. **What the analyzer derived**: `*.seconds`, `speaker.value`, `segment.derived`, `chunks`
3. **What the validator observed**: `validation.issues`, which point at segments by id

For example, if the source says `1:2:3`, the normalizer reads it as `3723` seconds and the validator flags the format as unusual. All three facts stay visible, so a future AI layer can see the uncertainty instead of inheriting a silent guess.

## Raw vs. derived data

```
RAW → PARSED → NORMALIZED → VALIDATED → CHUNKED → ANALYZED
```

- Each layer is derived from the previous one and added as a new property or a new document object (`withDerivedLayer()`).
- Documents are deep-frozen after each step, so validation, UI code, or console inspection can't mutate them. Assigning to a frozen field throws in module code.
- Memory rule: `rawText` is stored once. Segments reference it by offsets, chunks and issues reference segments by id, and shallow copies share strings by reference.

## Module responsibilities

```
vod-analyzer/
├── index.html                 App shell, mount points, load-check warning
├── README.md
├── css/
│   ├── base.css               Design tokens (CSS variables), reset, typography
│   ├── layout.css             Header / sidebar / main grid, responsive rules
│   └── components.css         Buttons, nav, cards, stats, raw preview
└── js/
    ├── app.js                 Coordinator: URL → resolver → project; file → parser → validator → project; state → render
    ├── core/
    │   ├── state.js           get / set / subscribe store (route, project, ui)
    │   ├── router.js          Hash routing + route list
    │   ├── errors.js          AppError: user message vs. developer diagnostics
    │   ├── ids.js             Random prefixed ids (project-…, tx-…)
    │   ├── project.js         Project model: video + transcript container, lifecycle
    │   ├── devtools.js        window.vodAnalyzer console helpers + self-tests
    │   └── devtools-project-tests.js   Stage 1.6 + 1.7 self-tests
    ├── video/
    │   ├── video-model.js     Video identity vs. metadata, metadata status
    │   ├── video-resolver.js  Platform-neutral URL → identity resolver
    │   └── platforms/
    │       └── youtube.js     YouTube URL rules (identity + start-position hint)
    ├── transcript/
    │   ├── formats.js         Single source of truth for supported formats
    │   ├── model.js           Canonical schema factories (document, segment, timestamp, speaker)
    │   ├── parser.js          Dispatcher: selects format module, builds frozen document
    │   ├── formats/
    │   │   ├── txt.js         Plain-text parser (placeholder + Stage 2 contract)
    │   │   ├── srt.js         SubRip parser (placeholder + Stage 2 contract)
    │   │   ├── vtt.js         WebVTT parser (placeholder + Stage 2 contract)
    │   │   └── json.js        JSON parser (placeholder + Stage 2 contract)
    │   ├── validator.js       Issue types, severity, issue factory, observational validator
    │   └── chunker.js         Chunk shape + defaults (600 s windows, 60 s overlap)
    └── ui/
        ├── dom.js             Safe DOM builders (textContent only)
        ├── sidebar.js         Section navigation
        ├── dashboard.js       Dashboard view + shared transcript summary card
        ├── project-panel.js   Video URL form (+ inline replace confirmation), Project card, Linked video card
        └── transcripts.js     Transcripts view (source details, layers, raw preview)
```

## Running

No install or build step. Open `index.html` through any local static server. On Android, use Acode: open the project folder, open `index.html`, and tap ▶ Run. Chrome blocks ES modules over `file://`, and when that happens a red "App files did not load" box appears.

## Testing

Open the browser console (Acode: enable "Show Console Toggler" in Preview settings) and run:

```js
vodAnalyzer.runSelfTests()      // 51 architectural checks, printed as a table
vodAnalyzer.inspectProject()    // the frozen Project (or null)
vodAnalyzer.inspectTranscript() // the frozen TranscriptDocument in the project
vodAnalyzer.resolveVideoUrl("https://youtu.be/dQw4w9WgXcQ")
vodAnalyzer.getState("route")
```

The self-tests don't change app state. The 23 Stage 1.5 checks cover:
- the format registry
- the upload `accept` list
- extension lookup and rejection
- exact raw-text preservation for every format (including CRLF, Unicode, and HTML-like content)
- document freezing
- that the validator doesn't mutate the document
- derived-layer copying
- segment provenance
- issue shape
- that the stored transcript can't be corrupted

The 13 Stage 1.6 checks cover:
- project creation and freezing
- all common YouTube URL forms
- equivalent URLs giving one identity
- identity stability
- keeping the URL exactly as entered
- 17 malformed or unsupported inputs failing with the expected code
- non-string input
- metadata staying `null`
- video lifecycle outcomes (created / attached / unchanged / replaced)
- a transcript belonging to the project with no video data copied into it
- attach order
- alignment defaulting to `unverified`

The 15 Stage 1.7 checks cover:
- `t` formats converted to seconds
- hint shape, freezing, and `verified: false`
- no `t` giving `null` (not 0)
- 9 malformed or ambiguous values never producing a position
- the hint staying out of identity and the canonical URL
- the original URL staying exact
- same video + new `t` updating only the hint
- same video without `t` staying unchanged
- replacing without a transcript (no confirmation)
- replacing with a transcript (confirmation required)
- Cancel keeping the same project
- Replace creating a clean project
- alignment staying unverified with no method or evidence in every path
- the Transcripts page showing the linked video (with a hostile URL, and no `a`/`iframe`/`img` elements)
- the dashboard status card

## Privacy and security

- Files are read locally with `File.text()` and kept in memory only.
- No analytics, tracking, third-party scripts, or network requests. Video URLs are resolved locally and never fetched.
- Video URL input is untrusted. It is parsed with `new URL()`, only `http(s)` is accepted, and it is displayed with `textContent`. No links, images, or iframes are created from it.
- Transcript content is untrusted. It is rendered with `textContent` only and never with `innerHTML`, `eval`, or script execution.

## Current limitations

- No format is parsed yet: `segments` is always empty and `parse.status` is `not_implemented`.
- Validation runs no checks (`valid: null`, status `not_implemented`).
- Chunking returns an empty array.
- Format detection is extension-only.
- `File.text()` always decodes as UTF-8 and drops a leading byte-order mark. Non-UTF-8 files (e.g. Windows-1252 SRTs) may show replacement characters.
- One project (one video, one transcript) at a time, held in memory; it's gone after a page reload.
- Video: identity only. Title, thumbnail, and duration are never fetched (`metadata.status` stays `unknown`).
- No transcript retrieval from URLs, no embedded player, no playback, no seeking.
- Only YouTube is recognized. YouTube ID validation is by shape (11 characters). The resolver cannot tell whether the video actually exists or is public.
- The start-position hint is stored and shown only. Nothing uses it for playback yet, and it's never checked against the video's length.
- Replace confirmation is inline and in-page. Navigating away while it's showing cancels it.
- The whole file is read into memory (no streaming or workers yet).

## Persistence boundary (documented, not implemented)

**Current behaviour:** the project exists only in memory. Reloading or closing the page discards the video, transcript, and everything linked to them.

**Requirement for a future persistence stage:**
- Persist the **canonical project** as a whole, not a parallel model. There will be no `savedVideo`, `savedTranscript`, or `savedPOIs` stores alongside state. What is saved is:
  ```
  PROJECT
  ├── VIDEO (identity, metadata, startPosition)
  ├── TRANSCRIPT (source, rawText byte-for-byte, parse, segments, validation, chunks, processing)
  ├── ALIGNMENT
  ├── ANALYSIS
  ├── POIs
  ├── EVENTS
  └── CLIPS
  ```
- Restoring must produce the same frozen `Project` shape: same ids, same segment ids, same `schemaVersion` fields. Restored data enters state through `state.set("project", …)` like any other project.
- `rawText` must round-trip exactly (including CRLF and Unicode). Derived layers must not replace source fields when saved.
- `schemaVersion` fields exist so a future loader can detect older saved projects. Migrations must add derived data, never rewrite source evidence.
- **The storage technology is intentionally not chosen yet** (localStorage, IndexedDB, filesystem, backend, or cloud). That decision belongs to the persistence stage.

## Frozen contracts (after Stage 1.7)

These are fixed unless a later implementation exposes a concrete contradiction:

| Contract | Rule |
|---|---|
| Project | The project is the canonical container for VOD analysis. |
| Video | Identity is separate from metadata; a start hint is separate from both. |
| Transcript | Source and derived information stay separate; `rawText` is immutable. |
| Provenance | Evidence traces back to transcript segment ids. |
| Timestamp | Stage 1.5 `{raw, seconds, status}` is the only timestamp shape. |
| Alignment | Explicit state, never assumed verified without evidence. |
| Resolver | Identifies a video; never acquires its content. |
| Parser | Parsing is separate from transcript acquisition. |
| Player | Playback is separate from video identity. |
| Analysis | AI analysis is separate from transcript processing. |
| POI | POIs reference evidence; they never replace it. |
| Persistence | Serialize the canonical project; no parallel state model. |

```
URL → VIDEO RESOLVER → VIDEO IDENTITY → METADATA ACQUISITION → TRANSCRIPT ACQUISITION
    → TRANSCRIPT PARSER → CANONICAL TRANSCRIPT → VALIDATOR → CHUNKER → AI ANALYSIS
    → EVIDENCE / POIs → VIDEO PLAYER → TIMESTAMP SEEKING
```

The AI layer will discover, describe, trace, and preserve uncertainty. It will not rank, pick "best" clips, predict virality, or decide what to publish. The human is the final reviewer.

## Not implemented on purpose (later stages)

Transcript download or generation, YouTube API / IFrame Player API, metadata fetching, embedded video player, playback controls, timestamp seeking, transcript/video sync, POI generation, event reconciliation, AI providers, clip generation or ranking, persistence (localStorage / IndexedDB / backend), database, authentication, cloud storage, payments, Discord integration, and platforms other than YouTube.

## Future video + transcript workflow

```
URL → VIDEO RESOLVER (1.6/1.7) → VIDEO METADATA PROVIDER → TRANSCRIPT PROVIDER
    → TRANSCRIPT PARSER (Stage 2) → VALIDATOR → CHUNKER → AI ANALYZER
    → POI ENGINE → VIDEO PLAYER (player.seekTo(poi.videoPosition.startSeconds))
```

A future `js/video/player-controller.js` will expose `load(video)`, `play()`, `pause()`, `seekTo(seconds)`, and `getCurrentTime()`. It will read `video.identity` and never own it, so the model stays independent of any player.

## Development philosophy

The application is intentionally modular and provider-agnostic. Each module has one responsibility and can be replaced on its own. Future AI providers (OpenAI, Gemini, Grok, or others) should be swappable without rewriting the frontend, and they will receive evidence with its provenance and uncertainty intact.

```
VOD → Transcript → Parser → Canonical Transcript → Validator → Chunker
    → AI Provider Layer → Evidence Analysis → POI Extraction
    → Event Reconciliation → Clip Candidates → HUMAN REVIEW
```

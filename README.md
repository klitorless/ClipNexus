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
| Stage 2A | Transcript acquisition architecture (provider registry, manual switching, provenance) | **Complete** (architecture only; no provider connected) |
| Stage 2 | Transcript parsing, normalization, validation, and chunking | Not yet implemented |

Nothing after Stage 2A exists yet. **Stage 2A establishes the transcript-acquisition architecture but does not retrieve transcripts from any external service.** The two listed providers are placeholders that answer `NOT_IMPLEMENTED` (see [Transcript acquisition](#transcript-acquisition-stage-2a)).
- **No format is actually parsed.** Uploaded files are loaded, stored, and shown as raw text, but every transcript currently has 0 segments, and validation runs no checks.
- **Pasting a video URL only identifies the video.** It does **not** fetch the title, thumbnail, or duration, retrieve or generate transcripts, or embed or play the video. Nothing is sent over the network.
- **"Get Transcript" does not reach the internet.** Every built-in provider is a placeholder, so it always reports "not connected yet". The only transcripts that can currently exist come from file import (or, for UI preview, from clearly named console mocks).

## Current capabilities

- Modular frontend (HTML, CSS, vanilla JavaScript ES modules, no build step)
- Client-side hash navigation (`#dashboard`, `#transcripts`, `#pois`, `#events`, `#clips`, `#analysis`, `#settings`)
- Video URL input: YouTube links are resolved locally to a video identity (platform, video ID, canonical URL)
- YouTube `?t=` / `#t=` / embed `start=` kept as a separate, unverified start-position hint
- Inline confirmation before a different video replaces a project that holds a transcript
- Transcripts page shows the linked video (platform, ID, title status, source, start hint, alignment)
- Transcript provider selection (provider, language, acquisition method) driven by a central registry
- Standardized acquisition errors with manual provider switching ("Try Again" / "Try With …")
- Provenance on every transcript: imported file vs. provider (provider, method, native/generated, language, retrieval time, source id, video)
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

Defined in `js/transcript/model.js` (schema version 2; v2 added `acquisition`).

```js
TranscriptDocument {
    schemaVersion: 2,
    id: "tx-…",

    acquisition: {            // SOURCE PROVENANCE (Stage 2A) — see "Transcript acquisition"
        type: "file" | "provider" | "unknown",
        providerId, providerName, method, generated, language,
        requestedLanguage, requestedMethod, retrievedAt, sourceId,
        video: { platform, videoId } | null
    },

    source: {                 // SOURCE: content facts (filename/lastModified null for providers)
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

## Transcript acquisition (Stage 2A)

Stage 2A adds the **architecture** for getting transcripts from interchangeable providers. It does **not** retrieve anything from an external service. No provider API, scraping, speech-to-text, API key, backend, or network call exists.

```
normalized VIDEO (project.video, Stage 1.6/1.7)
      ↓
TRANSCRIPT PROVIDER MANAGER   js/transcript/providers/manager.js
      ↓  one attempt, one provider — the one the user chose
┌──────────────┬────────────────────────┬──────────────┐
│ supadata     │ youtube-transcript-api │ future …     │   adapters/*.js
└──────────────┴────────────────────────┴──────────────┘
      ↓  normalizeAdapterResponse()  (provider boundary)
ACQUISITION RESULT  → provenance → shared pipeline (parser → validator) → canonical TranscriptDocument
```

### Provider abstraction

Each adapter (`js/transcript/providers/adapters/<name>.js`) exports a `provider` built with `defineProvider()`:

```js
{
  id: "supadata", name: "Supadata", description: "…",
  status: "available" | "not_implemented",
  enabled: true,                          // false = listed but cannot be selected
  capabilities: {
    platforms: ["youtube"],               // omitted flags are false — nothing assumed
    nativeCaptions: true, generatedTranscript: true, languageSelection: true
  },
  getTranscript(video, options) → Promise<AdapterResponse>
}
```

- `video` is `{ platform, videoId, canonicalUrl }` (frozen), taken from the resolved project video. Adapters never receive the raw user URL or the start hint, and they never resolve URLs themselves.
- `options` is `{ language: string | null, method: "any" | "native" | "generated" }`. `language: null` means "provider default". English is never assumed.
- An adapter returns `{ success: true, transcript: { rawText, format }, source: { method, language, sourceId } }` or `{ success: false, error: { code, detail } }`. `rawText` must be the transcript text exactly as delivered, in a format the parser registry supports (`txt`, `srt`, `vtt`, `json`). Everything else an adapter returns is dropped at the boundary.

Built-in adapters: `supadata` and `youtube-transcript-api`. Both are **placeholders** (`status: "not_implemented"`). They return `NOT_IMPLEMENTED` and make no requests. Their capabilities are the intended ones and must be re-checked when each is implemented. `adapters/mock.js` holds deterministic fakes used by the self-tests. It is never registered by default.

### Provider registry

`js/transcript/providers/registry.js` → `createProviderRegistry()`. The app's instance is in `default-providers.js`.

- `register(provider)`: invalid or duplicate providers throw (a programming error).
- `get(id)`: `{ success, provider }`, or a controlled `PROVIDER_NOT_FOUND` error.
- `getSelectable(id)`: like `get`, but a disabled provider gives `PROVIDER_DISABLED`.
- `list()` / `listSelectable()`: frozen data-only descriptors (no functions). The UI builds its menus from these and names no provider itself.

Adding a provider means writing one adapter file and adding it to `default-providers.js`. No UI or coordinator change is needed.

### Acquisition result contract

`acquireTranscript({ registry, providerId, video, options, timeoutMs })` always resolves (it never throws) to one frozen shape:

```js
// success
{ success: true,
  source: { providerId, providerName, method, generated, language,
            requestedLanguage, requestedMethod, retrievedAt, sourceId,
            video: { platform, videoId } },
  payload: { rawText, format } }

// failure
{ success: false,
  error: { code, message, retryable, providerId, detail } }
```

- `providerId`/`providerName` come from the registry, not the response, so an adapter cannot misattribute a transcript.
- `retrievedAt` is the time the app received the response.
- Request checks run **before** the adapter is called: provider exists and is enabled, a video is present, the platform is supported, the language code is valid, and the requested language/method is within the provider's capabilities.
- An adapter that throws gives `PROVIDER_ERROR`. One that doesn't answer within `timeoutMs` (default 30 s) gives `PROVIDER_TIMEOUT`.
- Applying a result is a separate pure step, `applyAcquisitionToProject(project, result, buildAcquiredTranscript)`. On failure it returns the **same project object**. A success for a different video than the project's is rejected.

### Error vocabulary

`js/transcript/providers/errors.js` is the only list. Every code has one fixed plain-language `message` and a `retryable` flag (true = trying the same provider again may help). Provider-supplied error text is untrusted, so it goes to `detail` (console only) and is never shown.

| Code | Retryable | Meaning |
|---|---|---|
| `PROVIDER_UNAVAILABLE` | yes | Provider not reachable |
| `AUTHENTICATION_FAILED` | no | Credentials rejected |
| `RATE_LIMITED` | yes | Temporarily limited |
| `VIDEO_UNAVAILABLE` | no | Private, removed, or region-locked video |
| `TRANSCRIPT_UNAVAILABLE` | no | This provider has no transcript for the video |
| `LANGUAGE_UNAVAILABLE` | no | Not available in the requested language |
| `TRANSCRIPT_EMPTY` | no | Empty or whitespace-only transcript |
| `PROVIDER_TIMEOUT` | yes | No answer in time |
| `PROVIDER_ERROR` | yes | Provider failed / adapter threw |
| `MALFORMED_RESPONSE` | yes | Response did not match the adapter contract |
| `NOT_IMPLEMENTED` | no | Placeholder provider (all built-ins in Stage 2A) |
| `UNKNOWN_ERROR` | yes | Anything unrecognized (original code kept in `detail`) |
| `PROVIDER_NOT_FOUND` | no | App check: no such provider id |
| `PROVIDER_DISABLED` | no | App check: provider disabled |
| `UNSUPPORTED_VIDEO` | no | App check: provider doesn't support the platform |
| `UNSUPPORTED_OPTION` | no | App check: language/method outside capabilities |
| `INVALID_REQUEST` | no | App check: no video, bad language/method, or stale result |

### Manual provider switching

Provider failure is expected, not a special case. On the Transcripts page:

1. Pick a **Transcript provider**, **Language**, and **Acquisition** method, then **Get Transcript**. The page shows "Retrieving transcript… Provider: X" while controls are disabled.
2. On failure, a panel says "X could not retrieve this transcript." with the reason and code. It offers **Try Again** (only when retryable) and a **Try another provider** menu with **Try With Y**. It notes that an existing transcript was not changed.
3. On success, the panel shows the provenance, and the "Loaded transcript" card shows it too.

There is **no automatic fallback**. The manager calls exactly one provider per attempt, and a failed provider never triggers another. Provenance always names the provider that actually supplied the transcript. A future automatic mode (A → B → C) would be a separate, explicit feature built on the same manager.

Switching providers never changes the project id or video identity. A successful acquisition replaces the transcript, resets alignment to `unverified`, and keeps the video and its start hint.

### Attempt state

`state.ui.transcriptAcquisition` (`acquisition-state.js`), separate from the project and the transcript:

```js
{ status: "idle" | "acquiring" | "success" | "error",
  selection: { providerId, language, method },        // what the user picked
  attempt: null | { id, providerId, providerName, language, method, projectId,
                    startedAt, finishedAt, error, source } }
```

Changing the selection (including after an error) is how switching works. There is no separate "selecting" status, because the selection is always editable. The attempt resets when the project is replaced or a file is imported. A late result from an older attempt is ignored and never attached.

### Transcript provenance

Every `TranscriptDocument` has one `acquisition` record with the same shape for every source (see the canonical model):

| | Imported file | Provider-acquired |
|---|---|---|
| `type` | `"file"` | `"provider"` |
| `providerId` / `providerName` | `null` | registry id / name |
| `method` / `generated` | `"unknown"` / `null` | `"native"`→`false`, `"generated"`→`true`, `"unknown"`→`null` |
| `language` / `requestedLanguage` | `null` | reported / requested (`null` = default) |
| `retrievedAt` | `null` (file time is `source.loadedAt`) | ISO time received |
| `sourceId` | `null` | provider's own track/transcript id, or `null` |
| `video` | `null` | `{ platform, videoId }` it was acquired for |
| `source.filename` | file name | `null` |

- `generated` is derived from `method`, so they can't disagree. Unknown is `null`, never `false`.
- `acquisition.video` is an identity reference only. No video metadata is copied, and it is **not** alignment evidence.
- `rawText` is stored once, exactly as delivered. No provider response object is stored anywhere.
- File import and provider acquisition share one pipeline (`js/transcript/pipeline.js`: parser → validator → frozen document).

### Future provider integration plan

1. Implement one adapter at a time inside its own file: request, auth, and mapping of the provider's response and errors to the contract above. Set `status: "available"`.
2. Credentials and network access will need a deliberate design (a user-run local helper or a backend). That's a later stage, and nothing in the UI or the manager should need to change.
3. Real language lists can come from provider capabilities. The placeholder list in `js/transcript/languages.js` is replaced, not duplicated.
4. Optional automatic fallback, if added, must be an explicit, visible mode that records each attempt.

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
    ├── app.js                 Coordinator: URL → resolver → project; file / provider → pipeline → project; state → render
    ├── core/
    │   ├── state.js           get / set / subscribe store (route, project, ui)
    │   ├── router.js          Hash routing + route list
    │   ├── errors.js          AppError: user message vs. developer diagnostics
    │   ├── ids.js             Random prefixed ids (project-…, tx-…)
    │   ├── project.js         Project model: video + transcript container, lifecycle
    │   ├── devtools.js        window.vodAnalyzer console helpers + self-tests
    │   ├── devtools-project-tests.js   Stage 1.6 + 1.7 self-tests
    │   └── devtools-provider-tests.js  Stage 2A self-tests (deterministic mocks)
    ├── video/
    │   ├── video-model.js     Video identity vs. metadata, metadata status
    │   ├── video-resolver.js  Platform-neutral URL → identity resolver
    │   └── platforms/
    │       └── youtube.js     YouTube URL rules (identity + start-position hint)
    ├── transcript/
    │   ├── formats.js         Single source of truth for supported formats
    │   ├── model.js           Canonical schema factories (document, segment, timestamp, speaker)
    │   ├── parser.js          Dispatcher: selects format module, builds frozen document
    │   ├── pipeline.js        Shared path: raw text + provenance → parser → validator → frozen document
    │   ├── languages.js       Language codes (null = provider default); placeholder option list
    │   ├── providers/
    │   │   ├── errors.js      Standardized acquisition error vocabulary
    │   │   ├── provider.js    Provider contract, capabilities, normalization boundary
    │   │   ├── registry.js    Central provider registry
    │   │   ├── manager.js     Runs one attempt; applies results without harming the project
    │   │   ├── acquisition-state.js  Attempt state (state.ui), separate from the transcript
    │   │   ├── default-providers.js  The app's registry instance
    │   │   └── adapters/
    │   │       ├── supadata.js                Placeholder (NOT_IMPLEMENTED, no network)
    │   │       ├── youtube-transcript-api.js  Placeholder (NOT_IMPLEMENTED, no network)
    │   │       └── mock.js                    Deterministic test providers (never registered by default)
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
        ├── acquisition-panel.js  Provider / language / method selection, failure + switching, success
        ├── provenance.js      Provenance display rows (file vs. provider)
        └── transcripts.js     Transcripts view (linked video, acquisition, source details, layers, raw preview)
```

## Running

No install or build step. Open `index.html` through any local static server. On Android, use Acode: open the project folder, open `index.html`, and tap ▶ Run. Chrome blocks ES modules over `file://`, and when that happens a red "App files did not load" box appears.

## Testing

Open the browser console (Acode: enable "Show Console Toggler" in Preview settings) and run:

```js
await vodAnalyzer.runSelfTests()   // 83 architectural checks, printed as a table
vodAnalyzer.listProviders()        // registry descriptors
vodAnalyzer.registerMockProviders() // optional UI preview: "Mock A (always fails)" + "Mock B (returns test data)"
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

The 32 Stage 2A checks use deterministic mock providers in local registries. They make no network calls and never touch the app's registry or state. They cover:
- **Registry:** register/list, get by id, unknown id → `PROVIDER_NOT_FOUND`, disabled listed but not selectable (and never called), invalid/duplicate rejected, data-only frozen descriptors.
- **Contract:** built-ins conform and are honest placeholders; placeholders return structured `NOT_IMPLEMENTED`; capabilities default to false; 11 malformed responses normalized; throw → `PROVIDER_ERROR`; hang → `PROVIDER_TIMEOUT`; provider-specific fields (and a spoofed provider id) never leak; adapters get only normalized video + options, with `language: null` by default.
- **Errors:** all 12 standard codes (message, retryable, frozen); each adapter code maps to itself with provider text hidden; unknown → `UNKNOWN_ERROR`; request checks run before any provider call.
- **Switching:** A fails → select B → B supplies the transcript, and provenance says B; any failure (all 12 codes, or a pipeline failure) leaves the existing transcript untouched; B is never called automatically; project id and video identity don't change; attempt state is separate and frozen and ignores stale results; a result for a different video is not attached.
- **Provenance:** provider, method, language, requested values, generated flag, retrieval time, source id, and video are all recorded; native, generated, and unknown stay distinguishable; acquired `rawText` is stored exactly once; imported files are marked `file` with nulls for unknowns.
- **UI:** the panel is built from the registry; the failure view offers Try Again (retryable only) and Try With another provider, with hostile names rendered as text; the success view and summary card show provenance; the dashboard status is honest.

## Privacy and security

- Files are read locally with `File.text()` and kept in memory only.
- No analytics, tracking, third-party scripts, or network requests. Video URLs are resolved locally and never fetched.
- Transcript providers make no requests in Stage 2A. Provider names, errors, and provenance are rendered with `textContent`. Provider error text is never shown, only the fixed message for its code.
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
- No transcript retrieval from URLs: every built-in provider is a placeholder returning `NOT_IMPLEMENTED`, and there are no API keys, network calls, or backend. No embedded player, no playback, no seeking.
- Provider-acquired transcripts go through the same placeholder parser, so they also have 0 segments until Stage 2 parsing exists.
- The language list is a fixed placeholder, not reported by providers.
- A successful acquisition replaces an existing transcript without a separate confirmation (a failed one never changes it). The panel says so before you tap Get Transcript.
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

## Architectural invariants (Stage 2A)

1. Raw transcript data is preserved exactly as delivered or loaded (`rawText`, stored once).
2. The canonical transcript model is provider-agnostic; no provider response object enters it.
3. Provider responses are normalized at the provider boundary (`normalizeAdapterResponse`).
4. Every transcript records where it came from (`acquisition`), including "imported file" and "unknown".
5. Unknown is `null`/`"unknown"`, never `false`.
6. Providers are listed and selected only through the registry; the UI names no provider.
7. Adapters receive normalized video identity and never resolve URLs.
8. The UI reads only standardized error codes and fixed messages, never provider-specific errors.
9. No silent or automatic provider switching; one attempt calls one user-chosen provider.
10. A failed acquisition never changes or destroys an existing transcript or the project.
11. Attempt state lives in `state.ui` and is never part of the canonical transcript.
12. File import and provider acquisition share one pipeline and one document shape.
13. No network acquisition exists in Stage 2A; placeholders return `NOT_IMPLEMENTED`.
14. No persistence (localStorage, IndexedDB, backend) and no credentials.
15. No framework migration: vanilla HTML/CSS/ES modules, no build step, no state library.

## Not implemented on purpose (later stages)

Real transcript providers (Supadata, youtube-transcript-api, or any other), automatic provider fallback, transcript download or generation, speech-to-text, API keys, YouTube API / IFrame Player API, metadata fetching, embedded video player, playback controls, timestamp seeking, transcript/video sync, POI generation, event reconciliation, AI providers, clip generation or ranking, persistence (localStorage / IndexedDB / backend), database, authentication, cloud storage, payments, Discord integration, and platforms other than YouTube.

## Future video + transcript workflow

```
VIDEO URL → VIDEO RESOLVER (1.6/1.7) → NORMALIZED VIDEO
    → TRANSCRIPT PROVIDER MANAGER (2A) → Provider A | Provider B | Provider C (user-chosen)
    → ACQUISITION RESULT → PROVENANCE → CANONICAL TRANSCRIPT
    → VALIDATION → CHUNKING → AI ANALYSIS → POIs → EVENT RECONCILIATION
    → CLIP CANDIDATES → HUMAN REVIEW
    (later: VIDEO PLAYER — player.seekTo(poi.videoPosition.startSeconds))
```

The AI must **not** choose the final clips. It extracts and describes evidence and proposes candidates with their provenance; the human reviews and decides.

A future `js/video/player-controller.js` will expose `load(video)`, `play()`, `pause()`, `seekTo(seconds)`, and `getCurrentTime()`. It will read `video.identity` and never own it, so the model stays independent of any player.

## Development philosophy

The application is intentionally modular and provider-agnostic. Each module has one responsibility and can be replaced on its own. Future AI providers (OpenAI, Gemini, Grok, or others) should be swappable without rewriting the frontend, and they will receive evidence with its provenance and uncertainty intact.

```
VOD → Transcript → Parser → Canonical Transcript → Validator → Chunker
    → AI Provider Layer → Evidence Analysis → POI Extraction
    → Event Reconciliation → Clip Candidates → HUMAN REVIEW
```

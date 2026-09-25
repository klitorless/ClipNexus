# VOD Analyzer

## Project

VOD Analyzer is a modular web application for analyzing long-form VOD transcripts. It will extract evidence-supported Points of Interest (POIs), identify event arcs, preserve context and source limitations, and help a human operator build short-form clip candidates.

The AI layer will **discover, describe, preserve, and trace** evidence. It will **not** guess, rank, or decide which clips the human should select. Final selection always happens in human review.

## Stages

| Stage | Scope | Status |
|---|---|---|
| Stage 1 | Frontend application shell | **Complete** |
| Stage 1.5 | Transcript architecture foundation | **Complete** |
| Stage 2 | Transcript parsing, normalization, validation, and chunking | Not yet implemented |

Nothing after Stage 1.5 exists yet. Uploaded files are loaded, stored, and shown as raw text, but **no format is actually parsed**: every transcript currently has 0 segments, and validation runs no checks.

## Current capabilities

- Modular frontend (HTML, CSS, vanilla JavaScript ES modules, no build step)
- Client-side hash navigation (`#dashboard`, `#transcripts`, `#pois`, `#events`, `#clips`, `#analysis`, `#settings`)
- Transcript file selection for all supported formats
- Canonical, frozen `TranscriptDocument` stored in state
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
    ├── app.js                 Coordinator: file → format → parser → validator → state → render
    ├── core/
    │   ├── state.js           get / set / subscribe store (reserved keys for later stages)
    │   ├── router.js          Hash routing + route list
    │   ├── errors.js          AppError: user message vs. developer diagnostics
    │   └── devtools.js        window.vodAnalyzer console helpers + self-tests
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
        └── transcripts.js     Transcripts view (source details, layers, raw preview)
```

## Running

No install or build step. Open `index.html` through any local static server. On Android, use Acode: open the project folder, open `index.html`, and tap ▶ Run. Chrome blocks ES modules over `file://`, and when that happens a red "App files did not load" box appears.

## Testing

Open the browser console (Acode: enable "Show Console Toggler" in Preview settings) and run:

```js
vodAnalyzer.runSelfTests()     // 23 architectural checks, printed as a table
vodAnalyzer.inspectTranscript() // the frozen TranscriptDocument in state
vodAnalyzer.getState("route")
```

The self-tests don't change app state. They check:
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

## Privacy and security

- Files are read locally with `File.text()` and kept in memory only.
- No analytics, tracking, third-party scripts, or network requests.
- Transcript content is untrusted. It is rendered with `textContent` only and never with `innerHTML`, `eval`, or script execution.

## Current limitations

- No format is parsed yet: `segments` is always empty and `parse.status` is `not_implemented`.
- Validation runs no checks (`valid: null`, status `not_implemented`).
- Chunking returns an empty array.
- Format detection is extension-only.
- `File.text()` always decodes as UTF-8 and drops a leading byte-order mark. Non-UTF-8 files (e.g. Windows-1252 SRTs) may show replacement characters.
- One transcript at a time, held in memory; it's gone after a page reload.
- The whole file is read into memory (no streaming or workers yet).

## Development philosophy

The application is intentionally modular and provider-agnostic. Each module has one responsibility and can be replaced on its own. Future AI providers (OpenAI, Gemini, Grok, or others) should be swappable without rewriting the frontend, and they will receive evidence with its provenance and uncertainty intact.

```
VOD → Transcript → Parser → Canonical Transcript → Validator → Chunker
    → AI Provider Layer → Evidence Analysis → POI Extraction
    → Event Reconciliation → Clip Candidates → HUMAN REVIEW
```

# VOD Analyzer

## Project

VOD Analyzer is a modular web application for analyzing long-form VOD transcripts. It will extract evidence-supported Points of Interest (POIs), identify event arcs, preserve context and source limitations, and help a human operator build short-form clip candidates.

The AI layer will extract and describe evidence. It will **not** decide which clips the human should select. Final selection always happens in human review.

## Current Stage

**Stage 1 — Frontend Application Shell**

## Current capabilities

- Modular frontend (HTML, CSS, vanilla JavaScript ES modules)
- Client-side navigation with URL hashes (`#dashboard`, `#transcripts`, `#pois`, `#events`, `#clips`, `#analysis`, `#settings`)
- Transcript file selection (`.txt`, `.srt`, `.vtt`, `.json`)
- Basic transcript state (name, size, raw text held in memory)
- Responsive layout (sidebar on desktop, scrollable top strip on mobile)

## Not implemented yet

- Transcript parsing
- Transcript validation
- Transcript chunking
- AI analysis
- POI extraction
- Event reconciliation
- Clip building
- Backend
- Database

## Project structure

```
vod-analyzer/
├── index.html              App shell and mount points
├── README.md
├── css/
│   ├── base.css            Design tokens, reset, typography
│   ├── layout.css          Header / sidebar / main grid
│   └── components.css      Buttons, nav, cards, stats
└── js/
    ├── app.js              Entry point, view switching, file loading
    ├── core/
    │   ├── state.js        get / set / subscribe state store
    │   └── router.js       Hash-based routing
    ├── transcript/
    │   ├── parser.js       Placeholder: parseTranscript()
    │   ├── validator.js    Placeholder: validateTranscript()
    │   └── chunker.js      Placeholder: chunkTranscript()
    └── ui/
        ├── sidebar.js      Section navigation
        └── dashboard.js    Dashboard view
```

## Running

No install or build step. Serve the folder with any static file server, or open `index.html` in a browser that allows ES modules from local files. Note that Chrome-based browsers block ES modules over `file://`, so use a local static server app (or Firefox) on Android.

## Privacy

Transcript files are read locally with `File.text()` and kept in browser memory only. There are no analytics, tracking, third-party scripts, or network requests.

## Development philosophy

The application is intentionally modular and provider-agnostic. Each module has one responsibility and can be replaced independently.

Future AI providers (OpenAI, Gemini, Grok, or others) should be replaceable without rewriting the frontend.

Planned pipeline:

```
VOD → Transcript → Parser → Validator → Chunker → AI Provider Layer
    → Evidence Analysis → POI Extraction → Event Reconciliation
    → Clip Candidates → HUMAN REVIEW
```

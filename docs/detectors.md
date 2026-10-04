# Deterministic Analysis Detectors

The detector layer (`js/analysis/detectors/`) is the first analysis
stage over the canonical `TranscriptDocument`. It finds **evidence**;
it never decides what becomes a clip.

```
TranscriptDocument
  → createAnalyzer({ extract: createDetectorExtractor() })
  → DetectorSignal[]            (per detector, per segment)
  → Stage 3 Evidence[]          (via the extractor)
  → Analysis tab / future POI & event reconciliation
  → POIs / Events → ClipSpec → human keep/reject
```

Detectors never create POIs, events, or ClipSpecs directly.

---

## Available detectors

| Type (`detector`) | What it finds | Scoring |
|---|---|---|
| `hype` | Excitement / high-energy language | Weighted phrases: strong +3, medium +2, weak +1. Each distinct phrase counts once per segment; a weaker phrase subsumed by a stronger matched phrase is dropped (`"that's insane"` suppresses bare `"insane"`). |
| `question` | Question-like segments | `?` → +2; question word as the first word of a 3+ word segment → +1. A question word mid-sentence is not a signal. |
| `keyword` | User-configured keywords/phrases | +1 per occurrence. Case-insensitive, word-boundary matching (`"cat"` never matches `"communication"`). |
| `reaction` | Strong reaction language | +1 per distinct matched phrase. Intentionally separate from `hype`; a segment may trigger both. |
| `emphasis` | Linguistic emphasis | +2 per signal: consecutive repeated words (`"no no no"`), repeated punctuation (`"!!!"`, `"???"` — 3+ marks), ALL CAPS (2+ words, every cased letter uppercase). Capitalization/punctuation are never required — normalized transcripts just yield no signal. |
| `phrase` | User-configured phrases | Same matching infrastructure as `keyword`, but a distinct type: keywords name things to find (`"BMW"`), phrases name things people say (`"watch this"`). |

Vocabularies live in the detector modules (`hype.js`,
`reaction.js`) as explicit, frozen lists — easy to extend, never
hidden in UI code.

**Heuristic, not measurement.** Weights and phrase lists are
deterministic heuristics over verbatim text. They do not measure
human excitement, intent, or importance. Every extractor run
records this as a limitation on its result.

---

## Inputs

`runDetectors(segments, config)` takes segment views shaped like
the analyzer's extraction payload:

```js
{ id: "seg-000142", text: "verbatim text",
  start: { seconds: 482.35 }, end: {...}, speaker: {...} }
```

- The transcript is never mutated; segments are read-only.
- Malformed segments (no id) and empty text are skipped silently.
- `timestampSeconds` is `start.seconds`, or `null` when unknown.

Configuration merges over `DEFAULT_DETECTOR_CONFIG`:

```js
{
  hype:     { enabled: true, sensitivity: "normal" }, // low|normal|high
  question: { enabled: true, sensitivity: "normal" },
  keyword:  { enabled: true, sensitivity: "normal", keywords: ["BMW", "turbo"] },
  reaction: { enabled: true, sensitivity: "normal" },
  emphasis: { enabled: true, sensitivity: "normal" },
  phrase:   { enabled: true, sensitivity: "normal", phrases: ["watch this"] }
}
```

`sensitivity` selects the score threshold (`types.js`
`SCORE_THRESHOLDS`); `keyword`/`phrase` emit on any match.
Unknown detector keys or sensitivity values throw at setup —
misconfiguration fails loudly, never silently.

---

## Outputs

Each detector returns at most one frozen signal per segment:

```js
{
  detector: "hype",
  segmentId: "seg-000142",
  timestampSeconds: 482.35,
  score: 8,
  signals: ["oh my god", "no way", "that's insane"],  // why it fired
  quote: "verbatim segment text"                       // trimmed, unmodified
}
```

`runDetectors` emits signals in segment order, then
`DETECTOR_ORDER` — fully deterministic. Detectors never
suppress each other: one segment may carry `hype`, `reaction`,
and `emphasis` at once. Reconciliation happens later.

`createDetectorExtractor()` adapts signals to the analyzer
seam (`extract(request, document, payload)`), converting each
to one Stage 3 Evidence item:

- `id`: `ev-<detector>-<segmentId>` (deterministic)
- `type`: `"text"`, `sourceRef`: `{ transcriptId, segmentIds: [segmentId] }`
- `content`: `{ detector, score, signals, timestampSeconds, quote }`
- `provenance`: `"source-observed"`, `reliability`: `"high"`
  (the *match* is verbatim and certain; the interpretation is
  heuristic — stated in the result's limitations)

---

## Scoring philosophy

1. **Deterministic.** Same document + same config ⇒ same
   signals, same scores, same order. No randomness, no
   network, no external libraries.
2. **Explainable.** Every signal lists the exact matched
   labels. There is no opaque `interesting: true`.
3. **Documented.** Each detector module states its rules in
   its header comment; weights and thresholds live in code,
   not in prose.
4. **Conservative.** Ambiguous text yields no signal rather
   than a guessed one (mid-sentence question words, lone
   `"!!"`, single lowercase words).

---

## How to add a new detector

1. Create `js/analysis/detectors/<name>.js` exporting
   `detect<Name>(segment, options)` → `{ detector, score,
   signals } | null`. Use `detectors/text.js` for matching.
2. Add the type to `DETECTOR_TYPE` and `DETECTOR_ORDER` in
   `types.js`, a threshold row in `SCORE_THRESHOLDS`, and a
   default entry in `DEFAULT_DETECTOR_CONFIG`.
3. Register it in the `DETECTORS` table in `index.js`.
4. Add tests to `js/core/devtools-detector-tests.js`
   (registered in `js/core/devtools.js`).
5. The extractor picks it up automatically — no analyzer
   changes needed.

---

## Why signals, not ClipSpecs

A detector answers "something observable happened here."
Whether that observation matters — alone, grouped with
neighbors, or not at all — is a reconciliation decision that
needs cross-segment context the detector intentionally does
not have. Signals stay traceable to one segment; events group
signals; POIs reference evidence; ClipSpecs reference POIs.
Collapsing those layers would destroy the evidence chain the
whole architecture is built to preserve.

---

## Analysis Builder (UI configuration)

The Analysis tab's "What are you looking for?" builder is a
pure configuration layer over the config above. It exposes,
per detector: an enable checkbox, a Low/Normal/High
sensitivity control, plus the keyword text field and the
custom-phrase add/remove list. Fixed vocabularies (question
words, hype phrases, reaction phrases) are shown read-only,
imported from the detector modules — the UI never
re-implements matching or scoring.

Config lives in app state (`ui.analysisConfig`, partial —
`resolveDetectorConfig()` fills defaults) and each run
builds a fresh extractor from it, so there is exactly one
analysis execution path. `validateAnalysisConfig()` rejects
empty runs ("Select at least one analysis type to search
for.") and explicitly-enabled-but-empty keyword/phrase
detectors; untouched defaults keep the historical silent
skip. Results remain canonical Stage 3 Evidence.

Deliberately not exposed (the detectors do not support
them): per-phrase toggles, custom hype/reaction/question
phrases, case/whole-word switches (always on), emphasis
sub-toggles, and minimum-repetition settings.

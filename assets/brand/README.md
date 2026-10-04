# ClipNexus Brand Assets

Branded imagery for the ClipNexus product, built around the existing UI —
never a redesign of it. The governing idea: **a VOD timeline flows into a
central nexus, and analyzed moments fan out of it.**

## Files

| File | Purpose | Placement | Size |
|---|---|---|---|
| `clipnexus-mark.webp` | Evolved brand mark (play triangle + nexus node) | Social avatars, docs, marketing, OG images. NOT in-app nav chrome — the inline SVG triangle stays authoritative there. | 94 KB, 1:1 |
| `clipnexus-hero-nexus.webp` | Flagship "timeline → nexus → moments" banner | Dashboard, above the Create Project intake card (`.brand-hero`) | 158 KB, 21:9 |
| `clipnexus-empty-dormant.webp` | Dormant timeline, dim unlit nodes | Empty states: Transcripts, POIs, Event Arcs, Clip Queue (`.brand-empty`) | 22 KB, 16:9 |
| `clipnexus-processing-scan.webp` | Violet scan beam sweeping transcript fragments | Caption acquisition / transcript processing progress (`.brand-processing`) | 84 KB, 16:9 (re-encoded q85, was 201 KB) |
| `favicon.svg` | **Authoritative** favicon/app-icon source, drawn from the existing `.brand-mark` triangle geometry (`M6 4.5v15l13-7.5z`, `#8b5cf6` on `#0a0e14`) | `<link rel="icon" type="image/svg+xml">` | 561 B |
| `favicon-32.png` | PNG fallback rasterized from `favicon.svg` geometry | `<link rel="icon" type="image/png" sizes="32x32">` | 319 B |
| `apple-touch-icon.png` | 180px home-screen icon rasterized from `favicon.svg` geometry | `<link rel="apple-touch-icon">` | 1.5 KB |

## Provenance

- `clipnexus-mark.webp`, `clipnexus-hero-nexus.webp`,
  `clipnexus-empty-dormant.webp`, `clipnexus-processing-scan.webp`:
  generated 2026-10-04 from art direction derived from the app's CSS
  design tokens (`--bg #0a0e14`, `--accent #8b5cf6`, `--accent-strong
  #a78bfa`). No text baked into any image; all copy stays in HTML/CSS.
- `favicon.svg` / `favicon-32.png` / `apple-touch-icon.png`: drawn
  deterministically from the existing brand triangle — no AI generation,
  single source of truth is the SVG.

## Consistency rules for future ClipNexus imagery

1. **Palette is law.** Backgrounds only from the `#0a0e14` family; light
   only in the `#8b5cf6 → #a78bfa → indigo` range. Green/red are
   status-only, never decorative.
2. **One glow.** A single soft violet glow per composition (≤35% opacity
   bloom). Never two competing light sources.
3. **Shape language.** Rounded rectangles = video frames/moments; circles =
   timestamp nodes; 1–2px threads = evidence connections. The only sharp
   geometry allowed is the play triangle.
4. **Line language.** Timelines are always horizontal, left-to-right = time.
   Ticks fine and regular. Nothing diagonal except extraction threads
   leaving the nexus.
5. **Negative space.** Imagery occupies ≤40% of any card's area;
   full-bleed only for the dashboard hero. Empty states must feel quiet,
   not decorative.
6. **Composition.** Subject never touches image edges; keep 10% clear
   margin (matters for OG crops and mobile).
7. **No baked text.** No words, letters, timestamps, or logos rendered in
   pixels — HTML owns all copy.
8. **The mark.** Play triangle always present in brand contexts; nexus node
   holds 3–7 satellites; wordmark stays system-ui 700, never redrawn as
   pixels.
9. **Motion.** Direction is left-to-right (scan, flow, extraction). Pulse,
   don't flash. The static image is the resting frame.
10. **Mobile.** Hero crops or hides ≤640px; empty states max 320px wide; no
    asset may cause horizontal overflow.
11. **Honesty.** Imagery illustrates process (timeline → nexus → moments),
    never data. No fake waveforms implying real content, no invented
    metrics, no fake timestamps or events.
12. **Provenance.** Every new asset gets a row in the table above: purpose,
    placement, date, and how it was made.

## Specified but not yet produced

- `clipnexus-clips-extract.webp` — a timeline segment lifting out of the
  VOD line into a clip frame; for the Clip Queue human-review intro card.
- `clipnexus-og-1200x630.webp` — hero composition re-framed with safe
  margins for social/docs previews.
- `clipnexus-bg-texture.webp` — near-black gradient mesh with faint tick
  rows at ~8% opacity; optional section atmosphere.

# Implementation notes (Claude Code)

Companion to [BLUEPRINT.md](BLUEPRINT.md), which stays authoritative. This file records implementation status and every deviation from the blueprint so the architecture review (ChatGPT) can accept or reject each one.

## Status — 2026-09-25

### Done and tested (`npm test`)

- **Color math**: sRGB → linear → XYZ → CIELAB (D65, 2°) with a 256-entry lookup table; inverse for display; CIEDE2000 passes all 34 published Sharma pairs in both argument orders; ΔE76; pluggable distance registry (`src/color/`).
- **Sampling**: 64×64 stratified, deterministically jittered single-pixel samples (seed 1, seed 2 for stability), alpha < 250 invalid, raw near-black/near-white/channel-clip metrics (`src/detection/sampling.js`, `quality.js`).
- **Clustering**: k = 1…5, two deterministic farthest-point initializations, ≤ 12 Lloyd iterations, penalized selection `N·ln(max(SSE/N,1)) + 4k·ln N`, ΔE00 merges below 6, median-nearest actual-sample representatives, small highlight/shadow artifact exclusion (`src/color/cluster.js`).
- **Pattern evidence**: 128×128 diagnostic image, boundary sharpness, 4×4 occupancy, seed-2 agreement, lighting ambiguity, accent detection (`src/detection/pattern.js`).
- **Matching / grouping / confidence**: top-3 canonical matches with profile penalty; ordered grouping rules with overrides and boundary flags; heuristic confidence with every blueprint cap; separate group confidence (`src/color/match.js`, `src/grouping.js`, `src/detection/confidence.js`).
- **Calibration**: neutral-patch measurement, validation, and usability rules (`src/detection/calibration.js`).
- **Data**: palette validation and index, reference-profile quality gates, runtime schema validation, UUIDs (`src/references.js`, `src/schema.js`).
- **Tests**: `tests/unit` (color math, sampling, clustering, matching, grouping, confidence, calibration, schema, references, formatting) and `tests/integration` (all palette anchors, the 18 required colors with exposure variants, multicolor fixtures, quality and calibration fixtures).

### Next

1. App shell and UI: `index.html`, styles, screens, camera, upload decoding, crop editor, detector worker and client.
2. IndexedDB storage, corrections, reference-profile UI, settings, export and import.
3. PWA: manifest, `sw.js` with generated precache, icons, update flow, offline readiness.
4. Optional AI provider interface (disabled by default).
5. Browser end-to-end tests (Playwright with the system Edge), performance pass, README.

## Deviations from the blueprint

1. **Edge sharpness uses ΔE76, not ΔL only** (§8). Red/blue stripes differ by only ΔL ≈ 7, so a lightness-only rule never counts their edges as sharp and would return “ambiguous” for an obvious two-color pattern. For pure-lightness (shadow) edges, ΔE76 equals ΔL, so the rule's shadow behavior is unchanged.
2. **“Mixed colors” flag (cap 60)**: added for a single-color result whose primary color plus its near shades (< 15 ΔE00) cover under 50% of the target, so a busy print isn't confidently named after one of its colors.
3. **Ambiguous pattern results cap confidence at 55** (Low, so “Check result” appears). The blueprint didn't give a number for this case.
4. **Possible accent** additionally requires the 8–15% cluster to differ from the primary by ≥ 15 ΔE00; a nearby shade isn't an accent.
5. **Color search** ranks exact name matches first (“blue” → Blue before Teal, whose alias is “Blue Green”).
6. **Worker protocol** adds `configure` (approved profiles + grouping settings) and `calibrate` (neutral-patch measurement) messages next to `analyze`.
7. **Profile gate “no severe clipping”** is defined as near-black + near-white ≤ 5% of samples.
8. **Uploads** are decoded into a working copy of at most 2048 px on the longest edge before cropping, which bounds phone memory. The ROI crop sent for analysis stays ≤ 1024 px, as specified.

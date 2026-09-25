# Implementation notes (Claude Code)

Companion to [BLUEPRINT.md](BLUEPRINT.md), which stays authoritative. This file records implementation status, measurements and every deviation from the blueprint, so the architecture review (ChatGPT) can accept or reject each one.

## Status — 2026-09-25

Blueprint §20 steps 1–6 are implemented and tested in this repository. Steps 7–8 (real-garment evaluation, device validation, shipping decision) need physical phones and garments and remain open.

| Area | State | Evidence |
| --- | --- | --- |
| Color math (§4, §5) | Done | sRGB→Lab reference values; all 34 Sharma CIEDE2000 pairs in both orders (≤ 1e-4); palette RGB/Lab consistency |
| Sampling, clustering, pattern evidence (§3, §8) | Done | Unit tests plus synthetic fixtures: stripes at five frequencies, 52/43/5, red/blue, checkerboards, accents, ramps, shadows |
| Matching, grouping, confidence (§5, §7, §9) | Done | Precedence, boundaries, every cap; all 57 anchors and the 18 required colors under ±20% exposure |
| Calibration (§10) | Done | Warm/cool round trips; rejection codes; same-frame and live flows in the browser |
| UI and state machine (§11) | Done | Browser tests: upload, camera (fake device), crop keyboard/numeric, Back = Cancel, results, corrections, references, settings |
| Storage, corrections, profiles (§13, §14) | Done | IndexedDB v1 stores; export/import validation and caps; Delete All; storage-unavailable mode; reference-photo builder |
| PWA (§15) | Done | Generated atomic precache; verified “Offline ready”; offline reload test; update flow test; privacy network test |
| AI fallback (§16) | Interface only, disabled | Contract validation, consent, cancel and timeout tests; mock provider in debug builds |
| Real-device matrix, held-out garment metrics (§17) | **Not done** | Needs iOS Safari and Android Chrome devices and a labeled garment set |

Test totals: 147 Node tests (`npm test`) and 22 browser tests (`npm run test:e2e`, system Edge via `playwright-core`).

### Measured performance (desktop, Node 24, `npm run bench`)

| Crop | p50 total | p95 total | Of which clustering (both seeds) |
| --- | --- | --- | --- |
| 432 px camera ROI, noisy navy | 23.7 ms | 28.0 ms | 19.9 ms |
| 1024 px noisy navy | 28.6 ms | 30.4 ms | 21.1 ms |
| 1024 px black/white stripes | 23.7 ms | 37.3 ms | 15.6 ms |
| 1024 px shading ramp | 22.7 ms | 23.1 ms | 15.0 ms |

These are desktop numbers. A midrange phone is typically 2–5× slower, which projects under the §18 budget (p50 < 150 ms), but this still needs measuring on a device. The debug panel shows per-stage timings on any device.

Optimizations so far are value-identical: output fingerprints over 63 fixtures were unchanged. They are an exact quickselect median in place of full sorts, and an inlined k-means assignment loop. Together they gave −27% at p50.

## Deviations from the blueprint

1. **Edge sharpness uses ΔE76, not ΔL only** (§8). Red/blue stripes differ by only ΔL ≈ 7, so a lightness-only rule never counts their edges as sharp and returns “ambiguous” for an obvious two-color pattern. For pure-lightness (shadow) edges, ΔE76 equals ΔL, so the rule's shadow behavior is unchanged.
2. **“Mixed colors” flag (cap 60).** Added for single-color results whose primary color plus its near shades (< 15 ΔE00) cover under 50% of the target, so a busy print isn't confidently named after one of its colors.
3. **Ambiguous pattern results cap confidence at 55** (Low, so “Check result” appears). The blueprint gives no number for this case. Group confidence equals color confidence for multicolor and ambiguous results.
4. **Possible accent** also requires the 8–15% cluster to be ≥ 15 ΔE00 from the primary. A nearby shade isn't an accent.
5. **Color search** ranks exact name matches first (“blue” → Blue before Teal, whose alias is “Blue Green”).
6. **Worker protocol** adds `configure` (approved profiles + grouping settings; fire-and-forget, ordered before later scans) and `calibrate` (neutral-patch measurement) next to `analyze`. `analyze` also carries `sourceRoiPx` (for the 64×64 minimum), `source` and `debug`.
7. **Result schema extensions.** Clusters also carry `laundryGroup` (the group that cluster alone would get) and `scoreDetail` (score components and applied caps). Results also carry `groupRule` and `groupAlternatives`. Every §12 field is present unchanged.
8. **Profile gate “no severe clipping”** is defined as near-black + near-white ≤ 5% of samples.
9. **Uploads** are decoded into a working copy of at most 2048 px on the longest edge before cropping, which bounds phone memory. The analyzed crop stays ≤ 1024 px, as specified.
10. **Home privacy copy** is “Photos are analyzed on this device and never uploaded.” while no AI provider is configured. The blueprint wording (“…unless you choose AI review”) is shown once one is configured, because the original promise would otherwise mention a feature that doesn't exist.
11. **Live calibration** is cleared when the camera screen is left: tracks stop there (§11), so the session ends. Same-frame calibration is unaffected.
12. **Live feedback** (optional in §3) is a lightweight glare/darkness check on 32×32 = 1,024 samples at 2 fps. It only says “Ready” or gives a reframing hint.
13. **Reference-photo builder** (§14) ships with a PNG-only decoder. It *rejects* ICC-tagged, non-sRGB-tagged and EXIF-oriented files with a reason, until a color-managed build-time decoder is chosen. JPEG/HEIC → export as sRGB PNG.
14. **AI fallback** includes the contract, validation, consent UI and a same-origin proxy client, but **no server proxy or vendor adapter**. The default static deployment needs none (§16). A local mock provider exists for debug builds and tests only.
15. **File layout** follows §2 with these additions: `src/detection/{sampling,pattern}.js`, `src/geometry.js`, `src/detector-client.js`, `src/data-transfer.js`, `src/live-feedback.js`, `src/util/`, and `src/ui/` (screens) instead of a single `app.js`.

## Review items for the architect

These follow the blueprint as written, but the synthetic fixtures suggest a spec change may help:

1. **Multicolor confidence inherits per-component name close-calls.** A crisp navy/cream or black/white stripe gets 55 · Low (“Check result”) because one component sits within 1 ΔE00 of two names (Off White vs White), even though the Multicolor decision is solid. Suggestion: for multicolor results, don't apply the name close-call cap, or base the score on component group margins.
2. **Real black/white stripes are always capped at 70.** |ΔL| ≥ 15 with chroma distance < 6 always sets the lighting-ambiguity flag. This is deliberate (§8), but it means a black/white pattern can never score High.
3. **The k-selection penalty is small.** With N = 4096, `4k·ln N` ≈ 33 per extra cluster, so noisy real data almost always selects k = 5 and the ΔE00 < 6 merge does the real work. The results are fine, but clustering costs more than it needs to. A data-driven penalty could cut time roughly in half.
4. **Near-black chroma noise** can split black fabric into two clusters just above the 6 ΔE00 merge threshold (both still match Black, so the grouping is unaffected).
5. **Folded garments in directional light** can form two shade clusters ≥ 15 apart without sharp edges. The result is then “Pattern or shadow?” (abstain). This needs real-photo evaluation before any tuning.

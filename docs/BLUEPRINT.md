# Laundry Color Scanner — implementation blueprint

Status: design handoff for the **one shared application**, 2026-09-25. Claude Code implements this specification in this repository. This document is authoritative for behavior; `spec/colors.json` is authoritative for seed colors. The generator is supporting specification code, not an alternate app. No UI or detector has yet been implemented or benchmarked.

## 1. Product contract and architecture

A mobile web PWA captures or imports a garment photo, samples a user-selected fabric region, finds one or more colors locally, and recommends a configurable color-sorting group. A scan classifies only the selected region; it cannot discover an unseen sleeve, determine fabric, or establish whether dyes bleed. Show “Color sorting suggestion. Follow the care label; wash new or bleeding items separately.” on results.

Use HTML, CSS, native JavaScript ES modules, Canvas 2D, one module Web Worker, IndexedDB, and a service worker. No runtime framework, analytics, remote fonts, account, or backend for the core app. A small development bundler is optional; native modules and static hosting suffice. Unit tests may use Node's test runner; browser automation may use Playwright as a development dependency.

Flow: camera/file → orientation-aware sRGB decode → crop in source coordinates → pixel sampling → optional calibration → Lab clustering → reference matching → grouping → heuristic confidence → results. Camera and DOM belong to the main thread; numeric processing belongs to the worker. Persist only settings and explicitly saved numeric profiles/corrections. All scan images and previews are transient.

## 2. Recommended project structure and contracts

```text
index.html
manifest.webmanifest
sw.js
assets/icons/{icon-192.png,icon-512.png,maskable-512.png,apple-touch-icon.png}
styles/app.css
src/app.js                       # UI state controller
src/camera.js                    # permissions, tracks, torch
src/image-input.js               # decode, orientation, source ROI
src/worker/detector.worker.js
src/color/{srgb-lab.js,delta-e-2000.js,cluster.js,match.js}
src/detection/{pipeline.js,quality.js,calibration.js,confidence.js}
src/grouping.js
src/storage.js
src/references.js
src/ai/{client.js,provider-contract.js}  # optional, disabled initially
data/{colors.json,detector-config.json}
scripts/build-reference-profiles.mjs
tests/{unit,fixtures,integration,e2e}/
docs/BLUEPRINT.md
spec/{colors.json,generate-colors.mjs}
```

Copy the seed palette to `data/colors.json` during implementation; keep one generated source of truth. All adjustable thresholds belong in a versioned detector configuration. Pure functions take configuration explicitly.

Worker request: `{type:'analyze',requestId,rgba:ArrayBuffer,width,height,roi,calibration:null|Calibration,configVersion,paletteVersion}`. Transfer the pixel buffer. Worker response: `{type:'result',requestId,result}` or `{type:'error',requestId,code}`. Ignore replies for canceled/stale IDs. Only one active analysis and one pending latest request; never accumulate frames.

## 3. Capture, sampling, and image quality

1. Open the rear camera after a tap with `{audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}}`. Use `autoplay muted playsinline`. Retry with basic video constraints if the preferred constraints fail.
2. The initial square target covers 60% of the shorter visible preview dimension. Explain “Fill the target with fabric; avoid skin and background.” Let the user move/resize it after capture and for every upload. No garment segmentation is claimed.
3. Map the overlay to actual video pixels. For `object-fit:cover`, scale `s=max(viewWidth/sourceWidth,viewHeight/sourceHeight)` and offsets `(sourceWidth*s-viewWidth)/2`, `(sourceHeight*s-viewHeight)/2`. Source x is `(overlayX+offsetX)/s`; likewise y. Account for preview container offsets, rotation, and any mirroring. Clamp to bounds. Store normalized source ROI, never CSS coordinates.
4. Decode with browser color management into an sRGB canvas (`getContext('2d',{colorSpace:'srgb',willReadFrequently:true})` where supported). Respect EXIF orientation exactly once. Feature-test image decoding paths. Never treat Display-P3 bytes as sRGB. Default canvas fallback requires the device/fixture validation below.
5. Preserve a source crop up to 1024 pixels on its longest edge for spatial diagnostics. Take 4,096 samples from a 64×64 stratified grid, one source pixel per cell, deterministically jittered using seed 1. Do not average each cell: thin black/white stripes must not turn gray. Repeat with seed 2 only for the stability check. Sample positions are preserved. Transparent pixels with alpha <250 are invalid; do not composite them onto black.
6. Require at least 1,024 valid samples and a source ROI of at least 64×64 pixels. Otherwise request a larger crop. Permit at most 20 MiB files; check decoded dimensions and reject >24 megapixels if resize-on-decode is unavailable. Handle decode failures and memory errors without losing navigation.
7. Record near-black fraction (`max(R,G,B)<=3`) and near-white fraction (`min(R,G,B)>=252`) before calibration. These are ambiguity indicators, not proof of bad exposure. Keep them in clustering: deleting dark/bright pixels would delete real black/white fabric.
8. No global median and no automatic gray-world balancing. Both can destroy the requested distinctions. Use robust representatives **within** clusters only.

Optional live feedback analyzes at most 2 frames/second at 1,024 samples and only says “Ready” or suggests reframing; Capture always performs the full scan. No requirement for continual live recognition in the first release.

## 4. RGB → CIELAB

Use **CIELAB, D65 white, 2° observer**, consistently in every stored profile and comparison. This is not CSS `lab()`, which uses D50; render swatches using sRGB HEX/RGB. Do not mix D50 library output with this database. sRGB uses nonlinear encoding; linearize before XYZ. The W3C documents conversion conventions and the D50/D65 distinction in [CSS Color 4](https://www.w3.org/TR/css-color-4/#color-conversion-code).

For each 8-bit channel, `c=v/255`, then `linear=c/12.92` when `c<=0.04045`, otherwise `((c+0.055)/1.055)^2.4`.

```text
X = .4124564R + .3575761G + .1804375B
Y = .2126729R + .7151522G + .0721750B
Z = .0193339R + .1191920G + .9503041B
f(t) = cubeRoot(t) if t > 216/24389 else ((24389/27)t+16)/116
L = 116 f(Y/1.00000) - 16
a = 500 [f(X/.95047) - f(Y/1.00000)]
b = 200 [f(Y/1.00000) - f(Z/1.08883)]
```

Executable conversion code is in `spec/generate-colors.mjs`. Keep full precision during analysis; round only serialized seed values and display. After calibration, feed corrected linear RGB directly into XYZ, avoiding a second linearization. Encode back to sRGB only for display: `12.92c` if `c<=.0031308`, else `1.055c^(1/2.4)-.055`.

## 5. Delta E matching

Use Euclidean Lab distance (ΔE76) for fast k-means assignments, and CIEDE2000 (ΔE00) for final matching and cluster merge decisions, with `kL=kC=kH=1`. Implement the standard formula as an isolated pure module. It adjusts a/chroma, handles circular hue differences, computes lightness/chroma/hue scale factors and a blue-region rotation term. Explicitly handle zero chroma, atan2 normalization to [0,360), and the 180° hue wrap. Do not substitute plain RGB distance.

Implementation authority and test vectors: [Sharma, Wu and Dalal, CIEDE2000](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/). Implement from the published equations; review licenses before copying supplied programs. Pass all published supplemental pairs to absolute tolerance 0.0001, including hue-wrap cases. One smoke pair: `[50,2.6772,-79.7751]` vs `[50,0,-82.7485]` → `2.0425`.

For each representative, compute ΔE00 to every seed. Later, each approved profile adds a candidate with distance penalty +2. A canonical color's score is the minimum of its seed distance and approved profile distances plus penalty. Rank canonical IDs, deduplicate aliases, break exact ties by ID. Return top 3 with distances; do not invent percentages for alternatives. If best distance >18, display “Unrecognized color” and group Other while retaining nearest matches as suggestions. Distances 10–18 receive an uncertainty flag.

## 6. Reference color database

`spec/colors.json` contains 57 initial clothing colors, including every requested example plus denim, faded denim, muted and pastel colors. Fields: `id,name,hex,rgb,lab,laundryGroup,family,aliases`. Envelope: schemaVersion, paletteVersion, colorSpace, source. HEX is the authored value; RGB, Lab and default group are generated. Aliases are search labels, not duplicate samples.

These are illustrative clothing-color anchors, not spectrophotometer measurements or universal definitions of names. Expand through controlled labeled examples and held-out evaluation. Denim means a blue color descriptor, not a fabric recognition claim. Keep navy, dark blue, charcoal, black and soft black as separate candidates; if the match margin is small, show alternatives rather than forcing a confident distinction.

## 7. Laundry grouping and configurable precedence

Separate `detectedColorId`, `family`, and `laundryGroup`. A navy garment can be blue-family and belong in Darks. Expose settings with a “Standard color sorting” preset and per-color overrides; store a rule version/hash with each result. The seed's `laundryGroup` documents the default for its exact anchor. At runtime evaluate the measured cluster Lab, not that static field.

Apply rules in this order:

1. Confirmed multicolor → Multicolor (unless the user explicitly corrects this scan).
2. Unrecognized/invalid quality classification → Other, with “Needs review”. Do not assign a normal confident group.
3. Saved per-color group override for a recognized canonical ID.
4. `L>=94 and C=sqrt(a²+b²)<=4` → Whites.
5. `L<38` → Darks, including navy, dark brown and burgundy.
6. Matched family red → Reds / Pinks, including light pink.
7. `L>=75` → Lights, including pale blue, cream, ivory and beige.
8. Remaining family neutral → Grays; blue → Blues; green → Greens; yellow/orange → Yellows / Oranges; brown → Browns / Beiges; red → Reds / Pinks; purple → Other.

All 11 requested categories exist, even when empty. Stable IDs: whites, lights, darks, reds-pinks, blues, greens, yellows-oranges, browns-beiges, grays, multicolor, other. Configuration can change thresholds and family mappings (e.g. purple to Darks), but cannot silently relabel a saved result. Boundary flags: within 2 L units of 38, 75 or 94, or within 1 C unit of the white threshold, reduce group confidence. Surface this only when perturbing across the boundary actually changes the group. Color grouping is a user sorting convention, not a claim about wash compatibility.

## 8. Lightweight clustering and multicolor

Fit k=1…5 on the unaveraged Lab samples using deterministic farthest-point initialization (first center is the sample closest to the component-wise median; next maximizes distance to its nearest existing center). Up to 12 Lloyd iterations, stop if all center movements <0.2 ΔE76. Reseed empty clusters with the farthest residual sample; stop adding centers if all residuals are zero. Repeat with a second deterministic initial first sample (maximum residual from median); retain smaller within-cluster squared error. Never run CIEDE2000 for every Lloyd pixel assignment.

Choose k minimizing `N*ln(max(SSE/N,1)) + 4*k*ln(N)`. This is a practical penalized distortion rule, not a statistical guarantee. Merge closest cluster pairs whose representative ΔE00 <6, recompute weighted representatives, repeat until none qualify. The representative is the actual sample nearest the component-wise Lab median in that cluster. Report its RGB and Lab; do not average different clusters to create the main swatch.

Keep sample fractions unweighted for coverage. Minor clusters remain in the data; do not renormalize just the visible major colors. “Other colors 5%” accounts for omitted clusters. Round using largest-remainder rounding so displayed percentages sum to 100. They represent sampled target area, not the entire garment.

A significant cluster has >=15% of valid samples. A candidate multicolor result requires at least two significant clusters with pairwise ΔE00 >=15 and total significant coverage >=70%. If a secondary cluster occupies 8–15%, label “Possible accent color” and offer a wider crop; it does not meet automatic Multicolor. Preserve all component matches.

### Distinguishing pattern from illumination

Do not merge clusters solely because their hue matches. That would erase black/white patterns. On a 128×128 diagnostic crop, assign each pixel to its nearest center. Compute transitions across right/down neighboring labels. A boundary is sharp if the immediate neighbor lightness difference is >=8; sharpBoundaryFraction is sharp boundary edges divided by all boundary edges. For each cluster also count occupied cells in a 4×4 grid (cell occupied when >=10% of its pixels belong to that cluster).

Strong pattern evidence: significant pair ΔE00 >=15 and sharpBoundaryFraction >=0.35; or both significant clusters appear in >=6 grid cells with sharpBoundaryFraction >=0.20. Require agreement on multicolor status and major proportions within 10 percentage points in the second jittered sample. This handles repeated stripes and sharp blocks, subject to resolution.

If multicolor color criteria hold but spatial evidence or sampling agreement fails, return `patternStatus:'ambiguous'`, group Other, display “Pattern or shadow—try flat, even lighting” and retain component swatches. A hard-edged shadow can still resemble a pattern: offer recapture/manual correction rather than claiming certainty. For candidate pairs with `|ΔL|>=15` and chromatic-plane distance `sqrt(Δa²+Δb²)<6`, always add a lighting ambiguity flag, even if edges are sharp; confidence cap 70. Real black/white stripes still return Multicolor when pattern evidence passes, never Gray.

Highlights and shadows: mark only isolated components <=2% of samples as possible artifacts when `L>97,C<5` or `L<3`. Exclude them from a cluster's representative estimation only if >50% of that cluster remains; retain their area and original cluster assignments for pattern detection. Large bright or dark patches are never discarded. No method can uniquely separate reflectance from lighting using one uncalibrated image.

## 9. Confidence and abstention

The displayed number is **heuristic match confidence**, not calibrated probability of correctness. Tooltip: “Based on color similarity and image quality; lighting can change the result.” Never present the example 94% as a measured accuracy claim.

For each significant recognized cluster define clamp(x)=min(1,max(0,x)):

```text
fit = exp(-(d1/10)^2)
margin = clamp((d2-d1)/6)   # next different canonical ID
compact = exp(-(medianDE00ToRepresentative/8)^2)
stability = 1-clamp(DE00(repSeed1, closestRepSeed2)/8)
quality = 1 - .35*clamp((nearBlackFraction+nearWhiteFraction)/.5)
score = round(100*(.35*fit+.20*margin+.15*compact+.15*stability+.15*quality))
```

Use per-cluster medians and clip fractions, not a global compactness that punishes true multicolor. No detected cast does not prove neutral light: cap all uncalibrated scores at 85. Cap calibrated scores at 95 until empirically calibrated. Cap at 65 if >20% samples are near clipping, at 60 if d1>10, and at 55 if top two competing IDs differ by <1 ΔE00. Apply caps after weighted score. Hard failures (too few samples, invalid calibration, decode error) produce no numerical confidence.

For single-color results use the largest cluster score. For multicolor use the minimum significant-cluster score, capped at 85; the ambiguous lighting case above also caps at 70. Pattern classification is heuristic and separately stored. For group confidence, compute the distance margin to the nearest candidate that would map to a different group; substitute that margin into the same formula and cap at 60 for an active group boundary flag. This permits high Darks confidence with uncertain navy/black naming. Result UI shows color confidence, and a text note if group confidence differs by >=15 points.

Labels: >=80 High, 60–79 Moderate, <60 Low. Low confidence still shows a tentative recognized match unless d1>18, but requires a visible “Check result” message; never automatically uploads or saves a correction.

## 10. Lighting and white-reference calibration

Default is no correction. Advise diffuse daylight or neutral indoor light, avoid glare and deep folds. Camera auto white balance is not controlled consistently across devices. Do not brighten black clothing to medium gray or normalize every scan's exposure.

Calibration is optional, session scoped, and uses a matte white or known neutral gray object placed beside the garment under the same light. The user selects the reference patch outside the garment ROI. Prefer measuring both from the same captured frame. For live calibration, retain gains only while the same camera/torch/session remains active, expire after 2 minutes, and show “Recalibrate if lighting changes.” Clear on camera switch, torch change, backgrounding, or new uploaded image. Do not apply a previous photo's calibration to an upload.

Measure medians in linear RGB. Require >=256 patch samples, median encoded channel range 40–245, <2% near-clipped pixels, and per-channel median absolute deviation <=0.03 in linear RGB. Reject visibly colored references using user guidance; software cannot prove a patch is neutral. Let `m=(r+g+b)/3`, gains `[m/r,m/g,m/b]`; require each gain in [0.67,1.5], otherwise request better light/reference. Apply gains to linear RGB, clamp to [0,1], and record newly clipped fraction. If >5% garment samples newly clip, do not silently accept: discard calibration and show recapture guidance. Do not normalize reference brightness to 1; a gray card removes cast without forcing exposure. This is diagonal white balancing, not full camera color calibration.

Warm/cool cast compensation can improve names but cannot recover clipped colors, mixed illuminants, fluorescence, metamerism, or automatic tone mapping. If different parts of fabric have different casts, request one evenly lit patch. Provide a one-tap comparison with uncorrected result and a clear calibration reset.

## 11. UI and state behavior

Home: title “Laundry Color Scanner”, primary Scan Clothing, secondary Upload Photo, small “Photos stay on this device unless you choose AI review.” Settings exposes grouping, saved profiles, export/delete local data, and offline readiness.

Camera: full preview, central outlined target, instruction, Capture, Flash, Calibration, Cancel. Flash means continuous torch only when the track advertises torch capability; otherwise hide it or label Unavailable. Handle constraint rejection. Stop tracks when leaving Camera, backgrounding, or canceling. Never request microphone access. Permission denied/unavailable gets clear retry instructions and Upload Photo.

Crop/review: captured image with movable target, optional neutral patch, Analyze and Retake. Initial camera capture can analyze the default target immediately; keep Adjust Target on results. Upload always permits confirming the target. Pattern prompt suggests a wider target containing all visible garment colors.

Analyzing: brief progress indicator, cancel, no fabricated percentage. A failed worker can retry on the main thread in small asynchronous chunks once; then return a recoverable error.

Results: large representative swatch, Detected Color, Laundry Group, “Match confidence: 82% · High”, top three Closest Matches, lighting/uncertainty guidance, Scan Another, Correct Result, Add Reference. Multicolor shows separate swatches and sampled percentages; never an averaged swatch. Display color names beside every swatch, including for screen readers.

Correct Result: editable canonical color search, group dropdown, optional note and “unknown / pattern” choices. Save correction locally only after Save; confirmation distinguishes a saved correction from detector learning. Do not retroactively change the original machine result. Add Reference requires choosing the known color and explicitly saving a numeric profile; it does not retain the picture.

State machine: Home → Camera or FileDecode → Crop/Analyze → Results → Correction/Reference → Results. Calibration is a Camera/Crop substate. Any cancel returns to prior stable state and releases unneeded resources. Browser back behaves like Cancel. Ignore late decode/worker responses after navigation.

Use >=44 CSS-pixel controls, visible focus, keyboard-operable crop controls and numeric crop fallback, WCAG AA text contrast, safe-area insets, text zoom, polite live-region result announcements, reduced motion, and no color-only status cues. Prevent double capture taps.

## 12. Data structures

Use JSON-compatible plain objects; runtime validation rejects NaN, Infinity, out-of-range values and unknown schema versions. Lab arrays are always [L,a,b]. Times are ISO strings; IDs use crypto.randomUUID with a tested fallback.

```ts
type Calibration = {
  schemaVersion: 1; gains: [number,number,number];
  referenceLinearRgb: [number,number,number];
  sourceId: string; cameraSessionId: string|null;
  createdAt: string; expiresAt: string; torch: boolean;
};
type Cluster = {
  lab: [number,number,number]; rgb: [number,number,number];
  fraction: number; spreadMedianDE00: number;
  matches: {colorId:string; distance:number; source:'seed'|'profile'}[];
  confidence: number|null;
};
type ScanResult = {
  schemaVersion:1; id:string; createdAt:string;
  detectorVersion:string; configVersion:string; paletteVersion:string;
  groupingVersion:string; profileSetVersion:string;
  source:'camera'|'upload'; roi:{x:number;y:number;width:number;height:number};
  calibration:Calibration|null;
  clusters:Cluster[]; detectedColorId:string|null;
  patternStatus:'single'|'multicolor'|'ambiguous';
  laundryGroup:string; confidence:number|null; groupConfidence:number|null;
  confidenceKind:'heuristic'; qualityFlags:string[];
  sampleCount:number; qualityMetrics:Record<string,number>;
};
type Correction = {
  schemaVersion:1; id:string; createdAt:string;
  original:ScanResult;
  corrected:{colorId:string|null; laundryGroup:string; patternStatus:string};
  note:string; usedForLearning:false;
};
type ReferenceProfile = {
  schemaVersion:1; id:string; colorId:string;
  lab:[number,number,number]; spreadMedianDE00:number;
  source:'user'|'curated'; status:'pending'|'approved'|'disabled';
  captureCondition:'neutral'|'calibrated'|'unknown';
  colorSpace:'CIELAB-D65-2deg';
  detectorVersion:string; createdAt:string; sampleCount:number;
};
```

Store actual calibration gain provenance and numeric quality metrics needed to reproduce score decisions. No EXIF, location, device fingerprint or raw photo. Schema implementation can use JSDoc; TypeScript tooling is not required.

## 13. Corrections, persistence, and learning

IndexedDB database `laundry-color-scanner`, version 1, stores `settings` (key name), `corrections` (id, createdAt index), and `profiles` (id, colorId index). A scan is ephemeral unless saved as a correction/profile. Handle private browsing, quota errors and denied storage: scans still work and UI explicitly reports “Could not save locally.” Never promise that browser storage survives eviction.

Corrections are evidence for future detector improvements, not automatic training labels. Their original feature summaries and version IDs support later analysis; opt-in export produces versioned JSON without pictures. Include import validation, 5 MiB cap, record cap 5,000, confirmation of merge counts, ID deduplication, and migration tests. Free text is rendered with textContent, never HTML. Offer per-record delete and Delete All Local Data. No synchronization.

Reference updates must be explicit. Keep at most 20 active profiles per color; combine near duplicates (ΔE00<2) after confirmation or ask the user to remove an old one. Corrections do not automatically change these profiles. Local profiles are removable and scoped to this origin/browser.

## 14. Reference photo preprocessing

Implement `scripts/build-reference-profiles.mjs` using the same pure detector modules as runtime. A manifest supplies local image path, manually verified canonical color ID, normalized garment ROI, optional neutral ROI, lighting label and image license/provenance. Decode through a color-managed pipeline and normalize to sRGB; choose a build-time decoder only after confirming ICC/EXIF behavior with fixtures. Fail a record rather than silently dropping its profile information.

Run the same sampling, calibration and clustering. Accept a single-color profile only if largest cluster >=85%, spread median ΔE00 <=6, no severe clipping, and known neutral/calibrated conditions. Save its representative, spread, sample count and versions; mark as pending. Emit a report of rejected records and measurements for review. For patterned photos retain a labeled cluster distribution in the build report for testing; do not collapse it into a color centroid or add it as a single-color candidate.

A curator approves profiles after checking the crop and known color. Keep 3–10 useful, distinct examples per canonical color. A profile >12 ΔE00 from its seed requires palette review instead of automatic approval. Ship only approved numeric JSON, never source photos. The original photo repository is a development-only input with its own consent/license management. Runtime compares a few Lab vectors, not whole images.

In-app Add Reference follows identical quality gates and previews the proposed profile. Unknown lighting may save a pending profile but cannot enable it for matching. Never infer that the camera's predicted label is ground truth. Test any enabled profile set against held-out garments before shipping curated updates.

## 15. PWA and browser behavior

Camera access requires a secure context and permission; rear-camera preference is a constraint request rather than a guarantee. Handle unsupported devices and release tracks when switching cameras. See [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

Serve HTTPS (localhost for development). The manifest contains name, short_name, id, start_url, scope, display:standalone, theme/background colors, 192/512 icons and a separate maskable icon. Resolve paths relative to deployment base so subdirectory hosting works. Include an Apple touch icon. Offer installation only where the relevant browser API exists; on Safari show platform-appropriate manual Add to Home Screen guidance after feature/platform detection. Do not make installation necessary for scanning.

Service worker precaches same-origin app HTML/CSS/JS, worker modules, icons, palette and configuration. Use a build-version cache, validate every required resource during install, keep the old worker if installation fails, and expose “Offline ready” only after activation and cache verification. Use cache-first versioned static assets and a navigation shell fallback inside app scope; do not intercept arbitrary cross-origin or non-GET requests. No image, upload or AI-response caching. [MDN service worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers) describes installation, activation and cache management.

Prompt “Update available” and activate on user reload from Home, never mid-scan. Delete obsolete application caches during activation, not unrelated origin caches. Bundle palette/config/worker in one atomic version so an old UI cannot call a new incompatible detector. Offline basic capture, upload, detection and correction work after one successful online installation; first-ever offline load cannot work. Test browser tab and installed modes separately on actual iOS Safari and Android Chrome. Service worker or IndexedDB failure must not prevent online core scanning.

## 16. Optional AI fallback

Disabled in the initial app; no automatic invocation. Results can offer “Review with AI” only if a provider is configured and the scan is low-confidence, pattern-ambiguous, or explicitly selected as difficult. Show the exact cropped image, provider name, and “This crop will be sent to [provider] for analysis. It may leave your device.” Require a per-request Send action; Cancel sends nothing. Strip metadata by re-encoding the crop and limit its longest side to 768 pixels. Retain original local analysis alongside the separately labeled AI suggestion.

Provider interface: `analyze({imageBlob,localSummary,allowedColorIds,allowedGroupIds,signal}) -> {colorId|null,groupId,pattern,components,explanation}`. Validate allowed IDs, finite fractions summing within .02 of 1, bounded text lengths and schema. AI text is untrusted and rendered as text. AI-reported confidence is never presented as detector confidence.

Use an optional same-origin serverless proxy with provider adapters when enabled. Keep credentials server-side, enforce body limits, authentication/abuse controls, timeout 15 seconds, cancel support and no automatic retry or photo logging. The default static deployment needs no proxy. No API keys in browser code, URLs, localStorage or the service worker. Disclose actual provider retention terms when choosing a provider; do not promise zero retention without verified terms. Offline, timeout and refusal leave the local result intact. AI advice is optional and does not authorize a correction/profile save.

## 17. Testing and acceptance

Automated numerical tests: RGB black → [0,0,0], white → approximately [100,0,0], red → [53.2408,80.0925,67.2032] (tolerance .001); all palette RGB/Lab consistency; full CIEDE2000 reference suite; identical colors yield zero; distance symmetry; zero-chroma/hue-wrap handling; deterministic clustering; finite scores; group precedence/boundaries; calibration round trips in synthetic linear light.

Synthetic image fixtures: solid palette anchors, noisy solids, gradients, 50/50 and 52/43/5 black-white-other stripes at multiple spatial frequencies, two blocks, checkerboards, 10% accent, navy/black mixture, transparent edges, clipped highlights, smooth/hard shadows, calibrated warm/cool casts. Expected: clear resolved black/white stripes return Multicolor with each area within 5 percentage points, never Gray. At unresolved spatial frequencies abstain if detectable ambiguity exists; do not claim that aliased image data can be recovered. Smooth illumination should not produce a confident Multicolor result. Group fixtures must exercise every requested category and overrides.

Real evaluation set before claiming accuracy: at least 60 garments across light/dark/neutrals/pastels/patterns, 3 lighting setups (daylight, warm indoor, cool indoor), 2 phones, and paired calibrated/uncalibrated scans where practical. Label canonical or acceptable-name sets under neutral light; establish sorting targets with the configured rules. Include black/navy/charcoal, cream/white, beige/light brown, burgundy/red, blue/light blue, denim/faded/pastel pairs. Split by garment, not by image, so the same garment does not leak between tuning and test. Report sample counts, top-1/top-3 acceptable-name accuracy, group accuracy, abstention rate, multicolor precision/recall and confusion matrices. Do not tune on the held-out subset.

Proposed release targets, not achieved results: >=90% group accuracy on accepted single-color neutral/calibrated held-out images; >=90% multicolor recall and >=90% precision on resolved pattern images; accepted coverage >=80% on normal neutral-light images. Publish difficult-lighting results separately. Review all confident incorrect classifications. If targets fail, adjust thresholds/palette and revalidate with fresh holdout data or narrow claims; never simply inflate confidence. Probability calibration, if desired later, requires a separate calibration split, reliability bins and Brier/ECE reporting.

Browser tests: permission allow/deny, no camera, busy camera, rear-camera fallback, torch unavailable, orientation and object-fit crop mapping, EXIF 1–8, sRGB/P3 files, JPEG/PNG/WebP and unsupported HEIC, large/invalid files, cancellation races, storage failure/migration, offline reload, update during scan, iOS background/resume, installation, keyboard and screen-reader flows. Test airplane mode and network logs: ordinary scans transmit no photos or pixel/profile data. Verify Delete All removes stores and pending in-memory saved data. AI mock tests cover consent, schema rejection, cancellation, no keys/logging/cache and no request before Send.

## 18. Performance recommendations

Targets on a documented midrange phone: processing p50 <150 ms and p95 <400 ms for 4,096 samples, capture-to-result p95 <800 ms excluding permission/file picker. Record device/OS/browser and decode, sample, cluster, match and total timings separately. Initial compressed core assets target <200 KiB excluding icons; no large ML model. These are budgets to measure, not present claims.

Use typed arrays, a 256-entry linearization lookup for uncalibrated 8-bit pixels, cached seed Lab, one worker, transferable buffers, and bounded iterations. Reserve ΔE00 for representatives and final metrics (a few thousand comparisons, not every k-means assignment). Do not retain full decoded images between scans. Close ImageBitmap, revoke object URLs, clear large canvases and stop tracks. Feature-test OffscreenCanvas; main-thread canvas extraction plus worker arrays is the baseline. Delay optional AI modules and reference import UI until used. If the budget is exceeded, lower live-feedback frequency before reducing capture accuracy.

## 19. Edge cases and explicit limits

- Solid very dark fabric: preserve pixels, report navy/black alternatives and clipping ambiguity; do not boost saturation to guess hue.
- White versus cream: require high L and low C for Whites; warmer neutrals normally become Lights. A warm cast without calibration can remain ambiguous.
- Folded fabric and hard shadows: preserve components and suggest flatter lighting; shadow/pattern separation is not guaranteed.
- Multicolor garment with one-color crop: result applies only to crop. Prompt wider framing when the user suspects a pattern.
- Fine heather, denim texture and faded fabric: close clusters merge; broad spread lowers confidence. Do not infer material or care instructions.
- Skin, table, hanger or calibration card inside target: adjust crop; no hidden background-removal claim.
- Metallic, fluorescent, iridescent or translucent material: “Appearance changes with lighting”; recapture or manual assignment. Camera RGB cannot measure spectral reflectance.
- Bright saturated single-channel clipping: add a channel-clipping metric/flag (any channel >=252) for quality guidance; avoid treating every saturated red pixel as a white highlight. Validate any resulting score penalty separately.
- HEIC without browser decoder: offer JPEG/PNG conversion guidance. Do not upload to a conversion service automatically.
- Invalid reference/empty cluster/zero SSE: explicit guards and deterministic fallbacks; no NaN results.

## 20. Claude Code implementation sequence and completion checklist

1. Read this blueprint and generated palette; implement one app in this repository. Preserve stable IDs and versioned interfaces. Resolve any later changes by updating this document, not adding an alternate implementation.
2. Implement pure color math and run numerical fixtures first. Copy the reproducible seed data into the runtime build.
3. Implement sampling, clustering, diagnostics, matching, grouping and score functions. Verify synthetic pattern and dark/light regressions before UI integration.
4. Build Home → Camera/Upload → Results with crop controls, worker cancellation, fallback paths and accessibility. Verify source-coordinate mapping on physical phones.
5. Add calibration, correction storage and numeric reference profiles with explicit save/reset/delete behavior.
6. Add manifest, service worker, offline checks and update handling. Run network privacy tests and real-device browser tests.
7. Collect the garment validation set, tune configuration on development garments, then report held-out metrics and measured performance. Document known failures. All thresholds in this document are initial defaults and must be versioned if changed.
8. Ship the local MVP when acceptance criteria pass. Keep AI disabled unless a separately configured provider/proxy and disclosure have been implemented and verified.

Core pipeline pseudocode:

```js
async function analyze(input, config, palette, profiles) {
  const samples = sampleSourceRoi(input, {count:4096, seed:1});
  requireValidSamples(samples);
  const quality = measureRawQuality(samples);
  const calibrated = validateAndApplyCalibration(samples, input.calibration);
  const labs = toLabD65(calibrated);
  const clusters = fitSelectMergeAndRepresent(labs, config);
  const spatial = analyzeBoundaries(input, clusters);
  const repeat = clusterSecondSample(input, config, {seed:2});
  const pattern = classifyPattern(clusters, spatial, repeat);
  const matches = matchCanonicalColors(clusters, palette, profiles);
  const groups = applyOrderedRules(matches, clusters, pattern, config);
  const confidence = scoreAndCap(matches, quality, repeat, groups, input.calibration);
  return serializeVersionedResult({clusters,matches,groups,pattern,quality,confidence});
}
```

Completion evidence should include numerical test output, synthetic fixture results, real-device behavior matrix, held-out garment metrics, measured timing distribution, and a network trace showing zero normal image uploads. This handoff supplies the design and seed data; implementation and empirical validation remain Claude Code's work.

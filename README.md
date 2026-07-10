# earth

![earth](./asset/view.png)

A minimal replica of the meteorological visualization from
[earth.nullschool.net](https://earth.nullschool.net/).The core algorithms are ported from [cambecc/earth](https://github.com/cambecc/earth) (MIT):

- **GFS grid interpolation** — bilinear interpolation of u/v wind components on a 0.25°×0.25° global grid
- **Projection distortion** — wind vectors are warped by the orthographic projection's local derivatives, so particle motion looks correct everywhere on the globe
- **Sinebow overlay** — the globe surface is colored by wind speed using earth's extended sinebow color scale (0–100 m/s), pastelized 22% toward white (the raw sinebow's saturated storm band renders brown over a dark map; nullschool's modern palette is lighter)
- **Particle animation** — thousands of particles advected through the field, drawn as fading grayscale trails bucketed by intensity


## Project structure

```
.
├── vercel.json                  # points Vercel's output at public/, sets cache headers
├── README.md
├── start.sh                     # local launcher: serves public/ on :8420 and opens browser
├── scripts/
│   └── refresh_wind.py          # data refresh, pygrib-based (verified working)
└── public/                      # the entire deployable site
    ├── index.html               # four stacked canvases (#map, #overlay, #lines, #animation) + burger-menu HUD
    ├── css/styles.css           # dark theme, bottom-left HUD bar + expandable menu panel
    ├── js/wind.js               # the whole engine (~600 lines, no build step)
    ├── js/menu.js               # burger-menu toggle, tab switching, layer-change dispatch (~40 lines)
    ├── libs/
    │   ├── d3.v7.min.js         # vendored D3 v7
    │   └── topojson-client.min.js
    └── data/
        ├── current-wind-surface-level-gfs-0.25.json  # GFS 10 m u/v wind, 0.25°×0.25°, grib2json format (~9.2 MB)
        ├── current-wind-1000hpa-gfs-0.25.json        # GFS u/v wind @ 1000 hPa (~9.2 MB)
        ├── current-wind-500hpa-gfs-0.25.json         # GFS u/v wind @ 500 hPa (~9.5 MB)
        ├── current-wind-10hpa-gfs-0.25.json          # GFS u/v wind @ 10 hPa (~10 MB)
        ├── earth-topo.json      # Natural Earth coastline/lake topology (50m + 110m)
        ├── countries-50m.json   # world-atlas@2 countries topology (political borders, idle detail)
        └── countries-110m.json  # world-atlas@2 countries topology (borders while dragging)
```

## How it works (rendering pipeline in `js/wind.js`)

1. **Load** — fetches the wind JSON and three topologies in parallel; `buildGrid()` indexes the
   two GFS records (u: parameterCategory 2 / parameterNumber 2, v: 2/3) into a 1440×721 grid with
   a duplicated wrap-around column, exposing `interpolate(λ, φ)` (bilinear; grid geometry is read
   from the header, so any regular lat/lon resolution works). Rows are flat Float32Arrays
   ([u0, v0, u1, v1, …]) — at 0.25° the grid exceeds 1M cells and per-cell JS arrays would cost
   hundreds of MB. Political borders are derived with
   `topojson.mesh(countries, (a, b) => a !== b)` — internal boundaries only, coastlines excluded.
2. **Map layers** — orthographic projection (`d3.geoOrthographic`, clip angle 90°). Sphere fill
   and graticule draw on `#map` *below* the color overlay; coastlines (1.6 px, full white),
   country borders and lakes draw on `#lines` *above* it — beneath the 0.72-alpha overlay the
   outlines dimmed to ~30% and vanished behind the trails. Uses 110m geometry while dragging,
   50m when idle. Both rendered at devicePixelRatio for crisp lines.
3. **Mask** — the sphere is filled with a sentinel color (magenta, unreachable by the sinebow
   scale) on an offscreen canvas; its imageData tells the interpolator which pixels are on the
   globe (alpha > 0) and later doubles as the overlay image.
4. **Field interpolation** — for every 2nd pixel of the visible globe: invert-project to (λ, φ),
   sample the wind, distort the vector by the projection's finite-difference derivatives
   (velocity scale = `bounds.height / 60000`), and store a screen-space motion vector per pixel
   ("columns"). Simultaneously the pixel's overlay color is written into the mask imageData using
   the extended sinebow scale at alpha 0.5. Runs in cooperative batches (100 ms work / 25 ms
   yield) so the UI never freezes; progress is shown in the HUD. On completion, leftover sentinel
   pixels at the antialiased rim are erased, then the imageData is blitted to `#overlay`.
5. **Particle animation** (`#animation` canvas) — `width × 10 × min(dpr, 2)` particles (×0.75 on
   mobile), each advected by the field vector at its pixel, respawned after 100 frames or when it
   exits the globe. The canvas is devicePixelRatio-scaled and strokes are 1 *device* px wide
   (`PARTICLE_LINE_WIDTH / dpr`) for fine nullschool-like trails. Trails fade via a
   `destination-in` fill of `rgba(0,0,0,0.97)` per frame (slower fade → long fluid streamlines);
   segments are bucketed into 13 near-neutral intensity styles (130→255, r×0.90/b×0.92, alpha
   0.70→0.50 falling with speed; grayscale 85→255 opaque in the original). Strokes are almost
   white on purpose: the hue comes from the overlay bleeding through (pink over the red eyewall,
   pale green over green) — a stronger green stroke tint muddied red zones into brown. Max
   intensity at 25 m/s; one `beginPath` per bucket.
   25 fps (`setTimeout`, 40 ms), matching the original. A **streak guard** respawns any particle
   whose per-frame move exceeds what the dataset's max wind speed can produce at the current
   zoom (×2 slack) — see [Fixed bugs](#fixed-bugs) for the sizing.
6. **Interaction** — drag rotates (sensitivity 75/scale °/px, φ clamped to ±90°), wheel zooms
   (0.5×–8× of the fitted scale), click reads wind speed at a point via `projection.invert` +
   `grid.interpolate`. Any manipulation cancels the current field/animation via a shared cancel
   token and hides the particle trails; while the pointer moves, `drawOverlayPreview()` repaints
   the color field **live at low resolution** (every 5th px, throttled to ~25 fps, upscaled with
   canvas smoothing) so the "smudged" overlay tracks the rotating/zooming globe outline exactly,
   like nullschool. A 200 ms debounce after release triggers the full recompute, whose
   `putImageData` replaces the preview wholesale. Window resize does the same, preserving
   relative zoom. Note: the preview must mask off-disc pixels **by radius** — d3-geo clamps
   `asin`, so `projection.invert` returns finite mirrored coordinates outside the globe.

### Key constants (top of `wind.js`, values taken from the original)

| Constant | Value | Meaning |
|---|---|---|
| `OVERLAY_ALPHA` | 0.72 × 255 | overlay transparency (0.4 in the original; near-opaque like nullschool) |
| `MAX_PARTICLE_AGE` | 100 | frames before a particle respawns |
| `PARTICLE_MULTIPLIER` | 3.5 | particles per pixel of globe width (7 in the original), further × min(dpr, 2); low → fewer, thicker, distinct traces |
| `FRAME_RATE` | 40 ms | ~25 fps animation |
| `MAX_INTENSITY` | 25 m/s | wind speed of brightest particle trail (17 in the original; higher cap keeps storm bands from saturating white) |
| `VELOCITY_SCALE` | 1/42000 | particle screen speed per m/s (× globe height × zoom factor below) |
| `ZOOM_SPEED_EXPONENT` | 0.6 | speed ∝ (initialScale/scale)^0.6: grows gently with zoom (~2× at 6×) — 1.0 made all tracks short/sparse, 0 made close-ups frantic |

(`PARTICLE_LINE_WIDTH` is 1.8 device px. **Particle screen speed is partially zoom-normalized**
via `ZOOM_SPEED_EXPONENT` — full normalization (exponent 1) made every track short and sparse,
no normalization (exponent 0) made close-ups a frantic white blaze that overshot the eyewall
vortex; 0.6 grows speed gently with zoom and `MAX_PARTICLE_STEP` (12 px) backstops stability.
The streak guard uses the same zoom factor. The streak-guard threshold is no longer a constant — it's computed per view from the dataset's
max wind speed and the projection scale; see [Fixed bugs](#fixed-bugs). Particle screen speed
deliberately grows with zoom — real-world physics seen closer up — and the guard scales the
same way. Trail strokes use the 100→255 tinted ramp at flat 0.55 alpha and fade by
0.97/frame — long fluid streamlines. Two de-whitening ramp experiments (ceiling 220,
speed-dependent alpha 0.6→0.35) were tried and **reverted by user preference**: the brighter
eyewall is accepted in exchange for the luminous long-streamline look.)



## Data

`public/data/current-wind-surface-level-gfs-0.25.json` holds GFS 10 m surface wind (u/v,
0.25°×0.25°, values rounded to 0.1 m/s; ~9.2 MB raw / ~2.5 MB gzipped by Vercel) in grib2json
format. **Last refreshed: GFS analysis 2026-07-10 00:00 UTC.** Upgraded 1° → 0.5° → 0.25°
(nullschool's resolution) on 2026-07-10 for aesthetic parity; before that it was the 2014-01-31
sample shipped with cambecc/earth. The HUD's "Data:" line always shows the loaded snapshot's
timestamp.

Three pressure-level datasets (added 2026-07-10, all GFS analysis 2026-07-10 06:00 UTC) sit
beside it: `current-wind-{1000hpa,500hpa,10hpa}-gfs-0.25.json` — UGRD/VGRD on isobaric
surfaces via the same filter CGI (`lev_1000_mb`/`lev_500_mb`/`lev_10_mb`). The engine's
`LAYERS` registry maps menu layer ids to these files; `buildGrid()` is level-agnostic
(records are picked by parameterCategory/Number only) and the data-driven streak guard and
color scale absorb the much faster jet-stream (500 hPa) and polar-night-jet (10 hPa) winds
with no per-level tuning.

To refresh (preferred path, verified working — no Java needed):

```sh
python3 -m venv gribenv && ./gribenv/bin/pip install pygrib
./gribenv/bin/python scripts/refresh_wind.py            # surface (10 m)
./gribenv/bin/python scripts/refresh_wind.py 500hpa     # or: 1000hpa, 10hpa
```

The script finds the newest published GFS cycle on NOMADS (walking back 6 h at a time — cycles
appear ~4–5 h after their nominal time), downloads only the 10 m UGRD/VGRD fields via the grib
filter CGI (`filter_gfs_0p25.pl`, file `gfs.t{hh}z.pgrb2.0p25.f000`; NB the 0.5° product is
named `pgrb2full.0p50`, the 0.25° one plain `pgrb2`), decodes with pygrib, and overwrites the
JSON in place. Pass a local `.grib2` path as an argument to skip the download. Grid geometry
(nx/ny/dx/dy) is derived from the GRIB, and `buildGrid()` reads it from the header, so any
regular lat/lon resolution works end-to-end.

Gotchas learned the hard way:

- The **`.anl` files do not expose 10 m winds** through the filter CGI (returns
  "data file is not present"). Use **`f000`** of the newest cycle instead — it's the
  analysis-hour forecast, effectively identical.
- A cycle's directory can exist on NOMADS before its grid files do; the script's fallback
  handles this (e.g. it skipped an empty 00z and used the previous day's 18z).

`public/data/earth-topo.json` is Natural Earth coastline/lake topology (50m + 110m), from
cambecc/earth. `countries-{50m,110m}.json` are vendored from
[world-atlas@2](https://github.com/topojson/world-atlas) (Natural Earth derived) for political
borders.

## Fixed bugs

- **Streaking lines across the globe** (fixed & verified 2026-07-10): thin straight chords
  appeared over the disc, drawn by the particle animation. Root cause: the finite-difference
  projection distortion **diverges at the globe's limb** (not just the poles) — headless
  instrumentation showed screen-space vectors of 170–2400 px/frame originating exclusively at
  rim pixels (~90° from the view center), which were stroked as straight lines when they landed
  back on the disc. Fix: `evolve()` in `wind.js` respawns any particle whose per-frame move
  exceeds the streak-guard threshold (see next entry for how that threshold is sized).
- **Missing trails in high-wind areas when zoomed in** (fixed & verified 2026-07-10): the first
  streak-guard threshold was a fixed screen distance (`max(10 px, 2% of globe height)`), but a
  particle's legitimate per-frame move grows with zoom (∝ projection scale). At ~5×+ zoom a real
  35–40 m/s eyewall wind moves 20–40 px/frame and was killed as a "streak", leaving a dead
  annulus with no trails exactly over the red high-speed zone of the typhoon. Fix: the guard is
  now sized from the data — `buildGrid()` records the dataset's max wind speed, and the
  threshold is `max(10 px, 2 × maxSpeed × bounds.height × VELOCITY_SCALE × px-per-degree)`,
  where px-per-degree = `projection.scale() × π/180`. Legit fast wind passes at any zoom; limb
  artifacts (5–100× beyond it) are still caught. Reproduced and verified headlessly at 8× zoom
  via the `#rotate=-128.5,-21.5&zoom=8` URL hash; default view re-verified streak-free.
- **Stray red sentinel pixels on the antialiased rim** (fixed earlier): the cleanup pass at the
  end of `interpolateField()` erases leftover magenta sentinel pixels. Verified clean in the
  2026-07-10 screenshots.
- **Frozen overlay misaligned during drag/zoom** (fixed 2026-07-10): the first freeze-frame
  implementation left the stale overlay static while the map outline rotated/scaled beneath it,
  so the color disc visibly detached from the globe (wrong size while zooming, wrong hemisphere
  while dragging). Fix: live low-res overlay preview during manipulation (see pipeline step 6).
  First attempt painted a colored square around the globe because `projection.invert` returns
  finite coordinates for off-disc points (d3-geo's clamped asin) — masked by radius check.
  Verified by headless screenshot of the preview pass: clean disc, aligned with coastlines,
  visually near-identical to the full-res overlay.
- **Stale data/engine after refresh** (fixed 2026-07-10): after refreshing the wind JSON and
  fixing wind.js, a plain browser reload still showed the 2014 date and the streaks. Chrome's
  normal reload only revalidates the HTML document — the `<script>` and `fetch()`ed JSON follow
  heuristic caching and were served stale from disk cache. The data fetches use
  `{cache: "no-cache"}` so they revalidate on every load (cheap 304 when unchanged). A `?v=`
  cache-busting scheme on the script tag was used during heavy iteration and later removed for
  simplicity (user preference) — after editing wind.js, view changes with a hard reload
  (Ctrl+Shift+R).

## Aesthetic-parity pass

- **Done & verified** (headless Chromium screenshots): 0.5° data renders with red typhoon
  eyewall + bright core, political borders, finer/dimmer particle trails, brighter overlay;
  no streaks; no rim artifacts; no console errors; HUD reads "GFS 0.5°" and the current run's
  date. Post-change metrics vs the nullschool reference screenshot: brightness 0.52 (target
  0.53), red-tint pixels 360 (reference 179, previously 0).
- **Human-verified**: drag freeze-frame behavior (user confirmed it matches nullschool).
  Follow-up fix the same day: the overlay now re-projects live at low resolution during
  drag/zoom so it tracks the globe outline instead of sitting frozen and misaligned; the
  preview render itself is headless-verified, the drag feel needs one more human pass.

- **Baseline measurement**: saturation already matched (0.71 theirs / 0.69 ours); 
  theirs was brighter (0.53 vs 0.46) with 179 red eyewall pixels vs our 0, and finer/denser trails. 

  All four gaps were closed:

   - **Red tints at intense wind** — was a *data resolution* issue, not a color-scale issue: the
   scale's red band lives at ~35–45 m/s and the 1° grid smoothed the typhoon eyewall to
   38.9 m/s. **Done:** data upgraded to 0.5° (peak 40.5 m/s → red ring + bright core verified
   in a zoomed crop).
   - **Trail texture** — ours was sparser/chunkier (fat CSS-px strokes, ramp maxing white at
   17 m/s). **Done:** `#animation` canvas is dpr-scaled with 1-device-px strokes, particle
   count ×10 multiplier ×min(dpr, 2), ramp floor 85→64, fade 0.97→0.96. Second pass
   (user-requested): trail ramp tinted green and `VELOCITY_SCALE` raised 1/60000→1/40000 for
   nullschool-like motion speed; the streak guard scales with `VELOCITY_SCALE`, so both bug
   fixes hold automatically. Third pass (user comparison at matched zoom): multiplier 10→6 and
   fade 0.96→0.97 (fewer, longer, fluid streamlines instead of dense fur), ramp floor 64→100
   (slow-wind trails bright and distinct, not dark-gray mush), tint deepened to r×0.78/b×0.82,
   `OVERLAY_ALPHA` 0.5→0.55 (leaf-green field dominates over the trails).
   - Overlay luminance** — **done:** `OVERLAY_ALPHA` 0.4→0.5 (measured brightness now 0.52 vs
   target 0.53).
   - **Political borders** — **done:** vendored world-atlas countries topologies;
   `topojson.mesh(…, (a, b) => a !== b)` draws internal boundaries at 0.25 alpha.
   - **Fourth pass** (user comparison): trail alpha 1.0→0.85 (overlay bleeds through trails —
   red eyewall stays visible), data upgraded 0.5°→0.25° (nullschool's resolution; grid rows
   refactored to Float32Arrays to keep memory sane), graticule alpha 0.07→0.12 (their visible
   lat/lon mesh).
   - **Fifth pass** ("cyclone too white", measured): in the eyewall ring 10.8% of our pixels
   were white-ish vs nullschool's 0.0%. First fix used short dashes + zoom-normalized speed
   (0.2% white), but the user preferred the long streamlines and physical zoom-scaled speed,
   so the **sixth pass** restored fade 0.97 / age 100 / zoom-growing velocity (streak guard
   re-scaled to match). Two further ramp experiments (ceiling 255→220, then speed-dependent
   alpha 0.6→0.35; measured 3.9% and 2.1% white cover) were **reverted — the user preferred
   the brighter long-streamline look** (flat 0.55 alpha, full 100→255 ramp, ~4.8% white in the
   eyewall crop). Final aesthetic: luminous fluid streamlines; nullschool's 0% white comes from
   short dashes, deliberately not adopted.

## HUD / burger menu (2026-07-10)

The bottom-left HUD is collapsed by default to a slim bar (`☰ earth` + transient
status line; page/HUD title is plain "earth", per user request). The burger button expands `#menu-panel` upward, nullschool-style, containing:

   - **Tabs** — hierarchical and exclusive: one top-level domain active at a time, and each
     domain displays exactly **one** layer (unlike nullschool, layers are never combined).
     Atmosphere holds four wind layers: **Surface (10 m), 1000 hPa, 500 hPa, 10 hPa** —
     buttons carry `data-layer` ids matching the `LAYERS` registry in `wind.js`; clicking
     dispatches a `layerchange` CustomEvent, and `loadLayer()` in the engine swaps the
     dataset, restarts the pipeline, and syncs the active-button state (single source of
     truth). `#layer=<id>` in the URL hash selects the initial layer (also the
     headless-testing hook, since the menu needs a click). An **Ocean tab** (with "Currents"
     and "Temperature" layers) is written but commented out in `index.html` — the user asked
     not to show it until those pages are ready; uncomment the two marked blocks to enable.
   - Data source + snapshot date lines, the color-scale bar, the click-for-wind-speed
     readout, and credits — all IDs (`#scale`, `#data-date`, `#location`, `#status`)
     unchanged, so `wind.js` needed no edits; `#status` lives in the always-visible bar so
     load progress/errors show while collapsed.

Logic lives in `js/menu.js` (plain JS, ~30 lines). CSS gotcha encountered: `.tab-body` uses
`display: flex`, which beats the HTML `hidden` attribute's UA-stylesheet `display: none` —
hence the explicit `.tab-body[hidden] { display: none; }` rule. Headless verification: the
burger can't be clicked headlessly; screenshot the open state by temporarily removing the
`hidden` attribute from `#menu-panel` (and restore it).

## Next steps

   - **Ocean layers**: build real "Currents" and "Temperature" pages (e.g., OSCAR currents /
     RTGS SST), then uncomment the Ocean tab blocks in `index.html`. The layer-switching
     plumbing now exists (`LAYERS` registry + `loadLayer()` + `layerchange` event, built for
     the pressure-level wind layers) — ocean layers mainly need their data pipelines and,
     for temperature, a scalar-overlay render mode (no particles).
   - Automate data refresh (e.g., a GitHub Action running `scripts/refresh_wind.py` every 6 h
     and redeploying) — otherwise the deployed snapshot goes stale from deploy day.
   - Touch pinch-zoom (only wheel zoom is implemented). A read-only URL-hash initial view
     already exists (`#rotate=λ,φ&zoom=k`, e.g. `#rotate=-128.5,-21.5&zoom=5` centers the
     typhoon; also the headless-testing hook) — writing the hash back on interaction like the
     original remains open.

## Version control / Feature deployment structure

Agreed branching model for growing the project beyond surface wind. **Executed 2026-07-10**
for the pressure-level wind layers: `refactor/layer-engine` merged first (`LAYERS` registry +
`loadLayer()` + per-level refresh script), then `feature/wind-1000hpa`, `feature/wind-500hpa`
and `feature/wind-10hpa` — each branched off updated `main` sequentially, verified headlessly
via the `#layer=<id>` hash before merging with `--no-ff`. Branches kept locally; not pushed.

- **`main` is the only long-lived branch**, always deployable. Vercel's production deployment
  points at it. Everything else is short-lived: branch off `main`, build, merge, delete.
- **One short-lived feature branch per render**: `feature/ocean-currents`,
  `feature/ocean-temperature`. Vercel gives every branch a preview URL automatically, which
  fits the screenshot-based visual verification workflow — compare a branch's render against
  production side by side before merging.
- **Do the shared-engine refactor first, on its own branch (`refactor/layer-engine`), and
  merge it before starting either ocean layer.** `wind.js` currently hardcodes the wind
  layer; the engine must split into a shared core (projection, canvas stack, drag/zoom,
  overlay preview, menu wiring) plus per-layer modules (data source, color scale, particle
  vs. scalar rendering — ocean temperature is likely a pure overlay with no particles,
  unlike currents). If both ocean branches instead modify the monolithic `wind.js`
  independently, the second merge will be painful; after the refactor each feature branch
  touches only its own layer module.
- **Keep data refreshes out of feature branches.** The ~9 MB wind JSON updates on its own
  cadence (eventually 6-hourly via GitHub Action); those commits land directly on `main`.
  Mixing snapshot churn into feature history bloats it and guarantees merge noise. If the
  repo eventually carries one large JSON per layer refreshed several times a day, repo size
  will balloon — consider having the refresh Action deploy data to Vercel without committing
  it (a later problem).
- **Avoid** a `develop` branch or gitflow (pure ceremony at this scale) and long-lived
  parallel feature branches — the features share the engine, so divergence is the main risk
  and prompt merges are the cure.
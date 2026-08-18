# earth

![earth](./asset/view.png)

A minimal replica of the meteorological visualization at
[earth.nullschool.net](https://earth.nullschool.net/): an orthographic globe with a colored
scalar field and thousands of particles advected through a live vector field. Eleven layers
across two domains (Atmosphere, Ocean) are driven by NOAA GFS, NOAA GFS-Wave and Copernicus
Marine (CMEMS) data.

The site is static — four stacked canvases, vanilla JS, vendored D3 v7 + topojson-client, no
build step, no framework. The core algorithms are ported from
[cambecc/earth](https://github.com/cambecc/earth) (MIT):

- **Grid interpolation** — bilinear interpolation of u/v components on a regular lat/lon grid
  (0.25°×0.25° globally), NaN-tolerant so fields with land holes reach their coastline.
- **Projection distortion** — flow vectors are warped by the orthographic projection's local
  derivatives, so particle motion looks correct everywhere on the globe.
- **Sinebow overlay** — the sphere is colored by wind speed through earth's extended sinebow
  scale (0–100 m/s), pastelized 22% toward white; the raw sinebow's saturated storm band
  renders brown over a dark map, while nullschool's modern palette is lighter.
- **Particle animation** — thousands of particles advected through the field, drawn as fading
  trails bucketed by intensity.

## Quick start

```sh
./start.sh            # serves public/ on http://localhost:8420 and opens a browser
```

Any static server works — `start.sh` is just
`python3 -m http.server 8420 -d public` plus an `xdg-open`.

The twelve weather datasets are **not in the repo** ([Data](#data)). For a working local page,
either refresh them into `public/data/` (see [Refreshing the data](#refreshing-the-data)) or
borrow the deployed bucket with the `#data=` hash below.

All URL-hash options are read once at load and can be combined with `&`:

| Hash | Meaning |
|---|---|
| `#layer=<id>` | initial layer: `surface`, `1000hpa`, `500hpa`, `10hpa`, `temperature`, `rh`, `dew`, `ocean`, `ocean25`, `sst`, `waves` |
| `#rotate=λ,φ` | initial center, e.g. `#rotate=-128.5,-21.5` (φ clamped to ±90°) |
| `#zoom=k` | initial zoom, 0.5–8× the fitted scale |
| `#data=<url>` | fetch the weather JSONs from this base URL instead of local files / R2 |

`#layer=` and `#rotate=`/`#zoom=` are also the headless-testing hooks: the burger menu needs a
real click, and a specific view can otherwise only be reached by dragging.

After editing `wind.js` or `menu.js`, reload hard (Ctrl+Shift+R) — there is no cache-busting on
the script tags. Data fetches use `{cache: "no-cache"}`, so refreshed datasets appear on a plain
reload.

Deployment: live at **[globe-climatesim.vercel.app](https://globe-climatesim.vercel.app)**. Vercel
serves `public/` (`vercel.json` sets `outputDirectory` and cache headers), the weather JSONs come
from a Cloudflare R2 bucket, and `.github/workflows/refresh-data.yml` refreshes them every six
hours without touching git ([Automated refresh](#automated-refresh)). The full runbook — bucket,
CORS, secrets, cadence toggle, maintenance playbook — lives in `earth-vercel-deploy.md` at the repo
root, which is **git-ignored on purpose** (it holds ops notes and credentials handling).

## Project structure

```
.
├── vercel.json                  # points Vercel's output at public/, sets cache headers
├── start.sh                     # local launcher: serves public/ on :8420, opens a browser
├── README.md
├── earth-vercel-deploy.md       # deployment runbook — git-ignored, local only
├── asset/view.png               # the screenshot above
├── .env/                        # git-ignored credentials: copernicusmarine, r2
├── .github/workflows/
│   └── refresh-data.yml         # 6-hourly refresh of all 12 datasets → R2 (no commits, no deploys)
├── scripts/
│   ├── refresh_wind.py          # GFS winds + 2 m scalars via NOMADS, pygrib (anonymous)
│   ├── refresh_ocean.py         # CMEMS currents + thetao via copernicusmarine (credentialed)
│   ├── refresh_waves.py         # GFS-Wave (WAVEWATCH III) height/period/direction (anonymous)
│   └── upload_data.sh           # ships public/data/current-*.json to the Cloudflare R2 bucket
└── public/                      # the deployable site (code + static assets only)
    ├── index.html               # four stacked canvases (#map, #overlay, #animation, #lines) + HUD
    ├── css/styles.css           # dark theme, bottom-left HUD bar + expandable menu panel
    ├── js/wind.js               # the whole engine (~1220 lines, one IIFE)
    ├── js/menu.js               # burger toggle, tab switching, layerchange dispatch (~40 lines)
    ├── libs/
    │   ├── d3.v7.min.js         # vendored D3 v7 (includes d3-scale-chromatic)
    │   └── topojson-client.min.js
    └── data/
        ├── current-*.json       # the 12 weather datasets — GIT-IGNORED (data/code split):
        │                        #   refresh scripts write them here for local dev,
        │                        #   upload_data.sh ships them to Cloudflare R2 for production,
        │                        #   wind.js picks local vs R2 by hostname (see Data)
        ├── earth-topo.json      # Natural Earth coastline/lake topology (50m + 110m) — in git
        ├── countries-50m.json   # world-atlas@2 countries topology (borders + land, idle detail)
        └── countries-110m.json  # world-atlas@2 countries topology (borders + land, while dragging)
```

The topologies are static assets, not data: they stay in git and always load relative to the
page, never through the R2 root.

## How it works

Everything lives in `public/js/wind.js` — one IIFE, no modules, sectioned as color scales →
grids → projection → canvases → mask/field → drag preview → animation → HUD → orchestration →
boot. `public/js/menu.js` only translates clicks into events; the engine owns all state.

### Rendering pipeline

1. **Load** — `init()` fetches the three topologies in parallel, builds the meshes, then
   `loadLayer()` fetches the active layer's flow dataset (plus its scalar dataset, if any).
   `buildGrid()` indexes the two flow records (u: `parameterCategory` 2 / `parameterNumber` 2,
   v: 2/3) into a `nj`-row grid with a duplicated wrap-around column and exposes
   `interpolate(λ, φ)`. Grid geometry comes from the header (`nx`, `ny`, `lo1`, `la1`, `dx`,
   `dy`), so any regular lat/lon resolution and either 0°/-180° origin works. Rows are flat
   `Float32Array`s (`[u0, v0, u1, v1, …]`) — at 0.25° the grid exceeds 1M cells and per-cell JS
   arrays would cost hundreds of MB. The bilinear is NaN-tolerant: hole corners drop out and the
   remaining weights renormalize, so color and flow reach the last valid cell instead of
   retreating half a cell from every coast. `buildGrid()` also records the dataset's maximum
   speed, which sizes the particle streak guard. `buildScalarGrid()` does the same for
   single-record scalar files. Political borders come from
   `topojson.mesh(countries, (a, b) => a !== b)` (internal boundaries only, coastlines excluded)
   and the ocean layers' landmass from `topojson.merge` of all country polygons.
2. **Map layers** — orthographic projection (`d3.geoOrthographic`, clip angle 90°, fitted scale
   `min(width, height) × 0.42`). Sphere fill (`#101018`), sphere outline and graticule draw on
   `#map` *below* the color overlay; coastlines (1.6 px, full white), country borders and lakes
   draw on `#lines` *above* it — beneath the overlay's alpha the outlines dimmed to ~30% and
   vanished behind the trails. Ocean layers additionally fill the merged landmass charcoal
   (`#333338`) on `#lines`, which crops both the grid staircase and any particle that strays
   past the coast. 110m geometry is used while dragging, 50m when idle; both canvases render at
   `devicePixelRatio` for crisp lines.
3. **Mask** — the sphere is filled with a sentinel color (magenta, unreachable by any of the
   color scales) on an offscreen canvas. Its `imageData` tells the interpolator which pixels are
   on the globe (alpha > 0) and then doubles as the overlay image.
4. **Field interpolation** — for every 2nd pixel of the visible globe: invert-project to (λ, φ),
   sample the flow, distort the vector by the projection's finite-difference derivatives, and
   store a screen-space motion vector per pixel ("columns", written in 2×2 blocks). The screen
   velocity scale is `bounds.height × layer.velocityScale × (initialScale / scale)^ZOOM_SPEED_EXPONENT`.
   Simultaneously each pixel's overlay color is written into the mask `imageData` by
   `overlayColorAt()`, which dispatches to the layer's scalar colormap, to the flow magnitude
   itself (`fromMagnitude` layers), or to the default wind-speed sinebow. Work runs in
   cooperative batches (100 ms work / 25 ms yield) so the UI never freezes, with progress in the
   HUD. On completion, leftover sentinel pixels at the antialiased rim are erased and the
   `imageData` is blitted to `#overlay` with `putImageData`.
5. **Particle animation** (`#animation`) — `globeBounds().width × multiplier × min(dpr, 2)`
   particles (×0.75 on mobile), each advected by the field vector at its pixel and respawned
   when it ages out or leaves the globe. The canvas is `devicePixelRatio`-scaled and strokes are
   1.8 *device* px wide (`lineWidth / dpr`) for fine nullschool-like trails. Trails fade via a
   `destination-in` fill of `rgba(0, 0, 0, fade)` per frame over the globe bounds; segments are
   bucketed into near-neutral intensity styles (`INTENSITY_SCALE_STEP` apart, from a brightness
   floor of 130 to 255 — 13 buckets) with one `beginPath` per bucket. Runs at 25 fps
   (`setTimeout`, 40 ms), like the original. Two per-layer variants share the loop: long fluid
   streamlines (winds, currents) and the wave layers' `crestLength` mode, which strokes an
   oriented dash *perpendicular* to travel through the segment midpoint. A **streak guard**
   respawns any particle whose per-frame move exceeds what the dataset's maximum speed can
   produce at the current zoom (×2 slack) — see [Fixed bugs](#fixed-bugs) for the sizing.
6. **Interaction** — drag rotates (sensitivity `75 / scale` °/px, φ clamped to ±90°, sub-3 px
   movement stays a click), wheel zooms (`exp(-deltaY × 0.0018)`, clamped to 0.5×–8× of the
   fitted scale), a click reads the values under the pointer via `projection.invert` +
   `interpolate`. Any manipulation cancels the running field/animation through a shared cancel
   token and clears the trails; while the pointer moves, `drawOverlayPreview()` repaints the
   color field **live at low resolution** (every 5th px, throttled to ~25 fps, upscaled with
   canvas smoothing) so the "smudged" overlay tracks the globe outline exactly, like nullschool.
   A 200 ms debounce after release triggers the full recompute, whose `putImageData` replaces the
   preview wholesale; a resize (250 ms debounce) does the same while preserving relative zoom.
   Note: the preview must mask off-disc pixels **by radius** — d3-geo clamps `asin`, so
   `projection.invert` returns finite mirrored coordinates outside the globe.

### Layer registry

`LAYERS` in `wind.js` maps a layer id to its flow file, optional `scalar` spec
(`{file, lut, min, max, scaleLabel, format}` or `{fromMagnitude: true, …}`), particle tuning,
credit/date lines, `landFill` and the click-readout format. `index.html`'s menu buttons carry
matching `data-layer` ids. One layer is displayed at a time; layers are never combined.

| Layer id | Menu button | Particles from | Overlay | Scale |
|---|---|---|---|---|
| `surface` | Atmosphere → Wind @ Surface | GFS 10 m u/v | wind speed, pastelized sinebow | 0 – 360 km/h |
| `1000hpa` | Atmosphere → Wind @ 1000 hPa | GFS u/v @ 1000 hPa | 〃 | 〃 |
| `500hpa` | Atmosphere → Wind @ 500 hPa | GFS u/v @ 500 hPa | 〃 | 〃 |
| `10hpa` | Atmosphere → Wind @ 10 hPa | GFS u/v @ 10 hPa | 〃 | 〃 |
| `temperature` | Atmosphere → Temperature | GFS 10 m u/v | 2 m TMP through matplotlib `bwr` | -10 – 45 °C |
| `rh` | Atmosphere → Humidity | GFS 10 m u/v | 2 m RH through `BuPu` | 0 – 100 % |
| `dew` | Atmosphere → Dew Point | GFS 10 m u/v | 2 m DPT through `PuBuGn` | -40 – 35 °C |
| `ocean` | Ocean → Current-Surface | CMEMS uo/vo @ 0.494 m | current speed, segmented ocean palette | 0 – 1.5 m/s |
| `ocean25` | Ocean → Current-25m | CMEMS uo/vo @ 25.211 m | 〃 | 〃 |
| `sst` | Ocean → Temperature | CMEMS surface currents | CMEMS thetao through `bwr` | 0 – 35 °C |
| `waves` | Ocean → Waves | GFS-Wave propagation u/v (magnitude = peak period) | significant wave height, blue → saffron | 0 – 15 m |

Colormaps come from the vendored D3 bundle's `d3-scale-chromatic` (`colormapLut()` samples an
interpolator into a 256-entry LUT), except `bwr` — a hand-rolled two-segment ramp — and the
ocean/wave palettes, built by `segmentedLut()` from `[value, [r, g, b]]` stops. Values outside a
domain pin to the end colors because the LUT index is clamped. `buildGrid()` is level-agnostic
(records are picked by parameter category/number only), and both the streak guard and the color
scales are data-driven, so the much faster jet-stream (500 hPa) and polar-night-jet (10 hPa)
winds need no per-level tuning.

### Key constants

Top of `wind.js` unless noted; per-layer overrides live in each `LAYERS` entry's `particles`.

| Constant | Value | Meaning |
|---|---|---|
| `OVERLAY_ALPHA` | 0.72 × 255 | atmosphere overlay opacity (0.4 in the original; near-opaque like nullschool) |
| `OCEAN_ALPHA` | 0.58 × 255 | ocean/wave overlay opacity — calm sea stays near-black so trails and crests read on top |
| `MAX_PARTICLE_AGE` | 100 frames | trail lifetime before respawn (waves override: `maxAge` 20) |
| `PARTICLE_MULTIPLIER` | 3.5 | particles per px of globe width (7 in the original), × min(dpr, 2); low → fewer, thicker, distinct traces (ocean 4, waves 3) |
| `PARTICLE_REDUCTION` | 0.75 | particle-count factor on mobile user agents |
| `PARTICLE_LINE_WIDTH` | 1.8 device px | divided by dpr at stroke time (ocean 1.7, waves 2.5) |
| `FRAME_RATE` | 40 ms | ~25 fps animation |
| `MAX_INTENSITY` | 25 m/s | speed of the brightest trail (17 in the original; a higher cap keeps storm bands from saturating white) — ocean 0.7 m/s, waves 22 s |
| `VELOCITY_SCALE` | 1/42000 | particle screen speed per m/s, × globe height × zoom factor (ocean 1/1700, waves 1/360000) |
| `ZOOM_SPEED_EXPONENT` | 0.6 | speed ∝ (initialScale/scale)^0.6 — grows gently with zoom, ~2× at 6× |
| `MAX_PARTICLE_STEP` | 12 px | cap on the Euler step; a numerical-stability backstop, not a speed model |
| `INTENSITY_SCALE_STEP` | 10 | brightness step between trail buckets (floor 130 → 13 buckets; waves' `brightnessFloor` 40 → 22) |
| `MAX_TASK_TIME` / `MIN_SLEEP_TIME` | 100 / 25 ms | field-interpolation work and yield slices |
| `OVERLAY_PREVIEW_STEP` / `_WAIT` | 5 px / 40 ms | drag-preview sampling stride and throttle |
| `H` | 3.6e-5 ° (≈4 m) | finite-difference step for the projection distortion |
| `NO_DATA_GRAY` | `[51, 51, 56]` | = the `#333338` land fill; ocean layers paint dataless water (Caspian, Aral, coastal grid holes) like land instead of leaving a black hole |

The streak-guard threshold is *not* a constant: it is computed per view as
`max(10 px, 2 × grid.maxSpeed × bounds.height × velocityScale × zoomFactor × pxPerDegree)`.

### Tuning notes

Why the numbers are what they are. All of it was settled by measurement against nullschool
screenshots plus user review; see [Changes](#changes) for the order things happened in.

- **Overlay color.** Wind speed maps onto the extended sinebow over 0–100 m/s (hence the
  "0 – 360 km/h" scale label), pastelized 22% toward white so the storm band reads bright
  salmon/gold instead of brown over the dark map. The calm end is blended toward deep indigo
  `rgb(4, 1, 146)` with `t = min(v/15, 1)^1.4`, which holds the deep tone through a typical
  3–7 m/s ocean breeze and releases into the pastel scale by 15 m/s, leaving greens and storm
  colors untouched. The parity measurements that drove this (taken during the parity pass, at 0.5°
  data and 0.5 overlay alpha, so they are the reasoning rather than current readings): brightness
  0.52 against the reference's 0.53, saturation 0.69 vs 0.71, red-tint pixels 360 vs 179 — and 0
  before the resolution upgrade, because the red band lives at ~35–45 m/s and only appears once
  the grid is fine enough to resolve an eyewall peak.
- **Trail color.** Strokes are almost white on purpose — `rgb(j × 0.90, j, j × 0.92)` with alpha
  falling 0.70 → 0.50 as speed rises. The hue comes from the overlay bleeding through (pink over
  a red eyewall, pale green over green); a stronger green stroke tint muddied red zones into
  brown, and constant high alpha let storm cores pile up into mush.
- **Trail shape.** Fade 0.97/frame with a 100-frame life gives long fluid streamlines. Two
  de-whitening experiments (brightness ceiling 220, then speed-dependent alpha 0.6 → 0.35) were
  measured and **reverted by user preference**: the brighter eyewall — ~4.8% white pixels in the
  eyewall crop when measured, against nullschool's 0% — is accepted in exchange for the luminous
  long-streamline look. Nullschool's 0% comes from short dashes, deliberately not adopted for the
  wind layers.
- **Zoom.** Particle screen speed is only *partially* normalized for zoom. Full normalization
  (exponent 1) made every track short and sparse; none (exponent 0) made close-ups a frantic
  white blaze that overshot tight vortices. 0.6 grows speed gently, `MAX_PARTICLE_STEP` backstops
  stability, and the streak guard uses the same zoom factor so both stay consistent.
- **Ocean.** Currents peak around 1.5 m/s against ~100 m/s winds, so they need ~25× the velocity
  scale to visibly flow and a brightness ramp that saturates at 0.7 m/s. The overlay is dimmer
  than the atmosphere's so calm ocean stays near-black and the trails read as the currents.
- **Waves.** Crests, not traces: dashes perpendicular to travel, a very small velocity scale
  (waves are localized and far slower than winds — the crests barely creep), a short life with a
  fast fade so each dash eases in and out without smearing, and `brightnessFloor` 40 to widen the
  brightness ramp. Because deep-water phase speed grows with period and the flow magnitude *is*
  the peak period, period-brightness is speed-brightness.

### HUD and menu

The bottom-left HUD is collapsed by default to a slim bar (`☰ earth` plus a transient status
line, which stays visible while collapsed so load progress and errors always show). The burger
expands `#menu-panel` upward, nullschool-style:

- **Domain tabs** stack vertically — each tab header sits directly above its own `.tab-body`, one
  domain expanded at a time. Atmosphere holds seven layers, Ocean four; all are live.
- **Layer buttons** dispatch a `layerchange` `CustomEvent` with the layer id.
  `loadLayer()` in the engine swaps the dataset(s), restarts the pipeline, and syncs the
  active-button state (single source of truth), including revealing the tab that owns the layer
  when booting from `#layer=`.
- **Data source and snapshot lines** (`#data-label`, `#data-date`) follow the layer's credit and
  `dateLabel`; the date is the loaded snapshot's own valid time (`refTime + forecastTime`),
  formatted as UTC — so the HUD always states which snapshot is on screen.
- **Scale bar** (`#scale`) is painted from the active overlay's LUT, with `#scale-label` from its
  `scaleLabel`; the **click readout** (`#location`) prints the scalar value · the flow value ·
  coordinates, formatted per layer (km/h for wind, m/s for currents, "m · s" for waves).

CSS gotcha: `.tab-body` uses `display: flex`, which beats the `hidden` attribute's UA-stylesheet
`display: none` — hence the explicit `.tab-body[hidden] { display: none; }` rule. Headless
gotcha: the burger can't be clicked, so screenshot the open panel by temporarily removing the
`hidden` attribute from `#menu-panel`.

## Data

### Data/code split

The `current-*` weather JSONs are **not in git**. The refresh scripts write them to
`public/data/` (git-ignored) so local dev works normally; production serves them from a
**Cloudflare R2 bucket**. In `wind.js` every weather-file URL goes through `DATA_ROOT`, resolved
once at load:

1. a `#data=<url>` hash override (for testing a bucket before wiring it in, e.g.
   `#layer=waves&data=https://bucket.example/`), then
2. local `data/` when served from `localhost`, `127.x`, `[::1]` or `file:`, otherwise
3. `R2_DATA_ROOT` — a constant at the top of the orchestration section, set to the bucket's
   public base URL.

All three paths are verified: localhost serving from `data/`, a cross-origin bucket via `#data=`,
and — since 2026-08-17 — the deployed site itself, where `data/current-*.json` 404s on the Vercel
origin and every weather fetch resolves to the bucket. The consequence that matters: data refreshes
create no commits, no force-pushes and no Vercel deploys — the repo carries no history churn and
Vercel only redeploys on code pushes.

`scripts/upload_data.sh` ships the files to R2 over the S3-compatible API with the AWS CLI
(`--cache-control "public, max-age=1800, must-revalidate"`). It globs `current-*.json`, so a
dataset added by a future layer is picked up automatically. Required environment (locally from the
git-ignored `.env/r2`): `R2_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional
`R2_BUCKET` (default `earth-data`).

**The r2.dev URL does not compress.** An earlier note here claimed Cloudflare's edge gzips the
JSON on the fly (~10 MB → ~2.5 MB); measured on 2026-08-17 that is false for the development
URL — both `curl --compressed` and an explicit `Accept-Encoding: gzip` return the full raw body
with no `Content-Encoding`. So every layer switch pulls its dataset uncompressed: ~100 MB for a
click-through of all 12. Vercel *does* serve the code and topologies with `content-encoding: br`;
Brotli for the weather files needs a **bucket custom domain** in front of R2 ([Next
steps](#next-steps)).

### The twelve datasets

All in grib2json format (the subset of header fields `wind.js` reads), all 0.25° global grids,
~100 MB total raw. GFS/GFS-Wave grids are 1440×721 with a 0° origin; the CMEMS grids are
1440×681 with a -180° origin (the store stops at 80°S).

| File | Contents | Source / script | Product arg |
|---|---|---|---|
| `current-wind-surface-level-gfs-0.25.json` | 10 m u/v wind (~9.4 MB) | GFS via `refresh_wind.py` | `surface` |
| `current-wind-1000hpa-gfs-0.25.json` | u/v @ 1000 hPa (~9.4 MB) | 〃 | `1000hpa` |
| `current-wind-500hpa-gfs-0.25.json` | u/v @ 500 hPa (~9.9 MB) | 〃 | `500hpa` |
| `current-wind-10hpa-gfs-0.25.json` | u/v @ 10 hPa (~10.1 MB) | 〃 | `10hpa` |
| `current-temp-surface-level-gfs-0.25.json` | 2 m temperature, K (~6.2 MB) | 〃 | `temperature` |
| `current-rh-surface-level-gfs-0.25.json` | 2 m relative humidity, % (~5.2 MB) | 〃 | `rh` |
| `current-dewpoint-surface-level-gfs-0.25.json` | 2 m dew point, K (~6.2 MB) | 〃 | `dew` |
| `current-ocean-currents-cmems-0.25.json` | u/v currents @ 0.494 m (~11.7 MB) | CMEMS via `refresh_ocean.py` | `currents` |
| `current-ocean-currents-25m-cmems-0.25.json` | u/v currents @ 25.211 m (~11.7 MB) | 〃 | `currents25` |
| `current-ocean-temp-cmems-0.25.json` | thetao, °C @ 0.494 m (~6.1 MB) | 〃 | `temperature` |
| `current-ocean-waves-gfswave-0.25.json` | wave propagation u/v; magnitude = peak period (s) (~10.9 MB) | GFS-Wave via `refresh_waves.py` | — |
| `current-ocean-wave-height-gfswave-0.25.json` | significant wave height, m (~5.1 MB) | 〃 (same download) | — |

Sources and how they are shaped:

- **GFS** (NCEP / US National Weather Service) — UGRD/VGRD on the requested level, or a single
  2 m scalar (TMP/RH/DPT), from the anonymous NOMADS grib filter CGI (`filter_gfs_0p25.pl`, file
  `gfs.t{hh}z.pgrb2.0p25.f000`), decoded with pygrib. Wind values are rounded to 0.1.
- **GFS-Wave** — the WAVEWATCH III model coupled into GFS, nullschool's credited source for its
  waves modes, via the same anonymous NOMADS CGI (`filter_gfswave.pl`, file
  `gfswave.t{hh}z.global.0p25.f000.grib2`, **no login needed**). One download of HTSGW + PERPW +
  DIRPW yields both wave files: propagation u/v whose magnitude is the peak period in seconds
  (DIRPW is the meteorological "direction from", so propagation = from + 180° — verified against
  the Southern Ocean westerlies, median 265°), plus the HTSGW scalar. Because the magnitude is
  the period, the period overlay and click readout come free from the `fromMagnitude` machinery
  — no third file.
- **CMEMS** (Copernicus Marine Service) — Global Ocean Physics Analysis & Forecast
  (`GLOBAL_ANALYSISFORECAST_PHY_001_024`), datasets `cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m`
  (uo/vo) and `cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m` (thetao), daily means read from the
  ARCO zarr store through the `copernicusmarine` toolbox and strided ×3 from 1/12° to ¼°
  (atmosphere-grid parity). Both datasets carry **50 depth levels** (0.494, 1.54, 2.65, 3.82,
  5.08, 6.44, 7.93, 9.57, 11.4, 13.5, 15.8 … 25.2 … 55.8 … 109.7 … 453.9 … 1062 … 5727.9 m); the
  shipped layers use 0.494 m and 25.211 m. A deeper layer needs only a new `PRODUCTS` entry with
  a `depth` bracket plus a `LAYERS` entry. Land cells are `null`, which the engine renders as
  charcoal, so land stays uncolored and particle-free for free. Store facts worth keeping: time
  is hours since 1950-01-01; the store also holds ~8 forecast days, and the script deliberately
  takes the newest day ≤ the requested one; uo/vo are float32 m/s with no scale/offset;
  latitude runs -80…90 and is flipped north-first for scan mode 0.

Both ocean sources ship a land mask a cell fatter than the vector coastline, which showed as a
charcoal staircase jutting into the sea. Both refresh scripts cure it in the data — CMEMS by
filling land-sampled points from the surrounding 7×7 full-resolution window during coarsening,
GFS-Wave by a 5×5 NaN-dilation at native 0.25° — and the engine's NaN-tolerant bilinear finishes
the job at render time.

### Refreshing the data

```bash
# The shared venv holds pygrib, numpy, copernicusmarine and the AWS CLI.
# If ~/.venvs/aws/bin is not in PATH, use the full paths below.

~/.venvs/aws/bin/python scripts/refresh_wind.py               # surface (10 m) wind
~/.venvs/aws/bin/python scripts/refresh_wind.py 500hpa        # or 1000hpa, 10hpa
~/.venvs/aws/bin/python scripts/refresh_wind.py temperature   # or rh, dew (2 m scalars)
~/.venvs/aws/bin/python scripts/refresh_waves.py              # both wave files from one download

set -a && source .env/copernicusmarine && set +a

~/.venvs/aws/bin/python scripts/refresh_ocean.py              # all three CMEMS products, today UTC
~/.venvs/aws/bin/python scripts/refresh_ocean.py currents25   # one product
~/.venvs/aws/bin/python scripts/refresh_ocean.py currents <YYYY-MM-DD>  # one product, given day

set -a && source .env/r2 && set +a
./scripts/upload_data.sh                                   # push public/data/current-*.json to R2
```

`refresh_wind.py` and `refresh_waves.py` find the newest published cycle on NOMADS by walking
back 6 h at a time from four hours ago (files appear ~3.5–5 h after the nominal cycle time),
download only the needed fields, and overwrite the JSON in place; pass a local `.grib2` path to
skip the download. `refresh_ocean.py` with no product argument refreshes all three CMEMS products
and logs a per-product progress/summary report (dataset, dimensions, selected record and depth,
ocean-vs-NaN cell counts, timings, output size).

The data on screen is a static snapshot: it only advances when a refresh script runs — unattended,
that means the workflow below. The HUD's `Data:` line always shows the loaded snapshot's own
timestamp, whatever its age.

### Automated refresh

`.github/workflows/refresh-data.yml` runs the three refresh scripts and then `upload_data.sh`, so
new data reaches production without a commit, a force-push or a Vercel deploy. It never needs write
access to the repo (`permissions: contents: read`), and `concurrency` keeps a slow run from racing
the next firing into a half-finished upload.

- **Cadence: 6-hourly, with a daily ocean anchor.** The cron fires at 00:45, 06:45, 12:45 and
  18:45 UTC; every slot refreshes GFS and GFS-Wave, and the **06:45 anchor slot** additionally
  refreshes CMEMS — the ocean products are daily means published once per day (~03:10–03:24 UTC),
  so the other slots would re-download an identical field. Set the repo *variable*
  `REFRESH_CADENCE=daily` to keep only the anchor slot — no workflow edit. `workflow_dispatch`
  always runs everything, so a manual **Run workflow** refreshes on demand.
- **How the toggle works.** Cron expressions can't read variables, so the schedule is written as
  *two* entries — `45 6 * * *` (the anchor) and `45 0,12,18 * * *` (the rest), the same four
  firings as the old `45 */6 * * *` — and the job's `if` compares `github.event.schedule`, which
  carries the triggering cron string verbatim. Anything but the anchor entry is dropped when the
  cadence is `daily`, and the CMEMS step's own `if` runs it only on the anchor (or any dispatch).
  This replaced a `gate` job that tested `date -u +%H -lt 6`: GitHub starts scheduled runs
  **15–85 minutes late** (measured across four consecutive slots), so a wall-clock gate would have
  silently dropped a whole day's refresh had lateness ever pushed a firing past the boundary.
  Cron-string comparison is immune to lateness, and a dropped slot is now a skipped job costing no
  runner rather than a green ~5-second gate run.
- **Snapshot age.** GFS publishes a cycle ~3.5–5 h after its nominal time and the scripts walk back
  from four hours ago, so each slot lands on the cycle that is 6 h 45 m old — 00:45 takes the
  previous 18z, 06:45 takes 00z, and so on. On-screen data is therefore **~7 h old just after a run
  and at most ~13 h before the next one.** The 06:45 anchor also sits >3 h after the CMEMS daily
  publication (~03:10–03:24 UTC), so the ocean layers show the **day-0 nowcast** — the old 00:45
  anchor fired ~75 min *before* publication and got the previous production's +1-day-lead
  forecast. For the same reason `REFRESH_CADENCE=daily` no longer sawtooths 8–32 h the way the
  00:45 anchor did (it missed each morning's 00z, which lands ~03:30–05:00 UTC, and then held the
  previous day's 18z for 24 hours): the 06:45 anchor catches both the fresh GFS 00z and the fresh
  CMEMS production.
- **CMEMS is fetched once per day, and time-pinned.** An earlier note here called the redundant
  ocean re-downloads "about a minute" and not worth fixing; measurement said otherwise. The
  store's dask chunking bundles 50 time steps per chunk, so `open_dataset` without a time subset
  pulled **~990 MB per variable read to keep ~20 MB** — ~4.9 GB per run, ~19.8 GB/day at four
  slots. `refresh_ocean.py` now pins `start_datetime`/`end_datetime` to one day (proven
  bit-identical output on the full 1/12° grid) with a walk-back over earlier days as a safety
  net, and the workflow's CMEMS step runs only on the anchor slot, taking CMEMS traffic to
  **~105 MB/day**. The cost: a failed anchor run leaves the ocean layers stale for 24 h — no
  later slot picks them up — accepted for the simpler gate. The three ocean objects simply keep
  their previous bytes on non-anchor slots, since `upload_data.sh` only globs files that exist on
  the runner.
- **Secrets** (repository scope, Actions): `COPERNICUSMARINE_SERVICE_USERNAME` /
  `_PASSWORD` for CMEMS, plus `R2_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` for the
  upload. GFS and GFS-Wave are anonymous. Vercel gets none of these — the site is fully static.
- **Failure shape:** the upload step runs last, so a CMEMS outage or login failure uploads
  *nothing* rather than shipping a half-refreshed set; the bucket keeps serving the previous
  snapshot and the site never breaks, it just ages.
- **Runtime ~4 minutes** for a full 12-dataset run (measured 3m49s, 3m48s and 3m25s) — free,
  since Actions minutes are unmetered on public repos. The CMEMS step was ~98 s of that; the
  time-pinned open should take it to ~20 s (dominated by `open_dataset` metadata round-trips),
  and the three non-anchor slots skip it entirely. `timeout-minutes: 20` is already generous.

### Credentials

- **GFS / GFS-Wave**: anonymous, nothing to configure.
- **CMEMS**: needs a Copernicus Marine account. The toolbox reads
  `COPERNICUSMARINE_SERVICE_USERNAME` / `COPERNICUSMARINE_SERVICE_PASSWORD`; locally these live
  in the git-ignored `.env/copernicusmarine` (`set -a && source .env/copernicusmarine && set +a`
  before running), and in CI they become GitHub Actions repository secrets. Anonymous access does
  **not** work: the ARCO zarr store serves `.zmetadata` and coordinate arrays publicly but
  returns 403 for every data chunk (verified across chunk indices and both dimension separators).
- **R2**: `.env/r2` holds `R2_ACCOUNT_ID` and the S3-compatible key pair; the token is scoped to
  one bucket with Object Read & Write only.

Never print or commit these; `.env/` is git-ignored.

### Gotchas learned the hard way

- The GFS **`.anl` files do not expose 10 m winds** through the filter CGI (it returns "data file
  is not present"). Use **`f000`** of the newest cycle instead — the analysis-hour forecast,
  effectively identical.
- A cycle's directory can exist on NOMADS before its grid files do, so the walk-back must key on
  the response actually being GRIB (the scripts check the magic bytes and a minimum size); it has
  skipped an empty 00z and used the previous day's 18z.
- The 0.5° GFS product is named `pgrb2full.0p50` while the 0.25° one is plain `pgrb2` — an easy
  404 if the resolution ever changes.
- `refresh_wind.py` **does not validate its product argument**: an unrecognized word falls through
  to `surface` and is then consumed as a *local GRIB path*, so a typo fails deep inside pygrib with
  an error that never mentions the typo. The seven valid names are `surface`, `1000hpa`, `500hpa`,
  `10hpa`, `temperature`, `rh`, `dew` — copy them, don't retype them, into any refresh loop.
- CMEMS's shallowest depth coordinate is 0.494025 m, so asking for `[0, 1]` works but warns; the
  script uses the interval `(0.494, 0.495)` instead.
- Dead ends already explored for ocean currents: NOMADS has no RTOFS filter, RTOFS 2ds is
  netCDF-only, NOMADS OPeNDAP is retired, OSCAR/jplOscar is stale. The working non-CMEMS fallback
  is NOAA CoastWatch ERDDAP `noaacwBLENDEDNRTcurrentsDaily` (0.25° blended geostrophic,
  `.ncoJson` + stride; needs curl — a python-urllib user agent gets 403).

## Fixed bugs

Each entry is root cause → fix, with how it was verified.

- **Streaking lines across the globe.** Thin straight chords appeared over the disc, drawn by the
  particle animation. The finite-difference projection distortion **diverges at the globe's limb**
  (not just at the poles): headless instrumentation showed screen-space vectors of 170–2400
  px/frame originating exclusively at rim pixels (~90° from the view center), stroked as straight
  lines whenever they landed back on the disc. `evolve()` now respawns any particle whose
  per-frame move exceeds the streak-guard threshold.
- **Missing trails in high-wind areas when zoomed in.** The first streak guard used a fixed screen
  distance (`max(10 px, 2% of globe height)`), but a legitimate per-frame move grows with zoom
  (∝ projection scale): at ~5×+ zoom a real 35–40 m/s eyewall wind moves 20–40 px/frame and was
  killed as a "streak", leaving a dead annulus with no trails exactly over the storm's red core.
  The guard is now sized from the data — `buildGrid()` records the dataset's max speed and the
  threshold is `max(10 px, 2 × maxSpeed × bounds.height × velocityScale × zoomFactor ×
  pxPerDegree)`, where `pxPerDegree = projection.scale() × π/180`. Legitimate fast flow passes at
  any zoom; limb artifacts (5–100× beyond it) are still caught. Reproduced and verified headlessly
  at 8× zoom via `#rotate=-128.5,-21.5&zoom=8`; the default view was re-verified streak-free.
- **Hollow typhoon eye at high zoom.** The Euler step could exceed a tight vortex's radius, so no
  particle ever traced the eyewall. Capped by `MAX_PARTICLE_STEP` (12 px), which leaves speed free
  to grow with zoom below the cap.
- **Frozen overlay misaligned during drag/zoom.** The first implementation kept the stale overlay
  static while the map outline rotated and scaled beneath it, so the color disc visibly detached
  from the globe. Fixed by the live low-res overlay preview (pipeline step 6). The first attempt at
  that painted a colored square around the globe, because `projection.invert` returns finite
  (mirrored) coordinates for off-disc points thanks to d3-geo's clamped `asin` — masked by an
  explicit radius check. Verified by headless screenshots of the preview pass: clean disc, aligned
  with the coastlines, near-identical to the full-res overlay.
- **Stray sentinel pixels on the antialiased rim.** The 2×2 write pattern misses some rim pixels,
  leaving the magenta mask fill visible as stray dots. A cleanup pass at the end of
  `interpolateField()` zeroes any remaining sentinel pixel's alpha.
- **Charcoal staircase in the sea (ocean and wave layers).** Striding the 1/12° CMEMS grid marked
  an output cell "land" whenever its exact sample point was, and GFS-Wave's own land mask is a cell
  fatter than the vector coastline — both produced blocky charcoal blocks jutting into the water.
  Fixed in the data (window fill during coarsening / NaN dilation) and at render time (NaN-tolerant
  renormalizing bilinear, plus the vector land fill on `#lines` cropping whatever bleeds past).
- **Particle trails spilling onto land.** Solved by canvas order: `#lines` sits above `#animation`,
  so the ocean layers' opaque land fill crops trails at the vector coastline for free.
- **Dataless water rendered as black holes** (Caspian, Aral, coastal grid holes). Painted
  `NO_DATA_GRAY` — the same charcoal as land — in both the full field and the drag preview.
- **Wrap-around column missing on a ⅓° grid.** The grid-continuity test used `floor(ni × Δλ)`,
  and 1080 × ⅓ is 359.99… in floating point; `round` fixed it.
- **Stale data/engine after a refresh.** A plain browser reload still showed the old snapshot and
  old code: Chrome's normal reload only revalidates the HTML document, while `<script>` and
  `fetch()`ed JSON follow heuristic caching and were served from disk cache. Data fetches now use
  `{cache: "no-cache"}` (a cheap 304 when unchanged); for script edits, hard-reload
  (Ctrl+Shift+R) — the `?v=` cache-busting scheme used during heavy iteration was removed for
  simplicity.

## Version control / feature deployment structure

- **`main` is the only long-lived branch**, always deployable; Vercel's production deployment
  points at it. Everything else is short-lived: branch off `main`, build, verify, merge with
  `--no-ff`, delete. Vercel gives every branch a preview URL, which fits the screenshot-based
  visual verification workflow — compare a branch's render against production side by side before
  merging.
- **One short-lived branch per render** (`feature/<Layer>`), and **shared-engine work goes in its
  own `refactor/…` branch that merges first**. The engine is a single file, so two feature branches
  editing it independently make the second merge painful; with the refactor landed first, each
  feature branch touches mostly its own `LAYERS` entry and colormap.
- **Data refreshes never touch git at all**: the weather JSONs are git-ignored, refresh scripts
  update the local copies, and `upload_data.sh` ships them to R2. Feature branches and `main` carry
  code only.
- **Commits are squashed to one per work day**, messaged `YYYYMMDD: <summary>`. History has been
  rewritten (`git filter-repo` to drop pre-split data blobs, and the squash), so a stale clone must
  be re-cloned, not pulled.
- **Avoid** a `develop` branch or gitflow (pure ceremony at this scale) and long-lived parallel
  feature branches — the features share one engine, so divergence is the main risk and prompt
  merges are the cure.

## Next steps

- **Watch a full 6-hourly day.** The dispatch path is proven by real runs, but the scheduled slots
  under the anchor schedule are not, so the first day is worth checking against the bucket: all
  four slots should advance the GFS/GFS-Wave `refTime` by one cycle each, and only the 06:45
  anchor should touch the three ocean objects (their `Last-Modified` must hold still elsewhere).
  Note also that GitHub disables cron in repos idle for 60 days (public repos get a warning email
  first), and that the `REFRESH_CADENCE=daily` branch is untested — it drops cron strings rather
  than running a gate, so verify a skipped slot logs nothing and consumes no runner before relying
  on it.
- **Bucket custom domain.** The r2.dev development URL is rate-limited by Cloudflare, documented as
  not-for-production, and serves the weather JSONs **uncompressed** ([Data/code
  split](#datacode-split)). A custom domain in front of the bucket buys Brotli/gzip and drops the
  limit; switching is a one-line `R2_DATA_ROOT` change, and the old URL keeps working during the
  transition.
- **Depth-level ocean layers.** Both CMEMS datasets carry 50 levels; 15.8 m, 109.7 m and 453.9 m
  are natural picks. One `PRODUCTS` entry (depth bracket) + one `LAYERS` entry + one menu button
  each.
- **Touch pinch-zoom** — only wheel zoom is implemented. The URL hash is read-only for the initial
  view; writing it back on interaction, like the original, is still open.
- **Small cleanups.** `LAYERS[].label` is documentation only — the HUD never reads it (the credit
  line comes from `credit`/`DEFAULT_CREDIT`), so either wire it in or drop it. `.soon` and
  `.layer:disabled` in `styles.css` are leftovers from the "Temperature soon" placeholder and no
  longer match any markup. `#location`'s placeholder is hardcoded in `index.html` as "click a point
  for wind speed", so every ocean and wave layer invites a click for wind speed until the first
  click replaces it.
- **Local venv is disposable.** `~/.venvs/aws` holds pygrib, numpy, copernicusmarine and the AWS
  CLI, and nothing depends on it surviving — the workflow builds its own on every run. Recreate with
  `python3 -m venv ~/.venvs/aws && ~/.venvs/aws/bin/pip install --upgrade pygrib numpy
  copernicusmarine awscli` (the system Python is PEP-668 managed, so a plain `pip3 install` fails).

## Changes

### 2026-08-18

- **Diagnosed the 3–5 second scheduled runs** as working-as-designed, not failures. With
  `REFRESH_CADENCE` unset the `gate` job skipped the 06:45, 12:45 and 18:45 UTC slots, leaving
  `refresh` as `skipped` and the run green in ~6 s; the 00:45 slot did the real work (run
  31987036925, 02:07:59 → 02:11:24 UTC, all 14 steps green, all 12 objects uploaded). Two things
  made this look broken: the run list's "Scheduled" column is the *trigger*, not a pending status,
  and GitHub's cron lateness moves the firings well away from `:45` — the four slots actually
  started at 19:00, 02:08, 07:37 and 13:25 UTC, i.e. 15 to 83 minutes late.
- **Traced the site's 25-hour-old wind snapshot** to the cadence rather than to a bug. The bucket
  object carried `refTime` `2026-08-16T18:00:00Z` with `Last-Modified` 02:11:22Z: at 02:08 the
  walk-back starts at `now − 4 h` → 18z 16 Aug, which was the newest *published* cycle, since 00z
  17 Aug does not reach NOMADS until ~03:30–05:00. So the daily slot structurally misses each
  morning's 00z and the displayed data sawtoothed between ~8 h and ~32 h old.
- **Cadence switched to 6-hourly**, putting the on-screen snapshot in a ~7–13 h band. The `gate`
  job is gone: the schedule is now two cron entries (`45 0 * * *`, `45 6,12,18 * * *`) and the
  cadence check is a job-level `if` on `github.event.schedule`, which carries the triggering cron
  string verbatim. The old `date -u +%H -lt 6` test had only ~5 h of slack against cron lateness
  already measured at up to 83 min, and any overshoot would have cost the entire day's refresh —
  the new check can't be affected by *when* a run starts. `REFRESH_CADENCE=daily` still restores
  the single 00:45 slot, now by dropping a cron string instead of burning a runner per skipped slot.
- **Smoke-tested by dispatch** (3m30s, one `refresh` job, all 11 steps green — an invalid `if`
  would have been a startup failure, so the expression is confirmed to parse and evaluate). The
  bucket advanced from GFS **16 Aug 18z → 17 Aug 12z**, i.e. from a 25-hour-old snapshot to a
  7-hour-old one, which is the new cadence's band exactly. The old workflow's last act was a final
  gate skip at 19:15:19 UTC, 34 s before this commit landed.
- **CMEMS over-fetch found and fixed — ~19.8 GB/day → ~105 MB/day.** `refresh_ocean.py` opened
  the dataset with no time selection; the store's dask chunking bundles 50 time steps per chunk,
  so slicing one day afterwards still materialised them all — measured **989.6 MB on the wire to
  keep 20.6 MB** per variable read, five reads per run. The open is now pinned with
  `start_datetime`/`end_datetime` (proven bit-identical: same record, dtype, axes and every value
  on the full 1/12° grid — resolution and coarsening untouched) plus a `candidate_days()`
  walk-back mirroring the GFS scripts', which raises after 8 misses instead of silently serving
  old data.
- **CMEMS fetches moved to a single daily anchor slot, 00:45 → 06:45 UTC.** The ocean products
  are `P1D-m` daily means published ~03:10–03:24 UTC, so the schedule became `45 6 * * *`
  (anchor) + `45 0,12,18 * * *` and the CMEMS step's `if` runs it only on the anchor (or any
  dispatch). Moving the anchor matters twice over: 00:45 fired ~75 min *before* the CMEMS
  publication, so it always took the previous production's +1-day-lead forecast, and it was also
  the slot that structurally missed each morning's GFS 00z under `REFRESH_CADENCE=daily`. At
  06:45 both are fresh; firing times are unchanged.

### 2026-08-17

- **Deployed to Vercel**, production at `globe-climatesim.vercel.app` — imported as a static project
  with no build step, since `vercel.json` supplies `outputDirectory: public`. Verified in production:
  all **11 layers** render headlessly; static assets come from Vercel with the intended cache headers
  and `content-encoding: br`; `data/current-*.json` 404s on the Vercel origin, which proves the
  rendered fields came from R2; the HUD reports the loaded snapshot with an empty `#status`.
- **Refresh workflow added** (`.github/workflows/refresh-data.yml`) and the five Actions secrets
  set at repository scope. Two changes from the runbook's draft: `refresh_ocean.py` is now invoked
  once (its all-products mode replaced the per-product loop) and `permissions: contents: read` is
  explicit rather than inherited.
- **R2 overwrite path re-verified**: a re-upload of all 12 objects advanced `Last-Modified` while
  the embedded `refTime` stayed at GFS 15 Aug 06z — the local files had been regenerated from the
  same cycle. Worth remembering: **`Last-Modified` alone does not prove fresher data**; `refTime`
  is the ground truth.
- **Corrected the edge-compression claim.** The r2.dev URL serves the weather JSONs with no
  `Content-Encoding` under either `--compressed` or an explicit `Accept-Encoding: gzip`, so the
  "~10 MB → ~2.5 MB" note was wrong; Brotli for the data needs a bucket custom domain, now a
  [Next step](#next-steps).
- **Documented two footguns** found while wiring the workflow: `refresh_wind.py` silently treats an
  unrecognized product name as a local GRIB path, and `#location`'s hardcoded placeholder mentions
  wind speed on every layer.
- **First workflow run green** (manual dispatch, 3m49s): gate passed in 3 s, every refresh step
  succeeded — including the CMEMS login, the only credential that had never been exercised — and all
  12 objects' `refTime` advanced, GFS/GFS-Wave **15 Aug 06z → 16 Aug 12z** and CMEMS **15 → 16 Aug**
  daily mean. The live HUD followed without a hard reload (`{cache: "no-cache"}` revalidates), and
  the run produced no commit, no force-push and no Vercel deploy, as designed.
- **Runner actions bumped** `actions/checkout@v4` → `@v7` and `actions/setup-python@v5` → `@v7`
  (both `node24`), and `timeout-minutes` 45 → 20 now that the real runtime is known. Confirmed by a
  second dispatch: same 14 steps green in 3m48s with **no annotations**, against the Node 20
  deprecation warning the v4/v5 run carried — so the scheduled path runs a tested configuration.

### 2026-08-16

- **`refresh_ocean.py` reworked**: with no product argument it now refreshes **all three** CMEMS
  products in one run (`currents`, `currents25`, `temperature`) instead of just `currents`, and
  argument parsing accepts `[product] [YYYY-MM-DD]` in any of the four combinations.
- **Progress reporting** added throughout: a TTY spinner with elapsed seconds (plain lines when
  redirected, for CI logs), dataset dimensions, selected record/depth, ocean-vs-NaN cell counts,
  per-stage timings, output size and a final per-product summary table. A missing day now raises
  `RuntimeError` inside the product loop instead of exiting the process, so the failure is
  reported with its product name.
- **Surface depth bracket** changed from `[0, 1]` to `SURFACE_DEPTH = (0.494, 0.495)`: 0 m is
  outside the store's coordinate range and produced a warning on every fetch.
- **Repo hygiene**: `.gitignore` now covers `.vscode/` and `earth-vercel-deploy.md`; the
  deployment runbook lives in the repo root as a local, untracked file (it holds the live bucket
  URL and ops notes) instead of `~/Documents/`.
- **History squashed** to one commit per work day (`YYYYMMDD: <summary>`).

### 2026-08-15

- **Cloudflare R2 live**: bucket `earth-data` created, r2.dev public URL enabled, CORS policy set,
  an Object Read & Write API token created and written to the git-ignored `.env/r2`, AWS CLI
  installed locally. All 12 datasets uploaded, and the **overwrite path verified** — a full local
  refresh followed by re-upload advanced `Last-Modified` and the served `refTime`.
- **`R2_DATA_ROOT` set** in `wind.js` to the live r2.dev base URL (was a placeholder), so a
  non-localhost page now fetches all 12 weather files from the bucket.
- **All datasets refreshed** to one cycle: GFS and GFS-Wave 06:00 UTC, CMEMS daily mean of the
  same day.

### 2026-07-12

Ocean layers, the data/code split, and the tuning rounds that followed.

- **Ocean currents layer** — CMEMS surface currents drive both the particles and a
  `fromMagnitude` speed overlay (segmented nullschool ocean palette, 0–1.5 m/s), with per-layer
  particle tuning, credit/date lines and an m/s click readout. `segmentedLut()` was added beside
  the colormap LUTs, and the grid-continuity check switched from `floor` to `round`.
- **New `scripts/refresh_ocean.py`** — a `copernicusmarine`-toolbox reader (1/12° → stride → ¼°,
  grib2json out, land = null), credentials from the git-ignored `.env/copernicusmarine`. The
  earlier claim that the CMEMS ARCO store is anonymous was disproved: metadata and coordinates
  GET fine, every data chunk 403s.
- **Vertical domain tabs** — `#tabs` became a column with each tab header above its own layer row;
  `loadLayer()` also reveals the owning tab when booting from `#layer=`.
- **Nullschool-parity pass on the ocean look** (side-by-side screenshots): charcoal `#333338` land
  fill above the overlay so crisp vector coasts replace the blocky grid staircase; NaN-tolerant
  renormalizing bilinear so sea color reaches the coast; ocean overlay dimmed to 0.58 alpha with
  denser, finer trails.
- **Ocean follow-up fixes**: trails no longer spill onto land (`#lines` moved above `#animation`);
  dataless water paints `NO_DATA_GRAY` instead of black in both the field and the drag preview;
  trails retuned faster, sparser and slightly thicker (velocityScale 1/2500 → 1/1700,
  multiplier 7 → 4, width 1.2 → 1.7).
- **Sea water temperature layer** — CMEMS thetao as a scalar overlay under the currents-driven
  particles, through the same `bwr` diverging scheme as the atmosphere temperature layer. Domain
  revised 0–50 → **0–35 °C** (the ocean never gets hotter, so the red half was wasted; the white
  midpoint now sits at 17.5 °C and tropical water reads warm-red).
- **Ocean-layer generalizations** — dataless-water charcoal and the m/s readout key on per-layer
  `landFill` / `flowFormat` instead of the currents-only `fromMagnitude` flag; shared `OCEAN_*`
  constants for file, credit and particle tuning.
- **Deep-current layer** — added at 109.73 m, then moved to **25.211 m** (near the mixed-layer
  base, where the flow starts diverging from wind-driven surface drift): layer id `ocean25`, menu
  button **Current-25m**, product `currents25`. `refresh_ocean.py` products gained a `depth`
  bracket and the header's `surface1Value` reports the real level.
- **Coastal blockiness fixed in the data** (user bug report): a plain stride marked an output cell
  "land" whenever its exact sample point was, giving the sea a land mask a whole cell fatter than
  the vector coastline. `coarsen()` now fills land-sampled points from the surrounding
  full-resolution window; tightened twice on review, ending at **¼° (stride 3) + 7×7** after ⅓° +
  5×5 still left single-cell nubs on convoluted coasts. All ocean files were regenerated and
  renamed `…-cmems-0.25.json`.
- **Atmosphere temperature domain** -50–50 → **-10–45 °C**: the populated range gets the full
  `bwr` stretch, endpoints pin, white point moves from 0 °C to 17.5 °C. Colormap history that day,
  all user-directed: temperature inferno → reversed inferno → YlOrRd → `bwr`; RH Purples → BuPu
  for contrast.
- **Wave layers** — GFS-Wave (WAVEWATCH III) significant height + peak period/direction via the
  anonymous NOMADS filter, no login required. New `scripts/refresh_waves.py`; one flow file
  carries propagation u/v with |v| = period in seconds, so the period overlay is `fromMagnitude`
  and the readout speaks seconds. A 5×5 coastal NaN dilation pre-empted the staircase bug the
  CMEMS layers hit.
- **Wave particle style, three rounds.** First: short, sparse, thick dashes marching in the
  propagation direction instead of long streamlines. Then (user feedback) **crest dashes** — an
  oriented dash *perpendicular* to travel via a new `crestLength` mode in `animate()`, marching at
  a tenth of the speed and dying fast. Then a **softer lifecycle** (maxAge 12 → 20, fade
  0.6 → 0.72) because the dashes blinked in and out too fast, and an **even slower march**
  (velocityScale 1/120000 → 1/360000).
- **One combined Waves layer** (user spec, like nullschool): the separate period layer was
  removed; `waves` pairs the height colormap with the direction/period crest dashes and the click
  readout speaks both fields ("4.2 m · 12.3 s"). Height colormap went navy→sand→orange, then
  white→gray→teal, then the final **blue → light blue → yellow → orange → saffron** ramp (0–15 m,
  higher clipping to saffron). `windIntensityColorScale` gained a per-layer `brightnessFloor` (40
  for waves vs the default 130) so longer-period swell draws markedly brighter crests.
- **Data/code split — Cloudflare R2.** The 12 `current-*.json` files became git-ignored and
  untracked (still written to `public/data/` for local dev); `wind.js` routes every weather URL
  through `DATA_ROOT` (`#data=` override → local on localhost → `R2_DATA_ROOT`); new
  `scripts/upload_data.sh` (S3 API via AWS CLI, cache-control 1800 s). Refreshes now cause zero
  commits, force-pushes or redeploys. Verified headlessly on both paths, the remote one against a
  CORS-enabled stand-in bucket on a second origin.
- **Refresh cadence: daily by default** (was 6-hourly, all datasets): the workflow keeps a
  6-hourly cron, but a gate job only lets the ~00:45 UTC firing through unless the repo variable
  `REFRESH_CADENCE=6h` is set — a settings-page toggle, no workflow edit.
- **Quality pass over `wind.js`**: an `OCEAN_ALPHA` constant replaced the repeated
  `Math.floor(0.58 * 255)`; the wave-particle comment block was rewritten to describe final
  behavior rather than accreted history. A dead-code audit found nothing unreferenced.
- **History rewritten with `git filter-repo`** to drop pre-split data blobs from all commits:
  `.git` 49 MB → 1.9 MB, one pure data-refresh commit pruned as empty. Force-pushed; all hashes
  changed.
- **Deployment runbook written** (outside the repo on purpose) and then rewritten around R2:
  bucket setup, public URL + CORS, five Actions secrets, upload workflow, repo-size strategy.

### 2026-07-10

The project went from the stock cambecc/earth port to its current shape in one extended session.

- **Live data** — the 2014-01-31 1° sample was replaced with current GFS analyses, and the
  resolution upgraded 1° → 0.5° → 0.25° (nullschool parity; grid rows became `Float32Array`s to
  keep memory sane). New pygrib-based `scripts/refresh_wind.py`, no Java, later parameterized by
  level and product.
- **Bug fixes** (details under [Fixed bugs](#fixed-bugs)): limb-divergence streak chords; the
  streak guard killing legitimate fast trails at zoom (data-driven threshold); the hollow typhoon
  eye from Euler overshoot; the frozen, misaligned overlay during drag/zoom (live low-res
  preview); stale browser cache; rim sentinel pixels.
- **Aesthetic parity with nullschool**, measured in several passes: pastelized extended-sinebow
  overlay at 0.72 alpha (from 0.4), deep-indigo calm end, dpr-crisp rendering with 1-device-px
  strokes, political borders, and the trail character retuned repeatedly — particle multiplier
  10 → 6 → 3.5, fade 0.96 → 0.97, brightness floor 85 → 64 → 100 → 130, `VELOCITY_SCALE`
  1/60000 → 1/40000 → 1/42000, alpha 1.0 → 0.85 → speed-dependent 0.70–0.50, graticule alpha
  0.07 → 0.12. Two de-whitening experiments were measured and reverted by user preference; see
  [Tuning notes](#tuning-notes).
- **Four-canvas stack** — a dedicated `#lines` canvas above the overlay so coastlines render
  full-white and stay visible through the trails.
- **Burger-menu HUD** — collapsed `☰ earth` bar plus an expandable panel with hierarchical
  exclusive tabs; color bar, data lines and readouts all moved inside. Page title simplified to
  "earth".
- **Layer engine + pressure-level winds** — `LAYERS` registry, `loadLayer()`, the `layerchange`
  event and the `#layer=<id>` hash, then the 1000 hPa, 500 hPa and 10 hPa wind layers, each on its
  own short-lived branch verified headlessly before merging.
- **Scalar-overlay engine + combined layers** — `buildScalarGrid()`, colormap LUTs,
  `overlayColorAt()` dispatch (full-res field and drag preview alike), per-layer scale bar and
  click readout, and the 2 m TMP/RH/DPT products in the refresh script; then the Temperature,
  Humidity and Dew Point layers, with surface wind refreshed first so every layer shared one GFS
  cycle.
- **Repo hygiene** — `__pycache__` ignored, `?v=` cache-busting removed, this README established
  as the cross-session handoff document, all work branches deleted after merging (their history
  survives in the `--no-ff` merge commits).

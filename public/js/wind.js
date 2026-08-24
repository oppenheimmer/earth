/**
 * wind.js — animated global wind visualization.
 *
 * A minimal replica of the "colorful wind" mode of https://earth.nullschool.net.
 * The core algorithms — GFS grid bilinear interpolation, projection distortion of wind
 * vectors, the sinebow overlay color scale, and the bucketed particle animation loop —
 * are ported from cambecc/earth (https://github.com/cambecc/earth, MIT license),
 * rewritten for D3 v7 without the jQuery/underscore/backbone/when.js dependencies.
 */
(function () {
    "use strict";

    var τ = 2 * Math.PI;
    var H = 0.0000360;                        // 0.0000360°φ ~= 4m, for finite-difference distortion
    var MAX_TASK_TIME = 100;                  // amount of time before an interpolation batch yields (millis)
    var MIN_SLEEP_TIME = 25;                  // amount of time a task waits before resuming (millis)
    var OVERLAY_ALPHA = Math.floor(0.72 * 255); // 0.4 in the original; near-opaque like nullschool — dark-background bleed turned the orange storm band brown
    var INTENSITY_SCALE_STEP = 10;            // step size of particle intensity color scale
    var MAX_PARTICLE_AGE = 100;               // max number of frames a particle is drawn before regeneration
    var PARTICLE_LINE_WIDTH = 1.5;            // in device px — divided by devicePixelRatio at stroke time; thin dense traces like nullschool (below ~1.5 a dpr-1 stroke antialiases across two rows and reads grey)
    var PARTICLE_MULTIPLIER = 6;              // particle count scalar (7 in the original; matched to nullschool's busier globe by comparison)
    var PARTICLE_REDUCTION = 0.75;            // reduce particle count to this fraction for mobile
    var FRAME_RATE = 40;                      // desired milliseconds per frame
    var NULL_WIND_VECTOR = [NaN, NaN, null];  // no wind data at this location [u, v, mag]
    var TRANSPARENT_BLACK = [0, 0, 0, 0];
    var NO_DATA_GRAY = [51, 51, 56, 255];     // sentinel for "ocean layer, no value here"; the write
                                              // sites swap it for the hatch below (see noDataHatchAt)
    // Dataless water on an ocean layer is hatched, not filled flat. The depth layers stop wherever
    // the sea floor rises above them, so at 450 m whole shelf seas — North Sea, Irish Sea, Channel,
    // Sunda — carry no value; painting them the land charcoal made them read as land, which they
    // are not. Screen-space anti-diagonal stripes say "water, not measured at this depth" instead.
    var NO_DATA_WATER = [24, 28, 40, 255];    // hatch ground: cooler and dimmer than the land charcoal
    var NO_DATA_HATCH = [62, 70, 88, 255];    // hatch stroke
    var NO_DATA_FLAT = [34, 39, 52, 255];     // area-average of the two, for the coarse drag preview
    var HATCH_PERIOD = 8;                     // px between stripes, measured along x+y
    var HATCH_WIDTH = 2;                      // px of stripe — one 2x2 interpolation block
    var MAX_INTENSITY = 25;                   // wind velocity (m/s) at which particle intensity is max (17 in the original; higher cap keeps storm bands from saturating white)
    var VELOCITY_SCALE = 1 / 42000;           // particle screen speed per unit of wind velocity (1/60000 in the original)
    var ZOOM_SPEED_EXPONENT = 0.6;            // 0 = speed grows fully with zoom (frantic close-up), 1 = constant speed at all zooms (sparse short tracks); 0.6 grows gently, ~2× at zoom 6
    var MAX_PARTICLE_STEP = 12;               // px/frame cap on the Euler step — larger steps overshoot tight vortices (empty typhoon eyewall at high zoom); speed still grows with zoom below the cap
    var MAX_ZOOM = 64;                        // max zoom, ×fitted scale (was 8 — country level; 64 reaches prefecture level; nullschool's absolute extent is [50, 250000] px)
    var DETAIL_ZOOM = 4;                      // zoom (×fitted scale) beyond which the idle map draws lazily-fetched 10m geometry — 50m lines look coarse past ~8×

    var view = {width: window.innerWidth, height: window.innerHeight};

    // ------------------------------------------------------------------------------------------------
    // Color scales (ported from micro.js)

    function colorInterpolator(start, end) {
        var r = start[0], g = start[1], b = start[2];
        var Δr = end[0] - r, Δg = end[1] - g, Δb = end[2] - b;
        return function (i, a) {
            return [Math.floor(r + i * Δr), Math.floor(g + i * Δg), Math.floor(b + i * Δb), a];
        };
    }

    /** Rainbow-like trefoil color space. See http://krazydad.com/tutorials/makecolors.php */
    function sinebowColor(hue, a) {
        // Map hue [0, 1] to radians [0, 5/6τ]; never a full rotation so 0 and 1 differ.
        var rad = hue * τ * 5 / 6;
        rad *= 0.75;  // increase frequency to 2/3 cycle per rad

        var s = Math.sin(rad);
        var c = Math.cos(rad);
        var r = Math.floor(Math.max(0, -c) * 255);
        var g = Math.floor(Math.max(s, 0) * 255);
        var b = Math.floor(Math.max(c, 0, -s) * 255);
        return [r, g, b, a];
    }

    var BOUNDARY = 0.45;
    var fadeToWhite = colorInterpolator(sinebowColor(1.0, 0), [255, 255, 255]);

    /** Interpolates a sinebow color where 0 <= i <= BOUNDARY, then fades to white for i up to 1. */
    function extendedSinebowColor(i, a) {
        return i <= BOUNDARY ?
            sinebowColor(i / BOUNDARY, a) :
            fadeToWhite((i - BOUNDARY) / (1 - BOUNDARY), a);
    }

    /**
     * Maps wind speed [0, 100] m/s onto the extended sinebow, pastelized toward white.
     * The raw sinebow's storm band (25-40 m/s) is saturated orange/red — intrinsically dark,
     * rendering as brown over the near-black map. Nullschool's modern palette is lighter;
     * blending 22% white turns that band bright salmon/gold like theirs.
     */
    function windOverlayColor(v, a) {
        var c = extendedSinebowColor(Math.min(v, 100) / 100, a);
        // Calm-end indigo: rgb(34,43,178) over the #101018 sphere at OVERLAY_ALPHA renders as
        // #212D91 at a 3 m/s ocean breeze, matching nullschool's #202D91 sampled there. The
        // previous royal blue rgb(56,84,199) rendered #2D449D at the same speed — too light
        // and too cyan. Derived by inverting the composite at that speed rather than by eye:
        // overlay = (screen − bg·(1−a)) / a, then back out the pastel term at t(3 m/s) = 0.21.
        // The blend still releases into the pastelized scale by ~11 m/s, so the cyan/green
        // band and every storm color above it are untouched.
        var t = Math.pow(Math.min(v / 11, 1), 1.2);
        c[0] = Math.round((c[0] + (255 - c[0]) * 0.22) * t + 34 * (1 - t));
        c[1] = Math.round((c[1] + (255 - c[1]) * 0.22) * t + 43 * (1 - t));
        c[2] = Math.round((c[2] + (255 - c[2]) * 0.22) * t + 178 * (1 - t));
        return c;
    }

    /** Near-neutral bright styles for particle trails plus indexFor(mag) to pick a bucket. */
    function windIntensityColorScale(step, maxWind, floor) {
        var result = [];
        // Brightness floor: 155 keeps slow-wind trails bright without bleaching them (85 in the
        // original, then 130 — fainter than nullschool — and 185, which overshot); the wave
        // layer drops it so slow short chop is dim and fast long swell is brighter.
        floor = floor || 155;
        for (var j = floor; j <= 255; j += step) {
            // Near-neutral strokes: the hue comes from the overlay bleeding through the alpha
            // (white over red reads pink, over green pale green). A stronger green tint muddied
            // the red eyewall into brown, so the tint sits just off neutral. Alpha falls with
            // speed (0.80 slow → 0.59 fast) so calm regions get bright distinct traces while
            // storm cores can't pile up into mush.
            var t = (j - floor) / (255 - floor);
            var alpha = (0.80 - 0.21 * t).toFixed(2);
            result.push("rgba(" + Math.round(j * 0.92) + ", " + j + ", " + Math.round(j * 0.94) + ", " + alpha + ")");
        }
        result.indexFor = function (m) {
            return Math.floor(Math.min(m, maxWind) / maxWind * (result.length - 1));
        };
        return result;
    }

    // ------------------------------------------------------------------------------------------------
    // GFS grid (ported from products.js)

    function isValue(x) {
        return x !== null && x !== undefined;
    }

    function floorMod(a, n) {
        return a - n * Math.floor(a / n);
    }

    /**
     * Builds an interpolating grid from grib2json output: two records (u then v wind components)
     * on a regular lat/lon grid, scan mode 0 (west→east, north→south). Rows are flat
     * Float32Arrays ([u0, v0, u1, v1, …]) — at 0.25° the grid has >1M cells, and per-cell JS
     * arrays would cost hundreds of MB.
     */
    function buildGrid(records) {
        var uRecord = null, vRecord = null;
        records.forEach(function (record) {
            var h = record.header;
            if (h.parameterCategory === 2 && h.parameterNumber === 2) uRecord = record;
            if (h.parameterCategory === 2 && h.parameterNumber === 3) vRecord = record;
        });
        if (!uRecord || !vRecord) throw new Error("wind data must contain u and v components");

        var header = uRecord.header;
        var uData = uRecord.data, vData = vRecord.data;
        var λ0 = header.lo1, φ0 = header.la1;  // origin (e.g., 0.0E, 90.0N)
        var Δλ = header.dx, Δφ = header.dy;    // distance between grid points
        var ni = header.nx, nj = header.ny;    // number of grid points W-E and N-S

        // Fastest wind in the dataset — sizes the particle streak guard at any zoom.
        var maxSpeed2 = 0;
        for (var n = 0; n < uData.length; n++) {
            if (isValue(uData[n]) && isValue(vData[n])) {
                var m2 = uData[n] * uData[n] + vData[n] * vData[n];
                if (m2 > maxSpeed2) maxSpeed2 = m2;
            }
        }

        var grid = [], p = 0;
        var isContinuous = Math.round(ni * Δλ) >= 360;  // round: 1080 × ⅓ is 359.99… in floats
        var rowLength = ni + (isContinuous ? 1 : 0);
        for (var j = 0; j < nj; j++) {
            var row = new Float32Array(rowLength * 2);
            for (var i = 0; i < ni; i++, p++) {
                row[2 * i] = isValue(uData[p]) ? uData[p] : NaN;
                row[2 * i + 1] = isValue(vData[p]) ? vData[p] : NaN;
            }
            if (isContinuous) {
                row[2 * ni] = row[0];  // duplicate first column as last to simplify wrap-around
                row[2 * ni + 1] = row[1];
            }
            grid[j] = row;
        }

        function interpolate(λ, φ) {
            var i = floorMod(λ - λ0, 360) / Δλ;  // calculate longitude index in wrapped range [0, 360)
            var j = (φ0 - φ) / Δφ;               // calculate latitude index in direction +90 to -90

            var fi = Math.floor(i), ci = fi + 1;
            var fj = Math.floor(j), cj = fj + 1;

            var row0 = grid[fj], row1 = grid[cj];
            if (!row0 || !row1) return null;

            var x = i - fi, y = j - fj;
            var rx = 1 - x, ry = 1 - y;
            var i0 = fi * 2, i1 = ci * 2;
            // NaN-tolerant bilinear: hole corners (ocean grids mark land as NaN) drop out and
            // the remaining weights renormalize, so color/flow reach the last valid cell instead
            // of retreating half a cell from every coast (blocky staircase against the land).
            var u = 0, v = 0, w = 0, k;
            if (!isNaN(row0[i0])) { k = rx * ry; u += row0[i0] * k; v += row0[i0 + 1] * k; w += k; }
            if (!isNaN(row0[i1])) { k = x * ry;  u += row0[i1] * k; v += row0[i1 + 1] * k; w += k; }
            if (!isNaN(row1[i0])) { k = rx * y;  u += row1[i0] * k; v += row1[i0 + 1] * k; w += k; }
            if (!isNaN(row1[i1])) { k = x * y;   u += row1[i1] * k; v += row1[i1 + 1] * k; w += k; }
            if (w === 0) return null;  // all four corners are holes
            u /= w;
            v /= w;
            return [u, v, Math.sqrt(u * u + v * v)];
        }

        var refTime = new Date(header.refTime);
        var validTime = new Date(refTime.getTime() + (header.forecastTime || 0) * 3600 * 1000);

        return {interpolate: interpolate, date: validTime, maxSpeed: Math.sqrt(maxSpeed2)};
    }

    /**
     * Builds an interpolating grid from a single-record scalar dataset (temperature, RH, …):
     * same regular lat/lon layout as buildGrid, one value per cell.
     */
    function buildScalarGrid(records) {
        var header = records[0].header;
        var data = records[0].data;
        var λ0 = header.lo1, φ0 = header.la1;
        var Δλ = header.dx, Δφ = header.dy;
        var ni = header.nx, nj = header.ny;

        var grid = [], p = 0;
        var isContinuous = Math.round(ni * Δλ) >= 360;  // round: 1080 × ⅓ is 359.99… in floats
        var rowLength = ni + (isContinuous ? 1 : 0);
        for (var j = 0; j < nj; j++) {
            var row = new Float32Array(rowLength);
            for (var i = 0; i < ni; i++, p++) {
                row[i] = isValue(data[p]) ? data[p] : NaN;
            }
            if (isContinuous) row[ni] = row[0];
            grid[j] = row;
        }

        function interpolate(λ, φ) {
            var i = floorMod(λ - λ0, 360) / Δλ;
            var j = (φ0 - φ) / Δφ;
            var fi = Math.floor(i), ci = fi + 1;
            var fj = Math.floor(j), cj = fj + 1;
            var row0 = grid[fj], row1 = grid[cj];
            if (!row0 || !row1) return null;
            var x = i - fi, y = j - fj;
            var v = row0[fi] * (1 - x) * (1 - y) + row0[ci] * x * (1 - y) +
                    row1[fi] * (1 - x) * y + row1[ci] * x * y;
            return isNaN(v) ? null : v;
        }

        var refTime = new Date(header.refTime);
        var validTime = new Date(refTime.getTime() + (header.forecastTime || 0) * 3600 * 1000);
        return {interpolate: interpolate, date: validTime};
    }

    /** 256-entry [r,g,b] lookup table from a d3 colormap interpolator (t in [0,1]). */
    function colormapLut(interpolator) {
        var lut = [];
        for (var i = 0; i < 256; i++) {
            var c = d3.rgb(interpolator(i / 255));
            lut.push([Math.round(c.r), Math.round(c.g), Math.round(c.b)]);
        }
        return lut;
    }

    /** 256-entry [r,g,b] lookup table from [value, [r,g,b]] stops spanning [min, max]. */
    function segmentedLut(stops, min, max) {
        var lut = [];
        for (var i = 0; i < 256; i++) {
            var v = min + (max - min) * i / 255;
            var k = 1;
            while (k < stops.length - 1 && stops[k][0] < v) k++;
            var lo = stops[k - 1], hi = stops[k];
            var t = Math.max(0, Math.min(1, (v - lo[0]) / (hi[0] - lo[0])));
            lut.push([
                Math.round(lo[1][0] + t * (hi[1][0] - lo[1][0])),
                Math.round(lo[1][1] + t * (hi[1][1] - lo[1][1])),
                Math.round(lo[1][2] + t * (hi[1][2] - lo[1][2]))
            ]);
        }
        return lut;
    }

    /**
     * Overlay color at (λ, φ): the current layer's scalar field through its colormap, or the
     * default wind-speed sinebow when the layer has no scalar. A `fromMagnitude` spec colors
     * by the flow speed itself (ocean currents) instead of a second dataset. Used by the
     * full-res field interpolation and the low-res drag preview alike.
     */
    function overlayColorAt(λ, φ, windMag) {
        if (!overlaySpec) return windOverlayColor(windMag, OVERLAY_ALPHA);
        var v;
        if (overlaySpec.fromMagnitude) {
            v = windMag;
        }
        else {
            v = scalarGrid && scalarGrid.interpolate(λ, φ);
            // Ocean layers render dataless spots like the landmass, not as holes.
            if (v === null || v === undefined) return landFill ? NO_DATA_GRAY : TRANSPARENT_BLACK;
        }
        var t = (v - overlaySpec.min) / (overlaySpec.max - overlaySpec.min);
        var c = overlaySpec.lut[Math.max(0, Math.min(255, Math.round(t * 255)))];
        return [c[0], c[1], c[2], overlaySpec.alpha || OVERLAY_ALPHA];
    }

    // ------------------------------------------------------------------------------------------------
    // Globe / projection

    var projection = d3.geoOrthographic().clipAngle(90);
    var initialScale;

    // Called once, from init(). The scale is assigned unconditionally: d3.geoOrthographic()
    // ships a non-zero default (249.5), so the old `projection.scale() ? … : initialScale`
    // guard always kept that default and the globe never actually rendered at the fitted
    // scale — a fixed 249.5 px radius on every display, and #zoom=1 meant a *different*
    // view than the one the page booted with.
    function fitProjection() {
        initialScale = Math.min(view.width, view.height) * 0.42;
        projection
            .scale(initialScale)
            .translate([view.width / 2, view.height / 2])
            .precision(0.5);
    }

    /** Visible bounds of the globe within the viewport, in integer pixels. */
    function globeBounds() {
        var b = d3.geoPath(projection).bounds({type: "Sphere"});
        var x = Math.max(Math.floor(b[0][0]), 0);
        var y = Math.max(Math.floor(b[0][1]), 0);
        var xMax = Math.min(Math.ceil(b[1][0]), view.width - 1);
        var yMax = Math.min(Math.ceil(b[1][1]), view.height - 1);
        return {x: x, y: y, xMax: xMax, yMax: yMax, width: xMax - x + 1, height: yMax - y + 1};
    }

    /**
     * Returns scaled derivatives [dx/dλ, dy/dλ, dx/dφ, dy/dφ] of the projection at (λ, φ),
     * used to distort wind vectors by the shape of the projection (ported from micro.js).
     */
    function distortion(λ, φ, x, y) {
        var hλ = λ < 0 ? H : -H;
        var hφ = φ < 0 ? H : -H;
        var pλ = projection([λ + hλ, φ]);
        var pφ = projection([λ, φ + hφ]);

        // Meridian scale factor (Snyder eq. 4-3), R = 1. Prevents pinching at the poles.
        var k = Math.cos(φ / 360 * τ);

        return [
            (pλ[0] - x) / hλ / k,
            (pλ[1] - y) / hλ / k,
            (pφ[0] - x) / hφ,
            (pφ[1] - y) / hφ
        ];
    }

    /** Distorts the wind vector at (x, y) by the projection; modifies wind in place. */
    function distort(λ, φ, x, y, scale, wind) {
        var u = wind[0] * scale;
        var v = wind[1] * scale;
        var d = distortion(λ, φ, x, y);
        wind[0] = d[0] * u + d[2] * v;
        wind[1] = d[1] * u + d[3] * v;
        // Numerical-stability cap (not a speed model): an Euler step larger than a tight
        // vortex's radius can't follow the flow, leaving storm eyewalls untraced.
        var m = Math.sqrt(wind[0] * wind[0] + wind[1] * wind[1]);
        if (m > MAX_PARTICLE_STEP) {
            wind[0] *= MAX_PARTICLE_STEP / m;
            wind[1] *= MAX_PARTICLE_STEP / m;
        }
        return wind;
    }

    // ------------------------------------------------------------------------------------------------
    // Canvases and map rendering

    var mapCanvas = d3.select("#map").node();
    var overlayCanvas = d3.select("#overlay").node();
    var linesCanvas = d3.select("#lines").node();
    var animCanvas = d3.select("#animation").node();
    var overlayCtx = overlayCanvas.getContext("2d");
    var animCtx = animCanvas.getContext("2d");
    var mesh = null;    // coastline/lake geometry, set after topology loads
    var mesh10 = null;  // 10m coastline/border/land geometry, lazily fetched past DETAIL_ZOOM
    var mesh10Loading = false;

    // Overlay backing-store pixels per CSS pixel. The data layers stay at 1: the overlay is
    // written with putImageData, which ignores the transform, and their color field is smooth
    // enough that the browser's upscale costs nothing visible. A renderer plug-in may ask for
    // more (js/sunlight.js does — an upscaled photograph is visibly soft on a HiDPI screen).
    var overlayScale = 1;

    function sizeOverlayCanvas() {
        overlayCanvas.width = Math.round(view.width * overlayScale);
        overlayCanvas.height = Math.round(view.height * overlayScale);
        overlayCanvas.style.width = view.width + "px";
        overlayCanvas.style.height = view.height + "px";
    }

    function sizeCanvases() {
        var dpr = window.devicePixelRatio || 1;
        // Map and animation render at device resolution for crisp lines; particle math stays
        // in CSS px via the transform.
        [mapCanvas, linesCanvas, animCanvas].forEach(function (c) {
            c.width = view.width * dpr;
            c.height = view.height * dpr;
            c.style.width = view.width + "px";
            c.style.height = view.height + "px";
            c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
        });

        sizeOverlayCanvas();
    }

    // Deep zoom outgrows the 50m geometry (coarse polygonal coastlines past ~8x), so the
    // first idle draw beyond DETAIL_ZOOM fetches world-atlas countries-10m (~3.7 MB) once
    // and rebuilds the idle meshes from it. Coastline is the land boundary (islands
    // included); lakes stay 50m — there is no 10m lakes asset in the bundle.
    function ensureDetailMesh() {
        if (mesh10 || mesh10Loading || projection.scale() / initialScale <= DETAIL_ZOOM) return;
        mesh10Loading = true;
        buildDetailMesh(DETAIL_MESH_URL).then(function (built) {
            mesh10 = built;
            drawMap(false);  // repaint the settled view with the sharper lines
        }).catch(function (err) {
            console.error(err);
            mesh10Loading = false;  // allow a retry on the next settled deep-zoom draw
        });
    }

    var DETAIL_MESH_URL = "data/countries-10m.json";

    /**
     * Fetch and build the 10m meshes, in a Worker when there is one. Inline the build takes
     * 437 ms during which a 16 ms heartbeat gets zero ticks — a hard freeze, landing right
     * after a zoom gesture. Nothing in it touches the DOM. See js/detail-worker.js for the
     * per-stage breakdown and for what the Worker costs in return.
     *
     * The inline path below is the fallback, and not a vestigial one: Workers cannot be
     * constructed from file:, which is a documented way to open this site.
     */
    function buildDetailMesh(url) {
        if (typeof Worker === "function" && location.protocol !== "file:") {
            try {
                return new Promise(function (resolve, reject) {
                    var worker = new Worker("js/detail-worker.js");
                    worker.onmessage = function (e) {
                        worker.terminate();     // one-shot: the meshes are built once per page
                        if (e.data.error) reject(new Error(e.data.error));
                        else resolve(e.data);
                    };
                    worker.onerror = function (err) {
                        worker.terminate();
                        reject(new Error("detail worker: " + (err.message || "failed")));
                    };
                    worker.postMessage({url: new URL(url, location.href).href});
                });
            }
            catch (err) {
                console.warn("detail worker unavailable, building inline", err);
            }
        }
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error("countries 10m: HTTP " + r.status);
            return r.json();
        }).then(function (c10) {
            var land = topojson.merge(c10, c10.objects.countries.geometries);
            // world-atlas 10m ships a few rings wound backwards (3 of 4044 merged polygons;
            // 50m/110m are clean) — d3-geo reads each as "the sphere minus the ring", so the
            // ocean layers' charcoal land fill flooded the whole globe. A polygon claiming
            // more than half the sphere (> τ steradians) is one of them: reversing all its
            // rings restores it while leaving real holes (the Caspian) alone.
            land.coordinates.forEach(function (poly) {
                if (d3.geoArea({type: "Polygon", coordinates: poly}) > τ) {
                    poly.forEach(function (ring) { ring.reverse(); });
                }
            });
            return {
                coast: topojson.mesh(c10, c10.objects.land),
                borders: topojson.mesh(c10, c10.objects.countries, function (a, b) { return a !== b; }),
                land: land
            };
        });
    }

    // Two layers of line work: sphere fill + graticule live on #map, *below* the color
    // overlay; coastlines/borders/lakes live on #lines, *above* it — under the overlay the
    // 0.72 alpha dimmed outlines to ~30% brightness and they vanished behind the trails.
    // #lines is also above #animation, so the ocean layers' opaque land fill crops any
    // particle trail that strays past the coastline.
    function drawMap(fast) {
        if (!mesh) return;
        if (!fast) {
            // Every full-detail draw goes through here, whatever asked for it, so this is
            // the one place the "sharp supersedes pending-fast" rule cannot be forgotten.
            cancelManipulationFrame();
            ensureDetailMesh();
        }
        var detail = !fast && mesh10 && projection.scale() / initialScale > DETAIL_ZOOM;

        function strokeOn(ctx, path, geometry, alpha, width) {
            ctx.beginPath();
            path(geometry);
            ctx.strokeStyle = "rgba(255, 255, 255, " + alpha + ")";
            ctx.lineWidth = width;
            ctx.stroke();
        }

        var ctx = mapCanvas.getContext("2d");
        var path = d3.geoPath(projection, ctx);
        ctx.clearRect(0, 0, view.width, view.height);
        ctx.beginPath();
        path({type: "Sphere"});
        ctx.fillStyle = "#101018";
        ctx.fill();
        if (!activeRenderer) {
            strokeOn(ctx, path, {type: "Sphere"}, 0.25, 1.2);
            strokeOn(ctx, path, d3.geoGraticule10(), 0.12, 0.75);
        }

        var lctx = linesCanvas.getContext("2d");
        var lpath = d3.geoPath(projection, lctx);
        lctx.clearRect(0, 0, view.width, view.height);
        // A renderer layer gets no vector work from the engine: what belongs over its
        // pixels is its own call, so #lines is handed to it whole.
        if (activeRenderer) {
            activeRenderer.decorate(lctx);
            return;
        }
        if (landFill) {
            // Ocean layers: charcoal land painted *above* the overlay (nullschool's look).
            // The crisp vector edge also crops the ⅓°-grid staircase where sea color
            // bleeds past the coastline.
            lctx.beginPath();
            lpath(fast ? mesh.landLo : detail ? mesh10.land : mesh.landHi);
            lctx.fillStyle = "#333338";
            lctx.fill();
        }
        strokeOn(lctx, lpath, fast ? mesh.coastLo : detail ? mesh10.coast : mesh.coastHi, 1.0, 1.6);  // prominent continent outlines
        strokeOn(lctx, lpath, fast ? mesh.bordersLo : detail ? mesh10.borders : mesh.bordersHi, 0.3, 0.75);
        strokeOn(lctx, lpath, fast ? mesh.lakesLo : mesh.lakesHi, 0.4, 0.75);
    }

    function clearCanvas(canvas) {
        canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }

    // ------------------------------------------------------------------------------------------------
    // Mask and field interpolation (ported from earth.js)

    function createMask() {
        var canvas = document.createElement("canvas");
        canvas.width = view.width;
        canvas.height = view.height;
        var ctx = canvas.getContext("2d", {willReadFrequently: true});
        // Sentinel fill marking on-globe pixels; magenta is unreachable by the sinebow scale,
        // so leftovers at the antialiased rim can be erased safely after interpolation.
        ctx.fillStyle = "rgba(255, 0, 255, 1)";
        ctx.beginPath();
        d3.geoPath(projection, ctx)({type: "Sphere"});
        ctx.fill();

        var imageData = ctx.getImageData(0, 0, view.width, view.height);
        var data = imageData.data;
        var width = view.width;
        return {
            imageData: imageData,
            isVisible: function (x, y) {
                var i = (y * width + x) * 4;
                return data[i + 3] > 0;  // non-zero alpha means pixel is on the globe
            },
            set: function (x, y, rgba) {
                var i = (y * width + x) * 4;
                data[i] = rgba[0];
                data[i + 1] = rgba[1];
                data[i + 2] = rgba[2];
                data[i + 3] = rgba[3];
                return this;
            }
        };
    }

    function createField(columns, bounds, mask) {

        /** @returns wind vector [u, v, magnitude] at (x, y), or [NaN, NaN, null] if undefined there. */
        function field(x, y) {
            var column = columns[Math.round(x)];
            return column && column[Math.round(y)] || NULL_WIND_VECTOR;
        }

        field.isDefined = function (x, y) {
            return field(x, y)[2] !== null;
        };

        // Free the massive columns array for GC when this field is replaced.
        field.release = function () {
            columns = [];
        };

        field.randomize = function (o) {
            var x, y;
            var safetyNet = 0;
            do {
                x = Math.round(bounds.x + Math.random() * (bounds.xMax - bounds.x));
                y = Math.round(bounds.y + Math.random() * (bounds.yMax - bounds.y));
            } while (!field.isDefined(x, y) && safetyNet++ < 30);
            o.x = x;
            o.y = y;
            return o;
        };

        field.bounds = bounds;
        field.overlay = mask.imageData;
        return field;
    }

    /**
     * Anti-diagonal hatch color for dataless water at a screen pixel. Screen space rather than
     * globe space on purpose: it is a legend for missing data, not a feature of the map, so it
     * should not rotate or scale with the sphere. The interpolator writes 2x2 blocks, which is
     * exactly HATCH_WIDTH, so the stripe lands whole regardless of where the block grid starts.
     */
    function noDataHatchAt(x, y) {
        return (x + y) % HATCH_PERIOD < HATCH_WIDTH ? NO_DATA_HATCH : NO_DATA_WATER;
    }

    /**
     * Asynchronously interpolates the wind grid onto the screen: for every other pixel of the
     * visible globe, invert-project to coordinates, sample the wind, and distort it into a
     * screen-space motion vector. Also paints the overlay color into the mask's image data.
     */
    function interpolateField(grid, cancel, done) {
        var mask = createMask();
        var bounds = globeBounds();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        // Partial zoom normalization (the projection derivatives grow with scale): full
        // normalization made tracks short and sparse at every zoom; no normalization made
        // close-ups frantic and overshot tight vortices. The exponent grows speed gently with
        // zoom; MAX_PARTICLE_STEP still backstops the eyewall. Guard uses the same factor.
        var velocityScale = bounds.height * particleOpts.velocityScale *
            Math.pow(initialScale / projection.scale(), ZOOM_SPEED_EXPONENT);

        var columns = [];
        var point = [];
        var x = bounds.x;

        function interpolateColumn(x) {
            var column = [];
            for (var y = bounds.y; y <= bounds.yMax; y += 2) {
                if (mask.isVisible(x, y)) {
                    point[0] = x;
                    point[1] = y;
                    var coord = projection.invert(point);
                    var color = TRANSPARENT_BLACK;
                    var wind = null;
                    if (coord) {
                        var λ = coord[0], φ = coord[1];
                        if (isFinite(λ)) {
                            wind = grid.interpolate(λ, φ);
                            if (wind) {
                                var scalar = wind[2];  // magnitude in m/s, before distortion
                                wind = distort(λ, φ, x, y, velocityScale, wind);
                                color = overlayColorAt(λ, φ, scalar);
                            }
                            else if (landFill) {
                                // Dataless water on an ocean layer: shelf seas shallower than
                                // the layer, the Caspian, coastal grid holes. Hatched below.
                                color = NO_DATA_GRAY;
                            }
                        }
                    }
                    column[y + 1] = column[y] = wind || NULL_WIND_VECTOR;
                    // One interception for both dataless paths — the vector branch above and
                    // overlayColorAt's scalar branch, which returns the same sentinel. Real land
                    // is hatched here too, then hidden under drawMap's opaque charcoal fill on
                    // #lines; what survives is water the layer could not measure.
                    if (color === NO_DATA_GRAY) color = noDataHatchAt(x, y);
                    mask.set(x, y, color).set(x + 1, y, color).set(x, y + 1, color).set(x + 1, y + 1, color);
                }
            }
            columns[x + 1] = columns[x] = column;
        }

        (function batchInterpolate() {
            if (cancel.requested) return;
            var start = Date.now();
            while (x < bounds.xMax) {
                interpolateColumn(x);
                x += 2;
                if ((Date.now() - start) > MAX_TASK_TIME) {
                    setStatus("interpolating: " + Math.round((x - bounds.x) / (bounds.xMax - bounds.x) * 100) + "%");
                    setTimeout(batchInterpolate, MIN_SLEEP_TIME);
                    return;
                }
            }
            setStatus("");
            // Erase the sentinel mask fill left at rim pixels the 2x2 write pattern missed,
            // so the globe's antialiased edge doesn't show stray colored dots.
            var d = mask.imageData.data;
            for (var i = 0; i < d.length; i += 4) {
                if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) {
                    d[i + 3] = 0;
                }
            }
            done(createField(columns, bounds, mask));
        })();
    }

    // ------------------------------------------------------------------------------------------------
    // Low-res live overlay preview, shown while the globe is being dragged/zoomed

    var OVERLAY_PREVIEW_STEP = 5;    // sample every Nth css pixel; upscaled with smoothing
    var OVERLAY_PREVIEW_WAIT = 40;   // min millis between preview renders (~25 fps)
    var preview = null;
    var lastPreviewTime = 0;

    /**
     * Re-projects the wind overlay at coarse resolution so the color field tracks the globe
     * outline during manipulation (nullschool's "smudged" drag view). No distortion or particle
     * work — just invert-project + color per sample, so a frame costs a few milliseconds.
     * The full-resolution recompute's putImageData replaces this wholesale when it finishes.
     */
    function drawOverlayPreview() {
        if (activeRenderer) return activeRenderer.preview();
        if (!grid) return;
        var step = OVERLAY_PREVIEW_STEP;
        var w = Math.ceil(view.width / step), h = Math.ceil(view.height / step);
        if (!preview || preview.w !== w || preview.h !== h) {
            var c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            var ctx = c.getContext("2d");
            preview = {canvas: c, ctx: ctx, image: ctx.createImageData(w, h), w: w, h: h};
        }
        var data = preview.image.data;
        data.fill(0);
        var b = globeBounds();
        var i0 = Math.max(0, Math.floor(b.x / step)), i1 = Math.min(w - 1, Math.ceil(b.xMax / step));
        var j0 = Math.max(0, Math.floor(b.y / step)), j1 = Math.min(h - 1, Math.ceil(b.yMax / step));
        // Off-disc pixels must be masked by radius: d3-geo clamps asin internally, so
        // projection.invert returns finite (mirrored) coordinates even outside the globe.
        var t = projection.translate();
        var r2 = projection.scale() * projection.scale();
        var point = [];
        for (var j = j0; j <= j1; j++) {
            point[1] = (j + 0.5) * step;
            var dy = point[1] - t[1];
            for (var i = i0; i <= i1; i++) {
                point[0] = (i + 0.5) * step;
                var dx = point[0] - t[0];
                if (dx * dx + dy * dy > r2) continue;
                var coord = projection.invert(point);
                if (coord && isFinite(coord[0])) {
                    var wind = grid.interpolate(coord[0], coord[1]);
                    var color = wind ? overlayColorAt(coord[0], coord[1], wind[2]) :
                        landFill ? NO_DATA_GRAY : null;
                    // The preview samples every OVERLAY_PREVIEW_STEP px, far coarser than the
                    // hatch period, so stripes here would alias into moire. Use their area
                    // average: the drag smudge keeps the same tone the settled draw resolves to.
                    if (color === NO_DATA_GRAY) color = NO_DATA_FLAT;
                    if (color) {
                        var k = (j * w + i) * 4;
                        data[k] = color[0];
                        data[k + 1] = color[1];
                        data[k + 2] = color[2];
                        data[k + 3] = color[3];
                    }
                }
            }
        }
        preview.ctx.putImageData(preview.image, 0, 0);
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        overlayCtx.drawImage(preview.canvas, 0, 0, w * step, h * step);
    }

    function previewOverlayThrottled() {
        var now = Date.now();
        if (now - lastPreviewTime >= OVERLAY_PREVIEW_WAIT) {
            lastPreviewTime = now;
            drawOverlayPreview();
        }
    }

    /**
     * One manipulation repaint per animation frame, however many input events arrive.
     * The handlers used to draw inline, which meant a frame's worth of pointer events —
     * a pinch delivers one per finger that moved — each paid for a full drawMap(true).
     * On a mid-range phone that call is 60-100 ms of vector work by itself, so the extra
     * draws could only queue work the display was never going to show. Now the handlers
     * just move the projection and ask for a frame; the projection is read at draw time,
     * so the frame always paints the newest state and the last event is never dropped.
     */
    var frameRequested = 0;   // rAF handle of a pending manipulation draw, 0 when none
    function drawManipulationFrame() {
        if (frameRequested) return;
        frameRequested = requestAnimationFrame(function () {
            frameRequested = 0;
            drawMap(true);
            previewOverlayThrottled();
        });
    }

    /**
     * Drop a manipulation frame that has not run yet, because a full-detail draw is about to
     * supersede it.
     *
     * Without this the two are racing. The frame is asked for as the gesture moves; the
     * settling redraw is on scheduleRecompute's 200 ms timer. Normally the frame wins by an
     * order of magnitude and the sharp draw lands last, which is the order that matters —
     * but they only have to be reordered once for the pending frame to repaint the same
     * projection from the *low-detail* meshes on top of the sharp one, leaving the globe
     * coarse until something else touches it. A backgrounded tab produces that order every
     * time: animation frames stop while timers keep firing. So does any device slow enough
     * for a draw to overrun its frame, which is the device this coalescing exists for.
     */
    function cancelManipulationFrame() {
        if (!frameRequested) return;
        cancelAnimationFrame(frameRequested);
        frameRequested = 0;
    }

    // ------------------------------------------------------------------------------------------------
    // Particle animation (ported from earth.js)

    function animate(field, cancel) {
        var bounds = field.bounds;
        var colorStyles = windIntensityColorScale(INTENSITY_SCALE_STEP, particleOpts.maxIntensity,
            particleOpts.brightnessFloor);
        var buckets = colorStyles.map(function () { return []; });
        var dpr = window.devicePixelRatio || 1;
        // Trail shape is a per-layer choice: long fluid streamlines (winds, currents) vs
        // the wave layers' short crest dashes (small maxAge + fast fade).
        var maxAge = particleOpts.maxAge || MAX_PARTICLE_AGE;
        var crest = particleOpts.crestLength || 0;  // >0: dash ⊥ to travel instead of a trail segment
        // Scale count with dpr (capped) so thinner device-px trails keep the same visual density.
        var particleCount = Math.round(bounds.width * (particleOpts.multiplier || PARTICLE_MULTIPLIER) *
            Math.min(dpr, 2));
        if (isMobile()) {
            particleCount *= PARTICLE_REDUCTION;
        }
        // Streak-guard threshold: the fastest legitimate per-frame move is the dataset's max
        // wind speed converted to screen px at the current zoom (velocityScale × px-per-degree
        // at the globe center); ×2 slack covers the projection's legitimate distortion range.
        // Limb-distortion artifacts are 5-100× beyond this. Must scale with zoom — a fixed
        // threshold killed all fast-wind particles (empty typhoon eyewall) when zoomed in.
        var pxPerDegree = projection.scale() * Math.PI / 180;
        var zoomNorm = Math.pow(initialScale / projection.scale(), ZOOM_SPEED_EXPONENT);  // as in interpolateField
        var maxJump = Math.max(10, 2 * grid.maxSpeed * bounds.height * particleOpts.velocityScale * zoomNorm * pxPerDegree);
        var maxJump2 = maxJump * maxJump;

        var particles = [];
        for (var i = 0; i < particleCount; i++) {
            particles.push(field.randomize({age: Math.floor(Math.random() * maxAge)}));
        }

        function evolve() {
            buckets.forEach(function (bucket) { bucket.length = 0; });
            particles.forEach(function (particle) {
                if (particle.age > maxAge) {
                    field.randomize(particle).age = 0;
                }
                var x = particle.x;
                var y = particle.y;
                var v = field(x, y);  // vector at current position
                var m = v[2];
                if (m === null) {
                    particle.age = maxAge;  // particle has escaped the grid, never to return
                }
                else {
                    var xt = x + v[0];
                    var yt = y + v[1];
                    if ((xt - x) * (xt - x) + (yt - y) * (yt - y) > maxJump2) {
                        // The projection's finite-difference distortion diverges at the globe's
                        // limb, producing screen vectors hundreds of px long; drawing one paints
                        // a straight streak across the disc. Respawn the particle instead.
                        particle.age = maxAge;
                    }
                    else if (field.isDefined(xt, yt)) {
                        particle.xt = xt;
                        particle.yt = yt;
                        buckets[colorStyles.indexFor(m)].push(particle);
                    }
                    else {
                        // Particle isn't visible, but it still moves through the field.
                        particle.x = xt;
                        particle.y = yt;
                    }
                }
                particle.age += 1;
            });
        }

        var g = animCtx;
        // The layer's line width in device px regardless of screen density.
        g.lineWidth = (particleOpts.lineWidth || PARTICLE_LINE_WIDTH) / dpr;
        // Per-frame trail fade: 0.97 → long fluid streamlines; the wave layers drop it so
        // only the last few segments survive — a short dash, not a streak.
        g.fillStyle = "rgba(0, 0, 0, " + (particleOpts.fade || 0.97) + ")";

        function draw() {
            // Fade existing particle trails.
            var prev = g.globalCompositeOperation;
            g.globalCompositeOperation = "destination-in";
            g.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
            g.globalCompositeOperation = prev;

            // Draw new particle trails, one stroke per intensity bucket.
            buckets.forEach(function (bucket, i) {
                if (bucket.length > 0) {
                    g.beginPath();
                    g.strokeStyle = colorStyles[i];
                    // Crest mode: half-length grows with the bucket's intensity — long
                    // swell draws longer crests than short chop.
                    var half = crest * (0.5 + 0.5 * i / (colorStyles.length - 1));
                    bucket.forEach(function (particle) {
                        if (crest) {
                            // Oriented dash perpendicular to travel, through the midpoint:
                            // a wave crest marching in the propagation direction.
                            var dx = particle.xt - particle.x, dy = particle.yt - particle.y;
                            var len = Math.sqrt(dx * dx + dy * dy);
                            if (len > 0) {
                                var ux = -dy / len * half, uy = dx / len * half;
                                var mx = (particle.x + particle.xt) / 2;
                                var my = (particle.y + particle.yt) / 2;
                                g.moveTo(mx - ux, my - uy);
                                g.lineTo(mx + ux, my + uy);
                            }
                        }
                        else {
                            g.moveTo(particle.x, particle.y);
                            g.lineTo(particle.xt, particle.yt);
                        }
                        particle.x = particle.xt;
                        particle.y = particle.yt;
                    });
                    g.stroke();
                }
            });
        }

        (function frame() {
            if (cancel.requested) {
                field.release();
                return;
            }
            evolve();
            draw();
            setTimeout(frame, FRAME_RATE);
        })();
    }

    function isMobile() {
        return /android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i.test(navigator.userAgent);
    }

    // ------------------------------------------------------------------------------------------------
    // HUD

    function setStatus(msg) {
        document.getElementById("status").textContent = msg || " ";
    }

    function setLocation(msg) {
        document.getElementById("location").textContent = msg || " ";
    }

    /** Paints the menu's color bar and range label for the current overlay (wind or scalar). */
    function drawScaleBar() {
        var canvas = document.getElementById("scale");
        var ctx = canvas.getContext("2d");
        if (activeRenderer) {
            document.getElementById("scale-label").innerHTML =
                activeRenderer.scaleBar(ctx, canvas.width, canvas.height);
            return;
        }
        for (var i = 0; i < canvas.width; i++) {
            var t = i / (canvas.width - 1);
            var rgb = overlaySpec ? overlaySpec.lut[Math.round(t * 255)] : windOverlayColor(t * 100, 255);
            ctx.fillStyle = "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
            ctx.fillRect(i, 0, 1, canvas.height);
        }
        document.getElementById("scale-label").innerHTML =
            overlaySpec ? overlaySpec.scaleLabel : "0 &ndash; 360 km/h";
    }

    function formatCoordinates(λ, φ) {
        return Math.abs(φ).toFixed(2) + "° " + (φ >= 0 ? "N" : "S") + ", " +
            Math.abs(λ).toFixed(2) + "° " + (λ >= 0 ? "E" : "W");
    }

    function showLocation(point, grid) {
        var coord = projection.invert(point);
        if (!coord || !isFinite(coord[0]) || !isFinite(coord[1])) return;
        if (activeRenderer) {
            setLocation(activeRenderer.readout(coord[0], coord[1]) + " @ " +
                formatCoordinates(coord[0], coord[1]));
            return;
        }
        var parts = [];
        if (overlaySpec && scalarGrid) {
            var v = scalarGrid.interpolate(coord[0], coord[1]);
            if (v !== null) parts.push(overlaySpec.format(v));
        }
        var wind = grid.interpolate(coord[0], coord[1]);
        if (wind) parts.push(flowFormat(wind[2]));
        setLocation(parts.length ?
            parts.join(" · ") + " @ " + formatCoordinates(coord[0], coord[1]) :
            formatCoordinates(coord[0], coord[1]));
    }

    // ------------------------------------------------------------------------------------------------
    // Orchestration: interaction, cancellation, recompute

    // One layer is displayed at a time. Feature branches add entries here (and a
    // matching button in index.html's menu); the menu dispatches a "layerchange"
    // event with the layer id. `file` is the wind dataset that drives the particles;
    // an optional `scalar` spec colors the overlay from a second dataset instead of
    // wind speed: {file, lut, min, max, scaleLabel, format}.
    /** matplotlib's 'bwr' diverging colormap: pure blue → white → pure red, linear in RGB. */
    function bwrInterpolator(t) {
        var c = Math.round(t < 0.5 ? 510 * t : 510 * (1 - t));
        return t < 0.5 ? "rgb(" + c + "," + c + ",255)" : "rgb(255," + c + "," + c + ")";
    }

    // Data/code split (2026-07-12): the current-* weather JSONs are NOT in git — the
    // refresh scripts write them to public/data/ (git-ignored) for local dev, and CI
    // uploads them to a public Cloudflare R2 bucket for the deployed site. Static
    // topologies (earth-topo, countries) stay in the repo and always load relative.
    // Resolution order: #data=<url> hash override (for testing a bucket before wiring
    // it in) → local files when served from localhost/file: → the R2 public URL.
    // The bucket through worker/, not through its r2.dev URL: r2.dev is HTTP/1.1 only,
    // is not edge-cached, and answers in 300–800 ms. See the README's Serving chapter.
    var R2_DATA_ROOT = "https://earth-data.globe-climatesim.workers.dev/";
    var DATA_ROOT = (function () {
        var override = new URLSearchParams(location.hash.slice(1)).get("data");
        if (override) return override.replace(/\/?$/, "/");
        var local = /^(localhost|127\.|\[::1\])/.test(location.hostname) ||
            location.protocol === "file:";
        return local ? "data/" : R2_DATA_ROOT;
    })();

    var SURFACE_WIND = DATA_ROOT + "current-wind-surface-level-gfs-0.25.json";
    // Shared by the Ocean layers: CMEMS currents drive the particles everywhere (as surface
    // wind does for the Atmosphere scalar layers), and the readout speaks m/s, not km/h.
    var OCEAN_CURRENTS = DATA_ROOT + "current-ocean-currents-cmems-0.25.json";
    var OCEAN_CREDIT = "CMEMS 0.25&deg; &nbsp;|&nbsp; Copernicus Marine Service";
    var OCEAN_DATE_LABEL = "Data: CMEMS daily mean, ";
    // Currents peak ~1.5 m/s vs ~100 m/s wind: particles need a much larger velocity
    // scale to visibly flow, and trail brightness saturates early (0.7 m/s, cambecc's
    // OSCAR value). Matched to nullschool by user comparison: moderately dense,
    // slightly-thicker-than-wind strokes, faster motion (was 1/2500 · ×7 · 1.2 px).
    // brightnessFloor pins the pre-whitening 130: the currents' strokes were never thinned and
    // their fast cores already run near-white, so the wind layers' brighter floor would blow
    // the Kuroshio/Gulf Stream out rather than lift faint trails.
    var OCEAN_PARTICLES = {velocityScale: 1 / 1700, maxIntensity: 0.7, multiplier: 4, lineWidth: 1.7,
        brightnessFloor: 130};
    var OCEAN_PLACEHOLDER = "click a point for current speed";
    // Ocean overlays render dimmer than the atmosphere's OVERLAY_ALPHA: the near-black
    // sphere bleeds through, deepening the calm-sea colors so the trails/crests read on top.
    var OCEAN_ALPHA = Math.floor(0.58 * 255);
    function metersPerSecond(v) { return v.toFixed(2) + " m/s"; }
    // One spec shared by every current-speed layer (surface, 25 m):
    var CURRENT_SPEED_SCALAR = {
        fromMagnitude: true,  // color by current speed itself — no second dataset
        alpha: OCEAN_ALPHA,
        // nullschool's ocean palette: deep blue abyss → green → sand → red jets
        lut: segmentedLut([
            [0.0, [10, 25, 68]],
            [0.15, [10, 25, 250]],
            [0.4, [24, 255, 93]],
            [0.65, [255, 233, 102]],
            [1.0, [255, 233, 15]],
            [1.5, [255, 15, 15]]
        ], 0, 1.5),
        min: 0, max: 1.5,
        scaleLabel: "0 &ndash; 1.5 m/s",
        format: metersPerSecond
    };
    // Waves: GFS-Wave (WAVEWATCH III) via the same NOMADS filter as the atmosphere layers.
    // One combined map (user spec, like nullschool): height colormap background + direction/
    // period crest dashes. The flow file's vectors point in the propagation direction and
    // their magnitude is the PEAK PERIOD IN SECONDS, so the click readout speaks "m · s".
    var WAVE_FLOW = DATA_ROOT + "current-ocean-waves-gfswave-0.25.json";
    var WAVE_CREDIT = "GFS-Wave 0.25&deg; &nbsp;|&nbsp; WAVEWATCH III / NCEP / NWS";
    var WAVE_DATE_LABEL = "Data: GFS-Wave (WW3), ";
    function seconds(v) { return v.toFixed(1) + " s"; }
    // Wave crests, not wind traces (user spec against the nullschool zoom shot): each
    // particle draws an oriented dash PERPENDICULAR to its travel (crestLength = max half-
    // length in px; longer swell draws longer crests). Magnitudes are periods (~5–20 s),
    // and deep-water phase speed grows with period, so the low brightnessFloor makes
    // faster waves visibly brighter than slow chop. The tiny velocityScale keeps the
    // crests barely creeping (waves are localized and far slower than winds); maxAge/fade
    // give each dash a soft ease-in/out with no trailing smear at that near-static speed.
    var WAVE_PARTICLES = {velocityScale: 1 / 360000, maxIntensity: 22, multiplier: 3,
        lineWidth: 2.5, maxAge: 20, fade: 0.72, crestLength: 4.5, brightnessFloor: 40};
    var LAYERS = {
        "surface": {file: SURFACE_WIND, label: "Wind @ Surface"},
        "1000hpa": {file: DATA_ROOT + "current-wind-1000hpa-gfs-0.25.json", label: "Wind @ 1000 hPa"},
        "500hpa": {file: DATA_ROOT + "current-wind-500hpa-gfs-0.25.json", label: "Wind @ 500 hPa"},
        "10hpa": {file: DATA_ROOT + "current-wind-10hpa-gfs-0.25.json", label: "Wind @ 10 hPa"},
        "temperature": {file: SURFACE_WIND, label: "Temperature @ Surface", scalar: {
            file: DATA_ROOT + "current-temp-surface-level-gfs-0.25.json",
            // bwr diverging, domain -10–45 °C (user spec, was ±50): the populated range
            // gets the color stretch; beyond the endpoints pins to the end colors via
            // the clamped LUT index. White midpoint sits at 17.5 °C.
            lut: colormapLut(bwrInterpolator),
            min: 263.15, max: 318.15,  // -10 – 45 °C
            scaleLabel: "-10 &ndash; 45 &deg;C",
            format: function (v) { return (v - 273.15).toFixed(1) + " °C"; }
        }},
        "rh": {file: SURFACE_WIND, label: "Rel. Humidity @ Surface", scalar: {
            file: DATA_ROOT + "current-rh-surface-level-gfs-0.25.json",
            lut: colormapLut(d3.interpolateBuPu),  // Purples → BuPu for better contrast (user preference)
            min: 0, max: 100,
            scaleLabel: "0 &ndash; 100 %",
            format: function (v) { return v.toFixed(0) + " %"; }
        }},
        "dew": {file: SURFACE_WIND, label: "Dew Point @ Surface", scalar: {
            file: DATA_ROOT + "current-dewpoint-surface-level-gfs-0.25.json",
            lut: colormapLut(d3.interpolatePuBuGn),
            min: 233.15, max: 308.15,  // -40 – 35 °C
            scaleLabel: "-40 &ndash; 35 &deg;C",
            format: function (v) { return (v - 273.15).toFixed(1) + " °C"; }
        }},
        "ocean": {file: OCEAN_CURRENTS, label: "Ocean Currents @ Surface",
            credit: OCEAN_CREDIT, dateLabel: OCEAN_DATE_LABEL,
            landFill: true,  // charcoal continents above the overlay, nullschool-style
            placeholder: OCEAN_PLACEHOLDER,
            particles: OCEAN_PARTICLES, flowFormat: metersPerSecond,
            scalar: CURRENT_SPEED_SCALAR},
        // 25.21 m: near the base of the tropical mixed layer — the flow starts diverging
        // from the wind-driven surface drift (user pick, was 109.73 m).
        "ocean25": {file: DATA_ROOT + "current-ocean-currents-25m-cmems-0.25.json",
            label: "Ocean Currents @ 25 m",
            credit: OCEAN_CREDIT, dateLabel: OCEAN_DATE_LABEL,
            landFill: true, placeholder: OCEAN_PLACEHOLDER,
            particles: OCEAN_PARTICLES, flowFormat: metersPerSecond,
            scalar: CURRENT_SPEED_SCALAR},
        // 109.73 m: below the seasonal thermocline — the wind-driven signal is gone
        // and the flow is dominated by the large-scale gyres.
        "ocean110": {file: DATA_ROOT + "current-ocean-currents-110m-cmems-0.25.json",
            label: "Ocean Currents @ 110 m",
            credit: OCEAN_CREDIT, dateLabel: OCEAN_DATE_LABEL,
            landFill: true, placeholder: OCEAN_PLACEHOLDER,
            particles: OCEAN_PARTICLES, flowFormat: metersPerSecond,
            scalar: CURRENT_SPEED_SCALAR},
        // 453.94 m: intermediate water. Speeds here are far below the 1.5 m/s
        // surface domain, so most of the map sits at the palette's deep-blue end —
        // that is the physical result, not a scaling bug.
        "ocean450": {file: DATA_ROOT + "current-ocean-currents-450m-cmems-0.25.json",
            label: "Ocean Currents @ 450 m",
            credit: OCEAN_CREDIT, dateLabel: OCEAN_DATE_LABEL,
            landFill: true, placeholder: OCEAN_PLACEHOLDER,
            particles: OCEAN_PARTICLES, flowFormat: metersPerSecond,
            scalar: CURRENT_SPEED_SCALAR},
        "sst": {file: OCEAN_CURRENTS, label: "Sea Water Temperature @ Surface",
            credit: OCEAN_CREDIT, dateLabel: OCEAN_DATE_LABEL,
            landFill: true, placeholder: "click a point for sea temperature",
            particles: OCEAN_PARTICLES, flowFormat: metersPerSecond,
            scalar: {
                file: DATA_ROOT + "current-ocean-temp-cmems-0.25.json",
                // Same bwr diverging scheme as the Atmosphere temperature layer. Upper
                // limit pinned at 35 °C (user's spec — the ocean never gets hotter, so a
                // 50 °C ceiling wasted the red half). thetao is already °C. Values outside
                // the domain pin to the end colors — the LUT index is clamped.
                lut: colormapLut(bwrInterpolator),
                min: 0, max: 35,
                scaleLabel: "0 &ndash; 35 &deg;C",
                format: function (v) { return v.toFixed(1) + " °C"; }
            }},
        "waves": {file: WAVE_FLOW, label: "Ocean Waves",
            credit: WAVE_CREDIT, dateLabel: WAVE_DATE_LABEL,
            landFill: true, placeholder: "click a point for wave height",
            particles: WAVE_PARTICLES, flowFormat: seconds,
            scalar: {
                file: DATA_ROOT + "current-ocean-wave-height-gfswave-0.25.json",
                alpha: OCEAN_ALPHA,
                // Significant wave height, blue → light blue → yellow → orange → saffron
                // (user spec): calm seas deep blue, 15 m saffron; higher values clip to
                // saffron via the clamped LUT index.
                lut: segmentedLut([
                    [0.0, [12, 44, 132]],
                    [4.0, [110, 175, 225]],
                    [8.0, [240, 228, 110]],
                    [11.5, [255, 165, 0]],
                    [15.0, [255, 103, 31]]
                ], 0, 15),
                min: 0, max: 15,
                scaleLabel: "0 &ndash; 15 m",
                format: function (v) { return v.toFixed(1) + " m"; }
            }}
    };

    // ------------------------------------------------------------------------------------------------
    // Renderer plug-ins
    //
    // A script loaded before this one may register a renderer on window.EarthRenderers; its
    // layers join LAYERS and, while one of them is displayed, it owns the overlay canvas
    // instead of the grid → field → particles pipeline. The split is state vs pixels: the
    // engine keeps everything that holds a render onto the globe (the projection instance,
    // the four canvases, drag/wheel/pinch, the cancel token, the recompute debounce, the URL
    // hash, the HUD), and a renderer only draws. The alternative — a second script owning its
    // own projection and interaction — means two copies of the view state to keep in sync on
    // every drag frame. js/sunlight.js is the first plug-in; see its header for the contract:
    //
    //   register(engine, dataRoot) → layers    latch the context, return layers to register
    //   overlayScale()                         backing-store px per CSS px it wants
    //   tick                                   ms between automatic re-renders, 0 for static
    //   load(layer) → Promise                  fetch/decode, resolved when ready to draw
    //   beginFrame()                           latch per-frame state before the engine draws
    //   render(cancel)                         paint the overlay, yielding on the token
    //   preview()                              cheap repaint per drag frame
    //   decorate(ctx)                          draw on #lines, above the overlay
    //   scaleBar(ctx, w, h) → label            paint the legend, return its caption
    //   readout(λ, φ) → text                   the click readout, minus the coordinates
    //
    // zoom() and requestRender() exist for renderers that swap in sharper assets as the view
    // closes in: zoom() is the same ×fitted-scale number the URL hash carries, and
    // requestRender() re-enters the settled-view path once a lazily-fetched asset is ready.
    var ENGINE = {
        projection: projection,
        overlay: overlayCanvas,
        overlayCtx: overlayCtx,
        view: function () { return view; },
        bounds: globeBounds,
        zoom: function () { return projection.scale() / initialScale; },
        requestRender: function () { recompute(); },
        overlayScale: function () { return overlayScale; },
        setStatus: setStatus,
        setDate: function (text) { document.getElementById("data-date").textContent = text; },
        isMobile: isMobile,
        maxTaskTime: MAX_TASK_TIME,
        minSleepTime: MIN_SLEEP_TIME
    };

    // A renderer plug-in may be loaded at boot (a plain <script> before this one, which is
    // how the contract began) or deferred to the first time one of its layers is asked for.
    // js/sunlight.js and the SunCalc it depends on are 63 KB of source serving three of
    // sixteen layers, and until now every visit that never opened RealView still parsed
    // them on the boot path. A stub names the scripts and the ids they will register.
    //
    // Deferring does not mean withholding: once the first layer has rendered, an idle
    // callback warms them anyway, so a later RealView click is normally instant. What the
    // deferral buys is the boot path, not the bytes.
    var DEFERRED_RENDERERS = [{
        scripts: ["libs/suncalc.js", "js/sunlight.js"],   // in order — sunlight.js needs SunCalc
        layers: ["daylight", "nightlights", "relief"]
    }];

    var renderersRegistered = {};

    function registerRenderers() {
        Object.keys(window.EarthRenderers || {}).forEach(function (name) {
            if (renderersRegistered[name]) return;
            renderersRegistered[name] = true;
            var renderer = window.EarthRenderers[name];
            var layers = renderer.register(ENGINE, DATA_ROOT);
            Object.keys(layers).forEach(function (id) {
                layers[id].renderer = renderer;   // how loadLayer knows to hand the layer over
                LAYERS[id] = layers[id];
            });
        });
    }

    function deferredFor(id) {
        for (var i = 0; i < DEFERRED_RENDERERS.length; i++) {
            if (DEFERRED_RENDERERS[i].layers.indexOf(id) >= 0) return DEFERRED_RENDERERS[i];
        }
        return null;
    }

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var el = document.createElement("script");
            el.src = src;
            el.async = false;      // these are a dependency chain, not independent scripts
            el.onload = function () { resolve(); };
            el.onerror = function () { reject(new Error("script: " + src)); };
            document.head.appendChild(el);
        });
    }

    /** Load a deferred renderer's scripts once, register what they declare, and cache it. */
    function loadDeferred(spec) {
        if (!spec.promise) {
            spec.promise = spec.scripts.reduce(function (chain, src) {
                return chain.then(function () { return loadScript(src); });
            }, Promise.resolve()).then(function () {
                registerRenderers();
                checkPreloadMap();   // its layers exist now, so their images can be checked
            }).catch(function (err) {
                spec.promise = null;   // a failed load must not poison the next click
                throw err;
            });
        }
        return spec.promise;
    }

    registerRenderers();

    /**
     * index.html prefetches the boot layer's dataset from an inline script, which has to run
     * before any of this exists and therefore duplicates the file names below. Nothing breaks
     * when the two drift — loadGrid() misses the prefetch and fetches normally — but the
     * prefetch then spends 1.5–2 MB on a file nobody wants, which is silent and expensive.
     * So compare the two maps once at boot and say so. Runs after the renderer merge, so the
     * RealView layers are present and their images get checked too.
     */
    function checkPreloadMap() {
        var preload = window.__earthPreload;
        if (!preload) return;
        function report(id, kind, got, want) {
            if (got.join("|") === want.join("|")) return;
            console.warn("stale prefetch map in index.html — layer '" + id + "' " + kind +
                ": prefetch has " + JSON.stringify(got) + ", registry wants " + JSON.stringify(want));
        }
        Object.keys(LAYERS).forEach(function (id) {
            var layer = LAYERS[id];
            function rooted(names) {
                return (names || []).map(function (n) { return DATA_ROOT + n; });
            }
            if (layer.renderer) {
                report(id, "images", rooted(preload.images[id]),
                    [layer.texture, layer.night, layer.relief].filter(Boolean));
                return;
            }
            var want = [layer.file];
            if (layer.scalar && layer.scalar.file) want.push(layer.scalar.file);
            report(id, "data", rooted(preload.files[id]), want);
        });
    }

    var DEFAULT_LAYER = "surface";
    var DEFAULT_CREDIT = "GFS 0.25&deg; &nbsp;|&nbsp; NCEP / US National Weather Service";
    var DEFAULT_PARTICLES = {velocityScale: VELOCITY_SCALE, maxIntensity: MAX_INTENSITY};
    var KMH = function (v) { return (v * 3.6).toFixed(0) + " km/h"; };  // default flow readout
    var DEFAULT_PLACEHOLDER = "click a point for wind speed";

    var currentCancel = {requested: false};
    var recomputeTimer = null;
    var grid = null;
    var scalarGrid = null;    // secondary scalar field of the current layer, or null
    var overlaySpec = null;   // the current layer's scalar spec, or null (= wind-speed overlay)
    var particleOpts = DEFAULT_PARTICLES;  // the current layer's animation tuning
    var landFill = false;     // charcoal land above the overlay (ocean layers)
    var flowFormat = KMH;     // click-readout format for the particle flow's speed
    var currentLayerId = null;  // active layer id — the hash write-back's source of truth
    var activeRenderer = null;  // renderer plug-in owning the overlay, or null for the data layers
    var rendererTimer = null;   // its periodic re-render, if it asked for one

    function cancelWork() {
        currentCancel.requested = true;
        currentCancel = {requested: false};
        return currentCancel;
    }

    /**
     * Called when the user starts rotating/zooming: stop the animation and hide the trails.
     * The overlay is kept and repainted per manipulation frame by the low-res preview so the
     * "smudged" color field tracks the globe outline; the full-resolution recompute replaces
     * it wholesale (putImageData) when it finishes.
     */
    function startManipulation() {
        cancelWork();
        clearTimeout(recomputeTimer);
        clearCanvas(animCanvas);
        setStatus("");
    }

    // The hash doubles as the shareable view state: layer, center and zoom are
    // written back after every settled interaction, so copying the URL or reloading
    // restores exactly what is on screen. replaceState, not location.hash, to avoid
    // filling the back button with every drag. A #data= override is carried through
    // verbatim — DATA_ROOT resolved from it at load, so dropping it would silently
    // send a reload back to the R2 bucket.
    var hashDataOverride = new URLSearchParams(location.hash.slice(1)).get("data");
    function writeHash() {
        if (!currentLayerId) return;
        var r = projection.rotate();
        var parts = [
            "layer=" + currentLayerId,
            "rotate=" + r[0].toFixed(1) + "," + r[1].toFixed(1),
            "zoom=" + (projection.scale() / initialScale).toFixed(2)
        ];
        if (hashDataOverride) parts.push("data=" + hashDataOverride);
        history.replaceState(null, "", "#" + parts.join("&"));
    }

    /** Zoom is clamped to 0.5x-MAX_ZOOM of the fitted scale, wheel and pinch alike. */
    function clampScale(scale) {
        return Math.max(initialScale * 0.5, Math.min(initialScale * MAX_ZOOM, scale));
    }

    function scheduleRecompute() {
        clearTimeout(recomputeTimer);
        recomputeTimer = setTimeout(function () {
            writeHash();   // every gesture settles here — drag, wheel, pinch, resize
            recompute();
        }, 200);
    }

    function recompute() {
        if (activeRenderer) {
            var rendererCancel = cancelWork();
            activeRenderer.beginFrame();   // before drawMap: its decoration shares the frame's state
            drawMap(false);
            activeRenderer.render(rendererCancel);
            return;
        }
        if (!grid) return;
        var cancel = cancelWork();
        drawMap(false);
        interpolateField(grid, cancel, function (field) {
            if (cancel.requested) return;
            overlayCtx.putImageData(field.overlay, 0, 0);
            animate(field, cancel);
        });
    }

    // Built grids, keyed by dataset URL. Datasets are shared — surface wind backs four
    // Atmosphere layers, the CMEMS currents back two Ocean ones — so this also makes the
    // second of any such pair free, not just a return visit to the same layer. What it saves
    // per hit is the fetch, the JSON.parse (50–95 ms) and the grid build.
    //
    // The cache is per page load, so `cache: "no-cache"` still does its job: a refreshed
    // dataset appears on a plain reload, exactly as documented. What changes is that a layer
    // re-selected *within* one session no longer re-reads the server — irrelevant against a
    // 6-hourly refresh.
    //
    // A flow grid is ~8 MB of Float32 (a scalar grid half that), hence the cap. Eviction is
    // oldest-inserted, which across a menu this size is close enough to least-recently-used.
    var MAX_CACHED_GRIDS = 6;
    var gridCache = new Map();

    /**
     * A built grid for `url`: from the cache, else from the inline prefetch in index.html,
     * else from the network. `what` names the dataset in any error the caller surfaces.
     */
    // Raw fetches already in flight, by URL: the boot prefetch, a hover warm and the real
    // load all meet here, so a dataset is never requested twice. Entries are dropped as soon
    // as a grid is built from them — the parsed JSON is ~9 MB and the built grid supersedes it.
    var pendingJson = {};
    var claimedJson = {};  // URLs a loadGrid is currently building from — never release these
    var warmedUrls = [];   // warmed but not yet consumed; bounded to one layer's worth

    function fetchJson(url) {
        if (!pendingJson[url]) {
            var preload = window.__earthPreload;
            // take() is single-use: the boot prefetch holds each promise until someone claims it.
            pendingJson[url] = (preload && preload.take(url)) ||
                fetch(url, {cache: "no-cache"}).then(function (r) {
                    if (!r.ok) throw new Error("HTTP " + r.status);
                    return r.json();
                });
            // A failure must not be cached as a permanent one, and an unclaimed rejection
            // must not surface as unhandled.
            pendingJson[url].catch(function () { delete pendingJson[url]; });
        }
        return pendingJson[url];
    }

    function loadGrid(url, build, what) {
        var hit = gridCache.get(url);
        if (hit) return Promise.resolve(hit);
        // Claim it for the duration: a hover on some other layer must not release the entry
        // this load is about to consume, or a second load of the same URL would refetch it.
        claimedJson[url] = (claimedJson[url] || 0) + 1;
        function done() {
            if (--claimedJson[url] <= 0) delete claimedJson[url];
        }
        return fetchJson(url).then(function (records) {
            var built = build(records);
            done();
            delete pendingJson[url];       // the JSON has served its purpose; let it go
            gridCache.set(url, built);
            while (gridCache.size > MAX_CACHED_GRIDS) {
                gridCache.delete(gridCache.keys().next().value);
            }
            return built;
        }, function (err) {
            done();
            throw new Error(what + ": " + err.message);   // only the load's own failures
        });
    }

    /**
     * Start a layer's downloads before it is chosen, on the strength of a pointer resting on
     * its menu button or tabbing to it. Intent, not prediction: hovering is a strong signal
     * and costs nothing when it turns out to be wrong, where an idle "probably next" prefetch
     * would spend 1.5–2 MB on a guess — on a phone, someone else's guess and someone else's
     * data. Only one layer is held warm at a time, so an unclaimed warm cannot accumulate.
     */
    function warmLayer(id) {
        var layer = LAYERS[id];
        if (!layer) {
            var spec = deferredFor(id);
            if (spec) loadDeferred(spec).catch(function () {});   // the scripts, not the imagery
            return;
        }
        if (layer.renderer) {
            // Renderer layers decode images; warming the browser's image cache is enough,
            // and the crossOrigin must match or texture() opens a second request.
            [layer.texture, layer.night, layer.relief].forEach(function (url) {
                if (!url) return;
                var img = new Image();
                img.crossOrigin = "anonymous";
                img.src = url;
            });
            return;
        }
        var urls = [layer.file];
        if (layer.scalar && layer.scalar.file) urls.push(layer.scalar.file);
        if (urls.every(function (u) { return gridCache.has(u) || pendingJson[u]; })) return;
        // Release the previous warm first: dropping the last reference to an unclaimed
        // promise is what lets its parsed JSON be collected.
        warmedUrls.forEach(function (u) {
            if (!gridCache.has(u) && !claimedJson[u]) delete pendingJson[u];
        });
        warmedUrls = urls;
        urls.forEach(function (u) { fetchJson(u); });
    }

    /**
     * Fetch a layer's dataset — or hand it to its renderer plug-in — and restart the pipeline
     * on it. The map topology is loaded once in init(); switching layers only swaps the data.
     */
    function loadLayer(id) {
        var layer = LAYERS[id];
        if (!layer) {
            // Not registered yet: either it is a deferred renderer's layer and this click is
            // what pays for it, or the id is simply unknown and there is nothing to do.
            var spec = deferredFor(id);
            if (!spec) return;
            setStatus("loading renderer…");
            loadDeferred(spec).then(function () {
                loadLayer(id);
            }).catch(function (err) {
                console.error(err);
                setStatus("error: " + err.message);
            });
            return;
        }
        currentLayerId = id;
        cancelWork();
        clearTimeout(recomputeTimer);
        clearInterval(rendererTimer);
        clearCanvas(animCanvas);
        activeRenderer = layer.renderer || null;
        // Every render path writes a full-canvas putImageData, so the outgoing layer's
        // overlay is replaced wholesale rather than cleared — it stays on screen while the
        // next one loads, which is how switching between the data layers has always looked.
        var wanted = activeRenderer ? activeRenderer.overlayScale() : 1;
        if (wanted !== overlayScale) {
            overlayScale = wanted;
            sizeOverlayCanvas();
        }
        document.querySelectorAll(".layer[data-layer]").forEach(function (b) {
            b.classList.toggle("active", b.dataset.layer === id);
        });
        // Reveal the tab that owns the layer (matters when booting via #layer=…).
        var activeBtn = document.querySelector('.layer[data-layer="' + id + '"]');
        var body = activeBtn && activeBtn.closest(".tab-body");
        if (body) {
            document.querySelectorAll("#tabs .tab").forEach(function (t) {
                t.classList.toggle("active", t.dataset.tab === body.dataset.tab);
            });
            document.querySelectorAll(".tab-body").forEach(function (b) {
                b.hidden = b !== body;
            });
        }
        // `label` is the layer's human name — it titles the document (so a bookmark
        // or a tab says which layer it is) and nothing else reads it.
        document.title = "earth · " + layer.label;
        // The readout is per-layer: the old text is in the previous layer's units,
        // and the units differ (km/h, m/s, m · s).
        setLocation(layer.placeholder || DEFAULT_PLACEHOLDER);
        writeHash();
        setStatus("downloading data…");

        // A renderer layer has no grids: it loads whatever it draws from, then owns the frame.
        if (activeRenderer) {
            grid = scalarGrid = overlaySpec = null;
            landFill = false;
            activeRenderer.load(layer).then(function () {
                drawScaleBar();
                document.getElementById("data-label").innerHTML = layer.credit || DEFAULT_CREDIT;
                recompute();
                if (activeRenderer.tick) rendererTimer = setInterval(recompute, activeRenderer.tick);
            }).catch(function (err) {
                console.error(err);
                setStatus("error: " + err.message);
            });
            return;
        }

        var loads = [loadGrid(layer.file, buildGrid, "wind data")];
        if (layer.scalar && layer.scalar.file) {
            loads.push(loadGrid(layer.scalar.file, buildScalarGrid, "overlay data"));
        }
        Promise.all(loads).then(function (results) {
            grid = results[0];
            overlaySpec = layer.scalar || null;
            scalarGrid = results.length > 1 ? results[1] : null;
            particleOpts = layer.particles || DEFAULT_PARTICLES;
            landFill = !!layer.landFill;
            flowFormat = layer.flowFormat || KMH;
            drawScaleBar();
            document.getElementById("data-label").innerHTML = layer.credit || DEFAULT_CREDIT;
            document.getElementById("data-date").textContent =
                (layer.dateLabel || "Data: GFS analysis, ") + formatDate(grid.date);
            recompute();
        }).catch(function (err) {
            console.error(err);
            setStatus("error: " + err.message);
        });
    }

    document.addEventListener("layerchange", function (e) {
        loadLayer(e.detail);
    });

    // Intent to switch, from either input model: a pointer settling on a button, or a
    // keyboard tab landing on it. touchstart is deliberately absent — on a touch device the
    // press that would trigger it is the selection itself, so there is nothing to gain and
    // a mis-tap to pay for.
    ["pointerenter", "focusin"].forEach(function (type) {
        document.addEventListener(type, function (e) {
            var btn = e.target.closest && e.target.closest(".layer[data-layer]");
            if (btn && btn.dataset.layer !== currentLayerId) warmLayer(btn.dataset.layer);
        }, true);   // capture: pointerenter does not bubble
    });

    function attachInteraction() {
        var display = d3.select("#display");
        var rotateStart, pointerStart, moved;
        // Two-finger pinch runs beside d3.drag rather than through it. The flag stays
        // set until every finger lifts, so the one-finger drag that d3 may already
        // have running (finger 1 down, finger 2 added later) neither rotates the globe
        // mid-pinch nor fires a click readout when the gesture ends.
        var pinching = false, pinchStartDist = 0, pinchStartScale = 0;

        function touchSpread(touches) {
            var dx = touches[0].clientX - touches[1].clientX;
            var dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        var drag = d3.drag()
            // Reject the second finger so a pinch never starts a rotation as well.
            .filter(function (event) {
                if (event.touches) return event.touches.length === 1;
                return !event.ctrlKey && !event.button;
            })
            .on("start", function (event) {
                rotateStart = projection.rotate();
                pointerStart = [event.x, event.y];
                moved = false;
            })
            .on("drag", function (event) {
                if (pinching) return;
                if (!moved) {
                    var dx0 = event.x - pointerStart[0], dy0 = event.y - pointerStart[1];
                    if (dx0 * dx0 + dy0 * dy0 < 9) return;  // ignore sub-3px jitter so clicks stay clicks
                    moved = true;
                    startManipulation();
                }
                var sensitivity = 75 / projection.scale();
                var λ = rotateStart[0] + (event.x - pointerStart[0]) * sensitivity;
                var φ = rotateStart[1] - (event.y - pointerStart[1]) * sensitivity;
                projection.rotate([λ, Math.max(-90, Math.min(90, φ)), rotateStart[2]]);
                drawManipulationFrame();
            })
            .on("end", function (event) {
                if (pinching) return;
                if (moved) {
                    scheduleRecompute();
                }
                else if (grid || activeRenderer) {
                    showLocation([event.x, event.y], grid);
                }
            });

        display.call(drag);

        display.on("wheel", function (event) {
            event.preventDefault();
            startManipulation();
            var k = Math.exp(-event.deltaY * 0.0018);
            projection.scale(clampScale(projection.scale() * k));
            drawManipulationFrame();
            scheduleRecompute();
        }, {passive: false});

        // Pinch zoom: the scale tracks the ratio of finger spread to its value at
        // gesture start, which keeps it absolute — no drift over a long pinch — and
        // reuses the wheel's clamp so both paths stop at the same 0.5x-MAX_ZOOM limits.
        // #display sets touch-action: none, without which the browser would consume
        // the gesture as a page zoom and no touchmove would arrive.
        //
        // Capture phase, and that is load-bearing rather than incidental. d3.drag's touch
        // handlers call stopImmediatePropagation for every changed touch that still owns a
        // gesture, and finger 1 owns one for the whole pinch — the filter above only ever
        // rejected finger 2. Listening on the bubble phase therefore lost every event in
        // which finger 1 moved, which on a real hand is nearly all of them: the zoom
        // advanced only on the frames where the anchor finger happened to be still, and
        // the closing touchend was swallowed too whenever finger 1 was the last to lift,
        // leaving `pinching` set and the globe unrotatable until reload. Capturing on
        // #display runs these handlers before d3 gets the chance.
        var CAPTURE = {passive: false, capture: true};
        var node = display.node();
        node.addEventListener("touchstart", function (event) {
            if (event.touches.length !== 2) return;
            event.preventDefault();
            pinching = true;
            pinchStartDist = touchSpread(event.touches);
            pinchStartScale = projection.scale();
            startManipulation();
        }, CAPTURE);

        node.addEventListener("touchmove", function (event) {
            if (!pinching || event.touches.length !== 2 || !pinchStartDist) return;
            event.preventDefault();
            projection.scale(clampScale(pinchStartScale * touchSpread(event.touches) / pinchStartDist));
            drawManipulationFrame();
        }, CAPTURE);

        function endPinch(event) {
            if (!pinching || event.touches.length > 0) return;  // hold until every finger lifts
            pinchStartDist = 0;
            scheduleRecompute();
            // Clear on the next tick, not synchronously: a d3.drag "end" can fire from
            // this same touchend (finger 1 was down before finger 2 landed), and capturing
            // puts that handler *after* this one, so the flag has to outlive the event turn
            // or the lift would end the gesture with a click readout.
            setTimeout(function () { pinching = false; }, 0);
        }
        node.addEventListener("touchend", endPinch, CAPTURE);
        node.addEventListener("touchcancel", endPinch, CAPTURE);
    }

    var resizeTimer = null;
    window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            startManipulation();
            view = {width: window.innerWidth, height: window.innerHeight};
            var relativeScale = projection.scale() / initialScale;
            sizeCanvases();
            initialScale = Math.min(view.width, view.height) * 0.42;
            projection.scale(initialScale * relativeScale).translate([view.width / 2, view.height / 2]);
            drawMap(false);
            scheduleRecompute();
        }, 250);
    });

    // ------------------------------------------------------------------------------------------------
    // Boot

    function formatDate(date) {
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate()) +
            " " + pad(date.getUTCHours()) + ":00 UTC";
    }

    // The view a visitor gets when their timezone yields nothing: centered over the
    // Bay of Bengal, which was the fixed starting view before homeCenter() existed.
    var DEFAULT_CENTER = [80, 15];

    /**
     * Coarse "where is the visitor" for the initial view, from the browser's IANA timezone
     * via the generated js/tz-centers.js table. Intl asks no permission and costs no
     * request, so unlike navigator.geolocation there is no prompt, and unlike an IP lookup
     * nothing about the visitor leaves the page — not even to this site. The table is
     * country-grained on purpose: every zone of a country resolves to the same centroid,
     * so the render can place a visitor no more precisely than their country.
     *
     * Returns DEFAULT_CENTER when the zone is absent from the table (Etc/UTC, a zone newer
     * than the table) or when anything about Intl is unavailable.
     */
    function homeCenter() {
        var table = window.TZ_COUNTRY_CENTERS;
        var zone;
        try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; }
        catch (e) { return DEFAULT_CENTER; }
        if (!table || !zone) return DEFAULT_CENTER;
        // Keys hold every zone of one country, space-separated; the padding makes the
        // match exact, so "Asia/Kolkata" cannot hit a longer name that contains it.
        var keys = Object.keys(table);
        for (var i = 0; i < keys.length; i++) {
            if ((" " + keys[i] + " ").indexOf(" " + zone + " ") >= 0) return table[keys[i]];
        }
        return DEFAULT_CENTER;
    }

    function init() {
        sizeCanvases();
        fitProjection();
        var home = homeCenter();
        projection.rotate([-home[0], -home[1], 0]);  // rotation is the negation of the centre

        // Optional initial view via URL hash, e.g. #rotate=-128.5,-21.5&zoom=5
        // (also the hook used for headless testing of zoomed/rotated views).
        var hash = new URLSearchParams(window.location.hash.slice(1));
        var rot = (hash.get("rotate") || "").split(",");
        if (rot.length >= 2 && isFinite(+rot[0]) && isFinite(+rot[1])) {
            projection.rotate([+rot[0], Math.max(-90, Math.min(90, +rot[1])), 0]);
        }
        var zoom = +hash.get("zoom");
        if (zoom > 0) {
            projection.scale(initialScale * Math.min(MAX_ZOOM, Math.max(0.5, zoom)));
        }
        drawScaleBar();
        attachInteraction();
        checkPreloadMap();
        setStatus("downloading data…");

        // Optional initial layer via URL hash, e.g. #layer=surface (also the headless-
        // testing hook for verifying non-default layers, since the menu needs a click).
        var layerId = hash.get("layer");
        if (!LAYERS[layerId] && !deferredFor(layerId)) layerId = DEFAULT_LAYER;

        Promise.all([
            // "no-cache" = always revalidate with the server (cheap 304 when unchanged),
            // so a refreshed topology shows up on plain reload instead of being served
            // stale from the browser's heuristic cache. Wind data loads via loadLayer().
            fetch("data/earth-topo.json", {cache: "no-cache"}).then(function (r) {
                if (!r.ok) throw new Error("topology: HTTP " + r.status);
                return r.json();
            }),
            fetch("data/countries-50m.json").then(function (r) {
                if (!r.ok) throw new Error("countries 50m: HTTP " + r.status);
                return r.json();
            }),
            fetch("data/countries-110m.json").then(function (r) {
                if (!r.ok) throw new Error("countries 110m: HTTP " + r.status);
                return r.json();
            })
        ]).then(function (results) {
            var topo = results[0], c50 = results[1], c110 = results[2];
            mesh = {
                coastHi: topojson.feature(topo, topo.objects.coastline_50m),
                coastLo: topojson.feature(topo, topo.objects.coastline_110m),
                lakesHi: topojson.feature(topo, topo.objects.lakes_50m),
                lakesLo: topojson.feature(topo, topo.objects.lakes_110m),
                // a !== b keeps only shared (internal) borders; coastlines are drawn separately
                bordersHi: topojson.mesh(c50, c50.objects.countries, function (a, b) { return a !== b; }),
                bordersLo: topojson.mesh(c110, c110.objects.countries, function (a, b) { return a !== b; }),
                // all countries merged into one landmass, for the ocean layers' charcoal fill
                landHi: topojson.merge(c50, c50.objects.countries.geometries),
                landLo: topojson.merge(c110, c110.objects.countries.geometries)
            };
            drawMap(false);
            loadLayer(layerId);
            warmDeferredWhenIdle();
        }).catch(function (err) {
            console.error(err);
            setStatus("error: " + err.message);
        });
    }

    /**
     * Pull in the deferred renderers once the browser has nothing better to do. Deferring
     * them keeps 63 KB of source off the boot path; leaving them unloaded would just move
     * the wait to the first RealView click, so this pays for them out of idle time instead.
     * The timeout is a backstop for a page that never goes idle.
     */
    function warmDeferredWhenIdle() {
        var warm = function () {
            DEFERRED_RENDERERS.forEach(function (spec) {
                loadDeferred(spec).catch(function (err) {
                    console.warn("deferred renderer warm failed; a click will retry", err);
                });
            });
        };
        if (window.requestIdleCallback) window.requestIdleCallback(warm, {timeout: 8000});
        else setTimeout(warm, 3000);
    }

    init();
})();

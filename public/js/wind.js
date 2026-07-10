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
    var PARTICLE_LINE_WIDTH = 1.8;            // in device px — divided by devicePixelRatio at stroke time; fewer-but-thicker traces like nullschool
    var PARTICLE_MULTIPLIER = 3.5;            // particle count scalar (7 in the original; fewer, thicker, distinct streamlines like nullschool)
    var PARTICLE_REDUCTION = 0.75;            // reduce particle count to this fraction for mobile
    var FRAME_RATE = 40;                      // desired milliseconds per frame
    var NULL_WIND_VECTOR = [NaN, NaN, null];  // no wind data at this location [u, v, mag]
    var TRANSPARENT_BLACK = [0, 0, 0, 0];
    var MAX_INTENSITY = 25;                   // wind velocity (m/s) at which particle intensity is max (17 in the original; higher cap keeps storm bands from saturating white)
    var VELOCITY_SCALE = 1 / 42000;           // particle screen speed per unit of wind velocity (1/60000 in the original)
    var ZOOM_SPEED_EXPONENT = 0.6;            // 0 = speed grows fully with zoom (frantic close-up), 1 = constant speed at all zooms (sparse short tracks); 0.6 grows gently, ~2× at zoom 6
    var MAX_PARTICLE_STEP = 12;               // px/frame cap on the Euler step — larger steps overshoot tight vortices (empty typhoon eyewall at high zoom); speed still grows with zoom below the cap

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
        // Calm-end deep indigo: rgb(4,1,146) composited at OVERLAY_ALPHA over the dark sphere
        // renders as ≈#070570 on screen (user-tuned for contrast). The curved blend holds the
        // deep tone through typical 3-7 m/s ocean breeze and releases into the pastelized
        // scale by 15 m/s, so greens and storm colors are unaffected.
        var t = Math.pow(Math.min(v / 15, 1), 1.4);
        c[0] = Math.round((c[0] + (255 - c[0]) * 0.22) * t + 4 * (1 - t));
        c[1] = Math.round((c[1] + (255 - c[1]) * 0.22) * t + 1 * (1 - t));
        c[2] = Math.round((c[2] + (255 - c[2]) * 0.22) * t + 146 * (1 - t));
        return c;
    }

    /** Near-neutral bright styles for particle trails plus indexFor(mag) to pick a bucket. */
    function windIntensityColorScale(step, maxWind) {
        var result = [];
        for (var j = 130; j <= 255; j += step) {  // 85 in the original; high floor keeps slow-wind trails bright
            // Near-neutral strokes: the hue comes from the overlay bleeding through the alpha
            // (white over red reads pink, over green pale green). A stronger green tint muddied
            // the red eyewall into brown. Alpha falls with speed (0.70 slow → 0.50 fast) so calm
            // regions get bright distinct traces while storm cores can't pile up into mush.
            var t = (j - 130) / (255 - 130);
            var alpha = (0.70 - 0.20 * t).toFixed(2);
            result.push("rgba(" + Math.round(j * 0.90) + ", " + j + ", " + Math.round(j * 0.92) + ", " + alpha + ")");
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
        var isContinuous = Math.floor(ni * Δλ) >= 360;
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
            var a = rx * ry, b = x * ry, c = rx * y, d = x * y;
            var i0 = fi * 2, i1 = ci * 2;
            var u = row0[i0] * a + row0[i1] * b + row1[i0] * c + row1[i1] * d;
            var v = row0[i0 + 1] * a + row0[i1 + 1] * b + row1[i0 + 1] * c + row1[i1 + 1] * d;
            if (isNaN(u) || isNaN(v)) return null;  // NaN marks holes in the source data
            return [u, v, Math.sqrt(u * u + v * v)];
        }

        var refTime = new Date(header.refTime);
        var validTime = new Date(refTime.getTime() + (header.forecastTime || 0) * 3600 * 1000);

        return {interpolate: interpolate, date: validTime, maxSpeed: Math.sqrt(maxSpeed2)};
    }

    // ------------------------------------------------------------------------------------------------
    // Globe / projection

    var projection = d3.geoOrthographic().clipAngle(90);
    var initialScale;

    function fitProjection() {
        initialScale = Math.min(view.width, view.height) * 0.42;
        projection
            .scale(projection.scale() ? projection.scale() : initialScale)
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
    var mesh = null;  // coastline/lake geometry, set after topology loads

    function sizeCanvases() {
        var dpr = window.devicePixelRatio || 1;
        // Map and animation render at device resolution for crisp lines; particle math stays
        // in CSS px via the transform. The overlay must remain at CSS resolution — it is
        // written with putImageData, which ignores the transform.
        [mapCanvas, linesCanvas, animCanvas].forEach(function (c) {
            c.width = view.width * dpr;
            c.height = view.height * dpr;
            c.style.width = view.width + "px";
            c.style.height = view.height + "px";
            c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
        });

        overlayCanvas.width = view.width;
        overlayCanvas.height = view.height;
        overlayCanvas.style.width = view.width + "px";
        overlayCanvas.style.height = view.height + "px";
    }

    // Two layers of line work: sphere fill + graticule live on #map, *below* the color
    // overlay; coastlines/borders/lakes live on #lines, *above* it — under the overlay the
    // 0.72 alpha dimmed outlines to ~30% brightness and they vanished behind the trails.
    function drawMap(fast) {
        if (!mesh) return;

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
        strokeOn(ctx, path, {type: "Sphere"}, 0.25, 1.2);
        strokeOn(ctx, path, d3.geoGraticule10(), 0.12, 0.75);

        var lctx = linesCanvas.getContext("2d");
        var lpath = d3.geoPath(projection, lctx);
        lctx.clearRect(0, 0, view.width, view.height);
        strokeOn(lctx, lpath, fast ? mesh.coastLo : mesh.coastHi, 1.0, 1.6);  // prominent continent outlines
        strokeOn(lctx, lpath, fast ? mesh.bordersLo : mesh.bordersHi, 0.3, 0.75);
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
        var velocityScale = bounds.height * VELOCITY_SCALE *
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
                                color = windOverlayColor(scalar, OVERLAY_ALPHA);
                            }
                        }
                    }
                    column[y + 1] = column[y] = wind || NULL_WIND_VECTOR;
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
                    if (wind) {
                        var color = windOverlayColor(wind[2], OVERLAY_ALPHA);
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

    // ------------------------------------------------------------------------------------------------
    // Particle animation (ported from earth.js)

    function animate(field, cancel) {
        var bounds = field.bounds;
        var colorStyles = windIntensityColorScale(INTENSITY_SCALE_STEP, MAX_INTENSITY);
        var buckets = colorStyles.map(function () { return []; });
        var dpr = window.devicePixelRatio || 1;
        // Scale count with dpr (capped) so thinner device-px trails keep the same visual density.
        var particleCount = Math.round(bounds.width * PARTICLE_MULTIPLIER * Math.min(dpr, 2));
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
        var maxJump = Math.max(10, 2 * grid.maxSpeed * bounds.height * VELOCITY_SCALE * zoomNorm * pxPerDegree);
        var maxJump2 = maxJump * maxJump;

        var particles = [];
        for (var i = 0; i < particleCount; i++) {
            particles.push(field.randomize({age: Math.floor(Math.random() * MAX_PARTICLE_AGE)}));
        }

        function evolve() {
            buckets.forEach(function (bucket) { bucket.length = 0; });
            particles.forEach(function (particle) {
                if (particle.age > MAX_PARTICLE_AGE) {
                    field.randomize(particle).age = 0;
                }
                var x = particle.x;
                var y = particle.y;
                var v = field(x, y);  // vector at current position
                var m = v[2];
                if (m === null) {
                    particle.age = MAX_PARTICLE_AGE;  // particle has escaped the grid, never to return
                }
                else {
                    var xt = x + v[0];
                    var yt = y + v[1];
                    if ((xt - x) * (xt - x) + (yt - y) * (yt - y) > maxJump2) {
                        // The projection's finite-difference distortion diverges at the globe's
                        // limb, producing screen vectors hundreds of px long; drawing one paints
                        // a straight streak across the disc. Respawn the particle instead.
                        particle.age = MAX_PARTICLE_AGE;
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
        g.lineWidth = PARTICLE_LINE_WIDTH / dpr;  // PARTICLE_LINE_WIDTH device px regardless of screen density
        g.fillStyle = "rgba(0, 0, 0, 0.97)";  // per-frame trail fade: slow → long fluid streamlines

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
                    bucket.forEach(function (particle) {
                        g.moveTo(particle.x, particle.y);
                        g.lineTo(particle.xt, particle.yt);
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

    function drawScaleBar() {
        var canvas = document.getElementById("scale");
        var ctx = canvas.getContext("2d");
        for (var i = 0; i < canvas.width; i++) {
            var rgb = windOverlayColor(i / (canvas.width - 1) * 100, 255);
            ctx.fillStyle = "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
            ctx.fillRect(i, 0, 1, canvas.height);
        }
    }

    function formatCoordinates(λ, φ) {
        return Math.abs(φ).toFixed(2) + "° " + (φ >= 0 ? "N" : "S") + ", " +
            Math.abs(λ).toFixed(2) + "° " + (λ >= 0 ? "E" : "W");
    }

    function showLocation(point, grid) {
        var coord = projection.invert(point);
        if (!coord || !isFinite(coord[0]) || !isFinite(coord[1])) return;
        var wind = grid.interpolate(coord[0], coord[1]);
        if (wind) {
            setLocation((wind[2] * 3.6).toFixed(0) + " km/h @ " + formatCoordinates(coord[0], coord[1]));
        }
        else {
            setLocation(formatCoordinates(coord[0], coord[1]));
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Orchestration: interaction, cancellation, recompute

    // One layer is displayed at a time. Feature branches add entries here (and a
    // matching button in index.html's menu); the menu dispatches a "layerchange"
    // event with the layer id.
    var LAYERS = {
        "surface": {file: "data/current-wind-surface-level-gfs-0.25.json", label: "Wind @ Surface"},
        "1000hpa": {file: "data/current-wind-1000hpa-gfs-0.25.json", label: "Wind @ 1000 hPa"},
        "500hpa": {file: "data/current-wind-500hpa-gfs-0.25.json", label: "Wind @ 500 hPa"},
        "10hpa": {file: "data/current-wind-10hpa-gfs-0.25.json", label: "Wind @ 10 hPa"}
    };
    var DEFAULT_LAYER = "surface";

    var currentCancel = {requested: false};
    var recomputeTimer = null;
    var grid = null;

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

    function scheduleRecompute() {
        clearTimeout(recomputeTimer);
        recomputeTimer = setTimeout(recompute, 200);
    }

    function recompute() {
        if (!grid) return;
        var cancel = cancelWork();
        drawMap(false);
        interpolateField(grid, cancel, function (field) {
            if (cancel.requested) return;
            overlayCtx.putImageData(field.overlay, 0, 0);
            animate(field, cancel);
        });
    }

    /**
     * Fetch a layer's wind dataset and restart the pipeline on it. The map topology is
     * loaded once in init(); switching layers only swaps the grid.
     */
    function loadLayer(id) {
        var layer = LAYERS[id];
        if (!layer) return;
        cancelWork();
        clearTimeout(recomputeTimer);
        clearCanvas(animCanvas);
        document.querySelectorAll(".layer[data-layer]").forEach(function (b) {
            b.classList.toggle("active", b.dataset.layer === id);
        });
        setStatus("downloading data…");
        fetch(layer.file, {cache: "no-cache"}).then(function (r) {
            if (!r.ok) throw new Error("wind data: HTTP " + r.status);
            return r.json();
        }).then(function (windData) {
            grid = buildGrid(windData);
            document.getElementById("data-date").textContent = "Data: GFS analysis, " + formatDate(grid.date);
            recompute();
        }).catch(function (err) {
            console.error(err);
            setStatus("error: " + err.message);
        });
    }

    document.addEventListener("layerchange", function (e) {
        loadLayer(e.detail);
    });

    function attachInteraction() {
        var display = d3.select("#display");
        var rotateStart, pointerStart, moved;

        var drag = d3.drag()
            .on("start", function (event) {
                rotateStart = projection.rotate();
                pointerStart = [event.x, event.y];
                moved = false;
            })
            .on("drag", function (event) {
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
                drawMap(true);
                previewOverlayThrottled();
            })
            .on("end", function (event) {
                if (moved) {
                    scheduleRecompute();
                }
                else if (grid) {
                    showLocation([event.x, event.y], grid);
                }
            });

        display.call(drag);

        display.on("wheel", function (event) {
            event.preventDefault();
            startManipulation();
            var k = Math.exp(-event.deltaY * 0.0018);
            var scale = Math.max(initialScale * 0.5, Math.min(initialScale * 8, projection.scale() * k));
            projection.scale(scale);
            drawMap(true);
            previewOverlayThrottled();
            scheduleRecompute();
        }, {passive: false});
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

    function init() {
        sizeCanvases();
        fitProjection();
        projection.rotate([-80, -15, 0]);  // start centered over the Indian Ocean

        // Optional initial view via URL hash, e.g. #rotate=-128.5,-21.5&zoom=5
        // (also the hook used for headless testing of zoomed/rotated views).
        var hash = new URLSearchParams(window.location.hash.slice(1));
        var rot = (hash.get("rotate") || "").split(",");
        if (rot.length >= 2 && isFinite(+rot[0]) && isFinite(+rot[1])) {
            projection.rotate([+rot[0], Math.max(-90, Math.min(90, +rot[1])), 0]);
        }
        var zoom = +hash.get("zoom");
        if (zoom > 0) {
            projection.scale(initialScale * Math.min(8, Math.max(0.5, zoom)));
        }
        drawScaleBar();
        attachInteraction();
        setStatus("downloading data…");

        // Optional initial layer via URL hash, e.g. #layer=surface (also the headless-
        // testing hook for verifying non-default layers, since the menu needs a click).
        var layerId = hash.get("layer");
        if (!LAYERS[layerId]) layerId = DEFAULT_LAYER;

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
                bordersLo: topojson.mesh(c110, c110.objects.countries, function (a, b) { return a !== b; })
            };
            drawMap(false);
            loadLayer(layerId);
        }).catch(function (err) {
            console.error(err);
            setStatus("error: " + err.message);
        });
    }

    init();
})();

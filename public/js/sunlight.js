/**
 * sunlight.js — the sun-lit RealView layers: NASA imagery of the Earth, shaded by where
 * the sun actually is at this moment.
 *
 * This is a *renderer plug-in*, not part of the weather engine. wind.js owns everything
 * that keeps a render glued to the globe — the orthographic projection, the four canvases,
 * drag/wheel/pinch, cancellation, the recompute debounce, the URL hash and the HUD — and
 * hands a small context object to whatever renderer owns the displayed layer. This module
 * owns pixels and nothing else: no grid, no particles, no weather data. See the "Renderer
 * plug-ins" comment in wind.js for the contract implemented at the bottom of this file.
 *
 * Two sources, both free of copyright:
 *
 *   NASA Blue Marble: Next Generation (MODIS/Terra, 2004), the 8 km composite with
 *   topographic and bathymetric relief shading — one image per month, so the layer picks
 *   the current month and gets the season's snow line and vegetation for free.
 *
 *   NASA Black Marble 2016 (VIIRS/Suomi NPP) city lights, for the "Night Lights" layer.
 *
 * The terminator itself comes from SunCalc (libs/suncalc.js, BSD-2-Clause), so no
 * astronomy is reimplemented here.
 */
(function () {
    "use strict";

    var NIGHT_BRIGHTNESS = 0.35;    // night-side brightness at full white — earthshine and
                                    // moonlight reflecting off the ground, so it follows the
                                    // imagery's own albedo. Shared by both layers: the night side
                                    // of Daylight and of Night Lights is the same render, and city
                                    // lights are the only thing the second one adds.
    var NIGHT_GAMMA = 0.60;         // tone curve applied under it — see NIGHT_CURVE
    var TWILIGHT_SIN = 0.1045;      // sin(6°) — civil twilight, the half-width of the terminator ramp
    var LIGHTS_GAIN = 2.0;          // how brightly extracted city light burns through at full night
    var BACKDROP_BLUE = 0.6;        // blue fraction subtracted to isolate lights — see shade()
    var TEXTURE_MAX_WIDTH = 5400;   // decode cap (halved on mobile): 5400 × 2700 RGBA is 58 MB
    var PREVIEW_STEP = 4;           // drag preview: sample every Nth CSS px, upscaled with smoothing
    var RELIEF_STRENGTH = 0.02;     // terrain relief depth — see buildRelief()
    var RELIEF_SUN_REF = Math.sin(35 / (180 / Math.PI));   // taper below this sun elevation
    var RELIEF_CLAMP = 0.62;        // relief may brighten or darken daylight by at most this
    var SUN_TICK = 60000;           // ms between re-renders; the sun moves 0.25°/min, ≈1.3 px at fit
    var DEG = 180 / Math.PI;

    /**
     * The night side's tone curve, one entry per 8-bit texture level (257 so a sample of
     * exactly 255 can interpolate).
     *
     * A flat multiply preserves the imagery's own contrast ratio, and at night levels that is
     * precisely the problem: rainforest lands at 12/255 while open ocean sits at 2/255, and no
     * phone screen resolves that gap under ambient light — the whole dark half reads as one
     * black shape with no coastline in it. Raising NIGHT_BRIGHTNESS cannot fix it, because a
     * scalar scales land and sea by the same factor: the ratio is untouched and only the bright
     * end moves, which washes out the terminator instead. A gamma below 1 expands the bottom of
     * the range and leaves the top where it is, so dark land pulls away from the sea while ice
     * and desert stay put. Measured on the August composite, γ = 0.60 takes the dark-land-minus-
     * sea gap from 10.6 to 18.7 display levels while bright ice moves 90.4 → 90.7.
     */
    var NIGHT_CURVE = (function () {
        var lut = new Float32Array(257);
        for (var v = 0; v <= 256; v++) {
            lut[v] = 255 * Math.pow(Math.min(v, 255) / 255, NIGHT_GAMMA) * NIGHT_BRIGHTNESS;
        }
        return lut;
    })();

    // Texture samples are bilinear, so they land between levels; interpolate the curve too.
    function nightValue(v) {
        var i = v | 0;
        return NIGHT_CURVE[i] + (NIGHT_CURVE[i + 1] - NIGHT_CURVE[i]) * (v - i);
    }

    var engine = null;              // the wind.js context, latched in register()
    var day = null;                 // Blue Marble sampler
    var night = null;               // Black Marble sampler, or null
    var cache = {};                 // decoded samplers by URL: switching layers must not re-decode
    var sunTime = new Date();       // the instant the current frame is drawn for — one value per
                                    // frame, so imagery, limb glow and click readout cannot disagree
    var preview = null;             // reused low-res canvas for the drag preview
    var terrain = null;             // elevation-gradient sampler, or null before it loads
    var reliefK = RELIEF_STRENGTH;  // live-tunable; see setRelief() at the bottom

    // ------------------------------------------------------------------------------------------------
    // Solar geometry

    /**
     * The subsolar point [λ, φ] — where the sun stands straight overhead — read out of
     * SunCalc's public API without reimplementing any astronomy. Both numbers come from one
     * call at the north pole: there cos φ = 0 kills the declination term of SunCalc's azimuth
     * (which it measures from south), leaving the sun's Greenwich hour angle, while the
     * altitude of a pole observer *is* the declination. Verified against SunCalc itself —
     * getPosition() at the returned point reports an altitude of exactly 90.0000° — and
     * against the physics: ±23.44° at the solstices, ~0° at the equinox, −15°/hour.
     */
    function subsolar(date) {
        var p = SunCalc.getPosition(date, 90, 0);
        var λ = -p.azimuth * DEG;
        return [λ - 360 * Math.floor((λ + 180) / 360), p.altitude * DEG];
    }

    /**
     * The sun's unit vector in the projection's *view* frame (x right, y up, z toward the
     * viewer), which is what makes the terminator cheap. Rotating the subsolar point by the
     * projection's own rotation puts the sun in the frame the screen coordinates live in, so
     * the cosine of the solar zenith angle at a pixel becomes a plain dot product with that
     * pixel's surface normal — and the normal is just the screen offset over the radius, plus
     * the depth that closes the unit vector. No trigonometry per pixel.
     */
    function sunVector() {
        var q = d3.geoRotation(engine.projection.rotate())(subsolar(sunTime));
        var λ = q[0] / DEG, φ = q[1] / DEG;
        return [Math.cos(φ) * Math.sin(λ), Math.sin(φ), Math.cos(φ) * Math.cos(λ)];
    }

    /**
     * The geographic north pole as a view-space unit vector, by the same route as
     * sunVector(). Constant for a frame, and it is what lets the relief shading build a
     * local east/north frame per pixel without any trigonometry — see render().
     */
    function northVector() {
        var q = d3.geoRotation(engine.projection.rotate())([0, 90]);
        var λ = q[0] / DEG, φ = q[1] / DEG;
        return [Math.cos(φ) * Math.sin(λ), Math.sin(φ), Math.cos(φ) * Math.cos(λ)];
    }

    // ------------------------------------------------------------------------------------------------
    // Texture sampling and shading

    /**
     * Decodes an equirectangular image (-180…180 × 90…-90, the layout of every NASA global
     * composite) into a bilinear sampler. The pixels are read back once with getImageData,
     * which is legal across origins only because the bucket sends Access-Control-Allow-Origin
     * and the <img> is loaded with crossOrigin — otherwise the canvas would be tainted.
     */
    function buildTexture(image) {
        // 5400 × 2700 costs 58 MB as RGBA on top of the decoded JPEG; halve it on phones.
        var width = Math.min(image.naturalWidth,
            engine.isMobile() ? TEXTURE_MAX_WIDTH / 2 : TEXTURE_MAX_WIDTH);
        var height = Math.round(width * image.naturalHeight / image.naturalWidth);
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext("2d", {willReadFrequently: true});
        ctx.drawImage(image, 0, 0, width, height);
        var data = ctx.getImageData(0, 0, width, height).data;
        var last = height - 1;

        // Bilinear, wrapping in longitude and clamping in latitude. Nearest-neighbour is
        // visibly blocky wherever the globe is magnified past the texture's 8 km/px, which
        // at the fitted scale is already true well before the limb.
        function sample(λ, φ, out) {
            var x = (λ + 180) / 360 * width - 0.5;
            var y = (90 - φ) / 180 * height - 0.5;
            var xi = Math.floor(x), yi = Math.floor(y);
            var fx = x - xi, fy = y - yi;
            var x0 = xi - width * Math.floor(xi / width);
            var x1 = x0 + 1 === width ? 0 : x0 + 1;
            var y0 = yi < 0 ? 0 : yi > last ? last : yi;
            var y1 = yi + 1 < 0 ? 0 : yi + 1 > last ? last : yi + 1;
            var a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4;
            var c = (y1 * width + x0) * 4, e = (y1 * width + x1) * 4;
            var w0 = (1 - fx) * (1 - fy), w1 = fx * (1 - fy), w2 = (1 - fx) * fy, w3 = fx * fy;
            out[0] = data[a] * w0 + data[b] * w1 + data[c] * w2 + data[e] * w3;
            out[1] = data[a + 1] * w0 + data[b + 1] * w1 + data[c + 1] * w2 + data[e + 1] * w3;
            out[2] = data[a + 2] * w0 + data[b + 2] * w1 + data[c + 2] * w2 + data[e + 2] * w3;
        }

        return {sample: sample, width: width, height: height};
    }

    /**
     * Decodes the elevation map into the two things the shading actually consumes: ∂h/∂x and
     * ∂h/∂y, one pair per texel, computed once here rather than per pixel per frame.
     *
     * The stencil is a separable 5-tap Sobel — derivative [1,2,0,-2,-1]/8 across, smoothing
     * [1,4,6,4,1]/16 along. The width is the point: the source is 8-bit, so ~35 m per code
     * level, and adjacent differences over gentle ground return long runs of zero broken by
     * single-level steps, which shade as visible terracing across plains. Averaging over ±2
     * texels turns that staircase back into a slope. It costs nothing per frame.
     *
     * Stored as Int16 scaled by GRAD_SCALE: two Float32 planes would be 29 MB, Int8 would
     * quantise gentle terrain back into the staircase this stencil exists to remove. 14.6 MB
     * for the pair, against 55.6 MB for one colour texture — and the heights themselves are
     * dropped once the gradients exist.
     */
    var GRAD_SCALE = 64;
    function buildRelief(image) {
        // Half the colour cap on desktop (the source is 2700 wide, so native), a quarter on
        // mobile. Relief survives downsampling far better than a photograph does — it is the
        // gradient that matters and mountains are large — so this is the cheapest 3× memory
        // saving available on the device that needs it most.
        var width = Math.min(image.naturalWidth,
            engine.isMobile() ? TEXTURE_MAX_WIDTH / 4 : TEXTURE_MAX_WIDTH / 2);
        var height = Math.round(width * image.naturalHeight / image.naturalWidth);
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext("2d", {willReadFrequently: true});
        ctx.drawImage(image, 0, 0, width, height);
        var src = ctx.getImageData(0, 0, width, height).data;
        var n = width * height, last = height - 1;

        // Convolved straight out of the ImageData (stride 4, grayscale so any channel will do)
        // rather than copied into a Float32 plane first: that copy was 14 MB of peak heap for
        // no gain, on a device budget already carrying two colour textures.
        // Signs matter and are easy to get wrong: this returns +∂h/∂index. The textbook
        // Sobel kernel [1,2,0,-2,-1] returns the *negative* derivative, which combined with a
        // second sign slip elsewhere left north-south relief inverted while east-west stayed
        // correct — a defect the Blue Marble's own baked-in hillshade hides almost perfectly.
        var D = [-1 / 8, -2 / 8, 0, 2 / 8, 1 / 8], S = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
        var gx = new Int16Array(n), gy = new Int16Array(n);
        var tmp = new Float32Array(n);
        function wrapX(x) { return x < 0 ? x + width : x >= width ? x - width : x; }
        function clampY(y) { return y < 0 ? 0 : y > last ? last : y; }

        // Each pass is split into an interior run and its two edges. The interior is where
        // ~99.8% of the texels are and needs no wrap or clamp, so it reduces to five indexed
        // multiply-adds with no call and no branch; the edges keep the careful version. The
        // naive uniform loop cost ~500 ms here, which is a visible pause on layer switch.
        for (var pass = 0; pass < 2; pass++) {
            var c = pass === 0 ? D : S, d = pass === 0 ? S : D;
            var c0 = c[0], c1 = c[1], c2 = c[2], c3 = c[3], c4 = c[4];
            var d0 = d[0], d1 = d[1], d2 = d[2], d3 = d[3], d4 = d[4];
            for (var y = 0; y < height; y++) {              // horizontal tap
                var row = y * width;
                for (var x = 0; x < 2; x++) {
                    var acc = 0;
                    for (var k = 0; k < 5; k++) acc += c[k] * src[(row + wrapX(x + k - 2)) * 4];
                    tmp[row + x] = acc;
                }
                for (var xi = 2; xi < width - 2; xi++) {
                    var b = row + xi;
                    tmp[b] = c0 * src[(b - 2) * 4] + c1 * src[(b - 1) * 4] + c2 * src[b * 4] +
                             c3 * src[(b + 1) * 4] + c4 * src[(b + 2) * 4];
                }
                for (var xe = Math.max(2, width - 2); xe < width; xe++) {
                    var acce = 0;
                    for (var ke = 0; ke < 5; ke++) acce += c[ke] * src[(row + wrapX(xe + ke - 2)) * 4];
                    tmp[row + xe] = acce;
                }
            }
            var out = pass === 0 ? gx : gy;
            for (var y2 = 0; y2 < height; y2++) {           // vertical tap
                var row2 = y2 * width;
                if (y2 < 2 || y2 >= height - 2) {
                    for (var x2 = 0; x2 < width; x2++) {
                        var acc2 = 0;
                        for (var k2 = 0; k2 < 5; k2++) acc2 += d[k2] * tmp[clampY(y2 + k2 - 2) * width + x2];
                        out[row2 + x2] = acc2 * GRAD_SCALE;   // Int16Array truncates and clamps
                    }
                } else {
                    var r0 = row2 - 2 * width, r1 = row2 - width, r3 = row2 + width, r4 = row2 + 2 * width;
                    for (var xj = 0; xj < width; xj++) {
                        out[row2 + xj] = (d0 * tmp[r0 + xj] + d1 * tmp[r1 + xj] + d2 * tmp[row2 + xj] +
                                          d3 * tmp[r3 + xj] + d4 * tmp[r4 + xj]) * GRAD_SCALE;
                    }
                }
            }
        }

        src = null;
        tmp = null;
        canvas.width = canvas.height = 0;    // release the decode surface too

        // Bilinear, wrapping in longitude and clamping in latitude, exactly as sample() does.
        function gradient(λ, φ, out) {
            var x = (λ + 180) / 360 * width - 0.5;
            var y = (90 - φ) / 180 * height - 0.5;
            var xi = Math.floor(x), yi = Math.floor(y);
            var fx = x - xi, fy = y - yi;
            var x0 = xi - width * Math.floor(xi / width);
            var x1 = x0 + 1 === width ? 0 : x0 + 1;
            var y0 = yi < 0 ? 0 : yi > last ? last : yi;
            var y1 = yi + 1 < 0 ? 0 : yi + 1 > last ? last : yi + 1;
            var a = y0 * width + x0, b = y0 * width + x1, c = y1 * width + x0, e = y1 * width + x1;
            var w0 = (1 - fx) * (1 - fy), w1 = fx * (1 - fy), w2 = (1 - fx) * fy, w3 = fx * fy;
            out[0] = (gx[a] * w0 + gx[b] * w1 + gx[c] * w2 + gx[e] * w3) / GRAD_SCALE;
            out[1] = (gy[a] * w0 + gy[b] * w1 + gy[c] * w2 + gy[e] * w3) / GRAD_SCALE;
        }

        return {gradient: gradient, width: width, height: height};
    }

    /**
     * Shades one texture sample by the daylight there. `lit` is the cosine of the solar
     * zenith angle (equivalently the sine of the sun's elevation), so the ±sin(6°) band
     * around zero is civil twilight: brightness ramps smoothly across it instead of cutting
     * the globe with a hard edge, and the ramp is tinted warm, which is what the terminator
     * of a real lit globe looks like. `lights` is the night-lights sample of the Night Lights
     * layer, or null — it fades in with exactly the complement of the daylight ramp, so
     * cities appear as the ground goes dark and never burn through daylight.
     *
     * The night side is deliberately identical in both layers: it is the imagery dimmed to
     * NIGHT_BRIGHTNESS, nothing more, so switching to Night Lights adds city lights and
     * changes nothing else about how the land reads.
     */
    function shade(rgb, lit, lights, relief, out) {
        var t = (lit + TWILIGHT_SIN) / (2 * TWILIGHT_SIN);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var s = t * t * (3 - 2 * t);                    // smoothstep across the twilight band
        var warm = 4 * t * (1 - t);                     // 0 at both ends of the band, 1 mid-band
        var dark = 1 - s;
        // Lit value and night value, blended by the ramp. With a linear curve this is exactly
        // the old `rgb * (NIGHT_BRIGHTNESS + (1 - NIGHT_BRIGHTNESS) * s)` — at s = 1 it is the
        // imagery untouched, so the day side cannot move whatever NIGHT_CURVE does.
        // `relief` multiplies the lit term only: shadowed ground is still daylit ground, and
        // must not pick up the night side's earthshine tint.
        var sr = s * relief;
        var r = (rgb[0] * sr + nightValue(rgb[0]) * dark) * (1 + 0.30 * warm);
        var g = (rgb[1] * sr + nightValue(rgb[1]) * dark) * (1 + 0.08 * warm);
        // Earthshine reads cool, so the night side keeps a little more blue than it loses.
        var b = (rgb[2] * sr + nightValue(rgb[2]) * dark) * (1 - 0.10 * warm) * (1 + 0.30 * dark);
        if (lights) {
            // The Black Marble composite is *not* city-lights-on-black: it carries a blue
            // landmass backdrop — measured (36,33,60) over the empty Sahara, (23,19,41) over
            // central Australia, (5,5,15) over open ocean — which, added on top, acted as a
            // second and much brighter terrain layer and made this layer's land disagree with
            // Daylight's. Only the lights themselves belong here. Cities are neutral-to-warm
            // (b/r ≤ 1.26 at every settlement sampled, down to Alice Springs) while the
            // backdrop is strongly blue-dominant (b/r ≥ 1.66 at every unlit sample, snow and
            // sea ice included), so subtracting a fraction of blue from red separates the two
            // cleanly: the backdrop lands at ≤0.1/255 everywhere it was measured.
            var city = lights[0] - BACKDROP_BLUE * lights[2];
            if (city > 0) {
                var f = city * dark * LIGHTS_GAIN;
                r += f;
                g += f * 0.92;
                b += f * 0.75;                          // sodium-lamp cast, as in the composite
            }
        }
        out[0] = r > 255 ? 255 : r;
        out[1] = g > 255 ? 255 : g;
        out[2] = b > 255 ? 255 : b;
    }

    /**
     * Per-frame constants for the relief shading. The trick that keeps it trigonometry-free:
     * every quantity the perturbation needs is a dot product, and dot products survive
     * rotation, so the local east/north frame can be built from the view-space sphere normal
     * `n` and two constants — the north pole `N` and the sun `s`.
     *
     *   c = n·N        is sin(latitude), so 1/√(1-c²) is 1/cos(latitude)
     *   n̂·s = (N·s - c·(n·s)) / √(1-c²)         N·s constant
     *   ê·s = (n·(s×N))    / √(1-c²)            s×N constant
     *
     * The cross product is s×N, not N×s: east is n̂×n, which unwinds to (N×n)/√(1-c²), and
     * (N×n)·s = n·(s×N). Reversing the operands silently mirrors every east-west slope.
     *
     * One sqrt and a handful of multiplies per pixel, against the four sin/cos calls the
     * obvious formulation would need.
     */
    function reliefFrame(sun) {
        var N = northVector();
        return {
            N: N,
            M: [sun[1] * N[2] - sun[2] * N[1],           // s × N
                sun[2] * N[0] - sun[0] * N[2],
                sun[0] * N[1] - sun[1] * N[0]],
            Ns: N[0] * sun[0] + N[1] * sun[1] + N[2] * sun[2]
        };
    }

    /**
     * Tilts the surface normal by the local terrain slope and returns how much that
     * brightens or darkens the daylight there — a multiplier around 1, not a new `lit`.
     *
     * Feeding the tilted dot product into `lit` instead is the obvious move and is wrong: the
     * twilight ramp spans only ±sin(6°) = ±0.1045, while a typical range perturbs the dot
     * product by 0.4 at strength 0.05 and 1.6 at 0.20 — four to fifteen times the whole ramp.
     * Slopes were therefore pushed straight through the terminator and rendered as *night*,
     * complete with the blue earthshine cast and a warm twilight fringe around each one:
     * mountain-shaped bruises scattered across a sunlit continent. The terminator belongs to
     * the planet's own geometry; relief modulates the daylight inside it and nothing else.
     *
     * The clamp bounds the effect to ±62%, which is what the stills used when the default
     * strength was chosen, so the constant means the same thing here as it did there.
     *
     * `grad` is ∂h/∂x, ∂h/∂y in texture space. x runs with longitude, so it is scaled by
     * 1/cos(latitude) — the same √(1-c²) the frame already computed — because a degree of
     * longitude is a shorter distance the further from the equator it is. y runs *southward*
     * against latitude, hence the sign on the north component.
     *
     * The strength tapers with the local sun elevation (`lit` is its sine). Without it the
     * 1/sin normalisation below amplifies contrast 2.8× at 12° against 35°, and dawn reads as
     * harsh noise rather than terrain — the more so because this model has no cast shadows,
     * which is exactly what the eye expects from grazing light and cannot get here.
     */
    function reliefFactor(lit, x, y, z, frame, grad) {
        if (lit <= 0) return 1;                                // night: no directional light
        var c = x * frame.N[0] + y * frame.N[1] + z * frame.N[2];
        var cos2 = 1 - c * c;
        if (cos2 < 1e-6) return 1;                             // at the poles the frame degenerates
        var w = 1 / Math.sqrt(cos2);                           // = 1 / cos(latitude)
        var eDotS = (x * frame.M[0] + y * frame.M[1] + z * frame.M[2]) * w;
        var nDotS = (frame.Ns - c * lit) * w;
        var k = reliefK * (lit < RELIEF_SUN_REF ? lit / RELIEF_SUN_REF : 1);
        var dE = grad[0] * w * k, dN = -grad[1] * k;
        var tilted = (lit - dE * eDotS - dN * nDotS) / Math.sqrt(1 + dE * dE + dN * dN);
        var f = tilted / lit;
        return f < 1 - RELIEF_CLAMP ? 1 - RELIEF_CLAMP : f > 1 + RELIEF_CLAMP ? 1 + RELIEF_CLAMP : f;
    }

    // ------------------------------------------------------------------------------------------------
    // Rendering

    /**
     * Paints the shaded imagery into the overlay canvas one row of backing-store pixels at a
     * time, in cooperative batches on the engine's schedule so a slow render never freezes
     * the UI. There is no flow field and no particle work, so this is the whole frame.
     */
    function render(cancel) {
        var projection = engine.projection;
        var scale = engine.overlayScale();
        var canvas = engine.overlay, ctx = engine.overlayCtx;
        var w = canvas.width, h = canvas.height;
        var image = ctx.createImageData(w, h);
        var data = image.data;
        var t = projection.translate();
        var tx = t[0] * scale, ty = t[1] * scale, radius = projection.scale() * scale;
        var sun = sunVector();
        var b = engine.bounds();
        var i0 = Math.max(0, Math.floor(b.x * scale)), i1 = Math.min(w - 1, Math.ceil((b.xMax + 1) * scale));
        var j0 = Math.max(0, Math.floor(b.y * scale)), j1 = Math.min(h - 1, Math.ceil((b.yMax + 1) * scale));
        var rgb = [0, 0, 0], lights = [0, 0, 0], out = [0, 0, 0], grad = [0, 0];
        var frame = terrain ? reliefFrame(sun) : null;
        var point = [];
        var j = j0;

        function renderRow(j) {
            var py = j + 0.5 - ty;
            var k = (j * w + i0) * 4;
            for (var i = i0; i <= i1; i++, k += 4) {
                var px = i + 0.5 - tx;
                var d2 = px * px + py * py;
                if (d2 > (radius + 1) * (radius + 1)) continue;
                point[0] = (i + 0.5) / scale;
                point[1] = (j + 0.5) / scale;
                var coord = projection.invert(point);
                if (!coord || !isFinite(coord[0]) || !isFinite(coord[1])) continue;
                var x = px / radius, y = -py / radius;
                var z2 = 1 - x * x - y * y;
                var z = z2 > 0 ? Math.sqrt(z2) : 0;
                var lit = x * sun[0] + y * sun[1] + z * sun[2];
                var relief = 1;
                if (frame) {
                    terrain.gradient(coord[0], coord[1], grad);
                    relief = reliefFactor(lit, x, y, z, frame, grad);
                }
                day.sample(coord[0], coord[1], rgb);
                if (night) night.sample(coord[0], coord[1], lights);
                shade(rgb, lit, night ? lights : null, relief, out);
                data[k] = out[0];
                data[k + 1] = out[1];
                data[k + 2] = out[2];
                // Feather the last pixel of the disc: unlike the weather layers there is no
                // antialiased sphere fill showing through to hide a hard-clipped edge.
                var edge = radius - Math.sqrt(d2);
                data[k + 3] = edge >= 1 ? 255 : edge <= -1 ? 0 : Math.round((edge + 1) * 127.5);
            }
        }

        (function batch() {
            if (cancel.requested) return;
            var start = Date.now();
            while (j <= j1) {
                renderRow(j++);
                if ((Date.now() - start) > engine.maxTaskTime) {
                    engine.setStatus("rendering: " + Math.round((j - j0) / (j1 - j0 + 1) * 100) + "%");
                    setTimeout(batch, engine.minSleepTime);
                    return;
                }
            }
            engine.setStatus("");
            ctx.putImageData(image, 0, 0);
        })();
    }

    /**
     * The same render at a coarse stride, cheap enough to run per drag frame so the imagery
     * tracks the globe outline instead of detaching from it (the engine throttles the calls).
     * The full-resolution putImageData replaces this wholesale when the drag settles.
     */
    function drawPreview() {
        if (!day) return;
        var projection = engine.projection;
        var view = engine.view();
        var scale = engine.overlayScale();
        var step = PREVIEW_STEP;
        var w = Math.ceil(view.width / step), h = Math.ceil(view.height / step);
        if (!preview || preview.w !== w || preview.h !== h) {
            var c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            var pctx = c.getContext("2d");
            preview = {canvas: c, ctx: pctx, image: pctx.createImageData(w, h), w: w, h: h};
        }
        var data = preview.image.data;
        data.fill(0);
        var b = engine.bounds();
        var i0 = Math.max(0, Math.floor(b.x / step)), i1 = Math.min(w - 1, Math.ceil(b.xMax / step));
        var j0 = Math.max(0, Math.floor(b.y / step)), j1 = Math.min(h - 1, Math.ceil(b.yMax / step));
        var t = projection.translate();
        var r = projection.scale(), r2 = r * r;
        var sun = sunVector();
        var rgb = [0, 0, 0], lights = [0, 0, 0], out = [0, 0, 0], grad = [0, 0];
        var frame = terrain ? reliefFrame(sun) : null;
        var point = [];
        for (var j = j0; j <= j1; j++) {
            point[1] = (j + 0.5) * step;
            var dy = point[1] - t[1];
            for (var i = i0; i <= i1; i++) {
                point[0] = (i + 0.5) * step;
                var dx = point[0] - t[0];
                if (dx * dx + dy * dy > r2) continue;
                // Off-disc points must be rejected by radius, as above: d3-geo clamps asin
                // internally, so invert() returns finite (mirrored) coordinates outside it.
                var coord = projection.invert(point);
                if (!coord || !isFinite(coord[0])) continue;
                var nx = dx / r, ny = -dy / r;
                var z2 = 1 - nx * nx - ny * ny;
                var nz = z2 > 0 ? Math.sqrt(z2) : 0;
                var lit = nx * sun[0] + ny * sun[1] + nz * sun[2];
                var relief = 1;
                if (frame) {
                    terrain.gradient(coord[0], coord[1], grad);
                    relief = reliefFactor(lit, nx, ny, nz, frame, grad);
                }
                day.sample(coord[0], coord[1], rgb);
                if (night) night.sample(coord[0], coord[1], lights);
                shade(rgb, lit, night ? lights : null, relief, out);
                var k = (j * w + i) * 4;
                data[k] = out[0];
                data[k + 1] = out[1];
                data[k + 2] = out[2];
                data[k + 3] = 255;
            }
        }
        preview.ctx.putImageData(preview.image, 0, 0);
        var ctx = engine.overlayCtx;
        ctx.clearRect(0, 0, engine.overlay.width, engine.overlay.height);
        ctx.drawImage(preview.canvas, 0, 0, w * step * scale, h * step * scale);
    }

    /**
     * The blue limb of an atmosphere seen edge-on, drawn on #lines above the imagery — the
     * engine draws no vector work for a renderer layer, since a white coastline over a
     * photograph of the same coastline is a double outline and the graticule reads as a cage
     * around a view from space.
     *
     * A radial gradient supplies the rim, then a linear gradient masks it back to the sunlit
     * side with destination-in. That mask is exact, not a fudge: at the limb the surface
     * normal has no depth component, so the day/night boundary meets the rim precisely on the
     * line through the globe's centre perpendicular to the sun's projected direction.
     */
    function decorate(ctx) {
        var projection = engine.projection;
        var view = engine.view();
        var t = projection.translate(), r = projection.scale();
        var sun = sunVector();
        var len = Math.sqrt(sun[0] * sun[0] + sun[1] * sun[1]);
        // Sun behind the globe and centred: no lit limb anywhere, so no glow at all.
        if (sun[2] < -0.55 && len < 0.2) return;

        var glow = document.createElement("canvas");
        var dpr = window.devicePixelRatio || 1;
        glow.width = view.width * dpr;
        glow.height = view.height * dpr;
        var g = glow.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Narrow on purpose: an atmosphere is 100 km on a 6371 km globe, so anything wider
        // than a percent or two of the radius stops reading as a limb and starts reading as
        // haze over the continents. The gradient spans 0.955r…1.06r, which puts the surface
        // itself at 0.43 of the way through it.
        var ring = g.createRadialGradient(t[0], t[1], r * 0.955, t[0], t[1], r * 1.06);
        ring.addColorStop(0.00, "rgba(90, 150, 235, 0)");
        ring.addColorStop(0.36, "rgba(120, 180, 255, 0.14)");   // just inside the edge
        ring.addColorStop(0.43, "rgba(180, 214, 255, 0.34)");   // the edge itself
        ring.addColorStop(0.55, "rgba(120, 180, 255, 0.16)");
        ring.addColorStop(1.00, "rgba(90, 150, 235, 0)");       // halo fading into space
        g.fillStyle = ring;
        g.fillRect(0, 0, view.width, view.height);

        var ux = len > 1e-6 ? sun[0] / len : 0, uy = len > 1e-6 ? -sun[1] / len : 0;
        var span = r * 0.45;
        var mask = g.createLinearGradient(t[0] - ux * span, t[1] - uy * span,
                                          t[0] + ux * span, t[1] + uy * span);
        mask.addColorStop(0, "rgba(0, 0, 0, 0)");
        mask.addColorStop(1, "rgba(0, 0, 0, 1)");
        g.globalCompositeOperation = "destination-in";
        g.fillStyle = mask;
        g.fillRect(0, 0, view.width, view.height);

        ctx.drawImage(glow, 0, 0, view.width, view.height);
    }

    // ------------------------------------------------------------------------------------------------
    // HUD

    /** Apparent solar time at longitude λ: noon under the sun, an hour per 15° away from it. */
    function solarTime(λ) {
        var h = 12 + (λ - subsolar(sunTime)[0]) / 15;
        var m = Math.round((h - 24 * Math.floor(h / 24)) * 60) % 1440;
        return pad(Math.floor(m / 60)) + ":" + pad(m % 60);
    }

    function pad(n) {
        return (n < 10 ? "0" : "") + n;
    }

    function utc(date) {
        return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate()) +
            " " + pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + " UTC";
    }

    // ------------------------------------------------------------------------------------------------
    // The renderer contract wind.js calls (see its "Renderer plug-ins" comment)

    window.EarthRenderers = window.EarthRenderers || {};
    window.EarthRenderers.sunlight = {

        // Called once at boot: latch the engine handle, return the layers to register.
        register: function (host, dataRoot) {
            engine = host;
            // BMNG ships one composite per month of 2004, so the current month is the honest
            // pick — it puts the northern snow line, the Sahel's green-up and the Antarctic
            // sea ice where they belong for the season on screen, at no extra cost.
            var month = (new Date().getUTCMonth() + 101).toString().slice(1);
            var blueMarble = dataRoot + "bluemarble-2004" + month + ".jpg";
            var credit = "NASA Blue Marble NG &nbsp;|&nbsp; MODIS / Terra, NASA Earth Observatory";
            var placeholder = "click a point for sun elevation";
            // Relief is its own layer rather than a treatment applied to the other two:
            // Daylight and Night Lights are the imagery as photographed, and adding shading
            // the camera never saw belongs in a layer a viewer chooses on purpose. The three
            // share one Blue Marble URL, so switching between them decodes nothing.
            return {
                "daylight": {texture: blueMarble, label: "Daylight",
                    credit: credit, placeholder: placeholder},
                "nightlights": {texture: blueMarble, night: dataRoot + "blackmarble-2016-5400.jpg",
                    label: "Night Lights", placeholder: placeholder,
                    credit: credit + " &nbsp;+&nbsp; VIIRS Black Marble 2016"},
                "relief": {texture: blueMarble, relief: dataRoot + "elevation-gebco-1350.png",
                    label: "Relief", placeholder: placeholder,
                    credit: credit + " &nbsp;+&nbsp; GEBCO elevation"}
            };
        },

        // Backing-store pixels per CSS pixel the overlay canvas should use for these layers.
        // The weather layers stay at 1 (putImageData ignores transforms and their colour field
        // is smooth); a photograph upscaled by the browser is visibly soft on a HiDPI screen.
        overlayScale: function () {
            return Math.min(window.devicePixelRatio || 1, 2);
        },

        tick: SUN_TICK,   // the engine re-renders this often; 0 would mean a static layer

        load: function (layer) {
            return Promise.all([
                texture(layer.texture),
                layer.night ? texture(layer.night) : null,
                layer.relief ? texture(layer.relief, buildRelief) : null
            ]).then(function (t) {
                day = t[0];
                night = t[1];
                terrain = t[2];
            });
        },

        // Latch the clock for the frame about to be drawn, so the imagery, the limb glow and
        // the click readout all describe the same instant.
        beginFrame: function () {
            sunTime = new Date();
            engine.setDate("Sun position: " + utc(sunTime));
        },

        render: render,
        preview: drawPreview,
        decorate: decorate,

        // No scalar field to legend, so the bar shows what does vary across the globe: the
        // terminator ramp itself, run over sun elevations -12°…+12° through the shading
        // function the pixels went through.
        scaleBar: function (ctx, width, height) {
            var sample = [190, 190, 190], shaded = [0, 0, 0];
            for (var i = 0; i < width; i++) {
                shade(sample, Math.sin((i / (width - 1) * 24 - 12) / DEG), null, 1, shaded);
                ctx.fillStyle = "rgb(" + Math.round(shaded[0]) + "," + Math.round(shaded[1]) +
                    "," + Math.round(shaded[2]) + ")";
                ctx.fillRect(i, 0, 1, height);
            }
            return "night &ndash; day";
        },

        // The elevation comes from SunCalc's ordinary observer call, so the readout cannot
        // drift from the shading, which is derived from the same library's subsolar point.
        readout: function (λ, φ) {
            var alt = SunCalc.getPosition(sunTime, φ, λ).altitude * DEG;
            return "sun " + alt.toFixed(1) + "° · " + solarTime(λ) + " solar";
        }
    };

    /**
     * Decodes an image into a sampler, once per URL. crossOrigin is required for the R2
     * bucket: without it the canvas the pixels are read back from is tainted and getImageData
     * throws, even though the bucket does send Access-Control-Allow-Origin.
     */
    function texture(url, build) {
        if (cache[url]) return Promise.resolve(cache[url]);
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = function () { resolve(cache[url] = (build || buildTexture)(img)); };
            img.onerror = function () { reject(new Error("texture: " + url.split("/").pop())); };
            img.src = url;
        });
    }

    /**
     * Relief depth, live. The default was chosen by eye against rendered stills; this exists
     * because it is far easier to judge on the moving globe. `#relief=` is read once at boot —
     * the engine rewrites the hash from its own known keys as the view settles, so the value
     * is latched here rather than re-read.
     */
    var hashRelief = /(?:^|&|#)relief=([\d.]+)/.exec(location.hash);
    if (hashRelief) reliefK = Math.max(0, Math.min(1, parseFloat(hashRelief[1]) || 0));
    window.EarthRenderers.sunlight.setRelief = function (k) {
        reliefK = Math.max(0, Math.min(1, k));
        // Re-running the layer is the cheapest way back to a frame from here: the engine owns
        // recompute(), and load() resolves straight out of the decode cache, so nothing refetches.
        var active = document.querySelector(".layer.active");
        if (active) document.dispatchEvent(new CustomEvent("layerchange", {detail: active.dataset.layer}));
        return reliefK;
    };
})();

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
    // Deep zoom on the imagery. The composites come on three grids, and each carries twice the
    // detail of the one below it: 15 px/deg at 5400, 30 at 10800, 60 at 21600. Only the first is
    // decoded whole — the 21600 is 933 MB as RGBA — so past the base plate the layers switch to a
    // *crop* of a master over the visible cap. See ensureDetail().
    //
    // Which grid a view earns used to be two zoom constants, DETAIL_ZOOM = 2.5 and MID_ZOOM = 5,
    // read off `scale · π/180` against those px/deg figures. Both were wrong in the same way: that
    // expression is CSS px, and render() draws at `scale · overlayScale` backing-store px. On a
    // Retina display the imagery is asked for twice the detail the arithmetic assumed and every
    // crossover arrives at half the zoom quoted — the 5400 plate running out at 1.3× rather than
    // 2.6×. The fixed numbers also could not follow the viewport: the same comment noted the
    // crossover falls to 1.9× on a 1080 px-tall window and left the constant at 2.5 regardless.
    //
    // So the thresholds are gone and the two questions are asked directly, of the numbers that
    // actually decide them: worthCropping() for whether to cut at all, chooseMaster() for which
    // grid to cut from. Both read screenDetail(), which carries overlayScale and the viewport with
    // it, so a Retina laptop and a 4K panel now get their own crossovers rather than a 790 px
    // CRT's. What the old constants encoded is preserved as a consequence rather than a constant:
    // on a 1600×900 CSS-pixel display the crop still engages around 2.4× and the master around 5×.
    //
    // The mid tier costs ~3.5 MB against the master's ~23 (means over the twelve monthly
    // composites; both vary by season). A view that jumps straight past the master's threshold
    // never fetches the mid tier at all; one that pauses on the way fetches both, which is the
    // price of not guessing where a drag is going. Checked against the master at 3.5× on a
    // 1200×800 viewport: SSIM 0.967 overall, and a Himalaya crop of the two is indistinguishable
    // -- same lakes, same snow line -- for 3.0 MB against 21.3, on the August composite.
    var MID_GRID = 10800;           // the mid tier's grid, px across; register() builds the URL from it
    var HI_GRID = 21600;            // the deep master's grid, likewise
    // The size of the cropped readback, as the edge of a square of equivalent area — and the
    // constraint that actually limits deep zoom, because over most of the range it is this and not
    // the tier that decides what reaches the screen. Measured on a 1600×900 viewport: at 3.5× the
    // window is 103.7° across, the 21600 master offers 6221 px of it, and the old 3072 took half.
    // Below ~3.8× that clamp was tighter than the *mid* tier's own 10800, so the mid tier and the
    // master produced byte-identical crops and the extra 20 MB of master bought nothing at all.
    //
    // Raising it to 4096 is worth ~30% more px/deg through the 4–6× band where the softness shows.
    // Not higher: this is getImageData into the JS heap, not a GPU allocation, and it is cut twice
    // on Night Lights (the day and night planes). 4096² RGBA is 67 MB a plane against 3072²'s 38;
    // 8192² would be 268 MB a plane and 537 MB for the pair, on top of the retained 21600 decode,
    // and the readback — already a few hundred ms at 3072 — scales with area, not with the axis.
    // Zooming back out releases it, so this is a ceiling on the deep-zoom view, not a resting cost.
    //
    // It is the *area* that is fixed, not each axis; cropSize() decides how to spend it, and the
    // two are the same square only when the window is as wide as it is tall.
    var DETAIL_MAX_CROP = 4096;
    var DETAIL_BUDGET = DETAIL_MAX_CROP * DETAIL_MAX_CROP;   // the cap is an area, see cropSize()
    // Per-axis ceiling, keeping a degenerate window from cutting a one-pixel strip. Memory is
    // bounded by DETAIL_BUDGET above and not by this — a 16384 × 1024 crop costs the same 67 MB as
    // a 4096² one — so raising it to 16384 looks free, and on paper it pays: above ~65°N past 5×
    // the demand split wants a wider strip than 8192 and clamping it costs 12–18% of plateDetail().
    //
    // Measured, it does not pay. Rendered headless at 70°N/7×, 68°N/6° and 67°N/5×, the wider strip
    // came back with 4–6% more east-west detail and 7–12% *less* north-south, for a net loss in
    // every one. plateDetail() maximises the weaker axis, and up there that is not the axis the eye
    // is reading: worstLat() scores longitude at the most equatorward latitude in the window, which
    // near a pole is the foreshortened rim of the disc rather than the middle of the screen, so the
    // split is already leaning further into longitude than the view wants. The ceiling was quietly
    // correcting for that. It stays at 8192 until the weighting it is compensating for is fixed.
    var DETAIL_MAX_AXIS = 8192;
    var DETAIL_MARGIN = 0.18;       // crop overshoot past the visible cap, as a fraction of span
    var DETAIL_REGAIN = 1.15;       // re-cut only when a fresh crop would carry this much more detail
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
    var baseDay = null;             // the 5400 samplers, kept as the fallback outside the crop
    var baseNight = null;
    var midDay = null;              // 10800 day master — the tier between base and hiDay
    var hiDay = null;               // high-res URLs for the displayed layer, or null
    var hiNight = null;
    var hiRelief = null;
    var images = {};                // decoded high-res <img> by URL, held for re-cropping
    var detail = null;              // {win, zoom, master, day, night} — the current high-res crop
    var detailBusy = false;         // a fetch or a re-cut is in flight
    var detailFailed = false;       // one failure is enough; do not re-request 21 MB on every settle
    var terrainHi = false;          // the 2700 elevation map has replaced the 1350 one
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
        // Only bites where the cap above actually shrinks the source, which is the mobile
        // half-width path: there the browser's default "low" scaler aliases a 2:1 downscale it
        // has no need to. Free everywhere else, since desktop draws 5400 → 5400 at 1:1.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
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

    // ----------------------------------------------------------------------------------------
    // Deep-zoom detail: a high-res crop of the visible cap
    //
    // The masters are 21600×10800 (Blue Marble) and 13500×6750 (Black Marble). Neither can go
    // through buildTexture: 933 MB and 364 MB of RGBA respectively, for a globe that shows at
    // most a hemisphere and, once worthCropping() engages, far less. So the <img> is kept decoded,
    // and only the window the camera can actually see is read back — measured in Chromium, a
    // full-resolution cropped drawImage off the 21600 master costs 4 ms and the getImageData
    // that follows a few hundred, once per settle rather than per frame.
    //
    // A tile pyramid would be the other way to do this, and was rejected: it needs the masters
    // sliced into ~900 objects at fetch time, a second index to serve them, and a per-pixel
    // dispatch across tile edges in the render loop — all to solve a problem one crop already
    // solves, because the visible region is contiguous by construction.

    /** The spherical cap the camera can see: centre (the negated rotation) and angular radius. */
    function visibleCap() {
        var projection = engine.projection;
        var view = engine.view();
        var r = projection.rotate();
        // Half the viewport diagonal, so the cap covers the corners and not just the axes.
        var reach = Math.sqrt(view.width * view.width + view.height * view.height) / 2;
        return {
            λc: -r[0],
            φc: -r[1],
            r: Math.asin(Math.min(1, reach / projection.scale())) * DEG
        };
    }

    /** Latitude band of a cap, clamped at the poles. */
    function capLatitudes(cap) {
        return [Math.max(-90, cap.φc - cap.r), Math.min(90, cap.φc + cap.r)];
    }

    /**
     * Half the longitude extent of a cap, or null when it reaches over a pole and the extent
     * is the whole circle. asin(sin r / cos φ) is the tangent-meridian of a small circle —
     * the same formula a geographic bounding box uses.
     */
    function capHalfSpan(cap) {
        // Strictly inside, not touching. visibleCap() clamps its asin argument at 1, so any view
        // whose viewport diagonal overshoots the globe reports r = 90° exactly — which is most of
        // the range below ~2.4× — and `>= 90` sent every one of them down the full-circle path.
        // A hemisphere centred on the equator covers λc ± 90 at *every* latitude, so 180° was the
        // right answer and 360° was double. That doubling landed on the widest windows there are,
        // where cropSize() has the least room to absorb it: it halved the crop's longitude
        // resolution across the whole low-zoom band, which is exactly the band a Retina display
        // needs the crop in. A cap that contains a pole in its interior is still 360°.
        if (Math.abs(cap.φc) + cap.r > 90 + 1e-9) return null;
        // |φc| ≤ 90 - r now, so cos φc ≥ sin r and the ratio cannot exceed 1; min() is arithmetic
        // safety at the boundary, not a clamp that changes an answer.
        var cosφ = Math.cos(cap.φc / DEG), sinR = Math.sin(cap.r / DEG);
        return Math.asin(Math.min(1, sinR / cosφ)) * DEG;
    }

    /** The lon/lat window to cut, the visible cap plus DETAIL_MARGIN on each span. */
    function cropWindow(cap) {
        var lat = capLatitudes(cap);
        var mφ = (lat[1] - lat[0]) * DETAIL_MARGIN;
        var south = Math.max(-90, lat[0] - mφ), north = Math.min(90, lat[1] + mφ);
        var half = capHalfSpan(cap);
        if (half === null) {
            return {west: -180, south: south, north: north, spanλ: 360, spanφ: north - south};
        }
        var spanλ = Math.min(360, half * 2 * (1 + DETAIL_MARGIN));
        return {west: cap.λc - spanλ / 2, south: south, north: north,
                spanλ: spanλ, spanφ: north - south};
    }

    /** Is λ inside the window, allowing for the wrap at ±180? */
    function inWindow(win, λ) {
        var d = λ - win.west;
        return d - 360 * Math.floor(d / 360) <= win.spanλ;
    }

    /** Does an existing crop still cover everything the camera can see? */
    function covers(win, cap) {
        var lat = capLatitudes(cap);
        if (lat[0] < win.south || lat[1] > win.north) return false;
        if (win.spanλ >= 360) return true;
        var half = capHalfSpan(cap);
        if (half === null) return false;                  // now over a pole; needs the full circle
        return inWindow(win, cap.λc - half) && inWindow(win, cap.λc + half);
    }

    /** The whole plate as a window: what the base texture covers, for comparison against a crop. */
    var GLOBE = {west: -180, south: -90, north: 90, spanλ: 360, spanφ: 180};

    /**
     * px per degree of *arc* that an equirectangular plate of w × h carries over `win`.
     *
     * Arc, not longitude, because arc is the unit the screen asks in while degrees of longitude
     * are the unit the array is indexed in, and the two differ by cos(φ). The longitude axis is
     * therefore divided by the largest cos(φ) the window contains — the latitude where its columns
     * are stretched widest on screen, and so where the plate is thinnest against what a viewer can
     * actually resolve. Whichever axis is worse is the one that decides.
     */
    function plateDetail(win, w, h) {
        return Math.min(w / win.spanλ / Math.cos(worstLat(win) / DEG), h / win.spanφ);
    }

    /**
     * The latitude in a window where a degree of longitude is widest on screen, and so where the
     * crop's columns are stretched thinnest: the equator if the window straddles it, otherwise
     * whichever edge is nearer to it.
     */
    function worstLat(win) {
        return win.south <= 0 && win.north >= 0
            ? 0 : Math.min(Math.abs(win.south), Math.abs(win.north));
    }

    /**
     * How many px to spend on each axis of a crop of `win` cut from a W0 × H0 master.
     *
     * The budget is an *area* — DETAIL_MAX_CROP² of readback per plane — split between the axes
     * in the ratio the screen is actually asking in, rather than capped at the same number on
     * each. Near the equator those are the same thing. Near a pole they are not, because
     * cropWindow() has to take all 360° of longitude as soon as the visible cap touches the pole,
     * and an equal per-axis cap then starves the wide axis to pay the narrow one. Measured at
     * 51.5°N and 3× on a 1600×900 viewport, where the window is 360° × 109°:
     *
     *     equal cap    4096 × 3276    11.4 px/deg lon,  30.0 px/deg lat
     *     by demand    7437 × 2256    20.7 px/deg lon,  20.7 px/deg lat
     *
     * The base texture carries 15 px/deg in both. So the old split was below it in the axis the
     * viewer is looking across and twice it in the axis they are not — the imagery lost real
     * east-west detail at every populated northern latitude, and spent it on north-south detail
     * no screen was asking for. The same readback, reapportioned, clears the base plate in both.
     * Measured headless at 51.5°N and 3×: east-west detail ×1.42, north-south ×0.99.
     *
     * The ratio is spanλ·cos(φ) against spanφ, both degrees of arc — the very cos(φ) that makes a
     * degree of longitude cheap up there, now spending the pixels rather than merely excusing
     * them. cos(φ) is taken at worstLat(), so a window that reaches down to the equator (this one
     * does: it runs from 19°S to the pole) gets no discount, which is why the split is as wide as
     * it is.
     */
    function cropSize(win, W0, H0) {
        var sw = win.spanλ / 360 * W0, sh = win.spanφ / 180 * H0;
        var w, h;
        if (sw * sh <= DETAIL_BUDGET) {                  // fits whole: no downscale to apportion
            w = sw;
            h = sh;
        } else {
            var aspect = win.spanλ * Math.cos(worstLat(win) / DEG) / win.spanφ;
            w = Math.min(sw, Math.sqrt(DETAIL_BUDGET * aspect), DETAIL_MAX_AXIS);
            h = Math.min(sh, Math.sqrt(DETAIL_BUDGET / aspect), DETAIL_MAX_AXIS);
            // Whichever axis hit its natural size first leaves slack; hand it to the other.
            h = Math.min(sh, DETAIL_BUDGET / w, DETAIL_MAX_AXIS);
            w = Math.min(sw, DETAIL_BUDGET / h, DETAIL_MAX_AXIS);
        }
        return {w: Math.max(2, Math.round(w)), h: Math.max(2, Math.round(h)), sw: sw, sh: sh};
    }

    /**
     * px per degree of arc the screen is asking for at the globe's centre.
     *
     * `overlayScale()` is the term every crossover in this file used to be missing. render() draws
     * at `projection.scale() · overlayScale` backing-store px, so on any display where that is 2 —
     * every Retina laptop — the imagery is asked for twice the detail the CSS-pixel arithmetic in
     * the old DETAIL_ZOOM/MID_ZOOM constants assumed, and each grid runs out at half the zoom they
     * were set to. worthCropping() and chooseMaster() read this instead of those constants.
     */
    function screenDetail() {
        return engine.projection.scale() * (Math.PI / 180) * engine.overlayScale();
    }

    /**
     * Reads one lon/lat window out of a decoded equirectangular master into a bilinear sampler,
     * downscaling to fit the readback budget if the window carries more pixels than it allows.
     *
     * The two axes are sized by cropSize(), which splits one area budget between them by demand
     * rather than capping each at the same number — see there for why a polar window makes those
     * two very different things. At 3× the visible window is ~127° across, and the budget puts
     * 30 px/deg on it against the ~20 a CSS-pixel screen resolves and the ~40 a Retina one does,
     * which is where the headroom raising the cap bought actually goes.
     */
    function buildCrop(image, win) {
        var W0 = image.naturalWidth, H0 = image.naturalHeight;
        var size = cropSize(win, W0, H0);
        var sw = size.sw, sh = size.sh, w = size.w, h = size.h;
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d", {willReadFrequently: true});
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        var sx = (win.west + 180) / 360 * W0;
        sx -= W0 * Math.floor(sx / W0);                   // into [0, W0)
        var sy = (90 - win.north) / 180 * H0;
        // A window straddling the antimeridian is two draws; drawImage will not wrap a source
        // rectangle off the right edge, it clamps, which would smear the last column across it.
        var head = Math.min(sw, W0 - sx);
        var headW = Math.max(1, Math.round(head / sw * w));
        ctx.drawImage(image, sx, sy, head, sh, 0, 0, headW, h);
        if (head < sw - 0.5) {
            ctx.drawImage(image, 0, sy, sw - head, sh, headW, 0, w - headW, h);
        }
        var data = ctx.getImageData(0, 0, w, h).data;
        var lastX = w - 1, lastY = h - 1;

        // Bilinear, clamped rather than wrapped in both axes: the window carries DETAIL_MARGIN
        // of slack, so the clamped edge is never inside the visible disc.
        function sampleIf(λ, φ, out) {
            var dλ = λ - win.west;
            dλ -= 360 * Math.floor(dλ / 360);
            if (dλ > win.spanλ) return false;
            var dφ = win.north - φ;
            if (dφ < 0 || dφ > win.spanφ) return false;
            var x = dλ / win.spanλ * w - 0.5;
            var y = dφ / win.spanφ * h - 0.5;
            var xi = Math.floor(x), yi = Math.floor(y);
            var fx = x - xi, fy = y - yi;
            var x0 = xi < 0 ? 0 : xi > lastX ? lastX : xi;
            var x1 = xi + 1 < 0 ? 0 : xi + 1 > lastX ? lastX : xi + 1;
            var y0 = yi < 0 ? 0 : yi > lastY ? lastY : yi;
            var y1 = yi + 1 < 0 ? 0 : yi + 1 > lastY ? lastY : yi + 1;
            var a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4;
            var c = (y1 * w + x0) * 4, e = (y1 * w + x1) * 4;
            var w0 = (1 - fx) * (1 - fy), w1 = fx * (1 - fy), w2 = (1 - fx) * fy, w3 = fx * fy;
            out[0] = data[a] * w0 + data[b] * w1 + data[c] * w2 + data[e] * w3;
            out[1] = data[a + 1] * w0 + data[b + 1] * w1 + data[c + 1] * w2 + data[e + 1] * w3;
            out[2] = data[a + 2] * w0 + data[b + 2] * w1 + data[c + 2] * w2 + data[e + 2] * w3;
            return true;
        }

        return {sampleIf: sampleIf, width: w, height: h};
    }

    /** Crop first, 5400 master outside it. One predictable branch per pixel per texture. */
    function layered(base, crop) {
        return {
            sample: function (λ, φ, out) {
                if (!crop.sampleIf(λ, φ, out)) base.sample(λ, φ, out);
            },
            width: crop.width,
            height: crop.height
        };
    }

    /** Decodes an image and keeps it, without reading any pixels back. */
    function decode(url) {
        if (images[url]) return Promise.resolve(images[url]);
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = function () { resolve(images[url] = img); };
            img.onerror = function () { reject(new Error("texture: " + url.split("/").pop())); };
            img.src = url;
        });
    }

    /**
     * Is a crop worth cutting for this window at all — the question DETAIL_ZOOM used to answer?
     *
     * Two things have to hold. The screen must be asking for more than the base plate carries,
     * which on a Retina display happens at half the zoom the old constant assumed. And a crop of
     * *this* window must be able to deliver meaningfully more than the base plate, which is not
     * automatic: below ~2.4× the visible cap is the whole hemisphere, the window is as wide as the
     * plate itself, and one budget's worth of readback spread over it comes back at 21 px/deg
     * against the plate's 15 — worth having, but only just, and not worth 3.5 MB if the screen is
     * only asking for 16. Clamping the crop's score at what the screen wants is what makes that
     * second test bite; DETAIL_REGAIN sets how much better than the plate is worth the fetch.
     */
    function worthCropping(win) {
        var base = plateDetail(GLOBE, baseDay.width, baseDay.height);
        var want = screenDetail();
        if (want <= base) return false;                  // the base plate still resolves the screen
        var size = cropSize(win, HI_GRID, HI_GRID / 2);  // the best any crop could do here
        return Math.min(plateDetail(win, size.w, size.h), want) >= base * DETAIL_REGAIN;
    }

    /**
     * Which grid to cut this window from — the question MID_ZOOM used to answer, and got wrong in
     * a way no zoom threshold could have got right.
     *
     * The master is only worth its ~23 MB when a crop cut from it actually comes back sharper than
     * one cut from the 10800 tier. Two separate things stop that being true, and neither is a
     * function of zoom alone. The readback budget clamps both cuts to the same size whenever the
     * window is wide — below ~3.8× on a 1600×900 viewport the two crops come back byte-identical,
     * and MID_ZOOM = 5 was fetching the master for the last of that band to no effect whatsoever.
     * And past the point where the screen is satisfied, extra px/deg in the plate are extra px/deg
     * nobody can see. Asking cropSize() both questions settles both.
     *
     * The comparison is axis by axis, and must be: plateDetail() reports a plate's *weakest* axis,
     * which is the right answer for how sharp a crop looks and the wrong one for whether one crop
     * beats another. At 68°N and 6× both grids pin the longitude axis to DETAIL_MAX_AXIS, so their
     * weakest axes are identical and a min() comparison called it a tie — while the master was in
     * fact carrying a quarter more latitude detail (37.8 px/deg against 30.0). Cutting the cheap
     * tier there was a visible regression on Siberian river country, caught headless at ×0.50.
     *
     * A per-axis *loss* is not disqualifying, and treating it as one cost 70°N at 7× a fifth of its
     * detail. Near a pole the mid tier's crop fits the budget whole and spends the slack on
     * longitude, while the master's has to be scaled down to fit — so the master trades longitude
     * for latitude. That is an artefact of how cropSize() spends the budget, not of the imagery:
     * the master is never the poorer source. So the only question asked is whether it wins some
     * axis by enough to be worth fetching.
     */
    function chooseMaster(win) {
        if (!midDay) return hiDay;
        if (!hiDay) return midDay;
        var want = screenDetail();
        var mid = cropSize(win, MID_GRID, MID_GRID / 2);
        var hi = cropSize(win, HI_GRID, HI_GRID / 2);
        // Longitude is compared in degrees of arc, as plateDetail() does, so the two axes are
        // scored in the same unit; latitude already is.
        var lon = axisGain(hi.w, mid.w, win.spanλ * Math.cos(worstLat(win) / DEG), want);
        var lat = axisGain(hi.h, mid.h, win.spanφ, want);
        return lon >= DETAIL_REGAIN || lat >= DETAIL_REGAIN ? hiDay : midDay;
    }

    /** How much more one grid resolves than another along one axis, capped at what the screen shows. */
    function axisGain(hiPx, midPx, span, want) {
        return Math.min(hiPx / span, want) / Math.min(midPx / span, want);
    }

    /**
     * Should the crop be re-cut for the view it now faces? Compares what it carries against what
     * the screen is asking for, rather than how far the zoom has travelled since it was cut.
     *
     * The ratio this replaces — re-cut once zoom had grown 1.6× — was wrong at both ends. A crop
     * cut at 2.5× stayed in service to 3.99×, carrying 17 px/deg against the 26 the screen wanted;
     * and above ~6.5×, where the crop is already at the master's native 60 px/deg and a re-cut
     * cannot add a pixel, it went on paying the readback anyway. Both numbers are available, so
     * this asks them directly instead of guessing from the zoom.
     *
     * DETAIL_REGAIN is what stops the second failure mode coming back as a loop: once the master
     * itself is the limit, a fresh cut scores what the current one already does, and the re-cut is
     * declined rather than repeated every settle.
     */
    function worthRecutting(cap) {
        var have = plateDetail(detail.win, detail.day.width, detail.day.height);
        if (have >= screenDetail()) return false;        // still finer than the screen resolves
        var win = cropWindow(cap), size = cropSize(win, detail.W, detail.H);
        return plateDetail(win, size.w, size.h) >= have * DETAIL_REGAIN;
    }

    /** Zoomed back out, or into a window a crop cannot improve: release ~70 MB and show the base. */
    function dropDetail() {
        detail = null;
        day = baseDay;
        night = baseNight;
    }

    /**
     * Called from render(), which the engine only reaches once a gesture has settled — the same
     * discipline the 10m coastline fetch uses. Nothing here runs per drag frame: the preview
     * keeps sampling the 5400 texture, and the sharper pixels arrive on the settle after.
     */
    function ensureDetail() {
        if ((!hiDay && !midDay) || detailFailed || engine.isMobile()) return;   // phones keep the 5400 masters
        var cap = visibleCap();
        if (!worthCropping(cropWindow(cap))) {
            if (detail) dropDetail();      // zoomed back out, or somewhere a crop cannot help
            return;
        }
        if (detailBusy) return;
        var master = chooseMaster(cropWindow(cap));
        // A tier change re-cuts even when the existing crop still covers the view: the
        // point of moving up a grid is that the same window now comes from sharper pixels.
        if (detail && detail.master === master &&
            covers(detail.win, cap) && !worthRecutting(cap)) return;
        detailBusy = true;
        // The three assets fail independently. Only the Blue Marble master is load-bearing —
        // a missing night or elevation twin should cost that layer its own upgrade, not the
        // imagery's, so those two resolve to null instead of rejecting the set.
        function optional(p) {
            return p ? p.catch(function (err) { console.error(err); return null; }) : Promise.resolve(null);
        }
        Promise.all([
            decode(master),
            optional(hiNight ? decode(hiNight) : null),
            optional(hiRelief && !terrainHi ? texture(hiRelief, buildRelief) : null)
        ]).then(function (im) {
            var win = cropWindow(visibleCap());
            // Asked again of the window as it stands now: a view that zoomed back out while this
            // was in flight must not have a crop installed over the plate that already beats it.
            if (!worthCropping(win)) {
                dropDetail();
            } else {
                detail = {
                    win: win,
                    master: master,
                    W: im[0].naturalWidth,      // the master's own grid, for worthRecutting()
                    H: im[0].naturalHeight,
                    day: buildCrop(im[0], win),
                    night: im[1] ? buildCrop(im[1], win) : null
                };
                day = layered(baseDay, detail.day);
                night = baseNight && detail.night ? layered(baseNight, detail.night) : baseNight;
            }
            if (im[2]) terrain = im[2];   // relief upgrades whole; it is small enough not to crop
            terrainHi = true;             // attempted — succeeded or not, do not ask again
            detailBusy = false;
            engine.requestRender();   // covers() is satisfied now, so this settles in one pass
        }).catch(function (err) {
            console.error(err);
            detailBusy = false;
            detailFailed = true;
        });
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
        // Matters more here than it does for colour: what this plate feeds is a *derivative*, and
        // the default "low" scaler's aliasing lands as noise in the exact quantity the shading
        // consumes — the same argument that makes the offline resample lanczos and the file a PNG.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
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
        // Settled view: this is where a sharper crop is worth cutting (and where the engine
        // has already stopped calling preview()).
        ensureDetail();
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
            // WebP, not the JPEG NASA publishes: half the bytes at SSIM 0.985 against it,
            // and these pixels are only ever sampled as colour. The night lights and the
            // elevation map stay in their own formats — their pixels are read back through
            // extractions that lossy WebP measurably poisons (see fetch_textures.sh).
            var blueMarble = dataRoot + "bluemarble-2004" + month + ".webp";
            // The deep-zoom masters, fetched only once worthCropping() says a crop is worth it.
            // Each name carries its grid, as the R2 objects are immutable and served forever, so
            // the URLs are built from the same MID_GRID/HI_GRID that chooseMaster() reasons about
            // and the two cannot drift. Two tiers rather than one: see chooseMaster(). The 21600
            // stays JPEG because WebP cannot exceed 16383 px on an axis.
            var blueMarbleMid = dataRoot + "bluemarble-2004" + month + "-" + MID_GRID + ".webp";
            var blueMarbleHi = dataRoot + "bluemarble-2004" + month + "-" + HI_GRID + ".jpg";
            var credit = "NASA Blue Marble NG &nbsp;|&nbsp; MODIS / Terra, NASA Earth Observatory";
            var placeholder = "click a point for sun elevation";
            // Relief is its own layer rather than a treatment applied to the other two:
            // Daylight and Night Lights are the imagery as photographed, and adding shading
            // the camera never saw belongs in a layer a viewer chooses on purpose. The three
            // share one Blue Marble URL, so switching between them decodes nothing.
            return {
                "daylight": {texture: blueMarble, textureMid: blueMarbleMid, textureHi: blueMarbleHi, label: "Daylight",
                    credit: credit, placeholder: placeholder},
                "nightlights": {texture: blueMarble, textureMid: blueMarbleMid, textureHi: blueMarbleHi,
                    night: dataRoot + "blackmarble-2016-5400.jpg",
                    nightHi: dataRoot + "blackmarble-2016-13500.jpg",
                    label: "Night Lights", placeholder: placeholder,
                    credit: credit + " &nbsp;+&nbsp; VIIRS Black Marble 2016"},
                "relief": {texture: blueMarble, textureMid: blueMarbleMid, textureHi: blueMarbleHi,
                    relief: dataRoot + "elevation-gebco-1350.png",
                    reliefHi: dataRoot + "elevation-gebco-2700.png",
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
            // The crop belongs to the layer that was showing, not to the one arriving: a
            // Daylight crop has no night plane and Relief wants a different elevation map.
            detail = null;
            detailBusy = false;
            detailFailed = false;
            terrainHi = false;
            midDay = layer.textureMid || null;
            hiDay = layer.textureHi || null;
            hiNight = layer.nightHi || null;
            hiRelief = layer.reliefHi || null;
            return Promise.all([
                texture(layer.texture),
                layer.night ? texture(layer.night) : null,
                layer.relief ? texture(layer.relief, buildRelief) : null
            ]).then(function (t) {
                day = baseDay = t[0];
                night = baseNight = t[1];
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

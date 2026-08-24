// Sunlight motion-physics suite: where sunlight.js puts the sun, and how the globe changes
// as the sun moves.
//
// The particle engine is only half the motion in this app. The RealView layers are lit by a
// real solar position — a subsolar point from SunCalc, a terminator ramped over civil
// twilight, a night plane with its own tone curve, and relief shaded by the sun's elevation.
// All of it is recomputed on a clock, and none of it was covered: the render suite pins the
// clock precisely so the sun *cannot* move, which makes those views comparable but leaves
// the sun's behaviour itself unmeasured. A terminator frozen in place, drifting at the wrong
// rate, or ramped over the wrong width would pass every existing check.
//
// Two kinds of observable, deliberately independent:
//   - Analytic: sunlight.js's own readout(λ, φ) returns the sun's elevation at a coordinate.
//     No pixels, no projection — the position maths on its own.
//   - Rendered: the lit fraction of the disc and the terminator's position along the equator,
//     read off the overlay. This is what the viewer sees, and it is what catches a correct
//     sun that is being drawn wrongly.
//
// Both are sampled at several instants, so the suite compares motion and not just a pose.
async function runSuite() {
    var view = E.params();
    var HOUR = 3600000;
    var STEPS = [0, 3, 6, 12];      // hours from the pinned instant
    var BASE = E.now();

    // Coordinates spread over latitude and longitude, including both poles, so a change to
    // the declination or the hour angle shows up somewhere no matter the season.
    var PROBES = [
        [0, 0], [90, 0], [-90, 0], [180, 0],
        [0, 45], [0, -45], [0, 89], [0, -89],
        [-80, -15], [120, 35]
    ];

    // sunlight.js is a deferred renderer: wind.js registers a stub at boot and only loads
    // the real module the first time a RealView layer is asked for. Latching the handle at
    // the top of the suite therefore captured the stub, which has no readout() and no
    // overlayScale() — the analytic half of this suite reported null for everything. It is
    // resolved on each use instead, after the view has settled and the module is in place.
    function renderer() {
        var r = window.EarthRenderers && window.EarthRenderers.sunlight;
        return (r && typeof r.readout === "function") ? r : null;
    }

    function round(n) { return Math.round(n * 1000) / 1000; }

    /** Sun elevation in degrees at each probe coordinate, straight from the renderer. */
    function elevations() {
        var sun = renderer();
        if (!sun) return null;
        return PROBES.map(function (p) {
            // "sun -12.3° · 07:41 solar" — the number is the elevation, the rest is solar time.
            var text = sun.readout(p[0], p[1]);
            var m = /sun\s+(-?[\d.]+)°\s+·\s+([\d:]+)/.exec(text);
            return m ? {at: p, alt: parseFloat(m[1]), solar: m[2]} : {at: p, raw: text};
        });
    }

    /**
     * The lit disc, measured off the overlay.
     *
     * Along the disc's horizontal centre line, day is bright and night is dark; the crossing
     * between them is the terminator. Its position is reported in device px and as a
     * fraction of the disc's width, so it stays meaningful whatever the viewport is, and the
     * lit fraction of the whole disc is reported with it — a terminator that stopped moving
     * and one that moved the wrong way are different numbers here, where a single mean
     * brightness would confuse them.
     */
    function litProfile() {
        var c = E.el("overlay");
        var w = c.width, h = c.height;
        if (!w || !h) return null;
        var ctx = c.getContext("2d");
        var all = ctx.getImageData(0, 0, w, h).data;

        // Disc extent, so every position below can be expressed relative to the globe and
        // stay comparable across viewports.
        var minX = w, maxX = -1, minY = h, maxY = -1;
        var covered = 0, lumSum = 0;
        var lit60 = 0, lit120 = 0, lit180 = 0;
        var wx = 0, wy = 0;             // luminance-weighted position

        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var i = (y * w + x) * 4;
                if (all[i + 3] === 0) continue;
                covered++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                var l = 0.299 * all[i] + 0.587 * all[i + 1] + 0.114 * all[i + 2];
                lumSum += l;
                if (l > 60) lit60++;
                if (l > 120) lit120++;
                if (l > 180) lit180++;
                wx += l * x;
                wy += l * y;
            }
        }
        if (!covered || maxX < 0) return null;

        var spanX = maxX - minX + 1, spanY = maxY - minY + 1;
        return {
            covered: covered,
            meanLuma: round(lumSum / covered),
            // Graded rather than single-threshold: the terminator is a ramp, and three cuts
            // through it separate "the lit area moved" from "the whole globe got brighter",
            // which one threshold cannot.
            litFraction60: round(lit60 / covered),
            litFraction120: round(lit120 / covered),
            litFraction180: round(lit180 / covered),
            // The brightness centroid, in disc-relative coordinates: 0 at the left/top limb,
            // 1 at the right/bottom. This is the terminator's position expressed as a
            // quantity that moves smoothly with the sun and needs no threshold at all — the
            // steepest-luminance-step estimate it replaces was landing on coastlines and
            // cloud edges, which are larger steps than the terminator itself.
            centroid: lumSum > 0
                ? [round((wx / lumSum - minX) / spanX), round((wy / lumSum - minY) / spanY)]
                : null,
            discSpanPx: spanX
        };
    }

    /** Re-render for the current clock: the renderer latches the instant in beginFrame(). */
    async function rerender() {
        E.fireWheel(0);                  // startManipulation + scale x exp(0) + scheduleRecompute
        await E.sleep(400);              // past the 200 ms recompute timer
        return await E.settle(60000);
    }

    // ---------------------------------------------------------------------------------
    E.trace("sun: initial settle");
    var settled = await E.settle(90000);

    var samples = [];
    for (var i = 0; i < STEPS.length; i++) {
        E.trace("sun: +" + STEPS[i] + "h");
        E.setNow(BASE + STEPS[i] * HOUR);
        var ok = i === 0 ? settled : await rerender();
        samples.push({
            hours: STEPS[i],
            settled: ok,
            elevations: elevations(),
            lit: litProfile()
        });
    }

    // Consecutive changes, which is the motion itself rather than the poses it passes
    // through. Reported so a difference lands on "the terminator advanced by a different
    // amount between +3h and +6h" instead of only "the pictures differ".
    var motion = [];
    for (var j = 1; j < samples.length; j++) {
        var a = samples[j - 1], b = samples[j];
        motion.push({
            from: a.hours, to: b.hours,
            dLitFraction60: (a.lit && b.lit) ? round(b.lit.litFraction60 - a.lit.litFraction60) : null,
            dMeanLuma: (a.lit && b.lit) ? round(b.lit.meanLuma - a.lit.meanLuma) : null,
            dCentroid: (a.lit && b.lit && a.lit.centroid && b.lit.centroid)
                ? [round(b.lit.centroid[0] - a.lit.centroid[0]),
                   round(b.lit.centroid[1] - a.lit.centroid[1])]
                : null,
            dAltitudes: (a.elevations && b.elevations)
                ? a.elevations.map(function (e, k) {
                    var f = b.elevations[k];
                    return (typeof e.alt === "number" && typeof f.alt === "number")
                        ? round(f.alt - e.alt) : null;
                })
                : null
        });
    }

    E.report({
        view: view.name,
        settled: settled,
        hasRenderer: !!renderer(),
        // The renderer's own resolution decision for the overlay backing store, read rather
        // than inferred: this is the number that decides how sharp the imagery is drawn.
        overlayScale: renderer() ? renderer().overlayScale() : null,
        tick: renderer() ? renderer().tick : null,
        isMobileUA: /android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i
            .test(navigator.userAgent),
        baseInstant: new Date(BASE).toISOString(),
        samples: samples,
        motion: motion,
        hash: E.hashState()
    });
}

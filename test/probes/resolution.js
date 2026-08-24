// Rendering-resolution suite: how much real detail reaches the glass.
//
// "It still renders" and "it renders at the resolution it used to" are different claims, and
// only the first one was ever being checked. A texture master halved, an overlay backing
// store left at 1x, a crop tier that stops engaging — none of those break a pixel hash into
// an obvious failure on a viewport of a different size; they just make the globe softer.
// This suite measures softness directly.
//
// Three independent lines of evidence, because each can be fooled on its own:
//   1. Geometry  — backing-store pixels per CSS pixel, per canvas. Catches a canvas that
//                  stopped honouring devicePixelRatio.
//   2. Provenance — which texture files were actually fetched. The tier is in the filename,
//                  so this says 5400 or 10800 or 21600 without inferring it from pixels.
//   3. Acuity    — gradient energy inside the globe disc. Catches everything else: a master
//                  that was fetched but upscaled from a smaller decode, a crop that never
//                  engaged, a preview left on screen instead of the full render.
async function runSuite() {
    var view = E.params();

    var settled = await E.settle(90000);

    // The app branches on this exact expression and nothing else, so the probe reads it the
    // same way rather than trusting the emulation to have produced the intended device.
    var isMobileUA = /android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i
        .test(navigator.userAgent);

    function geometry(id) {
        var c = E.el(id);
        var rect = c.getBoundingClientRect();
        return {
            backing: [c.width, c.height],
            css: [Math.round(rect.width), Math.round(rect.height)],
            // The number that matters: how many real pixels exist per CSS pixel. Below the
            // device ratio, the browser is upscaling something.
            scale: rect.width ? Math.round(c.width / rect.width * 1000) / 1000 : 0
        };
    }

    /**
     * Gradient energy inside the globe, per pixel — the acuity number.
     *
     * Mean absolute luminance difference to the right-hand and lower neighbour, over pixels
     * the globe actually covers. Detail lives in high spatial frequencies, so upscaling a
     * smaller source lowers this while leaving mean brightness, ink and coverage untouched;
     * a sharper master raises it. Sampled on the backing store, which is what is displayed,
     * not on the CSS box.
     *
     * Alpha-weighted so the antialiased rim cannot contribute an edge of its own: the disc's
     * own outline is the largest gradient on the canvas and would swamp the interior.
     */
    function acuity(id) {
        var c = E.el(id);
        var w = c.width, h = c.height;
        if (!w || !h) return null;
        var data = c.getContext("2d").getImageData(0, 0, w, h).data;

        var total = 0, counted = 0, lumSum = 0, covered = 0;
        // Interior only: the last row and column have no neighbour to difference against.
        for (var y = 0; y < h - 1; y++) {
            var row = y * w;
            for (var x = 0; x < w - 1; x++) {
                var i = (row + x) * 4;
                if (data[i + 3] === 0) continue;
                covered++;
                var l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                lumSum += l;

                var r = i + 4, d = i + w * 4;
                // Both neighbours must be inside the disc, or the difference is the rim.
                if (data[r + 3] === 0 || data[d + 3] === 0) continue;
                var lr = 0.299 * data[r] + 0.587 * data[r + 1] + 0.114 * data[r + 2];
                var ld = 0.299 * data[d] + 0.587 * data[d + 1] + 0.114 * data[d + 2];
                total += Math.abs(l - lr) + Math.abs(l - ld);
                counted++;
            }
        }
        return {
            energy: counted ? Math.round(total / counted * 1000) / 1000 : 0,
            meanLuma: covered ? Math.round(lumSum / covered * 100) / 100 : 0,
            covered: covered,
            sampled: counted,
            backing: [w, h]
        };
    }

    // The globe's own size in real pixels. Acuity per unit of globe is only comparable
    // between two builds that drew the globe at the same size, so it is reported alongside.
    function discDiameterDevicePx() {
        var c = E.el("map");
        var row = c.getContext("2d").getImageData(0, Math.floor(c.height / 2), c.width, 1).data;
        var first = -1, last = -1;
        for (var x = 0; x < c.width; x++) {
            if (row[x * 4 + 3] === 0) continue;
            if (first < 0) first = x;
            last = x;
        }
        return first < 0 ? 0 : last - first + 1;
    }

    E.trace("measuring resolution");

    E.report({
        view: view.name,
        settled: settled,
        device: {
            dpr: window.devicePixelRatio,
            inner: [window.innerWidth, window.innerHeight],
            maxTouchPoints: navigator.maxTouchPoints,
            isMobileUA: isMobileUA,
            ua: navigator.userAgent
        },
        geometry: {
            map: geometry("map"),
            overlay: geometry("overlay"),
            animation: geometry("animation"),
            lines: geometry("lines")
        },
        // #overlay carries the scalar field and, for RealView, the imagery — it is where a
        // resolution change shows first. #map and #lines are vector work: their acuity moves
        // only with the mesh tier, which is the other thing worth catching.
        acuity: {
            overlay: acuity("overlay"),
            map: acuity("map"),
            lines: acuity("lines")
        },
        discDevicePx: discDiameterDevicePx(),
        hash: E.hashState(),
        dom: {
            label: E.el("data-label").textContent.trim(),
            scale: E.el("scale-label").textContent.trim()
        }
    });
}

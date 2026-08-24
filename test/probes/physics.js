// Animation-physics suite: what the particle engine actually draws, frame by frame.
//
// The other suites treat #animation as unmeasurable because its particles are seeded from
// Math.random. They are — so this suite replaces Math.random with a seeded generator (see
// E.seedRandom, installed before any page script) and the trails become reproducible: the
// same particles spawn in the same places and take the same steps on both builds. What is
// left is physics, and it is compared exactly rather than statistically.
//
// The recorder is installed at document-start, at this file's top level, so frame 1 of the
// first animate() call is captured. Arming it later would have compared two different
// points in the particle lifecycle — the app has been running for an unknown number of
// frames by the time a suite's runSuite() is called, and that count is wall-clock
// dependent, which is exactly the nondeterminism this suite exists to remove.
var PHYSICS = (function () {
    "use strict";

    var MAX_FRAMES = 40;        // enough to see spawn, travel, fade and the first respawns
    var frames = [];
    var current = null;
    var lastX = 0, lastY = 0;
    var proto = CanvasRenderingContext2D.prototype;

    function isAnim(ctx) {
        return ctx.canvas && ctx.canvas.id === "animation";
    }

    // The per-frame fade — fillRect under "destination-in" — is the first thing draw()
    // does, so it is the frame boundary.
    var realFillRect = proto.fillRect;
    proto.fillRect = function (x, y, w, h) {
        if (isAnim(this) && this.globalCompositeOperation === "destination-in") {
            if (frames.length < MAX_FRAMES) {
                current = {
                    segments: 0, lengths: [], strokes: 0, styles: [],
                    fade: String(this.fillStyle), lineWidth: this.lineWidth,
                    rect: [Math.round(x), Math.round(y), Math.round(w), Math.round(h)],
                    sumX: 0, sumY: 0
                };
                frames.push(current);
            }
            else current = null;
        }
        return realFillRect.apply(this, arguments);
    };

    var realMoveTo = proto.moveTo;
    proto.moveTo = function (x, y) {
        if (current && isAnim(this)) { lastX = x; lastY = y; }
        return realMoveTo.apply(this, arguments);
    };

    // One moveTo/lineTo pair per particle: a trail segment for the wind and current layers,
    // an oriented crest dash for the wave layers. Either way its length is the distance the
    // engine decided that particle travels this frame, which is the physics.
    var realLineTo = proto.lineTo;
    proto.lineTo = function (x, y) {
        if (current && isAnim(this)) {
            var dx = x - lastX, dy = y - lastY;
            current.segments++;
            current.lengths.push(Math.sqrt(dx * dx + dy * dy));
            current.sumX += (x + lastX) / 2;
            current.sumY += (y + lastY) / 2;
        }
        return realLineTo.apply(this, arguments);
    };

    // One stroke() per non-empty intensity bucket: how the speeds spread across the colour
    // scale, which is where a change to velocity scaling or the intensity cap would show.
    var realStroke = proto.stroke;
    proto.stroke = function () {
        if (current && isAnim(this)) {
            current.strokes++;
            current.styles.push(String(this.strokeStyle));
        }
        return realStroke.apply(this, arguments);
    };

    function round(n) { return Math.round(n * 1000) / 1000; }
    function quantile(sorted, q) {
        if (!sorted.length) return 0;
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    }

    /** Collapses one frame to a fixed set of numbers that a diff can be taken on. */
    function summarise(f) {
        var sorted = f.lengths.slice().sort(function (a, b) { return a - b; });
        var total = 0;
        for (var i = 0; i < sorted.length; i++) total += sorted[i];
        return {
            segments: f.segments,
            strokes: f.strokes,
            buckets: f.styles.length,
            lenMedian: round(quantile(sorted, 0.5)),
            lenP95: round(quantile(sorted, 0.95)),
            lenMax: round(sorted.length ? sorted[sorted.length - 1] : 0),
            lenMean: round(sorted.length ? total / sorted.length : 0),
            travel: round(total),
            centroid: f.segments ? [round(f.sumX / f.segments), round(f.sumY / f.segments)] : [0, 0]
        };
    }

    return {
        frames: function () { return frames.map(summarise); },
        constants: function () {
            var first = frames[0];
            return first ? {fade: first.fade, lineWidth: round(first.lineWidth), rect: first.rect} : null;
        },
        styles: function () {
            // The colour ramp itself, in bucket order, from the busiest recorded frame.
            var best = null;
            for (var i = 0; i < frames.length; i++) {
                if (!best || frames[i].styles.length > best.styles.length) best = frames[i];
            }
            return best ? best.styles : [];
        },
        count: function () { return frames.length; }
    };
})();

async function runSuite() {
    var view = E.params();

    // Settle waits on the three deterministic canvases; the particle engine is running the
    // whole time and the recorder has been capturing since its first frame.
    var settled = await E.settle(90000);

    // If the view settled before MAX_FRAMES frames were drawn, give the engine room to
    // finish the sequence rather than reporting a short one — a short sequence would read
    // as a physics change when it is only a timing difference.
    for (var waited = 0; waited < 120 && PHYSICS.count() < 40; waited++) await E.sleep(50);

    E.report({
        view: view.name,
        settled: settled,
        frameCount: PHYSICS.count(),
        constants: PHYSICS.constants(),
        styles: PHYSICS.styles(),
        frames: PHYSICS.frames(),
        animationInk: E.canvasSignature("animation").ink,
        // With the generator seeded, the trail canvas itself is comparable. It is reported
        // for the record; the runner compares the frame sequence, which localises a
        // difference instead of only detecting one.
        animation: E.canvasSignature("animation"),
        hash: E.hashState()
    });
}

// Speed suite. Every number here is produced the same way on both builds, so the pair can
// be subtracted. The one-finger rotate cases carry the weight: rotation behaves identically
// on the two builds, so a difference there is the draw scheduling and nothing else.
//
// latency() is included because it is where this change could *cost* something: a repaint
// moved onto the next animation frame cannot land sooner than one, and a regression there
// would be a compromise rather than an improvement.
async function runSuite() {
    var GESTURE_MS = 1000;
    var EVENT_INTERVAL_MS = 8;      // faster than a frame, as a real touchscreen is
    var BURST_EVENTS = 8;
    var LATENCY_SAMPLES = 12;
    var LATENCY_GAP_MS = 250;

    var results = {};

    function median(values) {
        var sorted = values.slice().sort(function (a, b) { return a - b; });
        return sorted.length ? sorted[sorted.length >> 1] : 0;
    }
    function round(n) { return Math.round(n * 10) / 10; }
    function intervals(times) {
        var out = [];
        for (var i = 1; i < times.length; i++) out.push(times[i] - times[i - 1]);
        return out;
    }

    /** Records a frame timestamp for as long as `active` stays true. */
    function watchFrames(state) {
        var times = [];
        (function tick(now) {
            times.push(now);
            if (state.active) requestAnimationFrame(tick);
        })(performance.now());
        return times;
    }

    // ---------------------------------------------------------------------------------
    // A gesture held for GESTURE_MS, driving one event every EVENT_INTERVAL_MS. `advance`
    // dispatches one step; `open`/`close` bracket the gesture.
    async function gesture(name, open, advance, close) {
        E.trace("perf: " + name);
        open();
        await E.sleep(120);
        await E.frame();

        E.resetRepaints();
        var state = {active: true};
        var frames = watchFrames(state);
        var events = 0;
        var start = performance.now();

        while (performance.now() - start < GESTURE_MS) {
            advance(++events);
            await E.sleep(EVENT_INTERVAL_MS);
        }

        var elapsed = performance.now() - start;
        state.active = false;
        await E.frame();
        await E.frame();

        var repaints = E.repaints();
        var gaps = intervals(frames);
        close();
        await E.sleep(900);

        results[name] = {
            events: events,
            repaints: repaints,
            repaintsPerEvent: round(repaints / events * 100) / 100,
            // Coalescing is meant to land one repaint per displayed frame. Fewer repaints is
            // only a win while this stays near 1: at 0 the globe has stopped following the
            // finger altogether, which would also read as "fewer repaints" and score as an
            // improvement if nobody looked at it against the frames actually served.
            repaintsPerFrame: frames.length ? round(repaints / frames.length * 100) / 100 : null,
            // How often the globe was actually redrawn per second. framesObserved and fps
            // below count the probe's own requestAnimationFrame callbacks, which is a
            // different quantity: once the draw moves *into* an animation frame, each served
            // frame carries more work and the callback rate drops even though the globe is
            // being redrawn just as often. This is the one that tracks what is on screen.
            repaintsPerSecond: round(repaints / (elapsed / 1000)),
            framesObserved: frames.length,
            fps: round(frames.length / (elapsed / 1000)),
            medianFrameGapMs: round(median(gaps)),
            worstFrameGapMs: round(Math.max.apply(null, gaps)),
            elapsedMs: round(elapsed)
        };
    }

    // ---------------------------------------------------------------------------------
    // Input to paint, one isolated event at a time: nothing else is competing, so the
    // number is the scheduling delay plus the draw itself.
    async function latency(name, open, advance, close) {
        E.trace("perf: " + name);
        open();
        await E.sleep(150);
        await E.frame();

        var samples = [], done = [];
        for (var i = 0; i < LATENCY_SAMPLES; i++) {
            await E.sleep(LATENCY_GAP_MS);
            E.resetRepaints();
            var sent = performance.now();
            advance(i + 1);

            // Wait for the repaint this event caused, up to a generous ceiling.
            for (var waited = 0; waited < 40 && E.repaints() === 0; waited++) await E.frame();
            if (E.repaints() > 0) {
                samples.push(E.lastRepaintAt() - sent);
                // A draw that has begun is not a frame the viewer can see. Give the draw a
                // chance to finish before reading the completion mark, or a synchronous
                // build is credited with finishing at the instant it started.
                for (var settle = 0; settle < 4 && E.lastDrawDoneAt() < E.lastRepaintAt(); settle++) {
                    await E.frame();
                }
                if (E.lastDrawDoneAt() >= E.lastRepaintAt()) done.push(E.lastDrawDoneAt() - sent);
            }
        }

        close();
        await E.sleep(900);
        results[name] = {
            samples: samples.length,
            medianMs: round(median(samples)),
            worstMs: round(samples.length ? Math.max.apply(null, samples) : 0),
            // Input to a frame that is finished, which is the number a person feels.
            completeSamples: done.length,
            completeMedianMs: round(median(done)),
            completeWorstMs: round(done.length ? Math.max.apply(null, done) : 0)
        };
    }

    // ---------------------------------------------------------------------------------
    // A frame's worth of input delivered with no yield in between: the case where drawing
    // per event does work the display can never show.
    async function burst(name, open, advance, close) {
        E.trace("perf: " + name);
        open();
        await E.sleep(120);
        await E.frame();

        E.resetRepaints();
        var start = performance.now();
        for (var i = 1; i <= BURST_EVENTS; i++) advance(i);
        var blocking = performance.now() - start;

        await E.frame();
        await E.frame();
        var repaints = E.repaints();
        close();
        await E.sleep(900);

        results[name] = {
            events: BURST_EVENTS,
            repaints: repaints,
            blockingMs: round(blocking)
        };
    }

    // ---------------------------------------------------------------------------------
    // Gesture shapes. Rotate uses one finger; pinch moves only finger 2, the single
    // pattern the baseline build also responds to, so the pair stays comparable.
    var c = E.centre();

    function rotateShape(id) {
        return {
            open: function () {
                E.fireTouch("touchstart", [E.touch(id, c[0], c[1])], [E.touch(id, c[0], c[1])]);
            },
            advance: function (n) {
                var p = E.touch(id, c[0] + n * 4, c[1]);
                E.fireTouch("touchmove", [p], [p]);
            },
            close: function () {
                E.fireTouch("touchend", [], [E.touch(id, c[0], c[1])]);
            }
        };
    }

    function pinchShape(id) {
        var left = c[0] - 60, right = c[0] + 60;
        return {
            open: function () {
                E.fireTouch("touchstart", [E.touch(id, left, c[1])], [E.touch(id, left, c[1])]);
                E.fireTouch("touchstart", [E.touch(id, left, c[1]), E.touch(id + 1, right, c[1])],
                    [E.touch(id + 1, right, c[1])]);
            },
            advance: function () {
                right += 0.5;
                var a = E.touch(id, left, c[1]), b = E.touch(id + 1, right, c[1]);
                E.fireTouch("touchmove", [a, b], [b]);
            },
            close: function () {
                E.fireTouch("touchend", [E.touch(id, left, c[1])], [E.touch(id + 1, right, c[1])]);
                E.fireTouch("touchend", [], [E.touch(id, left, c[1])]);
            }
        };
    }

    // Mouse equivalents, for the non-touch run. Rotation arrives through d3.drag's mouse
    // handlers and zoom through the wheel listener; both were changed, and neither is
    // exercised by any touch gesture, so a desktop cost would be invisible without these.
    function dragShape() {
        return {
            open: function () { E.fireMouse("mousedown", c[0], c[1]); },
            advance: function (n) { E.fireMouse("mousemove", c[0] + n * 4, c[1], window); },
            close: function () { E.fireMouse("mouseup", c[0], c[1], window); }
        };
    }

    // A trackpad delivers wheel events far faster than a frame, which is the case the
    // coalescing is meant to help and therefore the one that has to be shown not to hurt.
    // The deltas alternate so a long burst cannot drift into the zoom clamp, where the
    // scale would stop changing and the draws would stop being comparable work.
    function wheelShape() {
        var n = 0;
        return {
            open: function () {},
            advance: function () { E.fireWheel((++n % 2) ? -4 : 4); },
            close: function () {}
        };
    }

    function run(shape, fn, name) { return fn(name, shape.open, shape.advance, shape.close); }

    E.trace("perf: initial settle");
    await E.settle(90000);
    await E.nudge();

    if (E.params().input === "mouse") {
        await run(dragShape(), gesture, "drag-1s");
        await run(wheelShape(), gesture, "wheel-1s");
        await run(dragShape(), burst, "drag-burst");
        await run(wheelShape(), burst, "wheel-burst");
        await run(dragShape(), latency, "drag-latency");
        await run(wheelShape(), latency, "wheel-latency");
    }
    else {
        // Every rotate case runs before any pinch case, and that ordering is load-bearing.
        // On the baseline build a pinch whose first finger lifts last leaves `pinching` set
        // for good — the bug this change fixes — and while it is set the drag handler
        // returns early and the globe stops being redrawn at all. Interleaved, the rotate
        // cases after a pinch measured a frozen baseline: zero repaints and zero latency,
        // which the comparison then read as the baseline being *faster* than a build that
        // actually draws. Rotate first, and every rotate number comes from a working globe
        // on both builds.
        await run(rotateShape(11), gesture, "rotate-1s");
        await run(rotateShape(31), burst, "rotate-burst");
        await run(rotateShape(51), latency, "rotate-latency");
        await run(pinchShape(21), gesture, "pinch-1s");
        await run(pinchShape(41), burst, "pinch-burst");
    }

    results.finalZoom = E.hashState().zoom;
    E.report(results);
}

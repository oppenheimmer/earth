// Injected before any page script. Provides the pieces every suite needs — a deterministic
// wall clock, synthetic input, canvas signatures, settle detection — and nothing specific
// to one suite. Suites append themselves and call E.report(...) when done.
//
// Everything here is ES5-plain on purpose: it is concatenated with the suite and shipped as
// one Page.addScriptToEvaluateOnNewDocument source, so a parse error anywhere kills the
// whole run before the app even boots.
var E = (function () {
    "use strict";

    // ---------------------------------------------------------------------------------
    // Deterministic wall clock, split by how the app asks the time.
    //
    // `new Date()` is pinned. sunlight.js takes the instant to shade for that way
    // (sunTime in beginFrame), so leaving it real moved the terminator between the
    // baseline run and the head run and every RealView pixel differed for reasons that
    // are not a regression — measured at 5-7 counts of summed channel difference per
    // canvas, enough to change a hash.
    //
    // `Date.now()` keeps advancing. Every use of it in the app is a *delta*: the
    // interpolation and render batchers compare it against MAX_TASK_TIME to decide when
    // to yield, and previewOverlayThrottled gates on 40 ms between readings. Freezing it
    // would make the batchers never yield and the drag preview never paint again — the
    // suite would be measuring a machine that does not exist.
    var FIXED_NOW = 1787000000000;      // 2026-08-16 05:33 UTC, an arbitrary fixed instant
    var RealDate = Date;
    var startedAt = RealDate.now();

    function FakeDate() {
        if (arguments.length === 0) return new RealDate(FIXED_NOW);
        if (arguments.length === 1) return new RealDate(arguments[0]);
        return new RealDate(RealDate.UTC.apply(RealDate, arguments) +
            new RealDate(0).getTimezoneOffset() * 60000);
    }
    FakeDate.now = function () { return FIXED_NOW + (RealDate.now() - startedAt); };

    /**
     * Move the pinned instant. sunlight.js draws for whatever `new Date()` says when
     * beginFrame latches it, so stepping the clock and forcing a render is how the sun's
     * *motion* becomes testable at all — otherwise the suite only ever sees one sun, and a
     * terminator that had stopped moving would look identical to one that moves correctly.
     * Deltas stay real: only the origin moves.
     */
    function setNow(ms) {
        FIXED_NOW = ms;
        startedAt = RealDate.now();
    }
    function now() { return FIXED_NOW; }
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    window.Date = FakeDate;

    // ---------------------------------------------------------------------------------
    // Deterministic pseudo-randomness.
    //
    // The particle engine seeds every particle's position and age from Math.random, which
    // is why the other suites can only assert that #animation has ink in it. Replacing the
    // generator with a seeded one — before any page script runs, so the app never sees the
    // real one — makes the trails reproducible: identical spawn points, identical steps,
    // identical respawns on both builds. The physics suite compares them frame by frame on
    // that basis. Nothing in the app depends on randomness being unpredictable; wind.js is
    // the only caller, in field.randomize and the particle seeding loop.
    //
    // mulberry32: small, fast, and good enough that a stuck or short-period generator
    // cannot be mistaken for a physics change.
    var SEED = 0x9e3779b9;
    Math.random = (function (a) {
        return function () {
            a = (a + 0x6d2b79f5) | 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), 1 | t);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    })(SEED);

    // ---------------------------------------------------------------------------------
    // Map repaint counter. drawMap() issues exactly one clearRect on #map, so counting
    // those counts repaints — the one number that says how much work a gesture caused,
    // measurable identically on both builds.
    var repaints = 0;
    var lastRepaintAt = 0;
    var lastDrawDoneAt = 0;
    var proto = CanvasRenderingContext2D.prototype;
    var realClearRect = proto.clearRect;
    proto.clearRect = function () {
        if (this.canvas && this.canvas.id === "map") {
            repaints++;
            lastRepaintAt = performance.now();
        }
        return realClearRect.apply(this, arguments);
    };

    // When a repaint *finished*, not when it started.
    //
    // clearRect is drawMap's first act, so timing input-to-clearRect measures how soon the
    // draw begins. That flatters a synchronous draw enormously: it starts inside the event
    // handler, at nearly zero, and then blocks for tens of milliseconds finishing — work the
    // viewer waits through but the number never counts. drawMap's last act is the lake
    // stroke on #lines, so the most recent stroke on that canvas is when the frame was
    // actually ready, and input-to-ready is the latency a person experiences.
    var realStroke = proto.stroke;
    proto.stroke = function () {
        var out = realStroke.apply(this, arguments);
        if (this.canvas && this.canvas.id === "lines") lastDrawDoneAt = performance.now();
        return out;
    };

    // ---------------------------------------------------------------------------------
    // Helpers

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    /**
     * One animation frame, or `timeoutMs` — whichever comes first. The fallback is not
     * belt-and-braces: a page kept busy enough stops being served frames at all, and a bare
     * requestAnimationFrame await then never settles. That is how the speed suite used to
     * fail — no result, no partial numbers, just the runner's 240 s timeout and a report
     * with nothing in it. Resolving false instead lets the suite record what it measured
     * and say the frame never came.
     */
    var FRAME_TIMEOUT_MS = 2000;
    function frame(timeoutMs) {
        return new Promise(function (r) {
            var settled = false;
            function finish(value) { if (!settled) { settled = true; r(value); } }
            requestAnimationFrame(function () { finish(true); });
            setTimeout(function () { finish(false); }, timeoutMs || FRAME_TIMEOUT_MS);
        });
    }
    function el(id) { return document.getElementById(id); }
    function trace(step) { window.__probeTrace = step; }

    function params() {
        return JSON.parse(window.__probeParams || "{}");
    }

    /** FNV-1a over a pixel buffer: a small stable number that changes if any pixel does. */
    function hashBytes(bytes) {
        var h = 0x811c9dc5;
        for (var i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
        }
        return h;
    }

    /** Pixel fingerprint of one canvas, plus enough detail to localise a difference. */
    function canvasSignature(id) {
        var canvas = el(id);
        var ctx = canvas.getContext("2d");
        var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        var ink = 0, sum = 0;
        for (var i = 0; i < data.length; i += 4) {
            if (data[i + 3] !== 0) ink++;
            sum += data[i] + data[i + 1] + data[i + 2] + data[i + 3];
        }
        return {hash: hashBytes(data), ink: ink, sum: sum, w: canvas.width, h: canvas.height};
    }

    /**
     * A cheap change detector for settle(), sampling evenly spaced full-width rows instead
     * of the whole canvas. canvasSignature reads every pixel, which at a dpr-3 phone
     * viewport is a 13.6 MB getImageData — 217 ms measured, three canvases per poll, two
     * and a half polls a second. That is not just slow: it is a large, uneven load applied
     * to the page *while the speed suite is trying to measure the page*, which the numbers
     * then include. Rows are enough to notice anything still moving, and cost ~1% of it.
     */
    var SETTLE_ROWS = 24;
    function settleHash(id) {
        var canvas = el(id);
        var ctx = canvas.getContext("2d");
        var h = 0x811c9dc5;
        for (var r = 0; r < SETTLE_ROWS; r++) {
            var y = Math.floor((r + 0.5) * canvas.height / SETTLE_ROWS);
            var row = ctx.getImageData(0, y, canvas.width, 1).data;
            for (var i = 0; i < row.length; i += 4) {
                h ^= row[i] + row[i + 1] + row[i + 2] + row[i + 3];
                h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
            }
        }
        return h;
    }

    /** Projected sphere diameter in CSS px, read off #map's opaque fill. ∝ projection.scale(). */
    function sphereDiameter() {
        var canvas = el("map");
        var row = canvas.getContext("2d").getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
        var first = -1, last = -1;
        for (var x = 0; x < canvas.width; x++) {
            if (row[x * 4 + 3] === 0) continue;
            if (first < 0) first = x;
            last = x;
        }
        var dpr = window.devicePixelRatio || 1;
        return first < 0 ? 0 : Math.round((last - first + 1) / dpr);
    }

    function hashState() {
        var q = new URLSearchParams(location.hash.slice(1));
        var rotate = (q.get("rotate") || "").split(",");
        return {
            layer: q.get("layer"),
            zoom: q.get("zoom") === null ? null : +q.get("zoom"),
            lon: rotate.length > 1 ? +rotate[0] : null,
            lat: rotate.length > 1 ? +rotate[1] : null
        };
    }

    // ---------------------------------------------------------------------------------
    // Synthetic input

    function display() { return el("display"); }
    function surface() { return el("lines"); }   // topmost canvas: what a finger actually hits

    function touch(id, x, y) {
        return new Touch({identifier: id, target: surface(), clientX: x, clientY: y});
    }
    function fireTouch(type, touches, changed) {
        surface().dispatchEvent(new TouchEvent(type, {
            touches: touches, targetTouches: touches, changedTouches: changed,
            bubbles: true, cancelable: true, view: window
        }));
    }
    function fireMouse(type, x, y, node) {
        (node || surface()).dispatchEvent(new MouseEvent(type, {
            clientX: x, clientY: y, bubbles: true, cancelable: true, view: window, buttons: 1
        }));
    }
    function fireWheel(deltaY) {
        surface().dispatchEvent(new WheelEvent("wheel", {deltaY: deltaY, bubbles: true, cancelable: true}));
    }

    function centre() { return [window.innerWidth / 2, window.innerHeight / 2]; }

    // ---------------------------------------------------------------------------------
    // Settle detection: the app is done when the status line is clear and the three
    // deterministic canvases stop changing. #animation is excluded — it is seeded from
    // Math.random and never repeats.
    var STABLE_POLLS = 3;
    var POLL_MS = 400;

    function loaded() {
        var date = el("data-date"), label = el("data-label");
        return !!date && (date.textContent.trim().length > 5 ||
            /Blue Marble|NASA|GEBCO/i.test(label.textContent));
    }

    async function settle(maxMs) {
        var deadline = performance.now() + (maxMs || 60000);
        trace("waiting for load");
        while (performance.now() < deadline && !loaded()) await sleep(100);

        trace("waiting for settle");
        var previous = null, stable = 0;
        while (performance.now() < deadline) {
            await sleep(POLL_MS);
            var status = el("status").textContent.trim();
            var now = settleHash("map") + ":" + settleHash("overlay") + ":" + settleHash("lines");
            stable = (now === previous && status === "") ? stable + 1 : 0;
            previous = now;
            if (stable >= STABLE_POLLS) return true;
        }
        return false;
    }

    /**
     * A no-op wheel event: startManipulation + scale × exp(0) + scheduleRecompute, so the
     * hash gets written without moving the view. Gives the suites a "before" reading of
     * layer/rotate/zoom on a page that has not been touched yet.
     */
    async function nudge() {
        fireWheel(0);
        await sleep(600);
    }

    function report(value) {
        trace("done");
        window.__probeResult = value;
    }

    return {
        sleep: sleep, frame: frame, el: el, trace: trace, params: params,
        canvasSignature: canvasSignature, settleHash: settleHash,
        sphereDiameter: sphereDiameter, hashState: hashState,
        touch: touch, fireTouch: fireTouch, fireMouse: fireMouse, fireWheel: fireWheel,
        display: display, surface: surface, centre: centre,
        settle: settle, nudge: nudge, report: report,
        setNow: setNow, now: now, FIXED_NOW: FIXED_NOW,
        repaints: function () { return repaints; },
        resetRepaints: function () { repaints = 0; lastDrawDoneAt = 0; },
        lastRepaintAt: function () { return lastRepaintAt; },
        lastDrawDoneAt: function () { return lastDrawDoneAt; }
    };
})();

// Every suite runs after the app has booted, never during parse.
window.addEventListener("load", function () {
    setTimeout(function () {
        if (typeof runSuite === "function") {
            runSuite().catch(function (err) {
                E.report({error: String(err && err.stack || err)});
            });
        }
    }, 0);
});

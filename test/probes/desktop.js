// Non-touch suite. The same interactions as the touch suite, on a desktop-shaped viewport
// with touch emulation off, because the paths are not the same code: rotation arrives
// through d3.drag's mouse handlers and zoom through the wheel listener, and both of those
// were changed. A phone-shaped run cannot stand in for this one — it reaches the mouse
// path with maxTouchPoints > 0 and mobile emulation on, which is a browser the desktop
// user never has.
//
// Cases marked `strict` carry a detail that must be *identical* on both builds, not merely
// passing. That is what catches the failure mode this change could plausibly have: a
// manipulation frame that lands after the gesture's full-detail redraw would leave the
// globe drawn from the low-detail meshes, which still "works" and still passes every
// verdict, while quietly rendering a coarser coastline than the baseline does.
async function runSuite() {
    var cases = [];
    var WAIT_SETTLE_MS = 800;          // past scheduleRecompute's 200 ms, with room to spare

    function record(name, detail, pass, strict) {
        cases.push({name: name, pass: !!pass, detail: detail, strict: !!strict});
    }

    function zoom() { return E.hashState().zoom; }
    function rotation() { var s = E.hashState(); return [s.lon, s.lat]; }
    function round(n) { return Math.round(n * 1000) / 1000; }
    function moved(pair) {
        return Math.abs(pair.after[0] - pair.before[0]) > 0.5 ||
               Math.abs(pair.after[1] - pair.before[1]) > 0.5;
    }

    /** A press-drag-release along (dx, dy), delivered one step at a time like a real mouse. */
    async function mouseDrag(dx, dy, steps) {
        var c = E.centre();
        var before = rotation();
        E.fireMouse("mousedown", c[0], c[1]);
        for (var i = 1; i <= steps; i++) {
            await E.sleep(40);
            E.fireMouse("mousemove", c[0] + dx * i / steps, c[1] + dy * i / steps, window);
        }
        await E.sleep(40);
        E.fireMouse("mouseup", c[0] + dx, c[1] + dy, window);
        await E.sleep(WAIT_SETTLE_MS);
        return {before: before, after: rotation()};
    }

    async function wheel(times, deltaY) {
        for (var i = 0; i < times; i++) {
            E.fireWheel(deltaY);
            await E.sleep(30);
        }
        await E.sleep(WAIT_SETTLE_MS);
        return zoom();
    }

    // ---------------------------------------------------------------------------------
    E.trace("initial settle");
    await E.settle(90000);
    await E.nudge();

    // The premise of the suite: this really is a machine with no touchscreen, so any touch
    // path is genuinely unreachable here and a mouse regression cannot hide behind one.
    record("viewport is non-touch",
        {maxTouchPoints: navigator.maxTouchPoints, ontouchstart: "ontouchstart" in window,
         width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio},
        navigator.maxTouchPoints === 0);

    var start = E.hashState();
    record("hash write-back", start,
        start.layer !== null && start.zoom !== null && start.lon !== null, true);

    // ---------------------------------------------------------------------------------
    // The deferred-draw race, isolated.
    //
    // A manipulation draw is now scheduled on an animation frame while the settling redraw
    // is on a 200 ms timer, and nothing cancels the first when the second runs. Ordinarily
    // the frame wins by an order of magnitude — 16 ms against 200 ms — but the two only
    // have to be reordered once for the globe to be left drawn from the low-detail meshes
    // until something else touches it. Blocking the main thread past the timer forces
    // exactly that ordering, which is not exotic: it is what a slow phone does whenever a
    // draw overruns, and what any tab does when it is backgrounded mid-gesture.
    //
    // deltaY 0 makes the check airtight. It runs the whole wheel path — startManipulation,
    // a scale multiplied by exp(0), a deferred draw, scheduleRecompute — and leaves the
    // projection exactly where it was, so the globe afterwards must be pixel-for-pixel the
    // globe before. Anything that differs is which draw ran last, and nothing else.
    E.trace("stale manipulation frame");
    await E.settle(60000);
    var beforeRace = {map: E.canvasSignature("map").hash, lines: E.canvasSignature("lines").hash};

    E.fireWheel(0);
    var holdUntil = performance.now() + 400;
    while (performance.now() < holdUntil) { /* hold the thread past the 200 ms recompute */ }

    var settledRace = await E.settle(60000);
    var afterRace = {map: E.canvasSignature("map").hash, lines: E.canvasSignature("lines").hash};
    record("no stale low-detail frame after a blocked gesture", {
        settled: settledRace,
        mapSame: afterRace.map === beforeRace.map,
        linesSame: afterRace.lines === beforeRace.lines
    }, settledRace && afterRace.map === beforeRace.map && afterRace.lines === beforeRace.lines, true);

    // The same hazard, made deterministic.
    //
    // Blocking the main thread leaves the reordering up to the scheduler, which on this
    // machine happens to run the held frame before the expired timer — so that case passes
    // without ever exercising the bug. Holding the animation frame directly does not depend
    // on scheduler luck: the callback is released after the 200 ms recompute has already
    // redrawn at full detail, which is precisely the order a backgrounded tab produces, and
    // a slow phone produces whenever a draw overruns its frame.
    //
    // deltaY 0 again, so the projection never moves and the only thing that can change the
    // globe is which draw ran last.
    E.trace("starved manipulation frame");
    await E.settle(60000);
    var beforeStarve = {map: E.canvasSignature("map").hash, lines: E.canvasSignature("lines").hash};

    // Both halves of the pair have to be replaced together. Stubbing only the request side
    // hands the app a setTimeout id and leaves the real cancelAnimationFrame to be called
    // with it, which silently does nothing — the held callback fires regardless and the case
    // fails whether or not the app cancels correctly. That is a broken emulation, not a
    // finding: a real starved tab defers the callback *and* honours a cancel.
    var realRAF = window.requestAnimationFrame;
    var realCancelRAF = window.cancelAnimationFrame;
    window.requestAnimationFrame = function (cb) {
        return setTimeout(function () { cb(performance.now()); }, 600);
    };
    window.cancelAnimationFrame = function (handle) { clearTimeout(handle); };

    E.fireWheel(0);
    await E.sleep(1500);          // recompute lands at 200 ms, the held frame at 600 ms
    window.requestAnimationFrame = realRAF;
    window.cancelAnimationFrame = realCancelRAF;

    var settledStarve = await E.settle(60000);
    var afterStarve = {map: E.canvasSignature("map").hash, lines: E.canvasSignature("lines").hash};
    record("no stale frame when the animation frame is starved", {
        settled: settledStarve,
        mapSame: afterStarve.map === beforeStarve.map,
        linesSame: afterStarve.lines === beforeStarve.lines
    }, settledStarve && afterStarve.map === beforeStarve.map &&
       afterStarve.lines === beforeStarve.lines, true);

    // ---------------------------------------------------------------------------------
    E.trace("mouse drag rotate");
    var horizontal = await mouseDrag(80, 0, 10);
    record("mouse drag rotate", horizontal, moved(horizontal), true);

    // The settled frame after a drag, and the case this whole suite exists for.
    //
    // Manipulation draws are now deferred to an animation frame, so the last one of a
    // gesture races the full-detail redraw that scheduleRecompute fires 200 ms later. Lose
    // that race and the globe is left drawn from the low-detail meshes — coastLo instead of
    // coastHi — which is a real degradation that every pass/fail verdict in this file would
    // sail straight past. The mesh choice is worth thousands of pixels of coastline, so
    // comparing the settled signature against the baseline's catches it precisely.
    //
    // Settling first is not optional: the recompute is still interpolating 800 ms after the
    // gesture, and a signature taken mid-interpolation differs between two runs of the
    // *same* build, which would make this case flag noise as a regression.
    var settledAfterDrag = await E.settle(60000);
    var afterDrag = {
        map: E.canvasSignature("map"),
        lines: E.canvasSignature("lines"),
        diameter: E.sphereDiameter()
    };
    record("post-drag redraw", {
        settled: settledAfterDrag,
        mapHash: afterDrag.map.hash, mapInk: afterDrag.map.ink,
        linesHash: afterDrag.lines.hash, linesInk: afterDrag.lines.ink,
        diameter: afterDrag.diameter
    }, settledAfterDrag && afterDrag.lines.ink > 0 && afterDrag.map.ink > 0, true);

    // startManipulation clears the trails and cancels the animation; the recompute is what
    // starts them again. If a gesture ever left the globe without particles, nothing else
    // here would notice — the map would still be drawn and every interaction still work.
    record("animation resumes after a gesture",
        {ink: E.canvasSignature("animation").ink > 0},
        E.canvasSignature("animation").ink > 0);

    E.trace("mouse drag vertical");
    var vertical = await mouseDrag(0, 60, 10);
    record("mouse drag tilt", vertical, moved(vertical), true);

    // ---------------------------------------------------------------------------------
    // A press and release that never moves is a click, and a press that wanders less than
    // the 3 px jitter deadzone must stay one: the readout is the only way to inspect a
    // value, and losing it to a trembling hand would be a regression nothing else catches.
    E.trace("click readout");
    var readout = E.el("location");
    var c = E.centre();
    readout.textContent = "__cleared__";
    E.fireMouse("mousedown", c[0], c[1]);
    await E.sleep(60);
    E.fireMouse("mouseup", c[0], c[1], window);
    await E.sleep(600);
    record("click readout", {text: readout.textContent.trim()},
        readout.textContent !== "__cleared__", true);

    E.trace("jitter stays a click");
    var beforeJitter = rotation();
    readout.textContent = "__cleared__";
    E.fireMouse("mousedown", c[0], c[1]);
    await E.sleep(40);
    E.fireMouse("mousemove", c[0] + 2, c[1] + 1, window);   // 2.2 px: inside the deadzone
    await E.sleep(40);
    E.fireMouse("mouseup", c[0] + 2, c[1] + 1, window);
    await E.sleep(600);
    record("sub-3px jitter stays a click",
        {rotation: beforeJitter + " -> " + rotation(), text: readout.textContent.trim()},
        !moved({before: beforeJitter, after: rotation()}) && readout.textContent !== "__cleared__",
        true);

    // Latitude is clamped to ±90 in the drag handler; a long upward drag must stop there
    // rather than rolling the globe over. Left until after the readout cases, which want a
    // latitude where a click lands on ordinary ground rather than on the pole.
    E.trace("latitude clamp");
    var extreme = await mouseDrag(0, -900, 20);
    record("latitude clamped to ±90",
        {lat: extreme.after[1], within: Math.abs(extreme.after[1]) <= 90},
        Math.abs(extreme.after[1]) <= 90, true);

    // ---------------------------------------------------------------------------------
    E.trace("wheel zoom");
    var beforeWheel = zoom();
    var zoomedIn = await wheel(5, -120);
    var zoomedOut = await wheel(5, 120);
    record("wheel zoom in", {from: beforeWheel, to: zoomedIn}, zoomedIn > beforeWheel * 1.05, true);
    record("wheel zoom out", {from: zoomedIn, to: zoomedOut},
        zoomedOut < zoomedIn * 0.95 && Math.abs(zoomedOut - beforeWheel) < beforeWheel * 0.1, true);

    // The wheel path defers its draw exactly as the drag path does, and settles through the
    // same scheduleRecompute, so it can lose the same race independently of any drag.
    var settledAfterWheel = await E.settle(60000);
    var afterWheel = {map: E.canvasSignature("map"), lines: E.canvasSignature("lines")};
    record("post-wheel redraw", {
        settled: settledAfterWheel,
        mapHash: afterWheel.map.hash, mapInk: afterWheel.map.ink,
        linesHash: afterWheel.lines.hash, linesInk: afterWheel.lines.ink,
        diameter: E.sphereDiameter()
    }, settledAfterWheel && afterWheel.lines.ink > 0 && afterWheel.map.ink > 0, true);

    E.trace("zoom clamps");
    var atMax = await wheel(45, -120);
    record("zoom clamped at MAX_ZOOM", {zoom: atMax, want: 64}, atMax === 64, true);

    // The sphere must actually be the size the zoom claims. A zoom that writes the hash
    // without moving the projection would pass every numeric case above.
    var zoomedDiameter = E.sphereDiameter();
    record("zoom moves the projection",
        {zoom: atMax, diameter: zoomedDiameter, baseDiameter: afterDrag.diameter},
        zoomedDiameter > afterDrag.diameter, true);

    var atMin = await wheel(70, 120);
    record("zoom clamped at 0.5x", {zoom: atMin, want: 0.5}, atMin === 0.5, true);

    // ---------------------------------------------------------------------------------
    E.trace("layer switch");
    var beforeScale = E.el("scale-label").textContent.trim();
    var beforeOverlay = E.canvasSignature("overlay").hash;
    var button = document.querySelector('.layer[data-layer="temperature"]');
    if (button) button.click();
    var switched = await E.settle(90000);
    var afterScale = E.el("scale-label").textContent.trim();

    record("layer switch via menu", {
        scale: beforeScale + " -> " + afterScale,
        layer: E.hashState().layer,
        overlayRepainted: E.canvasSignature("overlay").hash !== beforeOverlay,
        settled: switched
    }, switched && afterScale !== beforeScale && E.hashState().layer === "temperature" &&
       E.canvasSignature("overlay").hash !== beforeOverlay);

    E.report({
        cases: cases,
        passed: cases.filter(function (t) { return t.pass; }).length,
        total: cases.length
    });
}

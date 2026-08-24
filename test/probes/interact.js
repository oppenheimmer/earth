// Functionality suite. Every case records raw numbers as well as a verdict: the verdict
// catches something that is outright broken, and the numbers let the runner catch a build
// that still "works" while doing something subtly different from the baseline.
async function runSuite() {
    var cases = [];
    var WAIT_SETTLE_MS = 800;          // past scheduleRecompute's 200 ms, with room to spare
    var PINCH_STEPS = 16;
    var PINCH_SPREAD = 120;

    function record(name, detail, pass) {
        cases.push({name: name, pass: !!pass, detail: detail});
    }

    function zoom() { return E.hashState().zoom; }
    function rotation() { var s = E.hashState(); return [s.lon, s.lat]; }

    // ---------------------------------------------------------------------------------
    // Pinch. `moved` selects which fingers appear in changedTouches — the axis the whole
    // bug lived on, since d3.drag consumes any event carrying a touch it still owns.
    // `liftLast` selects which finger leaves the glass last.
    async function pinch(moved, liftLast, factor) {
        var c = E.centre();
        var half = PINCH_SPREAD / 2;
        var left = c[0] - half, right = c[0] + half;
        var step = (PINCH_SPREAD * (factor - 1) / 2) / PINCH_STEPS;
        var before = zoom();

        E.fireTouch("touchstart", [E.touch(1, left, c[1])], [E.touch(1, left, c[1])]);
        await E.sleep(40);
        E.fireTouch("touchstart", [E.touch(1, left, c[1]), E.touch(2, right, c[1])],
            [E.touch(2, right, c[1])]);

        for (var i = 0; i < PINCH_STEPS; i++) {
            await E.sleep(40);
            left -= step;
            right += step;
            var a = E.touch(1, left, c[1]), b = E.touch(2, right, c[1]);
            var changed = moved === "both" ? [a, b] : moved === "second" ? [b] : [a];
            E.fireTouch("touchmove", [a, b], changed);
        }

        await E.sleep(40);
        var stay = liftLast === 1 ? E.touch(1, left, c[1]) : E.touch(2, right, c[1]);
        var goes = liftLast === 1 ? E.touch(2, right, c[1]) : E.touch(1, left, c[1]);
        E.fireTouch("touchend", [stay], [goes]);
        E.fireTouch("touchend", [], [stay]);
        await E.sleep(WAIT_SETTLE_MS);

        var after = zoom();
        var got = after / before;
        record("pinch moved=" + moved + " liftLast=" + liftLast,
            {want: round(factor), got: round(got), zoom: before + "->" + after},
            Math.abs(got - factor) < 0.05);
        return got;
    }

    async function touchRotate(id) {
        var c = E.centre();
        var before = rotation();
        E.fireTouch("touchstart", [E.touch(id, c[0], c[1])], [E.touch(id, c[0], c[1])]);
        for (var i = 1; i <= 10; i++) {
            await E.sleep(40);
            E.fireTouch("touchmove", [E.touch(id, c[0] + i * 8, c[1])], [E.touch(id, c[0] + i * 8, c[1])]);
        }
        await E.sleep(40);
        E.fireTouch("touchend", [], [E.touch(id, c[0] + 80, c[1])]);
        await E.sleep(WAIT_SETTLE_MS);
        return {before: before, after: rotation()};
    }

    async function mouseRotate() {
        var c = E.centre();
        var before = rotation();
        E.fireMouse("mousedown", c[0], c[1]);
        for (var i = 1; i <= 10; i++) {
            await E.sleep(40);
            E.fireMouse("mousemove", c[0] + i * 8, c[1], window);
        }
        await E.sleep(40);
        E.fireMouse("mouseup", c[0] + 80, c[1], window);
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

    function round(n) { return Math.round(n * 1000) / 1000; }
    function moved(pair) {
        return Math.abs(pair.after[0] - pair.before[0]) > 0.5 ||
               Math.abs(pair.after[1] - pair.before[1]) > 0.5;
    }

    // ---------------------------------------------------------------------------------
    E.trace("initial settle");
    await E.settle(90000);
    await E.nudge();                        // establishes layer/rotate/zoom in the hash

    var start = E.hashState();
    record("hash write-back", start, start.layer !== null && start.zoom !== null && start.lon !== null);

    E.trace("pinch: both fingers move");
    await pinch("both", 2, 1.6);
    await pinch("both", 2, 0.625);           // back to where it started

    E.trace("pinch: first finger only");
    await pinch("first", 2, 1.6);
    await pinch("first", 2, 0.625);

    E.trace("pinch: second finger only, finger 1 lifts last");
    await pinch("second", 1, 1.6);

    // The lift above is the one that used to leave `pinching` set for good. If it did,
    // nothing below that needs a drag can work.
    E.trace("rotate after pinch");
    var afterPinch = await touchRotate(7);
    record("touch rotate after pinch", afterPinch, moved(afterPinch));
    await pinch("second", 2, 0.625);

    E.trace("touch rotate");
    var byTouch = await touchRotate(8);
    record("touch rotate", byTouch, moved(byTouch));

    E.trace("mouse rotate");
    var byMouse = await mouseRotate();
    record("mouse drag rotate", byMouse, moved(byMouse));

    E.trace("tap readout");
    var readout = E.el("location");
    readout.textContent = "__cleared__";
    var c = E.centre();
    E.fireTouch("touchstart", [E.touch(9, c[0], c[1])], [E.touch(9, c[0], c[1])]);
    await E.sleep(60);
    E.fireTouch("touchend", [], [E.touch(9, c[0], c[1])]);
    await E.sleep(600);
    record("tap readout", {text: readout.textContent.trim()}, readout.textContent !== "__cleared__");

    E.trace("wheel zoom");
    var beforeWheel = zoom();
    var zoomedIn = await wheel(5, -120);
    var zoomedOut = await wheel(5, 120);
    record("wheel zoom in", {from: beforeWheel, to: zoomedIn}, zoomedIn > beforeWheel * 1.05);
    record("wheel zoom out", {from: zoomedIn, to: zoomedOut},
        zoomedOut < zoomedIn * 0.95 && Math.abs(zoomedOut - beforeWheel) < beforeWheel * 0.1);

    E.trace("zoom clamps");
    var atMax = await wheel(45, -120);
    var atMin = await wheel(70, 120);
    record("zoom clamped at MAX_ZOOM", {zoom: atMax, want: 64}, atMax === 64);
    record("zoom clamped at 0.5x", {zoom: atMin, want: 0.5}, atMin === 0.5);

    // data-label is deliberately not the observable here: a scalar layer over GFS wind
    // carries no `credit` of its own, so Temperature inherits Surface's exactly. The scale
    // legend and the overlay pixels are what a switch has to move.
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

import assert from "node:assert/strict";
import {test} from "node:test";
import {spawnSync} from "node:child_process";
import {BUILDERS} from "./lib/suites.mjs";
import {judge, judgeTracking, judgeAcuity} from "./lib/metrics.mjs";

function run() {
    const gesture = {events: 60, repaints: 60, repaintsPerEvent: 1, repaintsPerFrame: 1,
        repaintsPerSecond: 60, framesObserved: 60, fps: 60, medianFrameGapMs: 16,
        worstFrameGapMs: 20, elapsedMs: 1000};
    const burst = {events: 8, repaints: 1, blockingMs: 2};
    const latency = {samples: 12, medianMs: 16, worstMs: 20,
        completeSamples: 12, completeMedianMs: 17, completeWorstMs: 21};
    return structuredClone({"rotate-1s": gesture, "pinch-1s": gesture,
        "rotate-burst": burst, "pinch-burst": burst, "rotate-latency": latency, finalZoom: 4});
}

function row() {
    return {view: "phone", repeats: 3, baseline: [run(), run(), run()], head: [run(), run(), run()]};
}

test("complete unchanged performance measurements pass", () => {
    assert.equal(BUILDERS.speed([row()]).bad, 0);
});

for (const [name, change] of [
    ["all timeouts", r => { r.baseline = r.baseline.map(() => ({error: "timeout"})); }],
    ["one failed repeat", r => { r.head[1] = {error: "timeout"}; }],
    ["insufficient repeats", r => { r.head.pop(); }],
    ["empty cases", r => { r.baseline = [{}, {}, {}]; r.head = [{}, {}, {}]; }],
    ["missing case", r => { delete r.head[2]["rotate-1s"]; }],
    ["missing metric in both builds", r => {
        for (const sample of [...r.baseline, ...r.head]) delete sample["rotate-1s"].fps;
    }],
    ["null metric", r => { r.head[0]["rotate-1s"].fps = null; }],
    ["NaN metric", r => { r.head[0]["rotate-1s"].fps = NaN; }],
    ["infinite metric", r => { r.head[0]["rotate-1s"].fps = Infinity; }],
    ["no completed latency samples", r => { r.head[0]["rotate-latency"].completeSamples = 0; }]
]) {
    test(`performance gate fails on ${name}`, () => {
        const sample = row(); change(sample);
        const result = BUILDERS.speed([sample]);
        assert.ok(result.bad > 0, result.summary);
        assert.match(result.body.join("\n"), /ERROR|WORSE/);
    });
}

test("empty result sets fail", () => assert.ok(BUILDERS.speed([]).bad > 0));
test("a later view cannot silently fail", () => {
    const broken = row(); broken.head = [{error: "timeout"}];
    assert.ok(BUILDERS.speed([row(), broken]).bad > 0);
});
test("an explicitly requested single repeat is supported", () => {
    const sample = row(); sample.repeats = 1;
    sample.baseline.length = sample.head.length = 1;
    assert.equal(BUILDERS.speed([sample]).bad, 0);
});
test("missing values cannot be identical measurements", () => {
    assert.equal(judge("fps", null, null).verdict, "ERROR");
    assert.equal(judgeTracking(null, null).verdict, "ERROR");
    assert.equal(judgeAcuity(null, null).verdict, "ERROR");
});
test("invalid repeat counts are rejected before running", () => {
    for (const count of ["0", "-1", "1.5", "NaN"]) {
        const env = {...process.env};
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath,
            ["test/run.mjs", "speed", "--list", "--repeats", count], {encoding: "utf8", env});
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, count);
        assert.match(result.stderr, /positive integer/);
    }
});

test("an unmatched suite filter cannot report a successful run", () => {
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath,
        ["test/run.mjs", "speed", "-k", "no-such-view"], {encoding: "utf8", env});
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /no suites selected/);
});

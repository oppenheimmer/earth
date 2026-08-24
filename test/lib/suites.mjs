// The suite catalogue and the comparison strategy for each kind of measurement.
//
// A suite is: a probe, a set of views, and the device each view is opened on. Devices are
// per-view rather than per-suite because the interesting comparisons are often the same
// measurement on two machines — the resolution suite exists precisely to put a desktop and
// a phone side by side, and before profiles existed it could not have.
import {DESKTOP, DESKTOP_HIDPI, PHONE, TABLET, PHONE_NO_UA} from "./devices.mjs";
import {
    PERF_METRICS, judge, judgeTracking, judgeAcuity,
    medianOf, fmt, table, same
} from "./metrics.mjs";

export const PERF_REPEATS = 3;

// Layer families that take different paths through drawMap: wireframe, scalar overlay,
// ocean land-fill + hatch, crest particles, and the three renderer plug-in layers.
// Rotation is pinned so nothing depends on the machine's timezone.
const RENDER_VIEWS = [
    {name: "surface z1", hash: "layer=surface&rotate=-80,-15&zoom=1"},
    {name: "surface z8", hash: "layer=surface&rotate=-8,-50&zoom=8"},
    {name: "temperature z1", hash: "layer=temperature&rotate=-80,-15&zoom=1"},
    {name: "ocean450 z2", hash: "layer=ocean450&rotate=-5,-54&zoom=2"},
    {name: "waves z1", hash: "layer=waves&rotate=-30,-40&zoom=1"},
    {name: "daylight z1", hash: "layer=daylight&rotate=-80,-15&zoom=1"},
    {name: "nightlights z1", hash: "layer=nightlights&rotate=-80,-15&zoom=1"},
    {name: "relief z1", hash: "layer=relief&rotate=-80,-15&zoom=1"}
];

// Particle families that take different paths through animate(): GFS wind, an ocean current
// (its own velocity scale and multiplier), and the wave layers' crest mode. Wind is measured
// at two zooms because the per-frame step is scaled by zoom.
const PHYSICS_LAYERS = [
    {name: "surface z1", hash: "layer=surface&rotate=-80,-15&zoom=1"},
    {name: "surface z8", hash: "layer=surface&rotate=-8,-50&zoom=8"},
    {name: "ocean450 z2", hash: "layer=ocean450&rotate=-5,-54&zoom=2"},
    {name: "waves z1", hash: "layer=waves&rotate=-30,-40&zoom=1"}
];

/** Same views, tagged with the device they run on, so a row names both. */
function on(device, views) {
    return views.map((v) => ({...v, device, name: `${v.name} · ${device.name}`}));
}

export const SUITES = {
    render: {
        title: "Rendering — desktop",
        kind: "render",
        probe: "render.js",
        device: DESKTOP,
        views: RENDER_VIEWS,
        page: {timeoutMs: 180000},
        repeats: 1
    },

    // The same pixel identity check on a real phone. isMobile() is true here, so this is the
    // only render suite that exercises the halved texture cap, the skipped deep-zoom tier
    // and the reduced particle count — the desktop suite cannot reach any of them.
    renderMobile: {
        title: "Rendering — mobile",
        kind: "render",
        probe: "render.js",
        device: PHONE,
        views: RENDER_VIEWS,
        page: {timeoutMs: 180000},
        repeats: 1
    },

    resolution: {
        title: "Rendering resolution",
        kind: "resolution",
        probe: "resolution.js",
        device: DESKTOP,
        views: [
            ...on(DESKTOP, [RENDER_VIEWS[0], RENDER_VIEWS[5], RENDER_VIEWS[7]]),
            ...on(DESKTOP_HIDPI, [RENDER_VIEWS[5]]),
            ...on(PHONE, [RENDER_VIEWS[0], RENDER_VIEWS[5], RENDER_VIEWS[7]]),
            ...on(TABLET, [RENDER_VIEWS[5]]),
            // The old "mobile" profile — phone metrics, desktop UA — kept as the control
            // that shows what the UA is worth. Its numbers are what every previous mobile
            // report was actually measuring.
            ...on(PHONE_NO_UA, [RENDER_VIEWS[5]])
        ],
        page: {timeoutMs: 180000, captureNetwork: true},
        repeats: 1
    },

    functionality: {
        title: "Functionality — touch viewport",
        kind: "cases",
        probe: "interact.js",
        device: PHONE,
        views: [{name: "surface", hash: "layer=surface&rotate=-80,-15&zoom=1"}],
        page: {timeoutMs: 240000},
        repeats: 1
    },

    // The same interactions with touch emulation off, on a desktop-shaped viewport. Mouse
    // rotation and wheel zoom are separate code from anything a finger reaches.
    desktop: {
        title: "Functionality — non-touch viewport",
        kind: "cases",
        probe: "desktop.js",
        device: DESKTOP,
        views: [{name: "surface", hash: "layer=surface&rotate=-80,-15&zoom=1"}],
        page: {timeoutMs: 300000},
        repeats: 1
    },

    physics: {
        title: "Particle physics",
        kind: "physics",
        probe: "physics.js",
        device: DESKTOP,
        views: [
            ...on(DESKTOP, PHYSICS_LAYERS),
            // Mobile takes PARTICLE_REDUCTION and a different dpr multiplier, so the
            // particle count, spacing and trail width are all different code paths.
            ...on(PHONE, [PHYSICS_LAYERS[0], PHYSICS_LAYERS[3]])
        ],
        page: {timeoutMs: 180000},
        repeats: 1
    },

    sunphysics: {
        title: "Sunlight motion physics",
        kind: "sun",
        probe: "sunphysics.js",
        device: DESKTOP,
        views: [
            {name: "daylight · desktop", hash: "layer=daylight&rotate=0,0&zoom=1", device: DESKTOP},
            {name: "nightlights · desktop", hash: "layer=nightlights&rotate=90,20&zoom=1", device: DESKTOP},
            {name: "relief · desktop", hash: "layer=relief&rotate=0,0&zoom=2", device: DESKTOP},
            {name: "daylight · phone", hash: "layer=daylight&rotate=0,0&zoom=1", device: PHONE},
            {name: "relief · phone", hash: "layer=relief&rotate=0,0&zoom=2", device: PHONE}
        ],
        page: {timeoutMs: 240000},
        repeats: 1
    },

    // No CPU throttling, and that is a measured decision. Emulation.setCPUThrottlingRate does
    // not turn this page into a slower phone, it turns it into a page that stops running: at
    // rate 2 the tab served 4 animation frames in 38 s and a 3-second timer fired 37.8 s
    // late, where rate 1 gave 76 frames in 3.0 s with the timer on time. The suite used to
    // ask for rate 4, under which the probe never reached its last two cases and the runner
    // gave up at 240 s with no numbers at all.
    speed: {
        title: "Speed — touch viewport",
        kind: "speed",
        probe: "perf.js",
        device: PHONE,
        views: [{name: "surface z4", hash: "layer=surface&rotate=-80,-15&zoom=4"}],
        page: {timeoutMs: 300000},
        repeats: PERF_REPEATS
    },

    speedDesktop: {
        title: "Speed — non-touch viewport",
        kind: "speed",
        probe: "perf.js",
        device: DESKTOP,
        views: [{name: "surface z4", hash: "layer=surface&rotate=-80,-15&zoom=4", input: "mouse"}],
        page: {timeoutMs: 300000},
        repeats: PERF_REPEATS
    }
};

// Verdicts meaning the head build is worse than the baseline, or cannot be shown not to be.
const BROKEN = ["REGRESSED", "MISSING", "ERROR", "NEW FAIL", "STILL FAILING", "DIFFERS", "SOFTER"];

// ---------------------------------------------------------------------------------------
// Comparison strategies

function compareRender(rows) {
    return rows.map(({view, baseline, head}) => {
        const a = baseline[0], b = head[0];
        if (a.error || b.error) return {view, verdict: "ERROR", note: a.error || b.error};

        const canvases = ["map", "overlay", "lines"];
        const differing = canvases.filter((c) => a[c].hash !== b[c].hash);
        const notes = [];

        if (!a.settled || !b.settled) notes.push(`did not settle (baseline ${a.settled}, head ${b.settled})`);
        if (a.animationInk > 0 && b.animationInk === 0) notes.push("particle trails vanished");
        if (a.diameter !== b.diameter) notes.push(`sphere ${a.diameter} -> ${b.diameter}px`);
        for (const key of ["label", "date", "scale"]) {
            if (a.dom[key] !== b.dom[key]) notes.push(`${key}: "${a.dom[key]}" -> "${b.dom[key]}"`);
        }
        for (const c of differing) {
            notes.push(`#${c} hash differs (ink ${a[c].ink} -> ${b[c].ink}, sum ${a[c].sum} -> ${b[c].sum})`);
        }

        const clean = !differing.length && !notes.length;
        return {view, verdict: clean ? "IDENTICAL" : differing.length ? "PIXELS CHANGED" : "CHANGED",
                note: notes.join("; ")};
    });
}

function compareCases(rows) {
    const a = rows[0].baseline[0], b = rows[0].head[0];
    if (a.error || b.error) return [{name: "suite", verdict: "ERROR", note: a.error || b.error}];

    const byName = (list) => new Map(list.map((c) => [c.name, c]));
    const before = byName(a.cases), after = byName(b.cases);
    const names = [...new Set([...before.keys(), ...after.keys()])];

    return names.map((name) => {
        const x = before.get(name), y = after.get(name);
        if (!y) return {name, verdict: "MISSING", note: "case absent from head run"};
        if (!x) return {name, verdict: y.pass ? "NEW PASS" : "NEW FAIL", note: JSON.stringify(y.detail)};
        if (x.pass && !y.pass) return {name, verdict: "REGRESSED", note: `${JSON.stringify(x.detail)}  ->  ${JSON.stringify(y.detail)}`};
        if (!x.pass && y.pass) return {name, verdict: "FIXED", note: `${JSON.stringify(x.detail)}  ->  ${JSON.stringify(y.detail)}`};
        if (!x.pass && !y.pass) return {name, verdict: "STILL FAILING", note: JSON.stringify(y.detail)};
        // A case can pass on both builds and still not be the same behaviour. Where the probe
        // marked it `strict`, the recorded numbers have to match too.
        if ((x.strict || y.strict) && !same(x.detail, y.detail)) {
            return {name, verdict: "DIFFERS", note: `${JSON.stringify(x.detail)}  ->  ${JSON.stringify(y.detail)}`};
        }
        return {name, verdict: "PASS", note: JSON.stringify(y.detail)};
    });
}

function comparePhysics(rows) {
    const FRAME_KEYS = ["segments", "strokes", "buckets", "lenMedian", "lenP95", "lenMax",
        "lenMean", "travel", "centroid"];

    return rows.map(({view, baseline, head}) => {
        const a = baseline[0], b = head[0];
        if (a.error || b.error) return {view, frames: "—", verdict: "ERROR", note: a.error || b.error};

        const notes = [];
        if (!a.frameCount || !b.frameCount) {
            notes.push(`animation drew no frames (baseline ${a.frameCount}, head ${b.frameCount})`);
        }
        if (a.animationInk > 0 && b.animationInk === 0) notes.push("particle trails vanished");

        const ca = a.constants || {}, cb = b.constants || {};
        for (const key of ["fade", "lineWidth", "rect"]) {
            if (!same(ca[key], cb[key])) {
                notes.push(`${key}: ${JSON.stringify(ca[key])} -> ${JSON.stringify(cb[key])}`);
            }
        }
        if (!same(a.styles, b.styles)) {
            notes.push(`intensity colour ramp changed (${(a.styles || []).length} -> ${(b.styles || []).length} buckets)`);
        }

        const frames = Math.min((a.frames || []).length, (b.frames || []).length);
        let differing = 0, first = null;
        for (let i = 0; i < frames; i++) {
            const changed = FRAME_KEYS.filter((k) => !same(a.frames[i][k], b.frames[i][k]));
            if (!changed.length) continue;
            differing++;
            if (!first) first = {i, changed};
        }
        if (first) {
            const k = first.changed[0];
            notes.push(`${differing}/${frames} frames differ; first at frame ${first.i} in ` +
                `${first.changed.join(", ")} (${k} ${JSON.stringify(a.frames[first.i][k])} -> ` +
                `${JSON.stringify(b.frames[first.i][k])})`);
        }
        return {view, frames, verdict: notes.length ? "CHANGED" : "IDENTICAL", note: notes.join("; ")};
    });
}

/** Texture files a build fetched, by the grid in their filename — the resolution tier. */
function texturesOf(result) {
    return (result.__network || [])
        .map((q) => q.url.split("/").pop())
        .filter((f) => /bluemarble|blackmarble|elevation-gebco/.test(f))
        .sort();
}

function compareResolution(rows) {
    return rows.map(({view, baseline, head}) => {
        const a = baseline[0], b = head[0];
        if (a.error || b.error) {
            return {view, verdict: "ERROR", energy: "—", change: "—", note: a.error || b.error};
        }

        const notes = [];
        if (!a.settled || !b.settled) notes.push(`did not settle (${a.settled} -> ${b.settled})`);

        // Which branch the build actually took. A profile that stopped satisfying isMobile()
        // would silently change every resolution decision below it.
        if (a.device.isMobileUA !== b.device.isMobileUA) {
            notes.push(`isMobile ${a.device.isMobileUA} -> ${b.device.isMobileUA}`);
        }

        // Backing-store pixels per CSS pixel, per canvas: the geometric half of resolution.
        for (const id of ["map", "overlay", "animation", "lines"]) {
            const g = a.geometry[id], h = b.geometry[id];
            if (!same(g.backing, h.backing) || g.scale !== h.scale) {
                notes.push(`#${id} ${g.backing.join("x")}@${g.scale} -> ${h.backing.join("x")}@${h.scale}`);
            }
        }
        if (a.discDevicePx !== b.discDevicePx) {
            notes.push(`globe ${a.discDevicePx} -> ${b.discDevicePx} device px`);
        }

        const before = texturesOf(a), after = texturesOf(b);
        if (!same(before, after)) notes.push(`textures ${before.join(",") || "none"} -> ${after.join(",") || "none"}`);

        // The acuity half: gradient energy inside the globe on the overlay.
        const ea = a.acuity.overlay ? a.acuity.overlay.energy : null;
        const eb = b.acuity.overlay ? b.acuity.overlay.energy : null;
        const acuity = judgeAcuity(ea, eb);

        for (const id of ["map", "lines"]) {
            const x = a.acuity[id], y = b.acuity[id];
            if (!x || !y) continue;
            const v = judgeAcuity(x.energy, y.energy);
            if (v.verdict === "SOFTER") notes.push(`#${id} acuity ${x.energy} -> ${y.energy} (${v.change})`);
        }

        const verdict = notes.length ? (acuity.verdict === "SOFTER" ? "SOFTER" : "CHANGED") : acuity.verdict;
        return {
            view,
            verdict,
            energy: `${fmt(ea)} -> ${fmt(eb)}`,
            change: acuity.change,
            note: notes.join("; ")
        };
    });
}

/** Numeric closeness for the pixel-derived sun measures, which carry float noise. */
function near(x, y, tol) {
    if (typeof x !== "number" || typeof y !== "number") return same(x, y);
    return Math.abs(x - y) <= tol;
}

function compareSunPhysics(rows) {
    return rows.map(({view, baseline, head}) => {
        const a = baseline[0], b = head[0];
        if (a.error || b.error) return {view, samples: "—", verdict: "ERROR", note: a.error || b.error};

        const notes = [];
        if (!a.hasRenderer || !b.hasRenderer) {
            notes.push(`renderer missing (baseline ${a.hasRenderer}, head ${b.hasRenderer})`);
        }
        if (a.overlayScale !== b.overlayScale) notes.push(`overlayScale ${a.overlayScale} -> ${b.overlayScale}`);
        if (a.tick !== b.tick) notes.push(`tick ${a.tick} -> ${b.tick}`);
        if (a.isMobileUA !== b.isMobileUA) notes.push(`isMobile ${a.isMobileUA} -> ${b.isMobileUA}`);

        const n = Math.min((a.samples || []).length, (b.samples || []).length);
        for (let i = 0; i < n; i++) {
            const x = a.samples[i], y = b.samples[i];

            // Analytic: the sun's elevation at fixed coordinates. Same maths, same instant —
            // these must agree exactly, and any drift is a change to the position model.
            if (!same(x.elevations, y.elevations)) {
                const ex = (x.elevations || []).findIndex((e, k) => !same(e, (y.elevations || [])[k]));
                const at = ex >= 0 ? JSON.stringify(x.elevations[ex].at) : "?";
                notes.push(`+${x.hours}h sun elevation differs at ${at}: ` +
                    `${JSON.stringify(ex >= 0 ? x.elevations[ex] : null)} -> ` +
                    `${JSON.stringify(ex >= 0 ? (y.elevations || [])[ex] : null)}`);
                continue;
            }

            // Rendered: how much of the disc is lit, and where its brightness sits.
            const p = x.lit, q = y.lit;
            if (!p || !q) { notes.push(`+${x.hours}h lit profile missing`); continue; }
            if (!near(p.meanLuma, q.meanLuma, 0.5)) notes.push(`+${x.hours}h meanLuma ${p.meanLuma} -> ${q.meanLuma}`);
            for (const key of ["litFraction60", "litFraction120", "litFraction180"]) {
                if (!near(p[key], q[key], 0.005)) notes.push(`+${x.hours}h ${key} ${p[key]} -> ${q[key]}`);
            }
            if (p.centroid && q.centroid) {
                if (!near(p.centroid[0], q.centroid[0], 0.005) || !near(p.centroid[1], q.centroid[1], 0.005)) {
                    notes.push(`+${x.hours}h brightness centroid ${JSON.stringify(p.centroid)} -> ${JSON.stringify(q.centroid)}`);
                }
            }
        }

        // The motion itself: how far the sun moved between instants, not where it was.
        const m = Math.min((a.motion || []).length, (b.motion || []).length);
        for (let i = 0; i < m; i++) {
            const x = a.motion[i], y = b.motion[i];
            if (!same(x.dAltitudes, y.dAltitudes)) {
                notes.push(`${x.from}h->${x.to}h elevation change differs: ` +
                    `${JSON.stringify(x.dAltitudes)} -> ${JSON.stringify(y.dAltitudes)}`);
            }
            if (!near(x.dLitFraction60, y.dLitFraction60, 0.005)) {
                notes.push(`${x.from}h->${x.to}h lit-fraction change ${x.dLitFraction60} -> ${y.dLitFraction60}`);
            }
        }

        return {view, samples: n, verdict: notes.length ? "CHANGED" : "IDENTICAL", note: notes.join("; ")};
    });
}

function comparePerf(rows) {
    const a = rows[0].baseline.filter((r) => !r.error);
    const b = rows[0].head.filter((r) => !r.error);
    if (!a.length || !b.length) {
        return [{metric: "suite", verdict: "ERROR", note: "no successful run on one of the builds"}];
    }

    const cases = Object.keys(a[0]).filter((k) => typeof a[0][k] === "object" && a[0][k] && !Array.isArray(a[0][k]));
    const out = [];

    for (const name of cases) {
        for (const metric of Object.keys(PERF_METRICS)) {
            if (!(metric in a[0][name])) continue;
            const before = medianOf(a.map((r) => r[name][metric]));
            const after = medianOf(b.map((r) => r[name][metric]));
            out.push({metric: `${name}.${metric}`, before, after, ...judge(metric, before, after)});
        }
        // A latency case that never saw a repaint has no latency to report; its zeros are
        // absence of data, not speed. Say so rather than letting them average in.
        if ("samples" in a[0][name]) {
            const beforeN = medianOf(a.map((r) => r[name].samples));
            const afterN = medianOf(b.map((r) => r[name].samples));
            if (!beforeN || !afterN) {
                out.push({metric: `${name}.samples`, before: beforeN, after: afterN,
                    verdict: !afterN ? "WORSE" : "BASELINE IDLE",
                    change: !afterN ? "no repaint observed on head" : "no repaint observed on baseline"});
            }
        }
        if ("repaintsPerFrame" in a[0][name]) {
            const before = medianOf(a.map((r) => r[name].repaintsPerFrame));
            const after = medianOf(b.map((r) => r[name].repaintsPerFrame));
            out.push({metric: `${name}.repaintsPerFrame`, before, after, ...judgeTracking(before, after)});
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------
// Report sections

export const BUILDERS = {
    render(data) {
        const rows = compareRender(data);
        const bad = rows.filter((r) => r.verdict !== "IDENTICAL");
        return {
            status: bad.length ? `${bad.length} view(s) changed` : "all views identical",
            bad: bad.length,
            body: [
                "Pixel fingerprint of #map, #overlay and #lines on the settled view. #animation",
                "is compared frame by frame in the particle-physics section instead, and is only",
                "asserted here to still carry ink.",
                "",
                table(["view", "verdict", "notes"], rows.map((r) => [r.view, r.verdict, r.note || "—"]))
            ],
            summary: bad.length ? `${bad.length}/${rows.length} views CHANGED`
                                : `${rows.length}/${rows.length} views identical`
        };
    },

    cases(data) {
        const rows = compareCases(data);
        const broke = rows.filter((r) => BROKEN.includes(r.verdict));
        const fixed = rows.filter((r) => r.verdict === "FIXED");
        return {
            status: `${rows.length - broke.length}/${rows.length} ok, ${fixed.length} fixed, ${broke.length} regressed`,
            bad: broke.length,
            body: [table(["case", "verdict", "baseline -> head"],
                rows.map((r) => [r.name, r.verdict, r.note || "—"]))],
            summary: `${rows.length - broke.length}/${rows.length} ok, ${fixed.length} fixed, ${broke.length} regressed`
        };
    },

    resolution(data) {
        const rows = compareResolution(data);
        const softer = rows.filter((r) => r.verdict === "SOFTER");
        const other = rows.filter((r) => !["SOFTER", "SAME", "SAME (within noise)", "SHARPER"].includes(r.verdict));
        const sharper = rows.filter((r) => r.verdict === "SHARPER");
        return {
            status: softer.length ? `${softer.length} view(s) SOFTER`
                : other.length ? `${other.length} view(s) changed`
                : sharper.length ? `${sharper.length} sharper, rest unchanged`
                : "all views at full resolution",
            bad: softer.length + other.length,
            body: [
                "What actually reaches the glass, on each device profile: backing-store pixels",
                "per CSS pixel, which texture masters were fetched, and gradient energy inside",
                "the globe. Energy is the acuity number — upscaling a smaller source lowers it",
                "while leaving brightness and coverage untouched, so it catches a softer render",
                "that no pixel-count check would notice.",
                "",
                table(["view", "overlay acuity", "change", "verdict", "notes"],
                    rows.map((r) => [r.view, r.energy, r.change || "—", r.verdict, r.note || "—"]))
            ],
            summary: softer.length ? `${softer.length}/${rows.length} views SOFTER`
                                   : `${rows.length}/${rows.length} views at full resolution`
        };
    },

    physics(data) {
        const rows = comparePhysics(data);
        const bad = rows.filter((r) => r.verdict !== "IDENTICAL");
        return {
            status: bad.length ? `${bad.length} layer(s) changed` : "all layers identical",
            bad: bad.length,
            body: [
                "Every trail segment the engine draws, frame by frame, with Math.random seeded",
                "so the particle stream is reproducible: identical spawn points, steps and",
                "respawns on both builds. Compared exactly — segment count, step length",
                "distribution, intensity buckets, trail centroid, fade alpha and line width.",
                "",
                table(["layer", "frames", "verdict", "notes"],
                    rows.map((r) => [r.view, r.frames, r.verdict, r.note || "—"]))
            ],
            summary: bad.length ? `${bad.length}/${rows.length} layers CHANGED`
                                : `${rows.length}/${rows.length} layers identical`
        };
    },

    sun(data) {
        const rows = compareSunPhysics(data);
        const bad = rows.filter((r) => r.verdict !== "IDENTICAL");
        return {
            status: bad.length ? `${bad.length} view(s) changed` : "all views identical",
            bad: bad.length,
            body: [
                "The sun's position and the globe it lights, sampled at +0h, +3h, +6h and +12h",
                "from a pinned instant. Two independent observables: sunlight.js's own",
                "readout() elevation at fixed coordinates — the position maths with no pixels",
                "in it — and the lit fraction and brightness centroid of the rendered disc.",
                "Consecutive differences are compared too, so the sun's motion is checked and",
                "not merely one of its poses.",
                "",
                table(["view", "samples", "verdict", "notes"],
                    rows.map((r) => [r.view, r.samples, r.verdict, r.note || "—"]))
            ],
            summary: bad.length ? `${bad.length}/${rows.length} views CHANGED`
                                : `${rows.length}/${rows.length} views identical`
        };
    },

    speed(data) {
        const rows = comparePerf(data);
        const worse = rows.filter((r) => r.verdict === "WORSE");
        const better = rows.filter((r) => r.verdict === "BETTER");
        const body = [table(["metric", "baseline", "head", "change", "verdict"],
            rows.map((r) => [r.metric, fmt(r.before), fmt(r.after), r.change || "—", r.verdict]))];

        if (worse.length) {
            body.push("", "**Flagged as worse**", "");
            for (const r of worse) body.push(`- **${r.metric}**: ${fmt(r.before)} -> ${fmt(r.after)} (${r.change})`);
        }
        return {
            status: `${better.length} better, ${worse.length} worse, ${rows.length - better.length - worse.length} unchanged`,
            bad: worse.length,
            body,
            summary: `${better.length} better, ${worse.length} worse, ${rows.length - better.length - worse.length} unchanged`
        };
    }
};

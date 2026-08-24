// Statistics and verdicts: how a pair of measurements becomes a judgement.
//
// Separated from the suite catalogue because the two change for different reasons — a new
// view or a new device is a catalogue edit, while "is this number worse" is a question about
// measurement, and mixing them is how a tolerance ends up quietly different in two places.

// A perf number moving by less than this is noise on a shared machine, not a change.
export const PERF_TOLERANCE = 0.25;

// Direction of goodness for every speed metric, so a regression can be told from a win.
export const PERF_METRICS = {
    repaints: "lower",
    repaintsPerEvent: "lower",
    repaintsPerSecond: "higher",
    framesObserved: "higher",
    fps: "higher",
    medianFrameGapMs: "lower",
    worstFrameGapMs: "lower",
    blockingMs: "lower",
    medianMs: "lower",
    worstMs: "lower",
    completeMedianMs: "lower",
    completeWorstMs: "lower"
};

/**
 * Metrics that count work done. A zero here does not mean "infinitely fast", it means
 * nothing was drawn — which is what a frozen globe looks like from the outside. Comparing
 * such a baseline arithmetically rated a build that draws as *worse* than one that had
 * stopped, so a zero baseline gets its own verdict instead of a ratio.
 */
const DRAW_COUNTERS = new Set([
    "repaints", "repaintsPerEvent", "repaintsPerSecond", "framesObserved", "fps"
]);

/**
 * One repaint per displayed frame is what coalescing is for; the baseline drew per event and
 * sits above 1. Below this the globe is no longer being redrawn on the frames it is shown
 * on, and scoring that as an improvement because the repaint count fell is the specific
 * mistake this floor exists to prevent.
 */
export const TRACKING_FLOOR = 0.5;

export function medianOf(values) {
    const sorted = values.filter((v) => typeof v === "number").sort((x, y) => x - y);
    return sorted.length ? sorted[sorted.length >> 1] : null;
}

export function percentChange(before, after) {
    if (before === 0) return "n/a";
    const ratio = after / before;
    return `${(ratio - 1) * 100 > 0 ? "+" : ""}${((ratio - 1) * 100).toFixed(0)}%`;
}

export function judge(metric, before, after) {
    const better = PERF_METRICS[metric];
    if (before === after) return {verdict: "SAME", change: "0%"};
    if (before === null || after === null) return {verdict: "ERROR", change: "missing"};

    if (DRAW_COUNTERS.has(metric) && before === 0 && after > 0) {
        return {verdict: "BASELINE IDLE", change: `0 -> ${after}`};
    }
    if (DRAW_COUNTERS.has(metric) && after === 0 && before > 0) {
        return {verdict: "WORSE", change: `${before} -> 0 — stopped drawing`};
    }

    const ratio = before === 0 ? (after === 0 ? 1 : Infinity) : after / before;
    const change = percentChange(before, after);
    const improved = better === "lower" ? after < before : after > before;

    if (Math.abs(ratio - 1) <= PERF_TOLERANCE) return {verdict: "SAME (within noise)", change};
    return {verdict: improved ? "BETTER" : "WORSE", change};
}

/**
 * repaintsPerFrame has a good *value*, not a good direction — see TRACKING_FLOOR.
 */
export function judgeTracking(before, after) {
    if (before === after) return {verdict: "SAME", change: "0%"};
    if (after === null) return {verdict: "WORSE", change: "no frames served"};
    const change = percentChange(before, after);
    if (after < TRACKING_FLOOR && before >= TRACKING_FLOOR) {
        return {verdict: "WORSE", change: `${change} — stopped tracking`};
    }
    if (Math.abs(after - 1) < Math.abs(before - 1) - 0.05) return {verdict: "BETTER", change};
    if (Math.abs(after - 1) > Math.abs(before - 1) + 0.05) return {verdict: "WORSE", change};
    return {verdict: "SAME (within noise)", change};
}

/**
 * Acuity — gradient energy inside the globe — is a resolution measure, and the project's
 * standing rule is that resolution may improve but never drop. A tighter band than the speed
 * tolerance: this number is computed from the same pixels on both builds with the clock and
 * the generator pinned, so it is nearly deterministic, and a real drop of a few per cent is a
 * real drop rather than jitter.
 */
export const ACUITY_TOLERANCE = 0.02;

export function judgeAcuity(before, after) {
    if (before === after) return {verdict: "SAME", change: "0%"};
    if (!before || after === null || after === undefined) return {verdict: "ERROR", change: "missing"};
    const change = percentChange(before, after);
    const ratio = after / before;
    if (Math.abs(ratio - 1) <= ACUITY_TOLERANCE) return {verdict: "SAME (within noise)", change};
    return {verdict: ratio > 1 ? "SHARPER" : "SOFTER", change};
}

export function fmt(value) {
    if (value === null || value === undefined) return "—";
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
    return String(value);
}

export function table(header, rows) {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
    const line = (cells) => "| " + cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join(" | ") + " |";
    return [line(header), "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|", ...rows.map(line)].join("\n");
}

/** Deep structural equality via canonical JSON — enough for the flat records probes emit. */
export function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

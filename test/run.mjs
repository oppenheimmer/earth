// Test runner. Collects suites, runs them against a baseline ref, prints once, exits 0/1.
//
//   node test/run.mjs                      every suite
//   node test/run.mjs render physics       named suites, like pytest paths
//   node test/run.mjs -k mobile            only items whose name matches
//   node test/run.mjs --list               collect without running
//   node test/run.mjs -v                   show passing detail too
//   node test/run.mjs --ref Release-v1.0   compare against another tag
//
// Nothing is written to disk. The whole point of the comparison is the moment you read it —
// a checked-in report is a claim about a working tree that has since moved on, and the one
// that used to be written here said "no regressions found" while holding the results of a
// single suite. Pipe it if you want to keep it: `node test/run.mjs > /tmp/run.txt`.
//
// The baseline is served from a throwaway worktree of the ref, so both builds run from their
// own unmodified files; probes are injected over CDP and never touch either tree.
import {execFile} from "node:child_process";
import {promises as fs} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {launch} from "./lib/browser.mjs";
import {serve} from "./lib/serve.mjs";
import {SUITES, BUILDERS} from "./lib/suites.mjs";
import {PERF_TOLERANCE, ACUITY_TOLERANCE} from "./lib/metrics.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WORKTREE = "/tmp/earth-test-baseline";

const HELP = `earth regression suite

usage: node test/run.mjs [suite ...] [options]

  suite ...          suites to run (default: all). Names from --list.

  -k EXPR            run only items whose name contains EXPR
  --ref REF          baseline git ref (default: newest Release-* tag)
  --repeats N        override repeat count for timing suites
  --list             collect only; print what would run
  -v, --verbose      print detail tables for passing suites too
  -q, --quiet        summary line only
  --json             print raw measurements as JSON instead of tables
  -x, --exitfirst    stop after the first failing suite
  -h, --help         this

exit status is 0 when every suite passes, 1 when any fails, 2 on error.`;

function parseArgs(argv) {
    const opts = {suites: [], k: null, ref: null, repeats: null, list: false,
                  verbose: false, quiet: false, json: false, exitFirst: false};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-h" || a === "--help") return {...opts, help: true};
        else if (a === "--list") opts.list = true;
        else if (a === "-v" || a === "--verbose") opts.verbose = true;
        else if (a === "-q" || a === "--quiet") opts.quiet = true;
        else if (a === "--json") opts.json = true;
        else if (a === "-x" || a === "--exitfirst") opts.exitFirst = true;
        else if (a === "-k") opts.k = argv[++i];
        else if (a.startsWith("-k=")) opts.k = a.slice(3);
        else if (a === "--ref") opts.ref = argv[++i];
        else if (a.startsWith("--ref=")) opts.ref = a.slice(6);
        else if (a === "--repeats") opts.repeats = Number(argv[++i]);
        else if (a.startsWith("--repeats=")) opts.repeats = Number(a.slice(10));
        else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
        else opts.suites.push(a);
    }
    return opts;
}

/**
 * Which suites and views actually run, after names and -k are applied. Returned as plain
 * data so --list can print exactly what a real run would do, and never diverge from it.
 */
function collect(opts) {
    const unknown = opts.suites.filter((name) => !(name in SUITES));
    if (unknown.length) {
        throw new Error(`unknown suite(s): ${unknown.join(", ")}\navailable: ${Object.keys(SUITES).join(", ")}`);
    }

    const chosen = Object.entries(SUITES)
        .filter(([name]) => !opts.suites.length || opts.suites.includes(name));

    const out = [];
    for (const [name, spec] of chosen) {
        const views = spec.views.filter((v) =>
            !opts.k || `${name} ${v.name}`.toLowerCase().includes(opts.k.toLowerCase()));
        if (!views.length) continue;
        const repeats = opts.repeats && spec.repeats > 1 ? opts.repeats : spec.repeats;
        out.push({name, spec, views, repeats, items: views.length * repeats * 2});
    }
    return out;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(HELP); return 0; }

    const plan = collect(opts);
    if (!plan.length) { console.log("no suites selected"); return 0; }

    const items = plan.reduce((n, s) => n + s.items, 0);

    if (opts.list) {
        console.log(`collected ${plan.length} suite(s), ${items} item(s)\n`);
        for (const {name, spec, views, repeats} of plan) {
            console.log(`${name}  — ${spec.title}`);
            for (const v of views) {
                const device = (v.device || spec.device).name;
                console.log(`    ${v.name}  [${device}]${repeats > 1 ? ` x${repeats}` : ""}`);
            }
        }
        return 0;
    }

    const ref = opts.ref || await newestReleaseTag();
    const baselineRoot = await prepareWorktree(ref);
    const servers = {
        baseline: await serve(join(baselineRoot, "public")),
        head: await serve(join(REPO, "public"))
    };
    const browser = await launch();

    if (!opts.quiet) {
        console.log(`baseline: ${ref}   browser: ${browser.version}`);
        console.log(`collected ${plan.length} suite(s), ${items} item(s)\n`);
    }

    const probes = await loadProbes(plan);
    const results = [];
    const started = Date.now();

    try {
        for (const suite of plan) {
            const collected = await runSuite(suite, probes, browser, servers, opts);
            const built = BUILDERS[suite.spec.kind](collected);
            results.push({...suite, collected, built});
            if (!opts.quiet) printLine(suite, built);
            if (opts.exitFirst && built.bad) break;
        }
    }
    finally {
        await browser.close();
        await servers.baseline.close();
        await servers.head.close();
    }

    if (opts.json) {
        console.log(JSON.stringify({ref, suites: Object.fromEntries(
            results.map((r) => [r.name, r.collected]))}, null, 2));
        return results.some((r) => r.built.bad) ? 1 : 0;
    }

    printReport(results, {ref, opts, seconds: (Date.now() - started) / 1000, ran: plan.length});
    return results.some((r) => r.built.bad) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------
// Output

const PAD = 16;

function printLine(suite, built) {
    const status = built.bad ? "FAILED" : "PASSED";
    console.log(`${suite.name.padEnd(PAD)} ${status}  ${built.summary}`);
}

function rule(label) {
    const width = 78;
    if (!label) return "=".repeat(width);
    const pad = Math.max(0, width - label.length - 2);
    const left = Math.floor(pad / 2);
    return `${"=".repeat(left)} ${label} ${"=".repeat(pad - left)}`;
}

function printReport(results, {ref, opts, seconds, ran}) {
    if (opts.quiet) {
        const failed = results.filter((r) => r.built.bad);
        console.log(`${ran - failed.length} passed, ${failed.length} failed in ${seconds.toFixed(1)}s`);
        return;
    }

    // Detail for anything that failed, and for everything when asked. A passing suite's
    // table is not usually what you opened the terminal for.
    const shown = results.filter((r) => opts.verbose || r.built.bad);
    if (shown.length) {
        console.log("\n" + rule(opts.verbose ? "RESULTS" : "FAILURES"));
        for (const r of shown) {
            console.log(`\n--- ${r.name}: ${r.spec.title} — ${r.built.status}\n`);
            console.log(r.built.body.join("\n"));
        }
    }

    const failed = results.filter((r) => r.built.bad);
    console.log("\n" + rule("summary"));
    for (const r of results) printLine(r, r.built);
    console.log(`\nbaseline ${ref} · speed within ±${PERF_TOLERANCE * 100}% is noise · ` +
        `acuity flagged past ±${ACUITY_TOLERANCE * 100}%`);
    console.log(rule(`${ran - failed.length} passed, ${failed.length} failed in ${seconds.toFixed(1)}s`));
}

// ---------------------------------------------------------------------------------------
// Build preparation

async function newestReleaseTag() {
    const {stdout} = await run("git", ["tag", "--list", "Release-*", "--sort=-v:refname"], {cwd: REPO});
    const tag = stdout.trim().split("\n")[0];
    if (!tag) throw new Error("no Release-* tag to compare against");
    return tag;
}

/**
 * A detached worktree at `ref`, with public/data pointed at the working tree's copy: the
 * weather JSONs and the NASA imagery are git-ignored, so a fresh worktree has none of them
 * and every layer would fail to load. They are identical for both builds by construction —
 * the same files on disk — which is what makes the pixel comparison meaningful.
 */
async function prepareWorktree(ref) {
    await run("git", ["worktree", "remove", "--force", WORKTREE], {cwd: REPO}).catch(() => {});
    await fs.rm(WORKTREE, {recursive: true, force: true});
    await run("git", ["worktree", "add", "--detach", WORKTREE, ref], {cwd: REPO});

    const data = join(WORKTREE, "public", "data");
    await fs.rm(data, {recursive: true, force: true});
    await fs.symlink(join(REPO, "public", "data"), data);
    return WORKTREE;
}

async function loadProbes(plan) {
    const harness = await fs.readFile(join(HERE, "probes", "harness.js"), "utf8");
    const probes = {};
    for (const {name, spec} of plan) {
        probes[name] = harness + "\n" + await fs.readFile(join(HERE, "probes", spec.probe), "utf8");
    }
    return probes;
}

// ---------------------------------------------------------------------------------------
// Execution

async function runSuite({name, spec, views, repeats}, probes, browser, servers, opts) {
    const out = [];

    for (const view of views) {
        const device = view.device || spec.device;
        const row = {view: view.name, device: device.name, baseline: [], head: []};

        for (let pass = 0; pass < repeats; pass++) {
            // Baseline and head are interleaved rather than run in two blocks, so a machine
            // that drifts over the run drifts through both builds equally.
            for (const build of ["baseline", "head"]) {
                const label = `${name}/${view.name}/${build}` + (repeats > 1 ? ` #${pass + 1}` : "");
                if (!opts.quiet) process.stdout.write(`  ${label} ... `);

                const started = Date.now();
                let steps = 0;
                const result = await browser.newPage({
                    ...device.page(spec.page),
                    url: `http://127.0.0.1:${servers[build].port}/#${view.hash}`,
                    preload: `window.__probeParams = ${JSON.stringify(JSON.stringify(view))};\n` + probes[name],
                    // Each step the probe announces, as it announces it, so a suite that
                    // stalls names the case it stalled on instead of only an elapsed time.
                    onProgress: opts.verbose ? (step, ms) => {
                        if (steps++ === 0) process.stdout.write("\n");
                        console.log(`      ${String((ms / 1000).toFixed(0)).padStart(4)}s  ${step}`);
                    } : undefined
                }).catch((err) => ({error: String(err.message || err)}));

                if (steps) process.stdout.write(`  ${label} ... `);
                if (!opts.quiet) {
                    console.log(`${((Date.now() - started) / 1000).toFixed(1)}s${result.error ? "  ERROR" : ""}`);
                }
                row[build].push(result);
            }
        }
        out.push(row);
    }
    return out;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error("\n" + (err.stack || err));
        process.exit(2);
    });

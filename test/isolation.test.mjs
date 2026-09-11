import assert from "node:assert/strict";
import {test} from "node:test";
import {execFile} from "node:child_process";
import {promises as fs} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {promisify} from "node:util";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

async function fixture(t) {
    const temp = await fs.mkdtemp(join(tmpdir(), "earth-isolation-"));
    t.after(() => fs.rm(temp, {recursive: true, force: true}));
    const repo = join(temp, "repo");
    await run("git", ["clone", "--shared", "--no-checkout", ROOT, repo]);
    await fs.cp(join(ROOT, "test"), join(repo, "test"), {recursive: true});
    await fs.mkdir(join(repo, "public", "data"), {recursive: true});
    const scratch = join(temp, "scratch");
    await fs.mkdir(scratch);
    const legacy = join(scratch, "earth-test-baseline");
    await fs.mkdir(legacy);
    await fs.writeFile(join(legacy, "keep"), "another run owns this");
    // Confine the old destructive path to the fixture when reproducing the bug.
    const runner = join(repo, "test", "run.mjs");
    const source = await fs.readFile(runner, "utf8");
    await fs.writeFile(runner, source.replace('"/tmp/earth-test-baseline"', JSON.stringify(legacy)));
    const events = join(temp, "events");
    const log = `import {appendFileSync} from "node:fs";
        const log = (event) => appendFileSync(process.env.EVENTS, JSON.stringify(event) + "\\n");`;
    await fs.writeFile(join(repo, "test/lib/serve.mjs"), log + `
        let count = 0;
        export async function serve(root) {
            if (++count === 2 && process.env.SCENARIO === "server") throw Error("server failed");
            log({open: root});
            return {port: count, close: async () => log({close: root})};
        }`);
    await fs.writeFile(join(repo, "test/lib/browser.mjs"), log + `
        export async function launch() {
            if (process.env.SCENARIO === "browser") throw Error("browser failed");
            return {version: "fixture", newPage: async () => {
                await new Promise(resolve => setTimeout(resolve, 100));
                return {};
            }, close: async () => {
                log({browser: "closed"});
                if (process.env.SCENARIO === "close") throw Error("close failed");
            }};
        }`);
    await fs.writeFile(join(repo, "test/lib/suites.mjs"), `
        export const SUITES = {fixture: {kind: "fixture", repeats: 1,
            device: {name: "fixture", page: () => ({})},
            probe: "physics.js", views: [{name: "fixture", hash: ""}]}};
        export const BUILDERS = {fixture: () => ({bad: 0, summary: "ok"})};`);
    const execute = async (scenario = "success", ref = "HEAD") => {
        const env = {...process.env, TMPDIR: scratch, EVENTS: events, SCENARIO: scenario};
        delete env.NODE_TEST_CONTEXT;
        return run(process.execPath, [runner, "--ref", ref, "--json"],
            {cwd: repo, env, timeout: 15000}).then(() => 0, error => error.code);
    };
    const inspect = async () => {
        assert.equal(await fs.readFile(join(legacy, "keep"), "utf8"), "another run owns this");
        assert.deepEqual(await fs.readdir(scratch), ["earth-test-baseline"]);
        const {stdout} = await run("git", ["worktree", "list", "--porcelain"], {cwd: repo});
        assert.equal(stdout.split("\n").filter(line => line.startsWith("worktree ")).length, 1);
        const entries = (await fs.readFile(events, "utf8").catch(() => ""))
            .trim().split("\n").filter(Boolean).map(JSON.parse);
        assert.deepEqual(entries.filter(e => e.close).map(e => e.close).sort(),
            entries.filter(e => e.open).map(e => e.open).sort());
        return entries;
    };
    return {execute, inspect, repo};
}

test("invalid refs preserve other runs' files", async t => {
    const f = await fixture(t);
    assert.equal(await f.execute("success", "missing-baseline-ref"), 2);
    await f.inspect();
});

for (const scenario of ["success", "browser", "server", "close", "probe"]) {
    test(`runner cleans up after ${scenario}`, async t => {
        const f = await fixture(t);
        if (scenario === "probe") await fs.rm(join(f.repo, "test/probes/physics.js"));
        assert.equal(await f.execute(scenario), scenario === "success" ? 0 : 2);
        await f.inspect();
    });
}

test("concurrent runs own separate worktrees", async t => {
    const f = await fixture(t);
    assert.deepEqual(await Promise.all([f.execute(), f.execute()]), [0, 0]);
    const entries = await f.inspect();
    const baselines = entries.filter(e => e.open && e.open !== join(f.repo, "public"));
    assert.equal(new Set(baselines.map(e => e.open)).size, 2);
});

import assert from "node:assert/strict";
import {test} from "node:test";
import {EventEmitter} from "node:events";
import {promises as fs} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import vm from "node:vm";

const source = (await fs.readFile(new URL("./lib/browser.mjs", import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "").replace(/export /g, "");

async function fixture(t, mode = "enabled", outcome = "ready") {
    const directory = await fs.mkdtemp(join(tmpdir(), "earth-browser-check-"));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const children = [];
    let elapsed = 0;
    // Simulate process/CDP failures without launching a browser or waiting 20 seconds.
    const context = vm.createContext({
        process: {env: mode === "default" ? {} : {EARTH_CHROME_SANDBOX: mode}},
        mkdtemp: fs.mkdtemp, rm: fs.rm, tmpdir: () => directory, join,
        readFile: async () => "9510\n/devtools/browser/fixture\n",
        setTimeout: callback => setTimeout(callback, 1), clearTimeout,
        Date: {now: () => elapsed += 1000},
        fetch: async () => {
            if (outcome === "timeout") throw Error("not ready");
            return {json: async () => ({Browser: "fixture"})};
        },
        spawn: (bin, args, options) => {
            const child = new EventEmitter();
            Object.assign(child, {args, options, exitCode: null, signalCode: null, stderr: new EventEmitter()});
            child.kill = signal => {
                child.signalCode = signal;
                queueMicrotask(() => child.emit("exit", null, signal));
                return true;
            };
            children.push(child);
            queueMicrotask(() => {
                if (outcome === "missing") {
                    child.emit("error", Object.assign(Error("missing"), {code: "ENOENT"}));
                    return;
                }
                child.emit("spawn");
                if (outcome === "exit") {
                    child.stderr.emit("data", "sandbox unavailable");
                    child.exitCode = 1;
                    child.emit("exit", 1, null);
                }
            });
            return child;
        }
    });
    vm.runInContext(source + "\nglobalThis.launchBrowser = launch;", context);
    return {launch: context.launchBrowser, children,
        clean: async () => assert.deepEqual(await fs.readdir(directory), [])};
}

test("browser keeps the sandbox enabled by default and uses its own debugging port", async t => {
    const f = await fixture(t, "default");
    const browser = await f.launch();
    try {
        assert.equal(f.children[0].args.includes("--no-sandbox"), false);
        assert.ok(f.children[0].args.includes("--remote-debugging-port=0"));
    } finally { await browser.close(); }
    await f.clean();
});

test("sandbox disabling requires an explicit setting", async t => {
    const f = await fixture(t, "disabled");
    const browser = await f.launch();
    try { assert.ok(f.children[0].args.includes("--no-sandbox")); }
    finally { await browser.close(); }
    await f.clean();
});

test("Chromium temporary files stay inside its owned profile", async t => {
    const f = await fixture(t);
    const browser = await f.launch();
    try {
        const child = f.children[0];
        const profile = child.args.find(arg => arg.startsWith("--user-data-dir=")).split("=")[1];
        assert.equal(child.options.env?.TMPDIR, profile);
    } finally { await browser.close(); }
    await f.clean();
});

test("invalid sandbox settings fail before launching", async t => {
    const f = await fixture(t, "typo");
    await assert.rejects(f.launch(), /EARTH_CHROME_SANDBOX/);
    assert.equal(f.children.length, 0);
    await f.clean();
});

for (const outcome of ["missing", "exit", "timeout"]) {
    test(`browser cleans up after ${outcome}`, async t => {
        const f = await fixture(t, "enabled", outcome);
        await assert.rejects(f.launch());
        if (outcome === "timeout") assert.equal(f.children[0].signalCode, "SIGKILL");
        await f.clean();
    });
}

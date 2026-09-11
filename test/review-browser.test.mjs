// Exercise the shipped page with controlled responses; no production test hooks.
import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {launch} from "./lib/browser.mjs";
import {serve} from "./lib/serve.mjs";

const root = fileURLToPath(new URL("../public", import.meta.url));
const harness = await readFile(new URL("./probes/harness.js", import.meta.url), "utf8");
let server, browser;

before(async () => {
    server = await serve(root);
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await server?.close();
});

const fixtures = `
const errors = [], requests = [], gates = new Map(), pending = new Map();
addEventListener('error', e => errors.push(e.message));
addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
const originalFetch = window.fetch;
window.fetch = async (url, options) => {
    url = String(url); requests.push(url);
    const key = [...gates.keys()].find(key => url.includes(key));
    if (key) await new Promise(resolve => pending.set(key, resolve));
    if (!url.includes('current-')) return originalFetch(url, options);
    const header = {nx: 4, ny: 3, dx: 90, dy: 90, lo1: 0, la1: 90,
        refTime: '2026-09-11T00:00:00Z', parameterCategory: 2};
    const scalar = /current-(temp|rh|dew|ocean-(temp|wave-height))/.test(url);
    const records = (scalar ? [0] : [2, 3]).map(parameterNumber => ({
        header: {...header, parameterNumber}, data: Array(12).fill(3)
    }));
    return new Response(JSON.stringify(records), {headers: {'Content-Type': 'application/json'}});
};
const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get: imageSrc.get,
    set(url) {
        const key = [...gates.keys()].find(key => String(url).includes(key));
        if (key && this.onload) {
            const callback = this.onload;
            this.onload = event => pending.set(key, () => callback.call(this, event));
        }
        // A tiny image keeps these tests independent of unversioned NASA downloads.
        imageSrc.set.call(this, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=');
    }
});
const append = Node.prototype.appendChild;
Node.prototype.appendChild = function(node) {
    const key = [...gates.keys()].find(key => node.tagName === 'SCRIPT' && node.src.includes(key));
    if (key) { pending.set(key, () => append.call(this, node)); return node; }
    return append.call(this, node);
};
function select(id) { document.dispatchEvent(new CustomEvent('layerchange', {detail: id})); }
function release(key) { gates.delete(key); const done = pending.get(key); pending.delete(key); done(); }
async function until(check) {
    const end = Date.now() + 10000;
    while (!check()) { if (Date.now() > end) throw Error('condition timed out'); await E.sleep(20); }
}
function snapshot() {
    return {title: document.title, credit: E.el('data-label').textContent,
        scale: E.el('scale-label').textContent, status: E.el('status').textContent,
        hash: location.hash, errors: errors.slice()};
}
`;

async function probe(body, extra = "", hash = "layer=surface") {
    const result = await browser.newPage({
        url: `http://127.0.0.1:${server.port}/#${hash}`,
        preload: fixtures + extra + harness + `\nasync function runSuite() { ${body} }`,
        viewport: {width: 640, height: 480, dpr: 1}, timeoutMs: 30000
    });
    assert.equal(result.error, undefined, result.error);
    return result;
}

for (const [name, layer, gate] of [
    ["grid response", "temperature", "current-temp"],
    ["renderer image", "daylight", "bluemarble"],
    ["deferred renderer script", "daylight", "js/sunlight.js"]
]) {
    test(`late ${name} cannot overwrite Ocean`, async () => {
        const result = await probe(`
            await E.settle(10000);
            gates.set('${gate}', true); select('${layer}');
            await until(() => pending.has('${gate}'));
            select('ocean'); await E.settle(10000);
            const before = snapshot(); release('${gate}');
            await E.sleep(600); E.report({before, after: snapshot()});
        `, gate.endsWith('.js') ? `gates.set('${gate}', true);` : "");
        assert.match(result.before.title, /Ocean/);
        assert.deepEqual(result.after, result.before);
    });
}

test("texture construction errors reach the HUD", async () => {
    const result = await probe(`
        await E.sleep(1500); E.report(snapshot());
    `, `
        const readPixels = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function(...args) {
            if (!this.canvas.id && this.canvas.width === 1) throw Error('synthetic texture failure');
            return readPixels.apply(this, args);
        };
    `, "layer=daylight");
    assert.match(result.status, /error: synthetic texture failure/);
    assert.deepEqual(result.errors, []);
});

test("Worker construction refusal falls back to inline mesh loading", async () => {
    const result = await probe(`
        await E.settle(10000); await E.sleep(600);
        E.report({attempted: window.workerAttempted,
            fetched: requests.some(url => url.includes('countries-10m')), ...snapshot()});
    `, `
        window.Worker = class {
            constructor() { window.workerAttempted = true; throw Error('synthetic policy refusal'); }
        };
    `, "layer=surface&zoom=8");
    assert.equal(result.attempted, true);
    assert.equal(result.fetched, true);
    assert.deepEqual(result.errors, []);
});

test("an invalid grid reports an error and can be retried", async () => {
    const result = await probe(`
        await E.settle(10000); window.corruptGrid = true; select('temperature');
        await until(() => E.el('status').textContent.includes('error:'));
        const rejected = snapshot(); window.corruptGrid = false;
        select('ocean'); await E.settle(10000);
        select('temperature'); await E.sleep(600);
        E.report({rejected, retried: snapshot()});
    `, `
        const fixtureFetch = window.fetch;
        window.fetch = async (url, options) => {
            const response = await fixtureFetch(url, options);
            if (!window.corruptGrid || !String(url).includes('current-temp')) return response;
            const records = await response.json(); records[0].header.ny = 0;
            return new Response(JSON.stringify(records));
        };
    `);
    assert.match(result.rejected.status, /error:.*grid/);
    assert.doesNotMatch(result.retried.status, /error:|downloading/);
    assert.match(result.retried.scale, /°C/);
    assert.deepEqual(result.retried.errors, []);
});

for (const layer of ["__proto__", "constructor", "toString"]) {
    test(`inherited layer ${layer} falls back to Surface`, async () => {
        const result = await probe(`await E.sleep(1200); E.report(snapshot());`, "", `layer=${layer}`);
        assert.match(result.title, /Wind @ Surface/);
        assert.deepEqual(result.errors, []);
    });
}

test("custom data URLs survive hash serialization", async () => {
    const original = "https://source.invalid/a&b+c/%23?version=a+b&format=json";
    const result = await probe(`
        await E.settle(10000); E.report({data: new URLSearchParams(location.hash.slice(1)).get('data')});
    `, "", "layer=surface&data=" + encodeURIComponent(original));
    assert.equal(result.data, original);
});

test("custom source attribution shows its actual host", async () => {
    const result = await probe(`
        await E.settle(10000); E.report({...snapshot(), date: E.el('data-date').textContent});
    `, "", "layer=surface&data=" + encodeURIComponent("https://custom.example:8443/weather/"));
    assert.equal(result.credit, "Custom source: custom.example:8443");
    assert.match(result.date, /^Dataset time:/);
});

test("default source attribution is preserved", async () => {
    const result = await probe(`await E.settle(10000); E.report(snapshot());`);
    assert.match(result.credit, /NCEP/);
    assert.doesNotMatch(result.credit, /Custom source/);
});

for (const layer of ["surface", "daylight"]) {
    test(`javascript data source cannot execute through ${layer}`, async () => {
        const result = await probe(`
            await E.sleep(1500); E.report({executed: !!window.executed, ...snapshot()});
        `, `
            window.fetch = originalFetch;
            Object.defineProperty(HTMLImageElement.prototype, 'src', imageSrc);
        `, `layer=${layer}&data=` + encodeURIComponent("javascript:window.executed=true;//"));
        assert.equal(result.executed, false);
        assert.match(result.status, /error:/);
        assert.deepEqual(result.errors, []);
    });
}

test("settle waits for the detailed coastline Worker", async () => {
    const result = await probe(`
        await E.settle(10000); E.report({detailDone: !!window.detailDone});
    `, `
        const RealWorker = window.Worker;
        window.Worker = class extends EventTarget {
            constructor(url) {
                super(); this.inner = new RealWorker(url);
                this.inner.onmessage = event => setTimeout(() => {
                    window.detailDone = true;
                    this.dispatchEvent(new MessageEvent('message', {data: event.data}));
                    if (this.onmessage) this.onmessage(event);
                }, 3000);
                this.inner.onerror = event => {
                    this.dispatchEvent(new Event('error'));
                    if (this.onerror) this.onerror(event);
                };
            }
            postMessage(value) { this.inner.postMessage(value); }
            terminate() { this.inner.terminate(); }
        };
    `, "layer=surface&zoom=8");
    assert.equal(result.detailDone, true);
});

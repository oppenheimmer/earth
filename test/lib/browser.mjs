// Chrome DevTools Protocol driver: everything that knows about sockets, targets and
// emulation lives here, so a suite only ever says "open this view and give me the result".
import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const CHROME_CANDIDATES = [
    "chromium-browser", "chromium", "google-chrome", "google-chrome-stable"
];

const READY_TIMEOUT_MS = 20000;
const PROBE_POLL_MS = 500;

/** Launches a headless browser and resolves to {newPage, close}. */
export async function launch() {
    const profile = await mkdtemp(join(tmpdir(), "earth-test-"));
    const port = 9500 + Math.floor(Math.random() * 400);

    let child;
    for (const bin of CHROME_CANDIDATES) {
        child = spawn(bin, [
            "--headless=new", "--no-sandbox", "--disable-gpu",
            "--remote-debugging-port=" + port,
            "--user-data-dir=" + profile,
            "about:blank"
        ], {stdio: "ignore"});

        const failed = await new Promise((done) => {
            child.once("error", () => done(true));
            setTimeout(() => done(false), 300);
        });
        if (!failed) break;
        child = null;
    }
    if (!child) throw new Error("no chromium/chrome binary found (tried " + CHROME_CANDIDATES.join(", ") + ")");

    const version = await waitFor(() => fetchJson(`http://127.0.0.1:${port}/json/version`));
    if (!version) throw new Error("browser did not open a debugging port");

    return {
        version: version.Browser,
        newPage: (options) => newPage(port, options),
        close: async () => {
            child.kill("SIGKILL");
            await rm(profile, {recursive: true, force: true}).catch(() => {});
        }
    };
}

async function fetchJson(url, init) {
    const res = await fetch(url, init);
    return res.json();
}

async function waitFor(attempt) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try { return await attempt(); }
        catch { await sleep(200); }
    }
    return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Opens a tab, applies the emulation the view asks for, injects `preload` so it runs
 * *before* any page script, then navigates. Resolves to {result, close}, where result is
 * whatever the injected code left on window.__probeResult.
 *
 * The preload route matters: the page under test stays byte-for-byte the deployed file.
 * Patching index.html to add a probe would have made every measurement a measurement of
 * a file nobody ships.
 */
async function newPage(port, {url, preload, viewport, cpuThrottle, touch, mobile,
                              userAgent, platform, captureNetwork,
                              timeoutMs = 120000, onProgress}) {
    const target = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, {method: "PUT"});
    const socket = await connect(target.webSocketDebuggerUrl);

    await socket.send("Page.enable");
    await socket.send("Runtime.enable");
    await socket.send("Network.enable");
    await socket.send("Network.setCacheDisabled", {cacheDisabled: true});

    // Which assets a build actually fetches is the most direct evidence there is of the
    // resolution a viewer is served: the texture tiers are separate files whose grid is in
    // the name, so the request log says 5400 or 10800 or 21600 without inferring anything
    // from pixels.
    const requests = [];
    if (captureNetwork) {
        socket.on("Network.requestWillBeSent", (params) => {
            requests.push({url: params.request.url, type: params.type, at: params.timestamp});
        });
    }

    // The user agent has to be set before navigation, and it is what isMobile() reads —
    // without it a phone profile is a phone-shaped desktop. See lib/devices.mjs.
    if (userAgent) {
        await socket.send("Emulation.setUserAgentOverride", {
            userAgent,
            platform: platform || undefined,
            userAgentMetadata: {
                brands: [{brand: "Chromium", version: "151"}],
                fullVersion: "151.0.0.0",
                platform: platform || "Unknown",
                platformVersion: "",
                architecture: "",
                model: "",
                mobile: !!touch
            }
        });
    }

    if (cpuThrottle > 1) await socket.send("Emulation.setCPUThrottlingRate", {rate: cpuThrottle});
    if (viewport) {
        await socket.send("Emulation.setDeviceMetricsOverride", {
            width: viewport.width, height: viewport.height,
            deviceScaleFactor: viewport.dpr || 1,
            mobile: mobile === undefined ? !!touch : !!mobile
        });
    }
    if (touch) await socket.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
    if (preload) await socket.send("Page.addScriptToEvaluateOnNewDocument", {source: preload});

    await socket.send("Page.navigate", {url});

    const result = await pollForResult(socket, timeoutMs, onProgress);
    if (captureNetwork && result && typeof result === "object") result.__network = requests;
    await socket.send("Page.close").catch(() => {});
    socket.close();
    return result;
}

/**
 * Polls for the probe's result, reporting each new step it announces. The progress channel
 * is not decoration: a suite that stalls used to report only "did not finish in 240000ms",
 * which says nothing about which of a dozen gestures it stalled on. Reporting the step as
 * it changes turns that into a named case, and the elapsed time with it.
 */
async function pollForResult(socket, timeoutMs, onProgress) {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let lastStep = null;

    while (Date.now() < deadline) {
        await sleep(PROBE_POLL_MS);
        const value = await socket.evaluate("window.__probeResult ? JSON.stringify(window.__probeResult) : null");
        if (value) return JSON.parse(value);

        if (onProgress) {
            const step = await socket.evaluate("String(window.__probeTrace || '')");
            if (step && step !== lastStep) {
                lastStep = step;
                onProgress(step, Date.now() - started);
            }
        }
    }
    const trace = await socket.evaluate("String(window.__probeTrace || 'no trace')");
    throw new Error("probe did not finish within " + timeoutMs + "ms; last step: " + trace);
}

function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        // Events carry a method and no id; command replies carry an id and no method.
        if (!message.id) {
            const handler = listeners.get(message.method);
            if (handler) handler(message.params);
            return;
        }
        if (!pending.has(message.id)) return;
        pending.get(message.id)(message);
        pending.delete(message.id);
    };

    const on = (method, handler) => listeners.set(method, handler);

    const send = (method, params = {}) => new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({id, method, params}));
    });

    const evaluate = async (expression) => {
        const reply = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
        return reply.result?.result?.value;
    };

    return new Promise((resolve, reject) => {
        ws.onopen = () => resolve({send, evaluate, on, close: () => ws.close()});
        ws.onerror = () => reject(new Error("could not open a CDP socket"));
    });
}

// Pre-release checks: Wind -> vectors/scalars; Ocean -> currents/temperature/waves;
// Solar radiance -> daylight/night lights/relief. No untracked assets or secrets.
import assert from "node:assert/strict";
import {after, before, describe, test} from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {launch} from "./lib/browser.mjs";
import {serve} from "./lib/serve.mjs";
import {DESKTOP, PHONE} from "./lib/devices.mjs";
import {FEATURES, featureFixtures} from "./lib/features.mjs";

const root = fileURLToPath(new URL("../public", import.meta.url));
const harness = await readFile(new URL("./probes/harness.js", import.meta.url), "utf8");
const physics = await readFile(new URL("./probes/physics.js", import.meta.url), "utf8");
const sunphysics = await readFile(new URL("./probes/sunphysics.js", import.meta.url), "utf8");
const selected = process.env.EARTH_TEST_FEATURE;
if (selected && !Object.hasOwn(FEATURES, selected)) throw Error("Unknown EARTH_TEST_FEATURE: " + selected);

function healthy(result) {
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.settled, true, "display did not settle");
    assert.deepEqual(result.errors, [], "uncaught browser errors");
}

for (const [name, feature] of Object.entries(FEATURES)) {
    if (selected && selected !== name) continue;
    describe(feature.title, () => {
        let server, browser;
        before(async () => {
            server = await serve(root);
            browser = await launch();
        });
        after(async () => {
            try { await browser?.close(); }
            finally { await server?.close(); }
        });

        async function probe(layer, device, source) {
            const report = `
                const reportResult = E.report;
                E.report = result => reportResult({...result, errors: featureAudit.errors,
                    requests: featureAudit.requests});
            `;
            return browser.newPage({
                ...device.page({timeoutMs: 90000}),
                url: `http://127.0.0.1:${server.port}/#layer=${layer}&rotate=0,0&zoom=1`,
                preload: featureFixtures() + harness + report + source
            });
        }

        const categories = [...new Set(feature.layers.map(layer => layer.category))];
        for (const category of categories) {
            describe(category, () => {
                for (const layer of feature.layers.filter(layer => layer.category === category)) {
                    describe(layer.title, () => {
                        for (const device of [DESKTOP, PHONE]) {
                            test(`${device.name}: render, data, units, readout and zoom`, async () => {
                                const result = await probe(layer.id, device, `
                                    async function runSuite() {
                                        const bootSettled = await E.settle(20000);
                                        const boot = {title: document.title, scale: E.el('scale-label').textContent.trim(),
                                            mapInk: E.canvasSignature('map').ink,
                                            overlayInk: E.canvasSignature('overlay').ink,
                                            animationInk: E.canvasSignature('animation').ink};
                                        const centre = E.centre();
                                        if (${device.touch}) {
                                            const touch = E.touch(1, centre[0], centre[1]);
                                            E.fireTouch('touchstart', [touch], [touch]); await E.sleep(60);
                                            E.fireTouch('touchend', [], [touch]);
                                        } else {
                                            E.fireMouse('mousedown', centre[0], centre[1]); await E.sleep(60);
                                            E.fireMouse('mouseup', centre[0], centre[1], window);
                                        }
                                        await E.sleep(400);
                                        const readout = E.el('location').textContent.trim();
                                        E.fireWheel(-240);
                                        const zoomSettled = await E.settle(20000);
                                        E.report({settled: bootSettled && zoomSettled,
                                            status: E.el('status').textContent.trim(), boot, readout,
                                            hash: E.hashState(), afterInk: E.canvasSignature('overlay').ink});
                                    }
                                `);
                                healthy(result);
                                assert.equal(result.status, "");
                                assert.ok(result.boot.title.includes(layer.title), result.boot.title);
                                assert.equal(result.boot.scale, layer.scale);
                                assert.ok(result.readout.includes(layer.readout), result.readout);
                                assert.ok(result.boot.mapInk > 0 && result.boot.overlayInk > 0);
                                assert.ok(result.afterInk > 0, "zoom lost the overlay");
                                assert.equal(result.hash.layer, layer.id);
                                assert.ok(result.hash.zoom > 1, "wheel zoom did not change scale");
                                if (name !== "solar") assert.ok(result.boot.animationInk > 0, "missing particle trails");
                                for (const file of layer.files) assert.ok(result.requests.includes(file), "missing input: " + file);
                            });
                        }
                    });
                }
            });
        }

        describe(name === "solar" ? "Solar position and illumination over time" : "Particle animation", () => {
            const layers = name === "solar" ? feature.layers.map(layer => layer.id) : feature.physics;
            for (const layer of layers) {
                for (const device of [DESKTOP, PHONE]) {
                    test(`${layer} / ${device.name}`, async () => {
                        const result = await probe(layer, device, name === "solar" ? sunphysics : physics);
                        healthy(result);
                        if (name === "solar") {
                            assert.equal(result.hasRenderer, true);
                            assert.deepEqual(result.samples.map(sample => sample.hours), [0, 3, 6, 12]);
                            for (const sample of result.samples) {
                                assert.equal(sample.settled, true);
                                assert.ok(sample.lit.covered > 0);
                                assert.ok(sample.elevations.every(value => Number.isFinite(value.alt) && Math.abs(value.alt) <= 90));
                            }
                            assert.ok(result.motion.some(step => step.dAltitudes.some(value => Math.abs(value) > 10)), "sun position stopped moving");
                            assert.ok(result.motion.some(step => Math.abs(step.dMeanLuma) > 1), "illumination stopped changing");
                        } else {
                            assert.equal(result.frameCount, 40);
                            assert.ok(result.animationInk > 0);
                            assert.ok(result.frames.some(frame => frame.segments > 0 && frame.travel > 0), "particles stopped moving");
                            assert.ok(result.frames.every(frame => Number.isFinite(frame.travel)));
                        }
                    });
                }
            }
        });
    });
}

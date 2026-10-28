import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";
import {FEATURES} from "./lib/features.mjs";

test("the feature hierarchy covers every layer in the shipped menu", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const menu = [...html.matchAll(/data-layer="([^"]+)"/g)].map(match => match[1]);
    const tested = Object.values(FEATURES).flatMap(feature => feature.layers.map(layer => layer.id));
    assert.equal(new Set(tested).size, tested.length, "duplicate feature entries");
    assert.deepEqual(tested.sort(), menu.sort(), "every menu layer must have a feature check");
});

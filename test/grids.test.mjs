// Evaluate private grid builders without exposing them on the production window.
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const wind = await readFile(new URL("../public/js/wind.js", import.meta.url), "utf8");
const source = wind.slice(wind.indexOf("    function isValue("), wind.indexOf("    /** 256-entry"));
function context() {
    let allocations = 0;
    const scope = vm.createContext({Float32Array: new Proxy(Float32Array, {
        construct(target, args) { allocations++; return new target(...args); }
    })});
    vm.runInContext(source, scope);
    return {scope, allocations: () => allocations};
}
function records() {
    return [2, 3].map(parameterNumber => ({header: {
        parameterCategory: 2, parameterNumber, nx: 4, ny: 3, dx: 90, dy: 90,
        lo1: 0, la1: 90, refTime: "2026-09-11T00:00:00Z", forecastTime: 0
    }, data: Array(12).fill(parameterNumber + 1)}));
}

test("valid vector and scalar grids retain interpolation", () => {
    const {scope} = context();
    assert.deepEqual(Array.from(scope.buildGrid(records()).interpolate(45, 45)), [3, 4, 5]);
    assert.equal(scope.buildScalarGrid(records().slice(0, 1)).interpolate(45, 45), 3);
});

for (const [name, change] of [
    ["infinite rows", r => { r[0].header.ny = Infinity; r[0].header.nx = 0; }],
    ["fractional rows", r => { r[0].header.ny = 2.5; }],
    ["zero spacing", r => { r[0].header.dx = 0; }],
    ["negative spacing", r => { r[0].header.dy = -1; }],
    ["too many columns", r => { r[0].header.nx = 100000; }],
    ["too many rows", r => { r[0].header.ny = 100000; }],
    ["latitude outside Earth", r => { r[0].header.la1 = 91; }],
    ["latitude span outside Earth", r => { r[0].header.dy = 91; }],
    ["longitude span outside Earth", r => { r[0].header.dx = 181; }],
    ["non-finite origin", r => { r[0].header.lo1 = Infinity; }],
    ["reversed scan", r => { r[0].header.scanMode = 64; }],
    ["missing samples", r => { r[0].data.pop(); }],
    ["string samples", r => { r[0].data[0] = "3"; }],
    ["object samples", r => { r[0].data[0] = {}; }],
    ["non-finite samples", r => { r[0].data[0] = Infinity; }],
    ["Float32 overflow", r => { r[0].data[0] = 1e99; }],
    ["invalid timestamp", r => { r[0].header.refTime = "bad"; }],
    ["infinite forecast", r => { r[0].header.forecastTime = Infinity; }]
]) {
    for (const build of ["buildGrid", "buildScalarGrid"]) {
        test(`${build} rejects ${name} before allocation`, () => {
            const {scope, allocations} = context();
            const input = records(); change(input);
            scope.input = build === "buildGrid" ? input : input.slice(0, 1);
            assert.throws(() => vm.runInContext(`${build}(input)`, scope, {timeout: 100}), /grid|data|sample|time/i);
            assert.equal(allocations(), 0);
        });
    }
}

test("vector component grids must match", () => {
    const {scope} = context();
    const input = records(); input[1].header.lo1 = 90;
    assert.throws(() => scope.buildGrid(input), /grid/i);
});
test("a missing V cell is a missing vector corner", () => {
    const {scope} = context();
    const input = records(); input[1].data[0] = null;
    assert.deepEqual(Array.from(scope.buildGrid(input).interpolate(45, 45)), [3, 4, 5]);
});

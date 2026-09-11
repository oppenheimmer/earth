import assert from "node:assert/strict";
import {beforeEach, test} from "node:test";
import worker from "../worker/index.js";

const BODY = "0123456789";
const ETAG = '"fixture"';
const MODIFIED = "Fri, 11 Sep 2026 00:00:00 GMT";
let cache, puts, reads;
beforeEach(() => {
    cache = new Map(); puts = []; reads = [];
    globalThis.caches = {default: {
        async match(request) { return cache.get(request.url)?.clone(); },
        async put(request, response) { cache.set(request.url, response); }
    }};
});

function metadata() {
    return {size: BODY.length, etag: "fixture", httpEtag: ETAG, version: "first",
        uploaded: new Date(MODIFIED), writeHttpMetadata(headers) {
            headers.set("Content-Type", "application/json");
        }};
}

// The fixture implements R2's documented metadata-only response on failed onlyIf.
function bucket() {
    return {
        async head(key) { reads.push("head"); return key === "absent" ? null : metadata(); },
        async get(key, options = {}) {
            reads.push("get");
            if (key === "absent") return null;
            const meta = metadata(), condition = options.onlyIf;
            if (condition instanceof Headers) {
                const match = condition.get("If-Match"), none = condition.get("If-None-Match");
                if (match !== null && match !== "*" && !match.split(/,\s*/).includes(ETAG)) return meta;
                if (match === null && Date.parse(condition.get("If-Unmodified-Since")) < meta.uploaded.getTime()) return meta;
                if (none === "*" || none?.replaceAll("W/", "").split(/,\s*/).includes(ETAG)) return meta;
                if (none === null && Date.parse(condition.get("If-Modified-Since")) >= meta.uploaded.getTime()) return meta;
            } else if (condition?.etagMatches && condition.etagMatches !== meta.etag) return meta;
            let body = BODY, range = options.range;
            if (range instanceof Headers) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range.get("Range"));
                const offset = match?.[1] ? Number(match[1]) : BODY.length - Number(match?.[2]);
                range = match ? {offset, length: match[1] ? Number(match[2] || 9) - offset + 1 : Number(match[2])} : null;
            }
            if (range) body = BODY.slice(range.offset, range.offset + range.length);
            return {...meta, range, body: new Response(body).body};
        }
    };
}

async function request(headers = {}, method = "GET", path = "/current-fixture.json", storage = bucket()) {
    const response = await worker.fetch(new Request("https://fixture.invalid" + path, {method, headers}),
        {BUCKET: storage}, {waitUntil(promise) { puts.push(promise); }});
    const body = await response.text();
    await Promise.all(puts);
    return {status: response.status, headers: response.headers, body};
}

for (const [name, headers, status] of [
    ["failed If-Match", {"If-Match": '"old"'}, 412],
    ["weak If-Match", {"If-Match": "W/" + ETAG}, 412],
    ["matching If-Match list", {"If-Match": '"old", ' + ETAG}, 200],
    ["matching wildcard", {"If-Match": "*"}, 200],
    ["failed If-Unmodified-Since", {"If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT"}, 412],
    ["If-Match takes precedence", {"If-Match": ETAG, "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT"}, 200],
    ["matching If-None-Match", {"If-None-Match": ETAG}, 304],
    ["weak If-None-Match list", {"If-None-Match": '"old", W/' + ETAG}, 304],
    ["If-None-Match wildcard", {"If-None-Match": "*"}, 304],
    ["matching modification time", {"If-Modified-Since": MODIFIED}, 304],
    ["invalid modification time", {"If-Modified-Since": "bad"}, 200],
    ["If-None-Match takes precedence", {"If-None-Match": '"old"', "If-Modified-Since": MODIFIED}, 200]
]) {
    for (const method of ["GET", "HEAD"]) {
        test(`${method} ${name}`, async () => {
            const result = await request(headers, method);
            assert.equal(result.status, status);
            assert.equal(result.body, method === "HEAD" || status !== 200 ? "" : BODY);
        });
    }
}

for (const [range, status, body] of [
    ["bytes=0-2", 206, "012"], ["bytes=-3", 206, "789"], ["bytes=7-", 206, "789"],
    ["bytes=8-99", 206, "89"], ["bytes=99-100", 416, ""], ["bytes=9-1", 416, ""],
    ["bytes=-0", 416, ""], ["bytes=0-1,8-9", 200, BODY], ["unknown=0-2", 200, BODY]
]) {
    test(`Range ${range}`, async () => {
        const result = await request({Range: range});
        assert.equal(result.status, status); assert.equal(result.body, body);
        if (status === 416) assert.equal(result.headers.get("Content-Range"), "bytes */10");
    });
}

for (const validator of ['"old"', "W/" + ETAG, "Thu, 01 Jan 1970 00:00:00 GMT"]) {
    test(`If-Range mismatch ${validator}`, async () => {
        const result = await request({Range: "bytes=0-2", "If-Range": validator});
        assert.equal(result.status, 200); assert.equal(result.body, BODY);
    });
}
test("matching If-Range returns the range", async () => {
    const result = await request({Range: "bytes=0-2", "If-Range": ETAG});
    assert.equal(result.status, 206); assert.equal(result.body, "012");
});
test("warm cache cannot bypass a precondition", async () => {
    await request();
    assert.equal((await request({"If-Match": '"old"'})).status, 412);
});
test("range responses cannot poison the full cache", async () => {
    await request({Range: "bytes=0-2"});
    assert.equal((await request()).body, BODY);
});
test("HEAD ignores Range and reads metadata only", async () => {
    assert.equal((await request({Range: "bytes=0-2"}, "HEAD")).status, 200);
    assert.deepEqual(reads, ["head"]);
});
for (const path of ["/%", "/%GG", "/%C0%AF", "/%00"]) {
    test(`malformed path ${path} returns 400`, async () => {
        assert.equal((await request({}, "GET", path)).status, 400);
    });
}
test("storage failures return controlled errors", async () => {
    const storage = {async get() { throw Error("private storage detail"); }};
    const result = await request({}, "GET", "/fixture", storage);
    assert.equal(result.status, 502);
    assert.doesNotMatch(result.body, /private storage detail/);
});
test("ordinary GET remains cacheable", async () => {
    assert.equal((await request()).body, BODY);
    assert.equal((await request()).body, BODY);
    assert.deepEqual(reads, ["get"]);
});

test("a replacement between metadata and body is retried", async () => {
    const storage = bucket(), get = storage.get;
    let calls = 0;
    storage.get = async (...args) => ++calls === 1 ? metadata() : get(...args);
    const result = await request({Range: "bytes=0-2"}, "GET", "/fixture", storage);
    assert.equal(result.status, 206); assert.equal(result.body, "012");
    assert.equal(calls, 2);
});
test("continuous replacement cannot loop indefinitely", async () => {
    const storage = bucket(); storage.get = async () => metadata();
    assert.equal((await request({Range: "bytes=0-2"}, "GET", "/fixture", storage)).status, 503);
});
test("date If-Range falls back to a complete representation", async () => {
    const result = await request({Range: "bytes=0-2", "If-Range": MODIFIED});
    assert.equal(result.status, 200); assert.equal(result.body, BODY);
});
test("non-HTTP dates are ignored", async () => {
    for (const value of ["0", "2000-01-01"]) {
        assert.equal((await request({"If-Unmodified-Since": value})).status, 200);
    }
});

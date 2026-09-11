/**
 * earth-data — a Cloudflare Worker in front of the R2 bucket.
 *
 * Why it exists. The site used to read the bucket's r2.dev URL directly, and that endpoint is
 * the slowest link in the page (measured 2026-08-24 from Tokyo): HTTP/1.1 only, no
 * cf-cache-status at all — so nothing edge-cached — and 300–800 ms to first byte where Vercel
 * answers the same page's assets in 60. Cloudflare also documents it as rate-limited and not
 * for production. Through this Worker the same objects come back over h2/h3 in 70–130 ms on a
 * cache hit, and workers.dev needs no domain.
 *
 * Why the objects are stored UNCOMPRESSED, which reverses the earlier design. They used to be
 * stored already brotli-compressed with Content-Encoding: br, because r2.dev never compresses
 * on the fly and that was the only way to get 6x off the wire. Putting a CDN in front removes
 * that premise, and trying to keep both fought the platform at every turn — three deploys,
 * three different failure modes, all measured against the live Worker:
 *
 *   1. re-wrapping a cached body lost the runtime's "already encoded" flag, so the edge
 *      encoded it again: hits came back as brotli(brotli(json)), and a browser negotiating
 *      zstd got zstd(brotli(json)) and handed JSON.parse binary;
 *   2. returning the cached Response untouched did not help — the edge still re-compressed
 *      live, the response size drifting run to run;
 *   3. Cache-Control: no-transform stopped the re-compression, and the edge then stripped
 *      Content-Encoding entirely, so clients received brotli bytes labelled application/json.
 *
 * The runtime has no brotli decompressor (DecompressionStream covers gzip and deflate), so a
 * Worker cannot hand the edge something it is willing to encode itself. Storing plain JSON and
 * letting the edge compress is what the platform is built for: it negotiates br, zstd or gzip
 * per client, caches a variant per encoding, and none of the machinery above is needed. The
 * Worker is a third of its former size as a result. See the README's Compression section.
 */

// Cache-Control to apply when an object carries none of its own. upload_data.sh and
// upload_textures.sh both set one, so these are a backstop rather than the usual path.
const FALLBACK_CACHE_CONTROL = {
    immutable: "public, max-age=31536000, immutable",
    volatile: "public, max-age=1800, must-revalidate"
};

/**
 * no-transform, but only for the imagery. Those files are read back pixel by pixel — the night
 * lights through an r-0.6b extraction, the elevation map through its gradient — and an
 * edge-side image transform would corrupt exactly what they are read for, quietly and behind a
 * year-long cache. Nothing that would do it is enabled today; this makes enabling it later
 * harmless. It must NOT go on the JSONs, because there it would also forbid the compression
 * this whole design now depends on.
 */
function isPixelData(contentType) {
    return (contentType || "").startsWith("image/");
}

function withCors(headers) {
    // sunlight.js reads texture pixels back with getImageData, so its <img> is
    // crossOrigin="anonymous" and the response must carry CORS or the canvas is tainted.
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag, Last-Modified, Accept-Ranges");
    return headers;
}

const CONDITIONAL_HEADERS = [
    "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since", "If-Range"
];
const MAX_READ_ATTEMPTS = 2;

function headersFor(object, key) {
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Last-Modified", object.uploaded.toUTCString());
    headers.set("Cache-Control", (headers.get("Cache-Control") ||
        (/^current-/.test(key) ? FALLBACK_CACHE_CONTROL.volatile : FALLBACK_CACHE_CONTROL.immutable)) +
        (isPixelData(headers.get("Content-Type")) ? ", no-transform" : ""));
    headers.set("Accept-Ranges", "bytes");
    return withCors(headers);
}

function failure(status, request) {
    const messages = {400: "bad request", 404: "not found", 502: "storage unavailable", 503: "retry request"};
    return new Response(request.method === "HEAD" ? null : messages[status] + "\n", {
        status, headers: withCors(new Headers({"Cache-Control": "no-store"}))
    });
}

function tags(value) {
    return value.match(/(?:W\/)?"[^"]*"/g) || [];
}

function httpDate(value) {
    // HTTP permits these three date formats; Date.parse also accepts unrelated inputs.
    const modern = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
    const obsolete = /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
    const asctime = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
    if (asctime.test(value)) return Date.parse(value + " GMT");
    return modern.test(value) || obsolete.test(value) ? Date.parse(value) : NaN;
}

function condition(headers, object) {
    const match = headers.get("If-Match"), none = headers.get("If-None-Match");
    const modified = Date.parse(object.uploaded.toUTCString());
    // RFC 9110: entity tags take precedence over the corresponding date condition.
    if (match !== null) {
        if (match !== "*" && !tags(match).includes(object.httpEtag)) return 412;
    } else if (modified > httpDate(headers.get("If-Unmodified-Since"))) return 412;
    if (none !== null) {
        if (none === "*" || tags(none).some(tag => tag.replace(/^W\//, "") === object.httpEtag)) return 304;
    } else if (modified <= httpDate(headers.get("If-Modified-Since"))) return 304;
    return 0;
}

function rangeFor(value, size) {
    // Unsupported units and multipart ranges are ignored, as HTTP permits.
    const match = /^bytes=(\d*)-(\d*)$/.exec(value || "");
    if (!match || (!match[1] && !match[2])) return null;
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || end < start) return {status: 416};
    return {offset: start, length: end - start + 1};
}

async function read(request, bucket, ctx, key) {
    const cache = caches.default;
    const wantsRange = request.method === "GET" && request.headers.has("Range");
    const conditional = CONDITIONAL_HEADERS.some(name => request.headers.has(name));
    if (request.method === "GET" && !wantsRange && !conditional) {
        const hit = await cache.match(request).catch(() => null);
        if (hit) return hit;
        const object = await bucket.get(key);
        if (!object) return failure(404, request);
        const response = new Response(object.body, {headers: headersFor(object, key)});
        ctx.waitUntil(cache.put(request, response.clone()).catch(() => {}));
        return response;
    }

    // Conditional/range requests bypass edge-cache condition semantics. Pin the body to
    // the checked version so a refresh between HEAD and GET cannot mix representations.
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
        const meta = await bucket.head(key);
        if (!meta) return failure(404, request);
        const headers = headersFor(meta, key);
        const status = condition(request.headers, meta);
        if (status) return new Response(null, {status, headers});
        if (request.method === "HEAD") {
            headers.set("Content-Length", String(meta.size));
            return new Response(null, {headers});
        }
        const ifRange = request.headers.get("If-Range");
        // R2 upload dates cannot prove there was only one version within a second.
        // Treat date/weak validators as unverified and send the full representation.
        const range = wantsRange && (ifRange === null || ifRange === meta.httpEtag)
            ? rangeFor(request.headers.get("Range"), meta.size) : null;
        if (range?.status === 416) {
            headers.set("Content-Range", `bytes */${meta.size}`);
            return new Response(null, {status: 416, headers});
        }
        const object = await bucket.get(key, {onlyIf: {etagMatches: meta.etag}, range: range || undefined});
        if (!object) return failure(404, request);
        if (!object.body) continue;
        if (object.version !== meta.version) {
            await object.body.cancel();
            continue;
        }
        if (range) {
            headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
            headers.set("Content-Length", String(range.length));
        }
        return new Response(object.body, {status: range ? 206 : 200, headers});
    }
    return failure(503, request);
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, {status: 204, headers: withCors(new Headers({
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers": ["Range", ...CONDITIONAL_HEADERS].join(", "),
                "Access-Control-Max-Age": "86400"
            }))});
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response("method not allowed\n",
                {status: 405, headers: withCors(new Headers({"Allow": "GET, HEAD, OPTIONS"}))});
        }
        let key;
        try {
            key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
            if (key.includes("\0")) return failure(400, request);
        } catch {
            return failure(400, request);
        }
        if (!key || key.includes("..")) return failure(404, request);
        try {
            return await read(request, env.BUCKET, ctx, key);
        } catch {
            return failure(502, request);
        }
    }
};

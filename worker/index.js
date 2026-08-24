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
    headers.set("Access-Control-Expose-Headers", "Content-Length, ETag");
    return headers;
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, {status: 204, headers: withCors(new Headers({
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Access-Control-Max-Age": "86400"
            }))});
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response("method not allowed\n",
                {status: 405, headers: {"Allow": "GET, HEAD, OPTIONS"}});
        }

        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
        if (!key || key.includes("..")) return new Response("not found\n", {status: 404});

        function finish(headers, contentType) {
            headers.set("Cache-Control", (headers.get("Cache-Control") ||
                (/^current-/.test(key) ? FALLBACK_CACHE_CONTROL.volatile
                                       : FALLBACK_CACHE_CONTROL.immutable)) +
                (isPixelData(contentType) ? ", no-transform" : ""));
            headers.set("Accept-Ranges", "bytes");
            return withCors(headers);
        }

        // HEAD is answered from metadata alone; going through the GET path would build a
        // response around the object stream and then discard it, leaving the body dangling.
        if (request.method === "HEAD") {
            const meta = await env.BUCKET.head(key);
            if (meta === null) return new Response("not found\n", {status: 404});
            const headers = new Headers();
            meta.writeHttpMetadata(headers);
            headers.set("ETag", meta.httpEtag);
            headers.set("Content-Length", String(meta.size));
            return new Response(null,
                {status: 200, headers: finish(headers, headers.get("Content-Type"))});
        }

        // Range requests bypass the cache: caching a partial body under a whole-object key
        // would be wrong, and nothing in the site issues one.
        const wantsRange = request.headers.has("Range");
        const cache = caches.default;
        // Keyed by URL alone. The bodies stored here are unencoded, so unlike the previous
        // design there is no encoding to key on — the edge holds its own variant per encoding
        // in front of this.
        if (!wantsRange) {
            const hit = await cache.match(request);
            if (hit) return hit;
        }

        const object = await env.BUCKET.get(key, {
            range: wantsRange ? request.headers : undefined,
            onlyIf: request.headers
        });
        if (object === null) return new Response("not found\n", {status: 404});

        const headers = new Headers();
        object.writeHttpMetadata(headers);      // content-type, -encoding, -language, cache-control
        headers.set("ETag", object.httpEtag);
        finish(headers, headers.get("Content-Type"));

        // A conditional request R2 satisfied comes back with no body.
        if (!object.body) return new Response(null, {status: 304, headers});

        if (wantsRange && object.range) {
            const {offset = 0, length} = object.range;
            const end = offset + (length ?? (object.size - offset)) - 1;
            headers.set("Content-Range", `bytes ${offset}-${end}/${object.size}`);
            return new Response(object.body, {status: 206, headers});
        }

        const response = new Response(object.body, {status: 200, headers});
        // clone() tees the stream: one copy to the edge cache, one to the client, so a 24 MB
        // object is never buffered whole in the isolate.
        ctx.waitUntil(cache.put(request, response.clone()));
        return response;
    }
};

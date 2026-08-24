/**
 * Builds the 10m detail meshes off the main thread.
 *
 * wind.js fetches world-atlas countries-10m once, the first time the view settles past
 * DETAIL_ZOOM, and rebuilds its idle meshes from it. Measured in Chromium on the 3.7 MB
 * topology, that build costs 376 ms of straight-line CPU:
 *
 *     JSON.parse             107 ms
 *     topojson.merge          90 ms
 *     d3.geoArea ring fix    122 ms
 *     mesh coast              48 ms
 *     mesh borders             9 ms
 *
 * and inline it is 437 ms during which a 16 ms heartbeat gets zero ticks — a hard freeze,
 * landing immediately after a zoom gesture, which is the worst possible moment for one.
 * None of it touches the DOM, so all of it belongs here. Through this Worker the same
 * heartbeat's worst tick is 17 ms: the page stays interactive throughout.
 *
 * What it costs is latency, and honestly: the result arrives about 1.6 s after the request
 * rather than 0.44 s. Worker spin-up including the d3 import is only ~100 ms of that; the
 * rest is structured-clone serialisation of the three GeoJSON objects, which are millions
 * of two-element coordinate arrays and about the worst shape a clone can be handed. That
 * trade is the right way round for this particular asset: the globe is already drawn in 50m
 * detail and stays interactive, and the 10m lines are a progressive sharpening nobody is
 * blocked on. It would be the wrong way round for anything on the boot path.
 *
 * d3 is imported for geoArea alone, which is worth it precisely because geoArea is the
 * single largest item above: the page has already fetched the same URL, so in production
 * (where /libs/ is immutable) this is a cache hit, and ~80 ms of parse off the main thread.
 *
 * wind.js keeps its original inline path as a fallback — Workers cannot be constructed from
 * file:, which is a documented way to run this site.
 */
importScripts("../libs/topojson-client.min.js", "../libs/d3.v7.min.js");

var τ = 2 * Math.PI;

onmessage = function (e) {
    fetch(e.data.url).then(function (r) {
        if (!r.ok) throw new Error("countries 10m: HTTP " + r.status);
        return r.json();
    }).then(function (c10) {
        var land = topojson.merge(c10, c10.objects.countries.geometries);
        // world-atlas 10m ships a few rings wound backwards (3 of 4044 merged polygons;
        // 50m/110m are clean) — d3-geo reads each as "the sphere minus the ring", so the
        // ocean layers' charcoal land fill flooded the whole globe. A polygon claiming
        // more than half the sphere (> τ steradians) is one of them: reversing all its
        // rings restores it while leaving real holes (the Caspian) alone.
        land.coordinates.forEach(function (poly) {
            if (d3.geoArea({type: "Polygon", coordinates: poly}) > τ) {
                poly.forEach(function (ring) { ring.reverse(); });
            }
        });
        postMessage({
            coast: topojson.mesh(c10, c10.objects.land),
            borders: topojson.mesh(c10, c10.objects.countries, function (a, b) { return a !== b; }),
            land: land
        });
    }).catch(function (err) {
        postMessage({error: err.message});
    });
};

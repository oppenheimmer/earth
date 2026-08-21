#!/usr/bin/env node
/**
 * Generate public/js/tz-centers.js — the IANA timezone → country-centre table that
 * js/wind.js uses to pick the globe's initial centre without asking for geolocation
 * permission (Intl.DateTimeFormat().resolvedOptions().timeZone is free and needs no
 * consent prompt; navigator.geolocation would prompt and is far more precise than
 * this page needs).
 *
 * Deliberately COUNTRY-GRAINED: every zone of a country maps to the same point, so
 * the rendered view distinguishes visitors only down to their country and nothing
 * finer — a Kolkata and a Delhi visitor get a pixel-identical globe. Coordinates are
 * rounded to whole degrees (~111 km), which is invisible at the fitted zoom, where
 * the globe spans a whole hemisphere.
 *
 * Inputs:
 *   /usr/share/zoneinfo/zone.tab      zone → ISO 3166-1 alpha-2 + a representative
 *                                     city coordinate (tzdata; any Linux/macOS box)
 *   /usr/share/zoneinfo/iso3166.tab   alpha-2 → English country name, for the
 *                                     cross-check below
 *   /usr/share/zoneinfo/**            TZif binaries, hashed to recover the legacy
 *                                     aliases (Asia/Calcutta, US/Eastern, GB, …)
 *                                     that browsers may still report but zone.tab
 *                                     omits
 *   public/data/countries-50m.json    the SAME topology the page draws, so the
 *                                     centre always agrees with the rendered borders
 *
 * The centre is the spherical centroid (d3.geoCentroid) of the country polygon that
 * contains the zone's city. zone.tab coordinates are rounded to whole minutes, so
 * coastal cities (New York, Copenhagen, Lagos) can land just offshore of the coarse
 * 50m outline; unmatched points are snapped outward in expanding rings and the first
 * containing polygon wins, which finds the city's own country long before a border
 * up to 110 km away. Every resolution is then cross-checked against the alpha-2 code
 * zone.tab already carries, and disagreements are printed for review rather than
 * silently shipped.
 *
 * d3 and topojson-client come from public/libs/ — the exact bundles the browser
 * loads, so no npm install and no chance of a version skew against the page.
 *
 * Usage:  node scripts/gen_tz_centers.js [--check]
 *         --check  report only, do not write the file
 */
"use strict";

var fs = require("fs");
var path = require("path");
var d3 = require("../public/libs/d3.v7.min.js");
var topojson = require("../public/libs/topojson-client.min.js");

var ZONEINFO = "/usr/share/zoneinfo";
var ROOT = path.join(__dirname, "..");
var OUT = path.join(ROOT, "public/js/tz-centers.js");
var SNAP_RINGS = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 1.0];  // degrees; 1.0° ≈ 110 km

// Countries whose Natural Earth feature bundles distant dependencies, dragging the
// whole-country centroid away from the landmass nearly everyone lives on. These use the
// centroid of their largest polygon instead. France is the clear case: its feature
// includes Guiana, Réunion, Martinique, Guadeloupe and Mayotte, which puts the centroid
// in the Bay of Biscay, 825 km off metropolitan France. The US gains ~670 km northwest
// from Alaska and Hawaii; the largest polygon is the contiguous 48.
//
// Dispersed countries are deliberately NOT listed: for Indonesia, the Philippines,
// Kiribati or French Polynesia a mid-archipelago point genuinely is the country's centre,
// even though it lands on water, and their largest island sits off at one edge.
var MAINLAND_ONLY = ["France", "United States of America"];

// Zones the ring search resolves to the wrong country, overridden to the Natural Earth
// feature matching the ISO 3166-1 code TZDATA ITSELF assigns the zone in zone.tab. That
// deference is the whole rule here — no view is taken on any territorial question beyond
// what tzdata already encodes.
var ZONE_COUNTRY_OVERRIDE = {
    "Europe/Busingen": "Germany",      // DE exclave inside Switzerland, absent at 50m
    "Africa/Ceuta": "Spain",           // ES enclaves on the Moroccan coast, absent at 50m
    "Africa/El_Aaiun": "W. Sahara",    // EH; the city's point falls in Morocco's polygon
    "Asia/Jerusalem": "Israel",        // IL; the city's point falls in Palestine's polygon
    "Europe/Simferopol": "Ukraine"     // UA; Crimea is drawn as Russia at 50m
};

// Deprecated names the hash pass has to skip because their TZif file is shared with zones
// of other countries (see the ambiguity guard below), yet Intl still lists them, so a
// browser may report one. Each maps to a zone already in the table; only its COUNTRY is
// read, so any zone of the right country resolves identically.
var ALIAS_OVERRIDE = {
    "Africa/Asmera": "Africa/Asmara",         // Eritrea
    "America/Coral_Harbour": "America/Toronto",  // Nunavut, Canada
    "Asia/Rangoon": "Asia/Yangon",            // Myanmar
    "Pacific/Ponape": "Pacific/Pohnpei",      // Micronesia
    "Pacific/Truk": "Pacific/Chuuk"           // Micronesia
};

// Reviewed 2026-08-21: iso3166.tab and Natural Earth simply spell these differently, or
// the zone belongs to a microstate/dependency that 50m folds into its neighbour, which is
// the right answer at country granularity (Vatican → Italy). Listing them keeps the
// cross-check sharp: a run only reports mismatches nobody has looked at yet.
var ACCEPTED_MISMATCH = [
    "Pacific/Pago_Pago", "America/Kralendijk", "Indian/Cocos", "Africa/Kinshasa",
    "Africa/Lubumbashi", "Atlantic/Cape_Verde", "Indian/Christmas", "Atlantic/Faroe",
    "Europe/London", "America/Cayenne", "Europe/Gibraltar", "America/Guadeloupe",
    "Africa/Malabo", "Atlantic/South_Georgia", "Indian/Chagos", "Asia/Pyongyang",
    "Asia/Seoul", "America/St_Lucia", "America/Marigot", "Asia/Macau", "Pacific/Saipan",
    "America/Martinique", "Pacific/Tahiti", "Pacific/Marquesas", "Indian/Reunion",
    "Atlantic/St_Helena", "Arctic/Longyearbyen", "Africa/Juba", "America/Lower_Princes",
    "Indian/Kerguelen", "Asia/Dili", "Europe/Vatican", "America/St_Vincent",
    "America/Tortola", "America/St_Thomas", "Indian/Mayotte"
];

/** "+4230" / "-03352" (±DDMM[SS], ±DDDMM[SS]) → signed decimal degrees. */
function degrees(field, digits) {
    var sign = field[0] === "-" ? -1 : 1;
    var d = +field.slice(1, 1 + digits);
    var m = +field.slice(1 + digits, 3 + digits);
    var s = +(field.slice(3 + digits, 5 + digits) || 0);
    return sign * (d + m / 60 + s / 3600);
}

function tabRows(file) {
    return fs.readFileSync(path.join(ZONEINFO, file), "utf8")
        .split("\n")
        .filter(function (line) { return line && line[0] !== "#"; })
        .map(function (line) { return line.split("\t"); });
}

// ------------------------------------------------------------------------------------
// Inputs

var isoNames = {};
tabRows("iso3166.tab").forEach(function (r) { isoNames[r[0]] = r[1]; });

var zones = tabRows("zone.tab").map(function (r) {
    var coord = r[1].match(/^([+-]\d+)([+-]\d+)$/);
    return {
        name: r[2],
        cc: r[0],
        // latitude is ±DD MM [SS], longitude ±DDD MM [SS]
        point: [degrees(coord[2], 3), degrees(coord[1], 2)]
    };
});

var topo = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/countries-50m.json")));
var countries = topojson.feature(topo, topo.objects.countries).features;

// ------------------------------------------------------------------------------------
// Resolve each zone to a country polygon

/** Ring search outward from the zone's city; the first polygon that contains a probe wins. */
function locate(point) {
    var lonScale = 1 / Math.max(0.2, Math.cos(point[1] * Math.PI / 180));  // keep rings ~circular in km
    for (var i = 0; i < SNAP_RINGS.length; i++) {
        var r = SNAP_RINGS[i];
        for (var a = 0; a < (r === 0 ? 1 : 16); a++) {
            var θ = a / 16 * 2 * Math.PI;
            var probe = [point[0] + Math.cos(θ) * r * lonScale, point[1] + Math.sin(θ) * r];
            for (var c = 0; c < countries.length; c++) {
                if (d3.geoContains(countries[c], probe)) return {country: countries[c], snap: r};
            }
        }
    }
    return null;
}

/** Loose name equality, only to flag suspicious resolutions for human review. */
function sameCountry(a, b) {
    function norm(s) {
        return s.toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .replace(/\b(the|of|and|republic|democratic|people's|state|states|islands?)\b/g, "")
            .replace(/[^a-z]/g, "");
    }
    var x = norm(a), y = norm(b);
    return x === y || (x.length > 3 && y.length > 3 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0));
}

var byName = {};
countries.forEach(function (f) { byName[f.properties.name] = f; });

Object.keys(ZONE_COUNTRY_OVERRIDE).concat(MAINLAND_ONLY).forEach(function (k) {
    var name = ZONE_COUNTRY_OVERRIDE[k] || k;
    if (!byName[name]) throw new Error("no country named '" + name + "' in countries-50m.json — " +
        "the topology changed and the override list in this script needs revisiting");
});

/** Sub-polygons of a feature, each as its own Polygon geometry. */
function parts(f) {
    var g = f.geometry;
    return (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map(function (coordinates) {
        return {type: "Polygon", coordinates: coordinates};
    });
}

function centerOf(f) {
    var target = f;
    if (MAINLAND_ONLY.indexOf(f.properties.name) >= 0) {
        target = parts(f).reduce(function (best, p) {
            return !best || d3.geoArea(p) > d3.geoArea(best) ? p : best;
        }, null);
    }
    return d3.geoCentroid(target);
}

var centroids = {};   // country name → [lon, lat], rounded
var byCountry = {};   // country name → [zone names]
var suspect = [], orphans = [];

zones.forEach(function (z) {
    var forced = ZONE_COUNTRY_OVERRIDE[z.name];
    var hit = forced ? {country: byName[forced], snap: 0} : locate(z.point);
    var label, center;
    if (hit) {
        label = hit.country.properties.name;
        center = centerOf(hit.country);
        var expected = isoNames[z.cc];
        if (!forced && expected && !sameCountry(label, expected) &&
                ACCEPTED_MISMATCH.indexOf(z.name) < 0) {
            suspect.push(z.name + " (" + z.cc + " " + expected + ") → " + label +
                " snap=" + hit.snap.toFixed(2) + "°");
        }
    }
    else {
        // Microstates absent from the 50m topology (Nauru, Tuvalu, Tokelau, …). The
        // zone's own city IS the country centre at this granularity.
        label = isoNames[z.cc] || z.cc;
        center = z.point;
        orphans.push(z.name + " (" + z.cc + " " + label + ")");
    }
    centroids[label] = [Math.round(center[0]), Math.round(center[1])];
    (byCountry[label] = byCountry[label] || []).push(z.name);
});

// ------------------------------------------------------------------------------------
// Legacy aliases, recovered by hashing the TZif binaries
//
// tzdata ships backward-compatibility names as links, so an alias is byte-identical
// to its target. posix/ and right/ are whole duplicate trees and are skipped. A hash
// group is only harvested when every zone in it that we ALREADY resolved belongs to
// one country: merged-but-distinct zones share a file too (Europe/Stockholm is a link
// to Europe/Berlin in current tzdata), so an ambiguous group like CET would otherwise
// hand Swedish visitors a German view.

var crypto = require("crypto");
var byHash = {};

(function walk(dir) {
    fs.readdirSync(dir, {withFileTypes: true}).forEach(function (entry) {
        var full = path.join(dir, entry.name);
        var rel = path.relative(ZONEINFO, full);
        if (rel === "posix" || rel === "right") return;
        if (entry.isDirectory()) return walk(full);
        // Zone identifiers are capitalised; a lowercase name is tzdata plumbing
        // ("posixrules" is a copy of America/New_York and is not a zone anyone can report).
        if (/^[a-z]/.test(entry.name)) return;
        var buf = fs.readFileSync(full);
        if (buf.slice(0, 4).toString() !== "TZif") return;  // skip tab files, leapseconds, tzdata.zi
        var h = crypto.createHash("sha1").update(buf).digest("hex");
        (byHash[h] = byHash[h] || []).push(rel);
    });
})(ZONEINFO);

var zoneCountry = {};
Object.keys(byCountry).forEach(function (label) {
    byCountry[label].forEach(function (z) { zoneCountry[z] = label; });
});

var aliases = 0, ambiguous = [];
Object.keys(byHash).forEach(function (h) {
    var group = byHash[h];
    var known = group.filter(function (z) { return zoneCountry[z]; });
    var unknown = group.filter(function (z) { return !zoneCountry[z]; });
    if (!known.length || !unknown.length) return;
    var labels = known.map(function (z) { return zoneCountry[z]; })
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (labels.length !== 1) {
        ambiguous.push(unknown.join(", ") + " ↔ " + labels.join(" / "));
        return;
    }
    unknown.forEach(function (z) {
        byCountry[labels[0]].push(z);
        zoneCountry[z] = labels[0];
        aliases++;
    });
});

Object.keys(ALIAS_OVERRIDE).forEach(function (alias) {
    var label = zoneCountry[ALIAS_OVERRIDE[alias]];
    if (!label) throw new Error("alias target '" + ALIAS_OVERRIDE[alias] + "' for '" + alias +
        "' is not in the table — tzdata renamed it and ALIAS_OVERRIDE needs updating");
    if (zoneCountry[alias]) return;  // the hash pass already got it unambiguously
    byCountry[label].push(alias);
    zoneCountry[alias] = label;
    aliases++;
});

// ------------------------------------------------------------------------------------
// Report

console.log("countries: " + Object.keys(byCountry).length +
    "   zones: " + zones.length + " + " + aliases + " aliases");

if (orphans.length) {
    console.log("\nnot in the 50m topology, using the zone's own city (" + orphans.length + "):");
    orphans.forEach(function (o) { console.log("  " + o); });
}
if (suspect.length) {
    console.log("\nNAME MISMATCH vs iso3166.tab — review (" + suspect.length + "):");
    suspect.forEach(function (s) { console.log("  " + s); });
}
if (ambiguous.length) {
    console.log("\nambiguous aliases, left out on purpose (" + ambiguous.length + "):");
    ambiguous.forEach(function (a) { console.log("  " + a); });
}

// Anything the running engine could report that the table would miss. Expected to be
// empty: every zone this Node's Intl lists should resolve, or a visitor in that zone
// silently falls back to wind.js's hardcoded default centre.
var missing = Intl.supportedValuesOf("timeZone").filter(function (z) { return !zoneCountry[z]; });
console.log("\nzones Intl knows but the table lacks (" + missing.length + "): " +
    (missing.join(", ") || "none"));

if (suspect.length || missing.length) {
    console.log("\nreview the above, then add to ACCEPTED_MISMATCH / ALIAS_OVERRIDE");
}
if (process.argv.indexOf("--check") >= 0) process.exit(suspect.length || missing.length ? 1 : 0);

// ------------------------------------------------------------------------------------
// Emit

var lines = Object.keys(byCountry).sort().map(function (label) {
    var c = centroids[label];
    return '    "' + byCountry[label].sort().join(" ") + '": [' + c[0] + ", " + c[1] + "],  // " + label;
});

fs.writeFileSync(OUT,
    '/**\n' +
    ' * tz-centers.js — IANA timezone → country centre, [longitude, latitude] in whole\n' +
    ' * degrees. GENERATED by scripts/gen_tz_centers.js; do not edit by hand.\n' +
    ' *\n' +
    ' * js/wind.js reads Intl.DateTimeFormat().resolvedOptions().timeZone and looks it up\n' +
    ' * here to centre the globe near the visitor on a first, hash-free load. That needs no\n' +
    ' * permission prompt and no network request — nothing about the visitor leaves the\n' +
    ' * browser, not even to this site.\n' +
    ' *\n' +
    ' * Keys are space-separated zone lists (aliases included) and every zone of a country\n' +
    ' * shares one centre, so the view narrows a visitor no further than their country.\n' +
    ' * Each centre is the spherical centroid of that country in public/data/countries-50m.json,\n' +
    ' * the same topology the page draws.\n' +
    ' *\n' +
    ' * ' + Object.keys(byCountry).length + ' countries, ' + (zones.length + aliases) +
        ' zones, from tzdata ' + tzdataVersion() + '.\n' +
    ' */\n' +
    "window.TZ_COUNTRY_CENTERS = {\n" +
    lines.join("\n") + "\n" +
    "};\n");

function tzdataVersion() {
    for (var i = 0; i < 2; i++) {
        try {
            var text = fs.readFileSync(path.join(ZONEINFO, i ? "+VERSION" : "tzdata.zi"), "utf8");
            var m = text.match(/^#\s*version\s+(\S+)/m);
            return m ? m[1] : text.trim();
        }
        catch (e) { /* try the next candidate */ }
    }
    return "unknown";
}

console.log("\nwrote " + path.relative(ROOT, OUT) + " (" + lines.length + " lines)");

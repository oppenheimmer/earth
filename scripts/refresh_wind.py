#!/usr/bin/env python3
"""
Refresh a wind dataset in public/data/ from the latest NOAA GFS run.

Downloads UGRD/VGRD at the requested level from the NOMADS grib filter (0.25° grid) and
writes them in grib2json-compatible format (the subset of header fields js/wind.js reads).
No Java/grib2json needed — decoding is done with pygrib.

Usage:
    python3 -m venv gribenv && ./gribenv/bin/pip install pygrib
    ./gribenv/bin/python scripts/refresh_wind.py                     # surface (10 m) wind
    ./gribenv/bin/python scripts/refresh_wind.py 500hpa              # a pressure level
    ./gribenv/bin/python scripts/refresh_wind.py 500hpa file.grib2   # convert a local GRIB2

Wind levels: surface, 1000hpa, 500hpa, 10hpa (see LEVELS — two records, u then v).
Scalar overlays: temperature, rh, dew (see SCALARS — one record, 2 m above ground).

Notes:
  - The `.anl` files do NOT expose 10 m winds through the filter CGI; use `f000`
    of the newest cycle instead (it is the analysis-hour forecast, effectively the same).
  - A new cycle's files appear on NOMADS ~3.5-5 h after the cycle time, so the script
    walks backwards through recent cycles until one responds with actual GRIB data.
"""
import json
import math
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone

import pygrib

BASE = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data")

# cgi: NOMADS filter level parameter; select: pygrib selector for the u record (the v
# record swaps shortName); surface1*: grib2json header values (informational — wind.js
# picks records by parameterCategory/Number only).
LEVELS = {
    "surface": {"cgi": "lev_10_m_above_ground", "select": {"shortName": "10u"},
                "out": "current-wind-surface-level-gfs-0.25.json",
                "surface1Type": 103, "surface1TypeName": "Specified height level above ground",
                "surface1Value": 10.0},
    "1000hpa": {"cgi": "lev_1000_mb", "select": {"shortName": "u", "level": 1000},
                "out": "current-wind-1000hpa-gfs-0.25.json",
                "surface1Type": 100, "surface1TypeName": "Isobaric surface",
                "surface1Value": 100000.0},
    "500hpa": {"cgi": "lev_500_mb", "select": {"shortName": "u", "level": 500},
               "out": "current-wind-500hpa-gfs-0.25.json",
               "surface1Type": 100, "surface1TypeName": "Isobaric surface",
               "surface1Value": 50000.0},
    "10hpa": {"cgi": "lev_10_mb", "select": {"shortName": "u", "level": 10},
              "out": "current-wind-10hpa-gfs-0.25.json",
              "surface1Type": 100, "surface1TypeName": "Isobaric surface",
              "surface1Value": 1000.0},
}

# Single-record scalar overlay products (all 2 m above ground). param: grib2json header
# identity (wind.js's buildScalarGrid reads geometry only, but keep the metadata honest).
SCALARS = {
    "temperature": {"cgi": "lev_2_m_above_ground", "var": "var_TMP", "select": {"shortName": "2t"},
                    "out": "current-temp-surface-level-gfs-0.25.json",
                    "param": {"parameterCategory": 0, "parameterCategoryName": "Temperature",
                              "parameterNumber": 0, "parameterNumberName": "Temperature",
                              "parameterUnit": "K"}},
    "rh": {"cgi": "lev_2_m_above_ground", "var": "var_RH", "select": {"shortName": "2r"},
           "out": "current-rh-surface-level-gfs-0.25.json",
           "param": {"parameterCategory": 1, "parameterCategoryName": "Moisture",
                     "parameterNumber": 1, "parameterNumberName": "Relative_humidity",
                     "parameterUnit": "%"}},
    "dew": {"cgi": "lev_2_m_above_ground", "var": "var_DPT", "select": {"shortName": "2d"},
            "out": "current-dewpoint-surface-level-gfs-0.25.json",
            "param": {"parameterCategory": 0, "parameterCategoryName": "Temperature",
                      "parameterNumber": 6, "parameterNumberName": "Dew_point_temperature",
                      "parameterUnit": "K"}},
}
WIND_PARAM = {"parameterCategory": 2, "parameterCategoryName": "Momentum",
              "parameterUnit": "m.s-1"}


def candidate_cycles(now=None, count=8):
    """Yield (yyyymmdd, hh) for recent GFS cycles, newest first."""
    now = now or datetime.now(timezone.utc)
    # Latest cycle that could plausibly be published (files lag ~4 h behind cycle time).
    t = now - timedelta(hours=4)
    t = t.replace(hour=(t.hour // 6) * 6, minute=0, second=0, microsecond=0)
    for i in range(count):
        c = t - timedelta(hours=6 * i)
        yield c.strftime("%Y%m%d"), "%02d" % c.hour


def fetch_cycle(ymd, hh, dest, lev_param, var_params):
    url = (BASE + "?file=gfs.t{hh}z.pgrb2.0p25.f000"
           "&{lev}=on&{vars}"
           "&dir=%2Fgfs.{ymd}%2F{hh}%2Fatmos").format(
               ymd=ymd, hh=hh, lev=lev_param,
               vars="&".join(v + "=on" for v in var_params))
    try:
        with urllib.request.urlopen(url, timeout=90) as r:
            data = r.read()
    except Exception as e:
        print("  %s %sz: %s" % (ymd, hh, e))
        return False
    if len(data) < 10000 or not data.startswith(b"GRIB"):
        print("  %s %sz: not available yet (%d bytes)" % (ymd, hh, len(data)))
        return False
    with open(dest, "wb") as f:
        f.write(data)
    print("  %s %sz: downloaded %d bytes" % (ymd, hh, len(data)))
    return True


def record(grb, param, surface):
    lats, _ = grb.latlons()
    values = grb.values
    if lats[0, 0] < lats[-1, 0]:  # ensure scan mode 0: north -> south
        values = values[::-1]
    nj, ni = values.shape
    dx = 360.0 / ni
    dy = 180.0 / (nj - 1)
    ref = datetime(grb.year, grb.month, grb.day, grb.hour, tzinfo=timezone.utc)
    flat = [None if (isinstance(v, float) and math.isnan(v)) else round(float(v), 1)
            for v in values.flatten()]
    header = {
        "discipline": 0, "disciplineName": "Meteorological products",
        "refTime": ref.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "forecastTime": int(grb.forecastTime),
        "surface1Type": surface["surface1Type"], "surface1TypeName": surface["surface1TypeName"],
        "surface1Value": surface["surface1Value"],
        "gridDefinitionTemplate": 0, "numberPoints": ni * nj, "shape": 6,
        "scanMode": 0, "nx": ni, "ny": nj,
        "lo1": 0.0, "la1": 90.0, "lo2": 360.0 - dx, "la2": -90.0, "dx": dx, "dy": dy,
    }
    header.update(param)
    return {"header": header, "data": flat}


SURFACE_2M = {"surface1Type": 103, "surface1TypeName": "Specified height level above ground",
              "surface1Value": 2.0}


def main():
    args = sys.argv[1:]
    name = args.pop(0) if args and args[0] in (LEVELS.keys() | SCALARS.keys()) else "surface"
    product = LEVELS.get(name) or SCALARS[name]
    is_wind = name in LEVELS
    grib_path = args.pop(0) if args else None
    if grib_path:
        print("using local GRIB file: " + grib_path)
    else:
        grib_path = os.path.join(tempfile.gettempdir(), "gfs_0p25_f000_%s.grib2" % name)
        print("searching NOMADS for the newest published GFS cycle (%s)…" % name)
        var_params = ["var_UGRD", "var_VGRD"] if is_wind else [product["var"]]
        for ymd, hh in candidate_cycles():
            if fetch_cycle(ymd, hh, grib_path, product["cgi"], var_params):
                break
        else:
            sys.exit("no GFS cycle available — NOMADS unreachable or lagging")

    grbs = pygrib.open(grib_path)
    if is_wind:
        surface = {k: product[k] for k in ("surface1Type", "surface1TypeName", "surface1Value")}
        u_select = dict(product["select"])
        v_select = dict(u_select, shortName=u_select["shortName"].replace("u", "v"))
        u = grbs.select(**u_select)[0]
        v = grbs.select(**v_select)[0]
        out = [record(u, dict(WIND_PARAM, parameterNumber=2,
                              parameterNumberName="U-component_of_wind"), surface),
               record(v, dict(WIND_PARAM, parameterNumber=3,
                              parameterNumberName="V-component_of_wind"), surface)]
    else:
        grb = grbs.select(**product["select"])[0]
        out = [record(grb, product["param"], SURFACE_2M)]

    out_path = os.path.abspath(os.path.join(DATA_DIR, product["out"]))
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    h = out[0]["header"]
    print("wrote %s (%d KB) — %s +%dh, %dx%d grid" % (
        out_path, os.path.getsize(out_path) // 1024,
        h["refTime"], h["forecastTime"], h["nx"], h["ny"]))


if __name__ == "__main__":
    main()

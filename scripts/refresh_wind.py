#!/usr/bin/env python3
"""
Refresh public/data/current-wind-surface-level-gfs-0.25.json from the latest NOAA GFS run.

Downloads 10 m above-ground UGRD/VGRD from the NOMADS grib filter (0.25° grid) and writes
them in grib2json-compatible format (the subset of header fields js/wind.js reads).
No Java/grib2json needed — decoding is done with pygrib.

Usage:
    python3 -m venv gribenv && ./gribenv/bin/pip install pygrib
    ./gribenv/bin/python scripts/refresh_wind.py            # auto-download newest cycle
    ./gribenv/bin/python scripts/refresh_wind.py file.grib2 # convert a local GRIB2 file

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
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data",
                   "current-wind-surface-level-gfs-0.25.json")


def candidate_cycles(now=None, count=8):
    """Yield (yyyymmdd, hh) for recent GFS cycles, newest first."""
    now = now or datetime.now(timezone.utc)
    # Latest cycle that could plausibly be published (files lag ~4 h behind cycle time).
    t = now - timedelta(hours=4)
    t = t.replace(hour=(t.hour // 6) * 6, minute=0, second=0, microsecond=0)
    for i in range(count):
        c = t - timedelta(hours=6 * i)
        yield c.strftime("%Y%m%d"), "%02d" % c.hour


def fetch_cycle(ymd, hh, dest):
    url = (BASE + "?file=gfs.t{hh}z.pgrb2.0p25.f000"
           "&lev_10_m_above_ground=on&var_UGRD=on&var_VGRD=on"
           "&dir=%2Fgfs.{ymd}%2F{hh}%2Fatmos").format(ymd=ymd, hh=hh)
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


def record(grb, parameter_number):
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
    return {
        "header": {
            "discipline": 0, "disciplineName": "Meteorological products",
            "refTime": ref.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "parameterCategory": 2, "parameterCategoryName": "Momentum",
            "parameterNumber": parameter_number,
            "parameterNumberName": "U-component_of_wind" if parameter_number == 2 else "V-component_of_wind",
            "parameterUnit": "m.s-1",
            "forecastTime": int(grb.forecastTime),
            "surface1Type": 103, "surface1TypeName": "Specified height level above ground",
            "surface1Value": 10.0,
            "gridDefinitionTemplate": 0, "numberPoints": ni * nj, "shape": 6,
            "scanMode": 0, "nx": ni, "ny": nj,
            "lo1": 0.0, "la1": 90.0, "lo2": 360.0 - dx, "la2": -90.0, "dx": dx, "dy": dy,
        },
        "data": flat,
    }


def main():
    grib_path = sys.argv[1] if len(sys.argv) > 1 else None
    if grib_path:
        print("using local GRIB file: " + grib_path)
    else:
        grib_path = os.path.join(tempfile.gettempdir(), "gfs_0p25_f000.grib2")
        print("searching NOMADS for the newest published GFS cycle…")
        for ymd, hh in candidate_cycles():
            if fetch_cycle(ymd, hh, grib_path):
                break
        else:
            sys.exit("no GFS cycle available — NOMADS unreachable or lagging")

    grbs = pygrib.open(grib_path)
    u = grbs.select(shortName="10u")[0]
    v = grbs.select(shortName="10v")[0]
    out = [record(u, 2), record(v, 3)]

    out_path = os.path.abspath(OUT)
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    h = out[0]["header"]
    print("wrote %s (%d KB) — %s +%dh, %dx%d grid" % (
        out_path, os.path.getsize(out_path) // 1024,
        h["refTime"], h["forecastTime"], h["nx"], h["ny"]))


if __name__ == "__main__":
    main()

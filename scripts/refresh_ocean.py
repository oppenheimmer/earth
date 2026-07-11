#!/usr/bin/env python3
"""
Refresh the ocean-current dataset in public/data/ from CMEMS Global Ocean Physics
Analysis & Forecast (GLOBAL_ANALYSISFORECAST_PHY_001_024) — the same source
earth.nullschool.net uses for ocean currents.

Uses the official Copernicus Marine Toolbox, which needs credentials once:
    ./gribenv/bin/copernicusmarine login
(stored in $HOME/.copernicusmarine/), or the environment variables
COPERNICUSMARINE_SERVICE_USERNAME / COPERNICUSMARINE_SERVICE_PASSWORD.
Anonymous access does not work: the ARCO zarr store serves metadata and
coordinate arrays publicly but returns 403 for every data chunk.

Usage:
    python3 -m venv gribenv && ./gribenv/bin/pip install copernicusmarine
    ./gribenv/bin/python scripts/refresh_ocean.py               # today UTC
    ./gribenv/bin/python scripts/refresh_ocean.py 2026-07-11    # a specific day

Reads the 1/12° ARCO store and strides ×4 down to 1/3° (wind-file-sized output).
Output is grib2json-compatible u/v records (the subset of header fields js/wind.js
reads). Land cells are null, which the engine renders as uncolored. The dataset is
a daily mean; the store also holds ~8 days of forecast, which is deliberately
skipped — the newest day ≤ the requested day is used.
"""
import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np

DATASET_ID = "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m"
OUT = "current-ocean-currents-cmems-0.33.json"
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data")


def fetch(day):
    """Latest daily mean ≤ day from the credentialed 1/12° store, strided to 1/3°."""
    import copernicusmarine
    ds = copernicusmarine.open_dataset(
        dataset_id=DATASET_ID, variables=["uo", "vo"],
        minimum_depth=0, maximum_depth=1)  # only the 0.494 m surface bin
    idx = int(np.searchsorted(ds.time.values, day + np.timedelta64(1, "h"))) - 1
    if idx < 0:
        sys.exit("no CMEMS data on or before %s" % day)
    when = ds.time.values[idx]
    sel = ds.isel(time=idx, depth=0)
    # 1/12° is 4320x2041; every 4th point lands exactly on the 1/3° grid (2040 % 4 == 0)
    u = sel.uo.values[::4, ::4]
    v = sel.vo.values[::4, ::4]
    lat = sel.latitude.values[::4]
    lon = sel.longitude.values[::4]
    return u, v, lat, lon, when


def record(values, lat, lon, when, param_number, param_name):
    ny, nx = values.shape
    dx = 360.0 / nx
    dy = (float(lat[-1]) - float(lat[0])) / (ny - 1)
    flat = [None if math.isnan(v) else round(float(v), 3) for v in values.flatten()]
    return {"header": {
        "discipline": 10, "disciplineName": "Oceanographic products",
        "refTime": str(when)[:10] + "T00:00:00.000Z",
        "forecastTime": 0,
        "surface1Type": 160, "surface1TypeName": "Depth below sea level",
        "surface1Value": 0.494,
        "gridDefinitionTemplate": 0, "numberPoints": nx * ny, "shape": 6,
        "scanMode": 0, "nx": nx, "ny": ny,
        "lo1": float(lon[0]), "la1": float(lat[-1]),          # north-first origin
        "lo2": float(lon[0]) + (nx - 1) * dx, "la2": float(lat[0]),
        "dx": dx, "dy": dy,
        # category/number 2/2 and 2/3 are what js/wind.js keys the u/v records on
        "parameterCategory": 2, "parameterCategoryName": "Currents",
        "parameterNumber": param_number, "parameterNumberName": param_name,
        "parameterUnit": "m.s-1",
    }, "data": flat}


def main():
    args = sys.argv[1:]
    day = np.datetime64(args[0] if args else
                        datetime.now(timezone.utc).strftime("%Y-%m-%d"))

    print("fetching CMEMS surface currents (%s) via Copernicus Marine Toolbox…" % day)
    u, v, lat, lon, when = fetch(day)
    u, v = u[::-1], v[::-1]  # store is south-first; wind.js expects scan mode 0 (north-first)

    out = [record(u, lat, lon, when, 2, "U-component_of_current"),
           record(v, lat, lon, when, 3, "V-component_of_current")]
    out_path = os.path.abspath(os.path.join(DATA_DIR, OUT))
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    h = out[0]["header"]
    print("wrote %s (%d KB) — %s, %dx%d grid" % (
        out_path, os.path.getsize(out_path) // 1024, h["refTime"], h["nx"], h["ny"]))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Refresh an ocean dataset in public/data/ from CMEMS Global Ocean Physics
Analysis & Forecast (GLOBAL_ANALYSISFORECAST_PHY_001_024) — the same source
earth.nullschool.net uses for ocean currents.

Products (see PRODUCTS):
    currents      uo/vo surface currents, two-record u/v file
    temperature   thetao sea water potential temperature (°C), single record

Uses the official Copernicus Marine Toolbox, which needs credentials: locally
    set -a && source .env/copernicusmarine && set +a
(the git-ignored file holds COPERNICUSMARINE_SERVICE_USERNAME / _PASSWORD, the
env vars the toolbox reads; in CI they become repository secrets). Anonymous
access does not work: the ARCO zarr store serves metadata and coordinate arrays
publicly but returns 403 for every data chunk.

Usage:
    python3 -m venv gribenv && ./gribenv/bin/pip install copernicusmarine
    ./gribenv/bin/python scripts/refresh_ocean.py                    # currents, today UTC
    ./gribenv/bin/python scripts/refresh_ocean.py temperature        # SST
    ./gribenv/bin/python scripts/refresh_ocean.py currents 2026-07-11

Reads the 1/12° ARCO store and strides ×4 down to 1/3° (wind-file-sized output).
Depth: index 0 = 0.494 m (the store has 50 levels down to 5728 m — deeper layers
are a minimum_depth/maximum_depth change away). Output is grib2json-compatible
(the subset of header fields js/wind.js reads). Land cells are null, which the
engine renders as charcoal. The dataset is a daily mean; the store also holds
~8 days of forecast, which is deliberately skipped — the newest day ≤ the
requested day is used.
"""
import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np

# params: grib2json header identities, one per variable. wind.js keys u/v records on
# parameterCategory 2 / parameterNumber 2·3 and reads geometry only for scalars —
# keep the rest honest.
PRODUCTS = {
    "currents": {
        "dataset_id": "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m",
        "variables": ["uo", "vo"],
        "out": "current-ocean-currents-cmems-0.33.json",
        "params": [{"parameterCategory": 2, "parameterCategoryName": "Currents",
                    "parameterNumber": 2, "parameterNumberName": "U-component_of_current",
                    "parameterUnit": "m.s-1"},
                   {"parameterCategory": 2, "parameterCategoryName": "Currents",
                    "parameterNumber": 3, "parameterNumberName": "V-component_of_current",
                    "parameterUnit": "m.s-1"}],
    },
    "temperature": {
        "dataset_id": "cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m",
        "variables": ["thetao"],
        "out": "current-ocean-temp-cmems-0.33.json",
        "params": [{"parameterCategory": 4, "parameterCategoryName": "Sub-surface properties",
                    "parameterNumber": 18, "parameterNumberName": "Sea_water_potential_temperature",
                    "parameterUnit": "degC"}],
    },
}
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data")


def fetch(product, day):
    """Latest daily mean ≤ day from the credentialed 1/12° store, strided to 1/3°."""
    import copernicusmarine
    ds = copernicusmarine.open_dataset(
        dataset_id=product["dataset_id"], variables=product["variables"],
        minimum_depth=0, maximum_depth=1)  # only the 0.494 m surface bin
    idx = int(np.searchsorted(ds.time.values, day + np.timedelta64(1, "h"))) - 1
    if idx < 0:
        sys.exit("no CMEMS data on or before %s" % day)
    when = ds.time.values[idx]
    sel = ds.isel(time=idx, depth=0)
    # 1/12° is 4320x2041; every 4th point lands exactly on the 1/3° grid (2040 % 4 == 0)
    fields = [sel[v].values[::4, ::4] for v in product["variables"]]
    return fields, sel.latitude.values[::4], sel.longitude.values[::4], when


def record(values, lat, lon, when, param):
    ny, nx = values.shape
    dx = 360.0 / nx
    dy = (float(lat[-1]) - float(lat[0])) / (ny - 1)
    flat = [None if math.isnan(v) else round(float(v), 3) for v in values.flatten()]
    header = {
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
    }
    header.update(param)
    return {"header": header, "data": flat}


def main():
    args = sys.argv[1:]
    name = args.pop(0) if args and args[0] in PRODUCTS else "currents"
    product = PRODUCTS[name]
    day = np.datetime64(args[0] if args else
                        datetime.now(timezone.utc).strftime("%Y-%m-%d"))

    print("fetching CMEMS %s (%s) via Copernicus Marine Toolbox…" % (name, day))
    fields, lat, lon, when = fetch(product, day)
    out = [record(f[::-1], lat, lon, when, p)  # [::-1]: store is south-first; wind.js
           for f, p in zip(fields, product["params"])]  # expects scan mode 0 (north-first)

    out_path = os.path.abspath(os.path.join(DATA_DIR, product["out"]))
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    h = out[0]["header"]
    print("wrote %s (%d KB) — %s, %dx%d grid" % (
        out_path, os.path.getsize(out_path) // 1024, h["refTime"], h["nx"], h["ny"]))


if __name__ == "__main__":
    main()

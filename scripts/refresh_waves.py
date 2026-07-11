#!/usr/bin/env python3
"""
Refresh the ocean-wave datasets in public/data/ from the latest NOAA GFS-Wave run
(WAVEWATCH III, the wave component of GFS since v16 — the same source
earth.nullschool.net credits for its waves modes). Anonymous NOMADS access, no
credentials needed.

Downloads HTSGW (significant height of combined wind waves and swell), PERPW
(primary wave mean period) and DIRPW (primary wave direction) at f000 of the
newest published cycle, and writes two grib2json-compatible files:

    current-ocean-waves-gfswave-0.25.json        u/v "wave motion" records
    current-ocean-wave-height-gfswave-0.25.json  HTSGW scalar (m)

The wave-motion vectors point in the propagation direction (DIRPW is the
meteorological "direction from", so propagation = from + 180°) and their
MAGNITUDE IS THE PEAK PERIOD IN SECONDS: js/wind.js animates the dashes from
u/v and gets the Peak Wave Period overlay and the click readout for free via
its fromMagnitude machinery — no third data file.

Usage:
    python3 -m venv gribenv && ./gribenv/bin/pip install pygrib
    ./gribenv/bin/python scripts/refresh_waves.py                # newest cycle
    ./gribenv/bin/python scripts/refresh_waves.py file.grib2     # convert local GRIB2
"""
import json
import math
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import pygrib

BASE = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl"
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data")
FLOW_OUT = "current-ocean-waves-gfswave-0.25.json"
HEIGHT_OUT = "current-ocean-wave-height-gfswave-0.25.json"

WINDOW = 5  # coastal NaN-fill window (±2 cells), see dilate()


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
    url = (BASE + "?file=gfswave.t{hh}z.global.0p25.f000.grib2"
           "&var_HTSGW=on&var_PERPW=on&var_DIRPW=on"
           "&dir=%2Fgfs.{ymd}%2F{hh}%2Fwave%2Fgridded").format(ymd=ymd, hh=hh)
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


def dilate(a):
    """
    Fill each NaN cell with the mean of the finite cells in its WINDOW×WINDOW
    neighborhood. The wave model's land mask is a cell fatter than the vector
    coastline; without the fill the sea color retreats from every coast in
    charcoal staircase blocks (same bug the CMEMS layers hit, same cure —
    here at native 0.25° there is no coarsening, so a plain dilation pass).
    Applied to u/v (already vectors — averaging directions in degrees would
    break at the 0/360 wrap) and to the height field.
    """
    half = WINDOW // 2
    pad = np.pad(a, half, constant_values=np.nan)
    total = np.zeros(a.shape)
    count = np.zeros(a.shape)
    for dy in range(WINDOW):
        for dx in range(WINDOW):
            shifted = pad[dy:dy + a.shape[0], dx:dx + a.shape[1]]
            ok = np.isfinite(shifted)
            total[ok] += shifted[ok]
            count[ok] += 1
    filled = np.where(count > 0, total / np.maximum(count, 1), np.nan)
    return np.where(np.isnan(a), filled, a)


def field(grbs, short_name):
    """North-first masked field as a NaN-holed float array."""
    grb = grbs.select(shortName=short_name)[0]
    lats, _ = grb.latlons()
    values = grb.values
    if lats[0, 0] < lats[-1, 0]:  # ensure scan mode 0: north -> south
        values = values[::-1]
    return np.ma.filled(values.astype(float), np.nan), grb


def record(values, ref, param, unit_decimals=2):
    nj, ni = values.shape
    dx = 360.0 / ni
    dy = 180.0 / (nj - 1)
    flat = [None if math.isnan(v) else round(float(v), unit_decimals)
            for v in values.flatten()]
    header = {
        "discipline": 10, "disciplineName": "Oceanographic products",
        "refTime": ref.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "forecastTime": 0,
        "surface1Type": 1, "surface1TypeName": "Ground or water surface",
        "surface1Value": 0.0,
        "gridDefinitionTemplate": 0, "numberPoints": ni * nj, "shape": 6,
        "scanMode": 0, "nx": ni, "ny": nj,
        "lo1": 0.0, "la1": 90.0, "lo2": 360.0 - dx, "la2": -90.0, "dx": dx, "dy": dy,
    }
    header.update(param)
    return {"header": header, "data": flat}


def write(path, records):
    out_path = os.path.abspath(os.path.join(DATA_DIR, path))
    with open(out_path, "w") as f:
        json.dump(records, f, separators=(",", ":"))
    h = records[0]["header"]
    print("wrote %s (%d KB) — %s, %dx%d grid" % (
        out_path, os.path.getsize(out_path) // 1024, h["refTime"], h["nx"], h["ny"]))


def main():
    grib_path = sys.argv[1] if len(sys.argv) > 1 else None
    if grib_path:
        print("using local GRIB file: " + grib_path)
    else:
        grib_path = os.path.join(tempfile.gettempdir(), "gfswave_0p25_f000.grib2")
        print("searching NOMADS for the newest published GFS-Wave cycle…")
        for ymd, hh in candidate_cycles():
            if fetch_cycle(ymd, hh, grib_path):
                break
        else:
            sys.exit("no GFS-Wave cycle available — NOMADS unreachable or lagging")

    grbs = pygrib.open(grib_path)
    height, grb = field(grbs, "swh")
    period, _ = field(grbs, "perpw")
    direction, _ = field(grbs, "dirpw")
    ref = datetime(grb.year, grb.month, grb.day, grb.hour, tzinfo=timezone.utc)

    # Propagation vector with |v| = period: DIRPW is "direction from" (checked against
    # the Southern Ocean westerlies: median 265° = from the west, marching east).
    rad = np.radians(direction)
    u = dilate(-period * np.sin(rad))
    v = dilate(-period * np.cos(rad))
    height = dilate(height)

    wave_param = {"parameterCategory": 2, "parameterCategoryName": "Currents",
                  "parameterUnit": "s"}  # category/number 2·3 is wind.js's u/v contract;
    write(FLOW_OUT, [                     # the magnitude is the peak period, seconds
        record(u, ref, dict(wave_param, parameterNumber=2,
                            parameterNumberName="U-component_of_wave_motion")),
        record(v, ref, dict(wave_param, parameterNumber=3,
                            parameterNumberName="V-component_of_wave_motion")),
    ])
    write(HEIGHT_OUT, [record(height, ref, {
        "parameterCategory": 0, "parameterCategoryName": "Waves",
        "parameterNumber": 3,
        "parameterNumberName": "Significant_height_of_combined_wind_waves_and_swell",
        "parameterUnit": "m"})])


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Refresh ocean datasets in public/data/ from CMEMS Global Ocean Physics
Analysis & Forecast (GLOBAL_ANALYSISFORECAST_PHY_001_024) — the same source
earth.nullschool.net uses for ocean currents.

Products (see PRODUCTS):
    currents      uo/vo currents at 0.494 m (surface), two-record u/v file
    currents25    uo/vo currents at 25.211 m — near the mixed-layer base, where
                  the flow starts diverging from the wind-driven surface drift
    currents110   uo/vo currents at 109.729 m — below the seasonal thermocline
    currents450   uo/vo currents at 453.938 m — intermediate water, essentially
                  no wind-driven signal left
    temperature   thetao sea water potential temperature (°C), single record

Uses the official Copernicus Marine Toolbox, which needs credentials: locally
    set -a && source .env/copernicusmarine && set +a

(the git-ignored file holds COPERNICUSMARINE_SERVICE_USERNAME / _PASSWORD, the
env vars the toolbox reads; in CI they become repository secrets). Anonymous
access does not work: the ARCO zarr store serves metadata and coordinate arrays
publicly but returns 403 for every data chunk.

Usage:
    python3 -m venv gribenv
    ./gribenv/bin/pip install copernicusmarine

    # Refresh ALL three products for today UTC:
    ./gribenv/bin/python scripts/refresh_ocean.py

    # Refresh ALL three products for a specific date:
    ./gribenv/bin/python scripts/refresh_ocean.py 2026-07-11

    # Refresh only one product for today UTC:
    ./gribenv/bin/python scripts/refresh_ocean.py currents
    ./gribenv/bin/python scripts/refresh_ocean.py currents25
    ./gribenv/bin/python scripts/refresh_ocean.py temperature

    # Refresh only one product for a specific date:
    ./gribenv/bin/python scripts/refresh_ocean.py currents 2026-07-11

Reads the 1/12° ARCO store and coarsens x3 down to 1/4° (atmosphere-grid parity).

Depth:
    Surface level = approximately 0.494025 m.
    The store has 50 levels down to approximately 5728 m.

Output is grib2json-compatible (the subset of header fields js/wind.js reads).
Land cells are null, which the engine renders as charcoal.

The dataset is a daily mean; the store also holds ~8 forecast days. The open
is pinned to a single day (start/end datetime) so only that day's chunks are
transferred — an unpinned open is chunked 50 time steps deep and downloads
~990 MB per variable to keep ~20 MB. A walk-back tries earlier days, newest
first, so the newest day <= the requested day is used; it raises after 8
misses rather than silently serving old data.
"""

import json
import math
import os
import sys
import threading
import time
from datetime import datetime, timezone

import numpy as np


# ---------------------------------------------------------------------------
# Copernicus depth selection
# ---------------------------------------------------------------------------

# The shallowest coordinate in this CMEMS dataset is approximately:
#
#     0.49402499198913574 m
#
# Asking Copernicus for [0, 1] works, but produces a warning because 0.0 m is
# outside the actual dataset coordinate range. This interval cleanly brackets
# the real surface depth without exceeding the dataset bounds.
SURFACE_DEPTH = (0.494, 0.495)

# A depth bracket MUST contain exactly one of the store's 50 levels. fetch()
# below takes isel(depth=0), so a bracket catching two levels would silently
# ship the shallower one under the deeper one's name; check_single_depth()
# turns that into a hard error. The levels near the shipped layers are:
#
#     … 21.599, 25.211, 29.445 …   92.326, 109.729, 130.666 …
#                                 380.213, 453.938, 541.089 …


# ---------------------------------------------------------------------------
# GRIB parameter identities
# ---------------------------------------------------------------------------

CURRENT_PARAMS = [
    {
        "parameterCategory": 2,
        "parameterCategoryName": "Currents",
        "parameterNumber": 2,
        "parameterNumberName": "U-component_of_current",
        "parameterUnit": "m.s-1",
    },
    {
        "parameterCategory": 2,
        "parameterCategoryName": "Currents",
        "parameterNumber": 3,
        "parameterNumberName": "V-component_of_current",
        "parameterUnit": "m.s-1",
    },
]


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------

PRODUCTS = {
    "currents": {
        "dataset_id": "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m",
        "variables": ["uo", "vo"],
        "depth": SURFACE_DEPTH,
        "out": "current-ocean-currents-cmems-0.25.json",
        "params": CURRENT_PARAMS,
    },
    "currents25": {
        "dataset_id": "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m",
        "variables": ["uo", "vo"],
        "depth": (23, 27),  # only the 25.211 m level
        "out": "current-ocean-currents-25m-cmems-0.25.json",
        "params": CURRENT_PARAMS,
    },
    "currents110": {
        "dataset_id": "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m",
        "variables": ["uo", "vo"],
        "depth": (100, 120),  # only the 109.729 m level
        "out": "current-ocean-currents-110m-cmems-0.25.json",
        "params": CURRENT_PARAMS,
    },
    "currents450": {
        "dataset_id": "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m",
        "variables": ["uo", "vo"],
        "depth": (420, 490),  # only the 453.938 m level
        "out": "current-ocean-currents-450m-cmems-0.25.json",
        "params": CURRENT_PARAMS,
    },
    "temperature": {
        "dataset_id": "cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m",
        "variables": ["thetao"],
        "depth": SURFACE_DEPTH,
        "out": "current-ocean-temp-cmems-0.25.json",
        "params": [
            {
                "parameterCategory": 4,
                "parameterCategoryName": "Sub-surface properties",
                "parameterNumber": 18,
                "parameterNumberName": "Sea_water_potential_temperature",
                "parameterUnit": "degC",
            }
        ],
    },
}


DATA_DIR = os.path.join(
    os.path.dirname(__file__),
    "..",
    "public",
    "data",
)

# 1/12 degree -> 1/4 degree.
STRIDE = 3

# NaN-fill window in full-resolution cells.
WINDOW = 7


# ---------------------------------------------------------------------------
# Progress helpers
# ---------------------------------------------------------------------------

def human_size(num_bytes):
    """Return a human-readable byte count."""
    size = float(num_bytes)

    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024.0 or unit == "TB":
            return "%.1f %s" % (size, unit)
        size /= 1024.0

    return "%.1f TB" % size


def run_with_progress(label, func):
    """Run func() while displaying a spinner and elapsed time."""
    start = time.monotonic()

    # Avoid noisy carriage-return output in CI / redirected logs.
    if not sys.stdout.isatty():
        print("%s ..." % label, flush=True)
        try:
            result = func()
        except Exception:
            elapsed = time.monotonic() - start
            print("%s FAILED (%.1fs)" % (label, elapsed), flush=True)
            raise

        elapsed = time.monotonic() - start
        print("%s done (%.1fs)" % (label, elapsed), flush=True)
        return result

    stop_event = threading.Event()

    def spinner():
        frames = "|/-\\"
        frame = 0

        while not stop_event.wait(0.2):
            elapsed = int(time.monotonic() - start)
            sys.stdout.write(
                "\r%s %s %ds elapsed"
                % (label, frames[frame % len(frames)], elapsed)
            )
            sys.stdout.flush()
            frame += 1

    spinner_thread = threading.Thread(target=spinner, daemon=True)
    spinner_thread.start()

    try:
        result = func()
    except Exception:
        stop_event.set()
        spinner_thread.join()
        elapsed = time.monotonic() - start
        sys.stdout.write(
            "\r%s FAILED (%.1fs)%s\n"
            % (label, elapsed, " " * 30)
        )
        sys.stdout.flush()
        raise
    else:
        stop_event.set()
        spinner_thread.join()

    elapsed = time.monotonic() - start
    sys.stdout.write(
        "\r%s done (%.1fs)%s\n"
        % (label, elapsed, " " * 30)
    )
    sys.stdout.flush()

    return result


# ---------------------------------------------------------------------------
# Grid coarsening
# ---------------------------------------------------------------------------

def coarsen(full):
    """
    1/12 degree -> 1/4 degree.

    Sample every STRIDE-th point, but where the sampled point is land (NaN),
    fall back to the mean of the surrounding WINDOW x WINDOW full-resolution
    window.
    """
    sampled = full[::STRIDE, ::STRIDE]
    half = WINDOW // 2

    pad = np.pad(
        full,
        half,
        constant_values=np.nan,
    )

    total = np.zeros(sampled.shape)
    count = np.zeros(sampled.shape)

    for dy in range(WINDOW):
        for dx in range(WINDOW):
            shifted = pad[
                dy:dy + full.shape[0]:STRIDE,
                dx:dx + full.shape[1]:STRIDE,
            ]

            ok = np.isfinite(shifted)
            total[ok] += shifted[ok]
            count[ok] += 1

    filled = np.where(
        count > 0,
        total / np.maximum(count, 1),
        np.nan,
    )

    return np.where(
        np.isnan(sampled),
        filled,
        sampled,
    )


# ---------------------------------------------------------------------------
# Copernicus fetch
# ---------------------------------------------------------------------------

def candidate_days(day, count=8):
    """Yield days, newest first, from the requested day backwards."""
    for i in range(count):
        yield day - np.timedelta64(i, "D")


def fetch(product, day):
    """
    Fetch the latest daily mean <= day from the credentialed CMEMS 1/12-degree
    store and coarsen it to 1/4 degree.
    """
    import copernicusmarine

    print()
    print("[CMEMS] Dataset: %s" % product["dataset_id"])
    print("[CMEMS] Variables: %s" % ", ".join(product["variables"]))
    print(
        "[CMEMS] Requested depth range: %.3f - %.3f m"
        % (product["depth"][0], product["depth"][1])
    )
    print("[CMEMS] Requested date: %s" % day)
    print()

    def open_remote_dataset(pinned_day):
        # Pinning start/end to one day keeps the transfer to that day's
        # chunks; without it xarray materialises 50-step time chunks.
        return copernicusmarine.open_dataset(
            dataset_id=product["dataset_id"],
            variables=product["variables"],
            minimum_depth=product["depth"][0],
            maximum_depth=product["depth"][1],
            start_datetime=str(pinned_day),
            end_datetime=str(pinned_day),
        )

    # A day outside the store's time range raises (time is not clamped the
    # way depth is), so step back a day at a time until one opens.
    for candidate in candidate_days(day):
        try:
            ds = run_with_progress(
                "[CMEMS] Opening remote dataset for %s" % candidate,
                lambda pinned_day=candidate: open_remote_dataset(pinned_day),
            )
        except copernicusmarine.CoordinatesOutOfDatasetBounds:
            print("[CMEMS] No record for %s; stepping back a day." % candidate)
            continue

        if ds.sizes.get("time", 0) == 0:
            print("[CMEMS] No record for %s; stepping back a day." % candidate)
            continue

        break
    else:
        raise RuntimeError(
            "no CMEMS daily mean within 8 days on or before %s" % day
        )

    print()
    print("[CMEMS] Dataset opened successfully.")

    try:
        print("[CMEMS] Dataset dimensions:")
        for dimension, size in ds.sizes.items():
            print("        %-12s %s" % (dimension, size))
    except Exception:
        pass

    print()

    when = ds.time.values[0]
    # isel(depth=0) takes the shallowest level in the bracket, so a bracket that
    # caught more than one would quietly write the wrong depth under the right
    # filename. Fail loudly instead — see the note beside SURFACE_DEPTH.
    n_depth = int(ds.sizes.get("depth", 0))
    if n_depth != 1:
        raise RuntimeError(
            "depth bracket %.3f-%.3f m selected %d levels (%s); it must select "
            "exactly one" % (
                product["depth"][0], product["depth"][1], n_depth,
                ", ".join("%.3f" % v for v in np.atleast_1d(ds.depth.values)),
            )
        )
    sel = ds.isel(time=0, depth=0)
    selected_depth = float(sel.depth.values)

    print("[CMEMS] Selected record: %s" % when)
    print("[CMEMS] Selected depth: %.6f m" % selected_depth)

    try:
        ny = len(sel.latitude)
        nx = len(sel.longitude)
        print(
            "[CMEMS] Full-resolution grid: %d x %d = %s points"
            % (nx, ny, format(nx * ny, ","))
        )
    except Exception:
        pass

    print()

    fields = []
    total_variables = len(product["variables"])

    for variable_index, variable in enumerate(
        product["variables"],
        start=1,
    ):
        print(
            "[CMEMS] Variable %d/%d: %s"
            % (variable_index, total_variables, variable)
        )

        def load_variable(v=variable):
            return sel[v].values

        full = run_with_progress(
            "[CMEMS] Downloading %s" % variable,
            load_variable,
        )

        print(
            "[CMEMS] %s downloaded: shape=%s, memory=%s"
            % (variable, full.shape, human_size(full.nbytes))
        )

        finite_count = int(np.count_nonzero(np.isfinite(full)))
        total_count = int(full.size)
        nan_count = total_count - finite_count

        print(
            "[CMEMS] %s cells: %s ocean / %s NaN-land"
            % (
                variable,
                format(finite_count, ","),
                format(nan_count, ","),
            )
        )

        def coarsen_variable(data=full):
            return coarsen(data)

        coarse = run_with_progress(
            "[CMEMS] Coarsening %s to 1/4 degree" % variable,
            coarsen_variable,
        )

        print(
            "[CMEMS] %s output grid: %s"
            % (variable, coarse.shape)
        )

        fields.append(coarse)
        del full
        print()

    lat = sel.latitude.values[::STRIDE]
    lon = sel.longitude.values[::STRIDE]

    print(
        "[CMEMS] Fetch complete: %d variable(s), depth %.6f m"
        % (len(fields), selected_depth)
    )

    return (
        fields,
        lat,
        lon,
        when,
        selected_depth,
    )


# ---------------------------------------------------------------------------
# Output record
# ---------------------------------------------------------------------------

def record(values, lat, lon, when, depth, param):
    ny, nx = values.shape
    dx = 360.0 / nx
    dy = (float(lat[-1]) - float(lat[0])) / (ny - 1)

    flat = [
        None if math.isnan(v)
        else round(float(v), 3)
        for v in values.flatten()
    ]

    header = {
        "discipline": 10,
        "disciplineName": "Oceanographic products",
        "refTime": str(when)[:10] + "T00:00:00.000Z",
        "forecastTime": 0,
        "surface1Type": 160,
        "surface1TypeName": "Depth below sea level",
        "surface1Value": round(depth, 3),
        "gridDefinitionTemplate": 0,
        "numberPoints": nx * ny,
        "shape": 6,
        "scanMode": 0,
        "nx": nx,
        "ny": ny,
        "lo1": float(lon[0]),
        "la1": float(lat[-1]),  # north-first origin
        "lo2": float(lon[0]) + (nx - 1) * dx,
        "la2": float(lat[0]),
        "dx": dx,
        "dy": dy,
    }

    header.update(param)

    return {
        "header": header,
        "data": flat,
    }


# ---------------------------------------------------------------------------
# Write one product
# ---------------------------------------------------------------------------

def refresh_product(name, product, day, product_number, product_count):
    """Fetch, transform, and write one configured product."""
    print()
    print("=" * 68)
    print(
        " PRODUCT %d/%d: %s"
        % (product_number, product_count, name)
    )
    print("=" * 68)

    product_start = time.monotonic()

    fields, lat, lon, when, depth = fetch(product, day)

    fetch_elapsed = time.monotonic() - product_start
    print()
    print(
        "[OUTPUT] Remote fetch + coarsening completed in %.1fs"
        % fetch_elapsed
    )

    print(
        "[OUTPUT] Converting %d field(s) to JSON records..."
        % len(fields),
        flush=True,
    )

    record_start = time.monotonic()

    # Store is south-first; wind.js expects scan mode 0 / north-first.
    out = [
        record(
            field[::-1],
            lat,
            lon,
            when,
            depth,
            param,
        )
        for field, param in zip(fields, product["params"])
    ]

    record_elapsed = time.monotonic() - record_start
    print(
        "[OUTPUT] JSON records prepared in %.1fs"
        % record_elapsed
    )

    os.makedirs(DATA_DIR, exist_ok=True)

    out_path = os.path.abspath(
        os.path.join(DATA_DIR, product["out"])
    )

    print("[OUTPUT] Writing %s ..." % out_path, flush=True)

    write_start = time.monotonic()

    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    write_elapsed = time.monotonic() - write_start
    product_elapsed = time.monotonic() - product_start

    h = out[0]["header"]

    print(
        "[OUTPUT] File write completed in %.1fs"
        % write_elapsed
    )
    print()
    print("[OUTPUT] Finished %s" % name)
    print("[OUTPUT] File  : %s" % out_path)
    print("[OUTPUT] Size  : %s" % human_size(os.path.getsize(out_path)))
    print("[OUTPUT] Date  : %s" % h["refTime"])
    print("[OUTPUT] Depth : %.3f m" % depth)
    print("[OUTPUT] Grid  : %dx%d" % (h["nx"], h["ny"]))
    print("[OUTPUT] Time  : %.1fs" % product_elapsed)

    # Release potentially large objects before moving to the next product.
    del fields
    del out

    return {
        "name": name,
        "path": out_path,
        "size": os.path.getsize(out_path),
        "ref_time": h["refTime"],
        "depth": depth,
        "nx": h["nx"],
        "ny": h["ny"],
        "elapsed": product_elapsed,
    }


# ---------------------------------------------------------------------------
# Command-line parsing
# ---------------------------------------------------------------------------

def parse_args(args):
    """
    Return (product_names, day).

    Supported forms:
        refresh_ocean.py
        refresh_ocean.py 2026-07-11
        refresh_ocean.py currents
        refresh_ocean.py currents 2026-07-11
    """
    args = list(args)

    if args and args[0] in PRODUCTS:
        names = [args.pop(0)]
    else:
        names = list(PRODUCTS.keys())

    if len(args) > 1:
        raise SystemExit(
            "Usage: refresh_ocean.py [currents|currents25|temperature] [YYYY-MM-DD]"
        )

    if args:
        try:
            day = np.datetime64(args[0])
        except Exception as exc:
            raise SystemExit("Invalid date %r: %s" % (args[0], exc))
    else:
        day = np.datetime64(
            datetime.now(timezone.utc).strftime("%Y-%m-%d")
        )

    return names, day


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    names, day = parse_args(sys.argv[1:])

    print()
    print("=" * 68)
    print(" CMEMS Ocean Data Refresh")
    print("=" * 68)
    print(" Date     : %s" % day)
    print(" Products : %s" % ", ".join(names))
    print(" Files    :")

    for name in names:
        print("   - %s" % PRODUCTS[name]["out"])

    print("=" * 68)

    total_start = time.monotonic()
    completed = []

    for product_number, name in enumerate(names, start=1):
        product = PRODUCTS[name]

        try:
            result = refresh_product(
                name=name,
                product=product,
                day=day,
                product_number=product_number,
                product_count=len(names),
            )
        except Exception as exc:
            print()
            print("=" * 68)
            print(" REFRESH FAILED")
            print("=" * 68)
            print(" Product : %s" % name)
            print(" Error   : %s" % exc)
            print("=" * 68)
            raise

        completed.append(result)

    total_elapsed = time.monotonic() - total_start

    print()
    print("=" * 68)
    print(" ALL REQUESTED PRODUCTS COMPLETE")
    print("=" * 68)

    for result in completed:
        print(
            " %-12s %s  (%s, %.1fs)"
            % (
                result["name"],
                os.path.basename(result["path"]),
                human_size(result["size"]),
                result["elapsed"],
            )
        )

    print("-")
    print(" Products updated : %d" % len(completed))
    print(" Total time       : %.1fs" % total_elapsed)
    print("=" * 68)
    print()


if __name__ == "__main__":
    main()

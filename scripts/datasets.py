"""Atomic dataset storage and strict pre-publication validation."""
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from datetime import datetime, timedelta

MAX_GRID_CELLS = 2_000_000
MAX_GRID_COLUMNS = 2880
MAX_GRID_ROWS = 1441
MAX_FLOAT32 = 3.4028234663852886e38
GEOMETRY_EPSILON = 1e-6


def write(path, records):
    path = Path(path)
    temporary = None
    try:
        # A failed conversion must leave the previous dataset readable.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix="." + path.name + ".", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(records, stream, separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate(records):
    if not isinstance(records, list) or len(records) not in (1, 2):
        raise ValueError("expected one scalar record or two vector records")
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("invalid record")
        header, data = record.get("header"), record.get("data")
        if not isinstance(header, dict) or not isinstance(data, list):
            raise ValueError("missing header or data array")
        nx, ny = header.get("nx"), header.get("ny")
        if (type(nx) is not int or type(ny) is not int or nx < 2 or ny < 2
                or nx > MAX_GRID_COLUMNS or ny > MAX_GRID_ROWS
                or nx * ny > MAX_GRID_CELLS or len(data) != nx * ny):
            raise ValueError("invalid grid dimensions or sample count")
        if not all(finite(header.get(key)) for key in ("dx", "dy", "lo1", "la1")):
            raise ValueError("non-finite grid geometry")
        dx, dy, lon, lat = (header[key] for key in ("dx", "dy", "lo1", "la1"))
        scan = header.get("scanMode", 0)
        if (dx <= 0 or dy <= 0 or not -180 <= lon <= 360 or not -90 <= lat <= 90
                or (nx - 1) * dx > 360 + GEOMETRY_EPSILON
                or lat - (ny - 1) * dy < -90 - GEOMETRY_EPSILON
                or not finite(scan) or scan != 0):
            raise ValueError("unsupported grid geometry")
        reference = datetime.fromisoformat(header["refTime"].replace("Z", "+00:00"))
        forecast = header.get("forecastTime", 0)
        if not finite(forecast) or forecast < 0:
            raise ValueError("invalid forecast time")
        # Finite JSON numbers can still overflow the consumer's date arithmetic.
        try:
            _ = reference + timedelta(hours=forecast)
        except OverflowError:
            raise ValueError("invalid forecast time") from None
        if any(value is not None and (not finite(value) or abs(value) > MAX_FLOAT32)
               for value in data):
            raise ValueError("samples must be finite Float32 numbers or null")
    if len(records) != 2:
        return
    headers = [record["header"] for record in records]
    if {(h.get("parameterCategory"), h.get("parameterNumber")) for h in headers} != {(2, 2), (2, 3)}:
        raise ValueError("missing vector components")
    for key in ("nx", "ny", "dx", "dy", "lo1", "la1", "refTime", "forecastTime"):
        if headers[0].get(key) != headers[1].get(key):
            raise ValueError("vector grids disagree: " + key)


def invalid_constant(value):
    raise ValueError("invalid JSON constant: " + value)


def main(paths):
    if not paths:
        sys.exit("no datasets to upload")
    for path in paths:
        try:
            with open(path, encoding="utf-8") as stream:
                validate(json.load(stream, parse_constant=invalid_constant))
        except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError) as error:
            sys.exit("invalid dataset %s: %s" % (path, error))
    print("validated %d datasets" % len(paths))


if __name__ == "__main__":
    main(sys.argv[1:])

# GRIB fixture

`regular_ll_sfc_grib2.tmpl` is the 179-byte regular latitude/longitude GRIB2 sample
from [ECMWF ecCodes](https://github.com/ecmwf/eccodes/blob/develop/samples/regular_ll_sfc_grib2.tmpl).
Its upstream license is included in `ECCODES_LICENSE` (Apache License 2.0).

The converter tests modify copies in memory to create tiny deterministic wind,
temperature, humidity and wave inputs. No weather downloads, credentials, or
untracked datasets are needed.

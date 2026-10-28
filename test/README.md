# Dependency and feature self-checks

`.github/workflows/self-check.yml` runs on pull requests, every push (branches and tags),
merge-queue requests, and manual dispatch. It is also callable from another workflow.
It has two Python jobs (3.12 and 3.14), four JavaScript jobs (shared, wind, ocean, solar),
and one aggregate check, **`Self-check / Ready to release`**, which fails if any required
job fails, is cancelled, or is skipped. Matrix jobs keep running after another one fails.

The Python 3.12 job installs `scripts/refresh-requirements.txt`; Python 3.14 installs
`requirements.txt`. Both use a new `.venv`, run `pip check`, and execute all `test_*.py`
tests. Native checks exercise GRIB, coordinate transforms, HDF5/NetCDF, Zarr/Dask and
Parquet. The refresh workflow runs these Python checks before downloading or uploading
production data as well.

The JavaScript jobs use Node 24 and Chrome from the Ubuntu 24.04 runner image, validate
syntax/runtime dependencies, and run all `*.test.mjs` tests. The shared job discovers
every such file except `features.test.mjs`; three display jobs each select a branch of
that file's hierarchy. New regression files are picked up automatically.
The shared catalog check also fails when a menu layer lacks a feature test. CI sets
`EARTH_CHROME_BINARY=google-chrome` so the browser checked and launched is the same;
local runs can select an installed binary with that variable as well.

## Feature hierarchy

| Feature | Subfeatures | Python coverage | Browser coverage |
|---|---|---|---|
| Wind displays | Surface, 1000/500/10 hPa vectors; temperature, humidity, dew point | `WindDisplays`: seven GRIB-to-JSON pipelines | All seven layers on desktop/phone; units, inputs, readouts, zoom, particle motion |
| Ocean displays | Surface/25/110/450 m currents; temperature; waves | `OceanDisplays`: five CMEMS pipelines and wave height/motion conversion | All six layers on desktop/phone; units, inputs, readouts, zoom, currents/wave motion |
| Solar radiance display | Daylight, night lights, terrain relief | Shared dependency checks; renderer is JavaScript | All three layers on desktop/phone; shading, readouts, zoom, solar elevation and illumination at +0/+3/+6/+12 h |
| Shared behavior | Invalid grids, loading/fallbacks, source attribution, HTTP/cache conditions, publication validation, launcher, runner isolation | Existing dataset/GRIB/launcher tests and `NativeDependencies` | Existing browser, grid, Worker, server, isolation and performance-gate regressions |

Weather, imagery and remote CMEMS dataset opens use deterministic fixtures. The actual
page, renderers, map files, native codecs, conversions and file I/O are exercised.
Uploads use a recording stub. Tests need no secrets, live services or untracked assets;
no production objects are written. The GRIB fixture's provenance and license are in
`fixtures/`.

## Run locally

Use Python 3.14, Node 24+, and Chromium/Chrome. From the repository root:

```sh
python3.14 -m venv .venv
.venv/bin/python -m pip install --only-binary=:all: -r requirements.txt
source .venv/bin/activate
python -m pip check
python -I -B -m unittest discover -s test -p 'test_*.py' -v
node --test --test-isolation=none --test-concurrency=1 test/*.test.mjs
```

Select a display branch with the same commands used by the Actions matrix:

```sh
EARTH_TEST_FEATURE=wind node --test --test-isolation=none --test-concurrency=1 test/features.test.mjs
EARTH_TEST_FEATURE=ocean node --test --test-isolation=none --test-concurrency=1 test/features.test.mjs
EARTH_TEST_FEATURE=solar node --test --test-isolation=none --test-concurrency=1 test/features.test.mjs
```

An unknown feature selection is an error. Browser tests need loopback ports. Chromium's
sandbox is enabled by default; on hosts that cannot support it, explicitly set
`EARTH_CHROME_SANDBOX=disabled`. Startup failures never disable it automatically.
Each browser owns its debugging port and temporary files. Runner isolation checks
use disposable clones and leave this repository's Git metadata untouched.

## Release gate and results

Each job writes its dependency/test status to the Actions summary and retains the full
TAP or Python log for seven days, including failed runs. A pipeline failure propagates
through `tee`; readiness requires both Python versions and all four JS jobs to succeed.

After manually adding these files to GitHub, select **`Self-check / Ready to release`** as a
[required status check](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
on the release branch. Workflow files alone do not configure branch protection or stop
manual release publication. A publishing workflow can call this reusable workflow and
set its publishing job's `needs` to the self-check job.

## Manual comparisons and performance

The existing `run.mjs` comparison suites also need downloaded datasets and imagery
under `public/data/`, plus a baseline Git ref:

```sh
node test/run.mjs --list
node test/run.mjs --ref HEAD -v
```

Each comparison owns and cleans up its baseline worktree. Rendering fingerprints,
resolution comparisons and performance measurements remain available through this runner.
The release gate uses absolute functional assertions for particles and solar motion,
with synthetic inputs. Timing comparisons are diagnostic because shared-host timing
outliers also occur with identical code. `performance.test.mjs` still checks the
benchmark's error handling and validation in every self-check run.

Update direct refresh dependency versions in `scripts/refresh-requirements.in`, regenerate
the CI lock using its header command, and run both Python environments. Update the local
`requirements.txt` snapshot deliberately when changing local tooling versions.

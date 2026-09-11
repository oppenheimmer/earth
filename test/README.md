# Review regressions

Run from the repository root with Node 24+ and Chromium/Chrome installed:

```sh
node --test --test-isolation=none --test-concurrency=1 test/*.test.mjs
```

Browser tests use synthetic datasets and imagery. They need loopback ports and
the tracked map files; no external datasets or credentials are required.

Chromium's sandbox is enabled by default. On hosts that cannot support it, explicitly
set `EARTH_CHROME_SANDBOX=disabled` for the test command. Startup failures never
disable it automatically. Each browser owns its debugging port and temporary files.

For converter tests, use a Python 3.12 virtual environment:

```sh
python -m pip install --only-binary=:all: -r scripts/refresh-requirements.txt
python -B test/test_datasets.py
python -B test/test_grib.py
```

Uploads are replaced by a recording stub. Write-failure tests use temporary files.

Launcher checks need only Python and Bash; server and browser commands are stubbed:

```sh
python -B test/test_launcher.py
```

The existing comparison suites in `run.mjs` additionally need the downloaded
assets under `public/data/` and create a baseline Git worktree.
Each run owns a separate worktree, removed on completion or failure, including
startup failure. Isolation tests use disposable clones and leave this repository's
Git metadata untouched.

Targeted browser-driver and worktree checks:

```sh
node --test --test-isolation=none --test-concurrency=1 test/browser.test.mjs test/isolation.test.mjs
```

Update direct dependency versions in `scripts/refresh-requirements.in`, regenerate
the lock using its header command, then repeat installation and converter tests.

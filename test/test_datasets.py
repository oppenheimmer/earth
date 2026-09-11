"""Synthetic conversion/publication regressions; never use upload credentials."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import refresh_wind as wind
import refresh_waves as waves
import refresh_ocean as ocean

NOW = datetime(2026, 9, 11, tzinfo=timezone.utc)


def records():
    return [{"header": {"nx": 2, "ny": 2, "dx": 180, "dy": 180,
                        "lo1": 0, "la1": 90, "refTime": NOW.isoformat()},
             "data": [1, None, 3, 4]}]


class Datasets(unittest.TestCase):
    def test_interrupted_write_keeps_previous_file(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "fixture.json"
            previous = json.dumps(records())
            target.write_text(previous)

            def interrupted(data, stream, **options):
                stream.write("[")
                raise OSError("synthetic disk failure")

            with patch.object(waves, "DATA_DIR", temp), patch("json.dump", interrupted):
                with self.assertRaises(OSError):
                    waves.write(target.name, records())
            self.assertEqual(target.read_text(), previous)
            self.assertEqual(list(Path(temp).iterdir()), [target])

    def test_invalid_numbers_do_not_replace_previous_file(self):
        for number in [float("nan"), float("inf"), -float("inf")]:
            with self.subTest(number=number), tempfile.TemporaryDirectory() as temp:
                target = Path(temp) / "fixture.json"
                previous = json.dumps(records())
                target.write_text(previous)
                invalid = records()
                invalid[0]["data"][0] = number
                with patch.object(waves, "DATA_DIR", temp):
                    with self.assertRaises(ValueError):
                        waves.write(target.name, invalid)
                self.assertEqual(target.read_text(), previous)

    def test_masked_wind_is_null(self):
        grb = types.SimpleNamespace(
            values=np.ma.array([[1., 2.], [3., 4.]], mask=[[0, 1], [0, 0]]),
            latlons=lambda: (np.array([[90, 90], [-90, -90]]), None),
            year=2026, month=9, day=11, hour=0, forecastTime=0)
        self.assertEqual(wind.record(grb, {}, wind.SURFACE_2M)["data"], [1, None, 3, 4])

    def test_nonfinite_samples_are_missing(self):
        values = np.array([[1, np.inf], [np.nan, -np.inf]])
        self.assertEqual(waves.record(values, NOW, {})["data"], [1, None, None, None])
        self.assertEqual(ocean.record(values, [-90, 90], [0, 180], NOW, 0, {})["data"],
                         [1, None, None, None])

    def upload(self, payloads):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            shutil.copytree(ROOT / "scripts", work / "scripts")
            data = work / "public/data"
            data.mkdir(parents=True)
            for index, payload in enumerate(payloads):
                (data / ("current-%d.json" % index)).write_text(payload)
            bin_dir = work / "bin"
            bin_dir.mkdir()
            aws = bin_dir / "aws"
            aws.write_text('#!/bin/sh\necho call >> "$TEST_CALLS"\n')
            aws.chmod(0o700)
            calls = work / "calls"
            env = {"PATH": str(bin_dir) + ":" + os.environ["PATH"],
                   "R2_ACCOUNT_ID": "synthetic", "AWS_ACCESS_KEY_ID": "synthetic",
                   "AWS_SECRET_ACCESS_KEY": "synthetic", "TEST_CALLS": str(calls)}
            result = subprocess.run(["bash", str(work / "scripts/upload_data.sh")],
                                    env=env, capture_output=True, text=True)
            return result, calls.read_text().count("call") if calls.exists() else 0

    def test_all_files_validated_before_first_upload(self):
        for bad in ["[invalid", "[]", '[{"header":{},"data":[NaN]}]',
                    json.dumps([{"header": records()[0]["header"], "data": [1]}])]:
            with self.subTest(bad=bad):
                result, calls = self.upload([json.dumps(records()), bad])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, 0)

    def test_valid_files_are_uploaded(self):
        result, calls = self.upload([json.dumps(records()), json.dumps(records())])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 2)

    def test_headers_must_be_usable_by_the_browser(self):
        for key, value in [("scanMode", False), ("forecastTime", 1e200)]:
            with self.subTest(key=key):
                invalid = records()
                invalid[0]["header"][key] = value
                result, calls = self.upload([json.dumps(invalid)])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, 0)

    def test_empty_upload_fails_without_calling_aws(self):
        result, calls = self.upload([])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, 0)


if __name__ == "__main__":
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()

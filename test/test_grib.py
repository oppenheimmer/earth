"""Exercise GRIB file ownership with synthetic downloads and decoder records."""
import contextlib
import io
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import refresh_wind as wind
import refresh_waves as waves


class Grib(unittest.TestCase):
    def refresh(self, module, folder, outcome="success", local=None):
        (folder / "output").mkdir(exist_ok=True)
        paths = []
        permissions = []
        grb = types.SimpleNamespace(
            values=np.ones((2, 2)),
            latlons=lambda: (np.array([[90, 90], [-90, -90]]), None),
            year=2026, month=9, day=11, hour=0, forecastTime=0)
        decoder = MagicMock()
        decoder.select.return_value = [grb]
        if outcome == "decode error":
            decoder.select.side_effect = ValueError("synthetic decoder failure")

        def download(day, hour, destination, *args):
            path = Path(destination)
            paths.append(path)
            permissions.append(stat.S_IMODE(path.parent.stat().st_mode))
            path.write_bytes(b"synthetic GRIB")
            return outcome != "unavailable"

        args = [module.__file__]
        if local:
            args += [str(local)]
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", args))
            stack.enter_context(patch.object(tempfile, "tempdir", str(folder)))
            stack.enter_context(patch.object(module, "DATA_DIR", str(folder / "output")))
            stack.enter_context(patch.object(module, "candidate_cycles", return_value=[("20260911", "00")]))
            fetch = stack.enter_context(patch.object(module, "fetch_cycle", side_effect=download))
            opened = stack.enter_context(patch.object(module.pygrib, "open", return_value=decoder))
            if outcome == "unavailable":
                with self.assertRaises(SystemExit):
                    module.main()
            elif outcome == "decode error":
                with self.assertRaisesRegex(ValueError, "synthetic decoder failure"):
                    module.main()
            else:
                module.main()
            if local:
                fetch.assert_not_called()
                opened.assert_called_once_with(str(local))
        return paths, permissions, decoder

    def test_downloads_are_private_unique_and_removed(self):
        for module in (wind, waves):
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory() as temp:
                folder = Path(temp)
                runs = [self.refresh(module, folder) for _ in range(2)]
                first, second = [run[0][0] for run in runs]
                self.assertNotEqual(first, second)
                for paths, permissions, decoder in runs:
                    self.assertEqual(permissions, [0o700])
                    self.assertFalse(paths[0].parent.exists())
                    decoder.close.assert_called_once()

    def test_failed_refreshes_remove_temporary_files(self):
        for module in (wind, waves):
            for outcome in ("unavailable", "decode error"):
                with self.subTest(module=module.__name__, outcome=outcome), tempfile.TemporaryDirectory() as temp:
                    paths, _, decoder = self.refresh(module, Path(temp), outcome)
                    self.assertFalse(paths[0].exists())
                    if outcome == "decode error":
                        decoder.close.assert_called_once()

    def test_local_files_are_preserved(self):
        for module in (wind, waves):
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory() as temp:
                folder = Path(temp)
                local = folder / "input.grib2"
                local.write_bytes(b"owned by user")
                _, _, decoder = self.refresh(module, folder, local=local)
                self.assertEqual(local.read_bytes(), b"owned by user")
                decoder.close.assert_called_once()


if __name__ == "__main__":
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()

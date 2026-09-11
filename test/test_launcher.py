"""Check launcher behavior without starting a server or opening a browser."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class Launcher(unittest.TestCase):
    def launch(self, setup=""):
        with tempfile.TemporaryDirectory() as temp:
            calls = Path(temp) / "calls"
            # Stub external effects; wait for the launcher's background command.
            script = '''
curl() { return 1; }
nohup() { printf '%s\\n' "$@" >> "$CALLS"; }
seq() { echo 1; }
sleep() { :; }
xdg-open() { printf 'browser:%s\\n' "$1" >> "$CALLS"; }
'''
            result = subprocess.run(
                ["bash", "-c", script + setup + '\nsource "$0"\nwait',
                 str(ROOT / "start.sh")],
                env={**os.environ, "CALLS": str(calls)},
                capture_output=True, text=True)
            return result, calls.read_text().splitlines() if calls.exists() else []

    def test_server_binds_to_loopback(self):
        result, calls = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--bind", calls)
        self.assertEqual(calls[calls.index("--bind") + 1], "127.0.0.1")
        self.assertIn("browser:http://127.0.0.1:8420", calls)

    def test_directory_failure_stops_launcher(self):
        result, calls = self.launch("cd() { return 1; }")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()

"""The Ask bot's engine (upsc_intel/web/static/intel-core.js) is plain JS shared by the dashboard and the app;
its tests run under Node (tests/js/intel_core.test.js), with the web stubbed out."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
def test_intel_core():
    run = subprocess.run(["node", str(ROOT / "tests" / "js" / "intel_core.test.js")], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout + run.stderr

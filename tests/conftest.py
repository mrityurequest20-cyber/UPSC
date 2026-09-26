import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from upsc_intel.config import Settings, load_topics  # noqa: E402
from upsc_intel.db import DB  # noqa: E402
from upsc_intel.pipeline.classify import Classifier  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def settings(tmp_path, monkeypatch):
    for var in ("ANTHROPIC_API_KEY", "IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    s = Settings()
    s.data_dir = tmp_path / "data"
    s.inbox_dir = tmp_path / "inbox"
    s.config_dir = ROOT / "config"
    s.browser_fallback = False
    s.video_search = False  # never hit YouTube from tests
    s.anthropic_api_key = None
    s.imap_host = None
    s.ensure_dirs()
    return s


@pytest.fixture
def db(settings):
    d = DB(settings.db_path)
    yield d
    d.close()


@pytest.fixture(scope="session")
def clf():
    s = Settings()
    s.config_dir = ROOT / "config"
    return Classifier(load_topics(s))

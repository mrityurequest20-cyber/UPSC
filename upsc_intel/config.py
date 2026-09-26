"""Settings (from environment / .env) and YAML config loading."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

try:  # python-dotenv is optional at import time
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None

ROOT = Path(__file__).resolve().parent.parent
if load_dotenv:
    load_dotenv(ROOT / ".env")


def _env(name: str, default: Any = None) -> Any:
    val = os.environ.get(name)
    return default if val is None or val == "" else val


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(_env(name, default)).split("#")[0].strip())
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    val = _env(name)
    if val is None:
        return default
    return str(val).strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(_env("UPSC_DATA_DIR", ROOT / "data")))
    inbox_dir: Path = field(default_factory=lambda: Path(_env("UPSC_INBOX_DIR", ROOT / "inbox")))
    config_dir: Path = field(default_factory=lambda: Path(_env("UPSC_CONFIG_DIR", ROOT / "config")))
    fetch_interval_min: int = field(default_factory=lambda: _env_int("UPSC_FETCH_INTERVAL_MIN", 15))
    concurrency: int = field(default_factory=lambda: _env_int("UPSC_CONCURRENCY", 8))
    http_timeout: int = field(default_factory=lambda: _env_int("UPSC_HTTP_TIMEOUT", 20))
    keep_days: int = field(default_factory=lambda: _env_int("UPSC_KEEP_DAYS", 400))
    max_item_age_days: int = field(default_factory=lambda: _env_int("UPSC_MAX_ITEM_AGE_DAYS", 35))
    host: str = field(default_factory=lambda: _env("UPSC_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("UPSC_PORT", 8000))
    browser_fallback: bool = field(default_factory=lambda: _env_bool("UPSC_BROWSER_FALLBACK", True))
    browser_executable: str | None = field(default_factory=lambda: _env("UPSC_BROWSER_EXECUTABLE"))
    # premium: IMAP
    imap_host: str | None = field(default_factory=lambda: _env("IMAP_HOST"))
    imap_port: int = field(default_factory=lambda: _env_int("IMAP_PORT", 993))
    imap_user: str | None = field(default_factory=lambda: _env("IMAP_USER"))
    imap_password: str | None = field(default_factory=lambda: _env("IMAP_PASSWORD"))
    imap_folder: str = field(default_factory=lambda: _env("IMAP_FOLDER", "INBOX"))
    imap_senders: list[str] = field(
        default_factory=lambda: [s.strip() for s in str(_env("IMAP_SENDERS", "")).split(",") if s.strip()]
    )
    imap_since_days: int = field(default_factory=lambda: _env_int("IMAP_SINCE_DAYS", 3))
    # daily brief & videos
    youtube_api_key: str | None = field(default_factory=lambda: _env("YOUTUBE_API_KEY"))
    video_search: bool = field(default_factory=lambda: _env_bool("UPSC_VIDEO_SEARCH", True))
    video_lang: str = field(default_factory=lambda: _env("UPSC_VIDEO_LANG", "en,hi"))
    # optional AI
    anthropic_api_key: str | None = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))
    ai_model: str = field(default_factory=lambda: _env("UPSC_AI_MODEL", "claude-opus-5"))
    ai_max_per_run: int = field(default_factory=lambda: _env_int("UPSC_AI_MAX_PER_RUN", 40))
    # static site: minutes between scheduled rebuilds (shown on the page, used by Refresh)
    site_refresh_min: int = field(default_factory=lambda: _env_int("UPSC_SITE_REFRESH_MIN", 60))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "upsc.db"

    @property
    def imap_enabled(self) -> bool:
        return bool(self.imap_host and self.imap_user and self.imap_password)

    @property
    def ai_enabled(self) -> bool:
        return bool(self.anthropic_api_key)

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.inbox_dir.mkdir(parents=True, exist_ok=True)


def get_settings() -> Settings:
    return Settings()


# ─────────────────────────── YAML config ───────────────────────────

def _read_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load_topics(settings: Settings | None = None) -> dict:
    settings = settings or get_settings()
    return _read_yaml(settings.config_dir / "topics.yaml")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]


def load_sources(settings: Settings | None = None, public_only: bool = False) -> list[dict]:
    """All source definitions: public registry + watchlist + local/private + premium built-ins."""
    settings = settings or get_settings()
    sources: list[dict] = []
    for src in _read_yaml(settings.config_dir / "sources.yaml").get("sources", []) or []:
        sources.append(dict(src))

    topics = load_topics(settings)
    wl = topics.get("watchlist") or {}
    for q in wl.get("queries", []) or []:
        sources.append({
            "id": "watch-" + _slug(q.replace("when:", "")),
            "name": "Google News watchlist",
            "section": "",
            "query_label": q.split(" when:")[0],
            "kind": "gnews",
            "query": q,
            "tier": "watch",
            "interval": wl.get("interval", 60),
            "limit": wl.get("limit", 30),
            "allow_empty": True,
            "watchlist": True,
        })

    if not public_only:
        for src in _read_yaml(settings.config_dir / "sources.local.yaml").get("sources", []) or []:
            src = dict(src)
            src.setdefault("tier", "premium")
            src["private"] = True
            sources.append(src)
        if settings.imap_enabled:
            sources.append({"id": "email", "name": "Email newsletters", "kind": "imap", "tier": "premium",
                            "private": True, "allow_empty": True})
        sources.append({"id": "library", "name": "Library", "kind": "documents", "tier": "library",
                        "private": True, "allow_empty": True})

    seen: set[str] = set()
    out = []
    for src in sources:
        if src.get("enabled", True) is False or src["id"] in seen:
            continue
        seen.add(src["id"])
        src.setdefault("tier", "general")
        src.setdefault("section", "")
        src.setdefault("editorial", False)
        src.setdefault("explained", False)
        src["chain"] = build_chain(src)
        out.append(src)
    return out


def build_chain(src: dict) -> list[dict]:
    """Primary step + explicit fallbacks + automatic Google News `site:` fallback."""
    primary = {k: v for k, v in src.items() if k in {"kind", "url", "query", "link_pattern", "selector"}}
    chain = [primary]
    for fb in src.get("fallbacks", []) or []:
        chain.append(dict(fb))
    site = src.get("site")
    has_gnews = any(step.get("kind") == "gnews" for step in chain)
    if site and not has_gnews:
        chain.append({"kind": "gnews", "query": f"site:{site} when:2d"})
    return chain

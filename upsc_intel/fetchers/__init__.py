"""Fetcher registry + the self-healing fallback chain.

Every source has a chain: [primary, *fallbacks, (auto) Google News site: query].
* Each run starts at the source's *active* step. If it fails, the run walks down the chain
  immediately, so there is no gap in coverage.
* After FAIL_SWITCH consecutive runs where the active step failed but a later one worked,
  the later step becomes the active one.
* Every PROBE_EVERY runs the primary is re-tried, and it takes over again once it recovers.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

from ..config import Settings
from ..db import DB, iso
from ..models import FetchError, RawItem
from .documents import fetch_documents
from .email_imap import fetch_imap
from .gnews import fetch_gnews
from .html_links import fetch_browser, fetch_html
from .http import Http
from .pib import fetch_pib
from .rss import fetch_rss
from .telegram import fetch_telegram

FETCHERS: dict[str, Callable] = {
    "rss": fetch_rss,
    "youtube": fetch_rss,
    "gnews": fetch_gnews,
    "pib": fetch_pib,
    "telegram": fetch_telegram,
    "html": fetch_html,
    "browser": fetch_browser,
    "imap": fetch_imap,
    "documents": fetch_documents,
}

FAIL_SWITCH = 2
PROBE_EVERY = 12


@dataclass
class FetchContext:
    settings: Settings
    db: DB
    http: Http
    stale_story_ids: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class Attempt:
    step: int
    kind: str
    ok: bool
    n: int
    error: str | None
    ms: int


@dataclass
class SourceResult:
    source: dict
    items: list[RawItem]
    ok: bool
    step: int | None
    attempts: list[Attempt]
    skipped: bool = False


def is_due(src: dict, state: dict, default_interval: int, now: datetime) -> bool:
    last = state.get("last_attempt_at")
    if not last:
        return True
    interval = int(src.get("interval") or default_interval)
    try:
        last_dt = datetime.fromisoformat(last)
    except ValueError:
        return True
    return now - last_dt >= timedelta(minutes=interval) - timedelta(seconds=30)


def run_source(ctx: FetchContext, src: dict, state: dict) -> tuple[SourceResult, dict]:
    chain = src["chain"]
    active = min(int(state.get("active_step") or 0), len(chain) - 1)
    probing = active > 0 and int(state.get("runs_since_probe") or 0) >= PROBE_EVERY
    start = 0 if probing else active
    attempts: list[Attempt] = []
    items: list[RawItem] = []
    success: int | None = None

    for idx in range(start, len(chain)):
        step = chain[idx]
        kind = step.get("kind", "rss")
        fn = FETCHERS.get(kind)
        t0 = time.monotonic()
        try:
            if fn is None:
                raise FetchError(f"unknown kind '{kind}'")
            if kind == "browser" and not ctx.settings.browser_fallback:
                raise FetchError("browser fallback disabled")
            got = fn(ctx, step, src)
            allow_empty = src.get("allow_empty", False) or kind == "gnews"
            if not got and not allow_empty:
                raise FetchError("no items")
            attempts.append(Attempt(idx, kind, True, len(got), None, int((time.monotonic() - t0) * 1000)))
            items, success = got, idx
            break
        except Exception as exc:  # any failure → next step in the chain
            msg = f"{type(exc).__name__}: {exc}" if not isinstance(exc, FetchError) else str(exc)
            attempts.append(Attempt(idx, kind, False, 0, msg[:300], int((time.monotonic() - t0) * 1000)))

    st = dict(state)
    st["source_id"] = src["id"]
    st["last_attempt_at"] = iso(datetime.now(timezone.utc))
    if probing:
        st["runs_since_probe"] = 0
    if success is None:
        st["fail_streak"] = int(st.get("fail_streak") or 0) + 1
        st["last_error"] = attempts[-1].error if attempts else "no steps"
    else:
        st["last_ok_at"] = st["last_attempt_at"]
        st["last_count"] = len(items)
        st["last_step_kind"] = chain[success].get("kind")
        st["last_error"] = next((a.error for a in attempts if not a.ok), None)
        if success <= active:
            st["active_step"] = success
            st["fail_streak"] = 0
            if success > 0 and not probing:
                st["runs_since_probe"] = int(st.get("runs_since_probe") or 0) + 1
        else:
            st["fail_streak"] = int(st.get("fail_streak") or 0) + 1
            if st["fail_streak"] >= FAIL_SWITCH:
                st["active_step"] = success
                st["fail_streak"] = 0
                st["runs_since_probe"] = 0
    return SourceResult(src, items, success is not None, success, attempts), st

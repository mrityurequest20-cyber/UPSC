"""Shared HTTP client: browser-like headers, HTTP/2, retries with backoff, per-host concurrency."""
from __future__ import annotations

import random
import threading
import time
from collections import defaultdict
from urllib.parse import urlsplit

import httpx

from ..models import FetchError

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/128.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

RETRY_STATUS = {429, 500, 502, 503, 504}
PER_HOST_LIMIT = {"news.google.com": 2}


class Http:
    def __init__(self, timeout: float = 20, retries: int = 2, per_host: int = 3):
        self.retries = retries
        try:
            self.client = httpx.Client(http2=True, headers=BROWSER_HEADERS, follow_redirects=True, timeout=timeout)
        except ImportError:  # h2 not installed
            self.client = httpx.Client(headers=BROWSER_HEADERS, follow_redirects=True, timeout=timeout)
        self._sems: dict[str, threading.BoundedSemaphore] = defaultdict(
            lambda: threading.BoundedSemaphore(per_host)
        )
        self._sem_lock = threading.Lock()

    def _sem(self, host: str) -> threading.BoundedSemaphore:
        with self._sem_lock:
            if host not in self._sems and host in PER_HOST_LIMIT:
                self._sems[host] = threading.BoundedSemaphore(PER_HOST_LIMIT[host])
            return self._sems[host]

    def get(self, url: str, params: dict | None = None, headers: dict | None = None) -> httpx.Response:
        host = urlsplit(url).hostname or ""
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                with self._sem(host):
                    resp = self.client.get(url, params=params, headers=headers)
                if resp.status_code in RETRY_STATUS and attempt < self.retries:
                    time.sleep(1.5 * (attempt + 1) + random.random())
                    continue
                if resp.status_code >= 400:
                    raise FetchError(f"HTTP {resp.status_code}")
                return resp
            except httpx.HTTPError as exc:
                last = exc
                if attempt < self.retries:
                    time.sleep(1.5 * (attempt + 1) + random.random())
                    continue
        raise FetchError(f"{type(last).__name__}: {last}" if last else "request failed")

    def close(self) -> None:
        self.client.close()

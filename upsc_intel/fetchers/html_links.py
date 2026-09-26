"""Listing-page scrapers for public pages without a feed.

`html`    plain HTTP fetch + link extraction (cheap)
`browser` headless Chromium render (for JS-built pages), same link extraction
"""
from __future__ import annotations

import glob
import os
import re
import threading
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from ..models import FetchError, RawItem
from ..pipeline.normalize import collapse

JUNK = re.compile(
    r"(login|sign ?in|sign ?up|register|subscribe|privacy|terms|cookie|contact|about us|careers|advertise|"
    r"download (the )?app|facebook|twitter|instagram|linkedin|youtube|whatsapp|telegram|home$|read more$|"
    r"click here|view all|see all)",
    re.I,
)


def extract_links(html: str, base_url: str, link_pattern: str | None = None,
                  min_len: int = 25, limit: int = 60) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript"]):
        tag.decompose()
    host = urlsplit(base_url).hostname
    pat = re.compile(link_pattern) if link_pattern else None
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        text = collapse(a.get("title") or a.get_text(" ", strip=True))
        if len(text) < min_len or len(text) > 240 or JUNK.search(text):
            continue
        url = urljoin(base_url, a["href"]).split("#")[0]
        if not url.startswith("http") or urlsplit(url).hostname != host:
            continue
        if pat and not pat.search(url):
            continue
        if url in seen or url.rstrip("/") == base_url.rstrip("/"):
            continue
        seen.add(url)
        out.append((text, url))
        if len(out) >= limit:
            break
    return out


def _to_items(pairs: list[tuple[str, str]]) -> list[RawItem]:
    # No dates on listing pages: first-seen time becomes the date (items are deduped by URL).
    return [RawItem(title=t, url=u) for t, u in pairs]


def fetch_html(ctx, step: dict, src: dict) -> list[RawItem]:
    resp = ctx.http.get(step["url"])
    pairs = extract_links(resp.text, str(resp.url), step.get("link_pattern"), limit=int(src.get("limit", 60)))
    return _to_items(pairs)


_browser_lock = threading.Lock()  # one Chromium at a time keeps memory sane


def _executable(ctx) -> str | None:
    if ctx.settings.browser_executable:
        return ctx.settings.browser_executable
    base = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if base:
        found = sorted(glob.glob(os.path.join(base, "chromium-*/chrome-linux/chrome")))
        if found:
            return found[-1]
    return None


def render_page(ctx, url: str, timeout_ms: int = 45000) -> tuple[str, str]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise FetchError("playwright not installed (pip install playwright)") from exc
    with _browser_lock, sync_playwright() as p:
        exe = _executable(ctx)
        browser = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        try:
            page = browser.new_page(user_agent=ctx.http.client.headers.get("User-Agent"))
            page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass
            return page.content(), page.url
        finally:
            browser.close()


def fetch_browser(ctx, step: dict, src: dict) -> list[RawItem]:
    if not ctx.settings.browser_fallback:
        raise FetchError("browser fallback disabled")
    html, final_url = render_page(ctx, step["url"])
    pairs = extract_links(html, final_url, step.get("link_pattern"), limit=int(src.get("limit", 60)))
    return _to_items(pairs)

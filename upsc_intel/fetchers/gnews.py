"""Google News RSS search: `site:` fallbacks for sources without a working feed, plus the topic watchlist."""
from __future__ import annotations

import time

import feedparser

from ..models import FetchError, RawItem
from ..pipeline.normalize import clean_title, strip_publisher_suffix
from .rss import entry_datetime

ENDPOINT = "https://news.google.com/rss/search"


def parse_gnews(content: bytes, limit: int = 40, publisher: str | None = None) -> list[RawItem]:
    """publisher: name to use for every item (single-site queries); otherwise Google's source name."""
    feed = feedparser.parse(content)
    if not feed.entries and feed.bozo:
        raise FetchError("unparseable Google News response")
    items: list[RawItem] = []
    for entry in feed.entries[:limit]:
        source = entry.get("source") or {}
        title = strip_publisher_suffix(clean_title(entry.get("title")), source.get("title") or publisher)
        if not title or not entry.get("link"):
            continue
        items.append(RawItem(
            title=title,
            url=entry.get("link"),
            summary="",  # Google News descriptions only repeat the headline
            published=entry_datetime(entry),
            publisher=publisher or source.get("title") or None,
            guid=entry.get("id"),
            extra={"origin": source.get("href")} if source.get("href") else {},
        ))
    return items


def fetch_gnews(ctx, step: dict, src: dict) -> list[RawItem]:
    query = step.get("query") or src.get("query")
    if not query:
        raise FetchError("gnews step without query")
    resp = ctx.http.get(ENDPOINT, params={"q": query, "hl": "en-IN", "gl": "IN", "ceid": "IN:en"})
    time.sleep(0.3)  # be gentle with Google News
    # a single-site query (a source's own fallback or section) keeps the source's name,
    # instead of Google's variants ("hindustantimes.com", "HT Auto", …)
    single_site = query.count("site:") == 1 and not src.get("watchlist")
    return parse_gnews(resp.content, limit=int(src.get("limit", 40)),
                       publisher=src.get("name") if single_site else None)

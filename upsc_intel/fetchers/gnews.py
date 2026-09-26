"""Google News RSS search: `site:` fallbacks for sources without a working feed, plus the topic watchlist."""
from __future__ import annotations

import time

import feedparser

from ..models import FetchError, RawItem
from ..pipeline.normalize import clean_title, strip_publisher_suffix
from .rss import entry_datetime

ENDPOINT = "https://news.google.com/rss/search"


def parse_gnews(content: bytes, limit: int = 40) -> list[RawItem]:
    feed = feedparser.parse(content)
    if not feed.entries and feed.bozo:
        raise FetchError("unparseable Google News response")
    items: list[RawItem] = []
    for entry in feed.entries[:limit]:
        source = entry.get("source") or {}
        publisher = source.get("title") or None
        title = strip_publisher_suffix(clean_title(entry.get("title")), publisher)
        if not title or not entry.get("link"):
            continue
        items.append(RawItem(
            title=title,
            url=entry.get("link"),
            summary="",  # Google News descriptions only repeat the headline
            published=entry_datetime(entry),
            publisher=publisher,
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
    return parse_gnews(resp.content, limit=int(src.get("limit", 40)))

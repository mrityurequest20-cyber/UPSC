"""Generic RSS/Atom (also YouTube channel feeds and private/tokenised feeds)."""
from __future__ import annotations

from calendar import timegm
from datetime import datetime, timezone

import feedparser
from dateutil import parser as dateparser

from ..models import FetchError, RawItem
from ..pipeline.normalize import clean_summary, clean_title, html_to_text


def entry_datetime(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        st = entry.get(key)
        if st:
            try:
                return datetime.fromtimestamp(timegm(st), tz=timezone.utc)
            except (OverflowError, ValueError):
                pass
    for key in ("published", "updated", "pubDate", "date"):
        raw = entry.get(key)
        if raw:
            try:
                dt = dateparser.parse(raw, fuzzy=True)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc)
            except (ValueError, OverflowError, TypeError):
                pass
    return None


def parse_feed(content: bytes, limit: int = 100) -> list[RawItem]:
    feed = feedparser.parse(content)
    if not feed.entries:
        if feed.bozo:
            raise FetchError(f"unparseable feed: {type(feed.bozo_exception).__name__}")
        return []
    items: list[RawItem] = []
    for entry in feed.entries[:limit]:
        title = clean_title(entry.get("title"))
        link = entry.get("link") or ""
        if not title or not link:
            continue
        summary = entry.get("summary") or entry.get("description") or ""
        if not summary and entry.get("media_description"):
            summary = entry.get("media_description")
        items.append(RawItem(
            title=title,
            url=link,
            summary=html_to_text(clean_summary(html_to_text(summary)), limit=700),
            published=entry_datetime(entry),
            guid=entry.get("id"),
        ))
    return items


def fetch_rss(ctx, step: dict, src: dict) -> list[RawItem]:
    resp = ctx.http.get(step["url"])
    return parse_feed(resp.content, limit=int(src.get("limit", 100)))

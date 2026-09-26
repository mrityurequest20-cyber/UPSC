"""Public Telegram channels via their web preview (https://t.me/s/<channel>). No bot/API key needed."""
from __future__ import annotations

from datetime import datetime, timezone

from bs4 import BeautifulSoup

from ..models import FetchError, RawItem
from ..pipeline.normalize import collapse


def channel_url(step: dict) -> str:
    if step.get("url"):
        url = step["url"]
        if "t.me/" in url and "/s/" not in url:
            url = url.replace("t.me/", "t.me/s/")
        return url
    if step.get("channel"):
        return f"https://t.me/s/{step['channel'].lstrip('@')}"
    raise FetchError("telegram step needs url or channel")


def parse_channel(html: str, limit: int = 40) -> list[RawItem]:
    soup = BeautifulSoup(html, "html.parser")
    items: list[RawItem] = []
    for msg in soup.select(".tgme_widget_message"):
        text_el = msg.select_one(".tgme_widget_message_text")
        if not text_el:
            continue
        lines = [collapse(x) for x in text_el.get_text("\n", strip=True).split("\n") if collapse(x)]
        if not lines:
            continue
        link_el = msg.select_one("a.tgme_widget_message_date")
        time_el = msg.select_one("time[datetime]")
        published = None
        if time_el:
            try:
                published = datetime.fromisoformat(time_el["datetime"]).astimezone(timezone.utc)
            except ValueError:
                pass
        title = lines[0][:180]
        if len(title) < 20 and len(lines) > 1:
            title = (title + " — " + lines[1])[:180]
        external = [a["href"] for a in text_el.select("a[href]") if "t.me/" not in a["href"]]
        items.append(RawItem(
            title=title,
            url=link_el["href"] if link_el else (external[0] if external else ""),
            summary=" ".join(lines[1:])[:700],
            content=" ".join(lines),
            published=published,
            extra={"links": external[:5]} if external else {},
        ))
    items = [i for i in items if i.url]
    return items[-limit:][::-1]


def fetch_telegram(ctx, step: dict, src: dict) -> list[RawItem]:
    resp = ctx.http.get(channel_url(step))
    return parse_channel(resp.text, limit=int(src.get("limit", 40)))

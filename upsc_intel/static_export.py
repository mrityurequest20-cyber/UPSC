"""Static export: the same dashboard as plain files (for GitHub Pages or any static host).

site/
  index.html            dashboard (static mode)
  static/app.js, styles.css
  data/meta.json        meta + source health + list of months
  data/stories-YYYY-MM.json
Only public sources are exported unless include_private=True. A Pages site is public, so
never export email/library/private-feed content there.
"""
from __future__ import annotations

import json
import shutil
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .config import Settings, load_topics
from .db import DB, iso
from .pipeline.classify import Classifier
from .pipeline.normalize import today_ist
from .web.app import STATIC_DIR, build_meta, sources_out, story_out

SUMMARY_CHARS = 420


def _month_bounds(month: str) -> tuple[str, str]:
    y, m = map(int, month.split("-"))
    first = date(y, m, 1)
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return first.isoformat(), (nxt - timedelta(days=1)).isoformat()


def _write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def export_static(settings: Settings, db: DB, out: str | Path, days: int = 62,
                  include_private: bool = False) -> Path:
    out = Path(out)
    (out / "static").mkdir(parents=True, exist_ok=True)
    (out / "data").mkdir(parents=True, exist_ok=True)
    for name in ("app.js", "styles.css"):
        shutil.copyfile(STATIC_DIR / name, out / "static" / name)
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace("<!--STATIC_FLAG-->", "<script>window.UPSC_STATIC = true;</script>")
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    today = date.fromisoformat(today_ist())
    start = today - timedelta(days=days)
    months: list[str] = []
    d = start.replace(day=1)
    while d <= today:
        months.append(d.strftime("%Y-%m"))
        d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)

    written: list[str] = []
    total = 0
    for m in months:
        lo, hi = _month_bounds(m)
        lo, hi = max(lo, start.isoformat()), min(hi, today.isoformat())
        rows = db.stories_between(lo, hi, include_low=False, library=False, include_private=include_private)
        if not rows:
            continue
        stories = []
        for s in rows:
            o = story_out(s)
            if len(o["summary"]) > SUMMARY_CHARS:
                o["summary"] = o["summary"][:SUMMARY_CHARS].rsplit(" ", 1)[0] + "…"
            o["sources"] = o["sources"][:8]
            stories.append(o)
        _write_json(out / "data" / f"stories-{m}.json", {"month": m, "stories": stories})
        written.append(m)
        total += len(stories)

    topics = load_topics(settings)
    meta = build_meta(settings, db, Classifier(topics), topics, mode="static")
    meta.update({
        "months": written,
        "built_at": iso(datetime.now(timezone.utc)),
        "sources": sources_out(settings, db, public_only=not include_private),
        "exported_stories": total,
    })
    if not include_private:
        meta["counts"]["library"] = 0
        meta["imap_enabled"] = False
    _write_json(out / "data" / "meta.json", meta)
    return out

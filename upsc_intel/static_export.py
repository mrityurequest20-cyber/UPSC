"""Static export: the same dashboard as plain files (for GitHub Pages or any static host).

site/
  index.html            dashboard (static mode)
  static/app.js, styles.css
  data/meta.json        meta + source health + list of months
  data/stories-YYYY-MM.json
  data/brief-YYYY-MM.json
Only public sources are exported unless include_private=True. A Pages site is public, so
never export email/library/private-feed content there.

Archive (archive=DIR): a month is frozen FREEZE_AFTER_DAYS after it ends (its last brief is
final by then) and its brief/stories files are copied into DIR. From then on the month is
served from DIR, never regenerated, so it stays on the site after the database has pruned it.
CI keeps DIR on the repository's `archive` branch. Private exports never write to it.
"""
from __future__ import annotations

import json
import shutil
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .config import Settings, load_topics
from .db import DB, iso
from .pipeline.brief import ensure_range
from .pipeline.classify import Classifier
from .pipeline.normalize import today_ist
from .web.app import STATIC_DIR, annotate, brief_payload, build_meta, sources_out, story_out

SUMMARY_CHARS = 420
FREEZE_AFTER_DAYS = 3


def _month_bounds(month: str) -> tuple[str, str]:
    y, m = map(int, month.split("-"))
    first = date(y, m, 1)
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return first.isoformat(), (nxt - timedelta(days=1)).isoformat()


def _write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _archived_months(archive: Path | None) -> set[str]:
    if not archive or not archive.is_dir():
        return set()
    months = {f.stem.split("-", 1)[1] for f in archive.glob("brief-*.json")}
    return {m for m in months if (archive / f"stories-{m}.json").is_file()}


def export_static(settings: Settings, db: DB, out: str | Path, days: int = 62,
                  include_private: bool = False, snapshot: bool = False,
                  archive: str | Path | None = None) -> Path:
    out = Path(out)
    (out / "static").mkdir(parents=True, exist_ok=True)
    (out / "data").mkdir(parents=True, exist_ok=True)
    for name in ("app.js", "styles.css"):
        shutil.copyfile(STATIC_DIR / name, out / "static" / name)
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    flags = "window.UPSC_STATIC = true;" + (" window.UPSC_SNAPSHOT = true;" if snapshot else "")
    html = html.replace("<!--STATIC_FLAG-->", f"<script>{flags}</script>")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")  # browsers keep assets 10 min on Pages
    for name in ("app.js", "styles.css"):
        html = html.replace(f"static/{name}", f"static/{name}?v={stamp}")
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    today = date.fromisoformat(today_ist())
    start = today - timedelta(days=days)
    months: list[str] = []
    d = start.replace(day=1)
    while d <= today:
        months.append(d.strftime("%Y-%m"))
        d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)

    archive = Path(archive) if archive and not include_private else None
    if archive:
        archive.mkdir(parents=True, exist_ok=True)
    archived = _archived_months(archive)
    freeze_before = (today - timedelta(days=FREEZE_AFTER_DAYS)).isoformat()
    reported = db.date_counts(days=days + 31)

    written: list[str] = []
    total = 0
    clf = Classifier(load_topics(settings))
    # briefs first: a day backfilled on a first run has no brief yet, and the story cards' "in brief"
    # labels below must match the briefs written after them
    ensure_range(settings, db, clf, start.isoformat(), today.isoformat())
    for m in months:
        if m in archived:
            continue  # frozen: served from the archive below
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
        annotate(stories, db, clf)
        _write_json(out / "data" / f"stories-{m}.json", {"month": m, "stories": stories})
        written.append(m)
        total += len(stories)
        brief = brief_payload(settings, db, clf, lo, hi, include_private=include_private)
        brief["reported"] = {d: n for d, n in reported.items() if lo <= d <= hi}
        _write_json(out / "data" / f"brief-{m}.json", {"month": m, **brief})
        if archive and _month_bounds(m)[1] < freeze_before:
            for kind in ("brief", "stories"):
                shutil.copyfile(out / "data" / f"{kind}-{m}.json", archive / f"{kind}-{m}.json")
            archived.add(m)

    # every archived month is published as it was frozen
    brief_days: dict[str, int] = {}
    counts = dict(reported)
    for m in sorted(archived):
        for kind in ("brief", "stories"):
            if m not in written:
                shutil.copyfile(archive / f"{kind}-{m}.json", out / "data" / f"{kind}-{m}.json")
    for m in sorted(set(written) | archived):
        b = json.loads((out / "data" / f"brief-{m}.json").read_text(encoding="utf-8"))
        for d, v in (b.get("days") or {}).items():
            brief_days[d] = len(v.get("news") or [])
        for d, n in (b.get("reported") or {}).items():
            counts.setdefault(d, n)

    topics = load_topics(settings)
    meta = build_meta(settings, db, Classifier(topics), topics, mode="static", public_only=not include_private)
    meta.update({
        "refresh_min": settings.site_refresh_min,
        "months": sorted(set(written) | archived),
        "brief_days": brief_days,
        "built_at": iso(datetime.now(timezone.utc)),
        "sources": sources_out(settings, db, public_only=not include_private),
        "exported_stories": total,
    })
    meta["date_counts"] = dict(sorted(counts.items()))
    if not include_private:
        meta["counts"]["library"] = 0
        meta["imap_enabled"] = False
    _write_json(out / "data" / "meta.json", meta)
    return out

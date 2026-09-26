"""The Daily Brief: a short, syllabus-balanced list of must-know stories and editorials per day.

The firehose (hundreds of items a day) stays in the "Everything" tab; the brief is what a
candidate should actually read. Weekly and monthly views are built from the daily briefs, so
"this week we covered…" means exactly what appeared in that week's briefs.

Selection for one day (stories first reported that day):
1. Coverage pass: the best NOTE/SKIM story of each syllabus subject, so no area is skipped.
2. Fill pass: remaining slots by score (importance + coverage), max PER_SUBJECT per subject.
3. Editorials: best-matching opinion pieces, max 3 per publisher.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

from ..config import Settings
from ..db import DB
from .classify import Classifier
from .normalize import today_ist

PER_SUBJECT = 4
TEXT_BONUS = 0.8
PER_EDITORIAL_PUBLISHER = 3


def select_day(db: DB, clf: Classifier, day: str, size: int, ed_size: int) -> list[tuple[str, str, int]]:
    rows = db.q(
        "SELECT id, score, grade, subjects, is_editorial, publishers, length(COALESCE(summary,'')) AS slen FROM stories "
        "WHERE date_ist=? AND is_library=0 AND grade != 'LOW' ORDER BY score DESC",
        (day,),
    )
    news, eds = [], []
    for r in rows:
        subjects = json.loads(r["subjects"] or "[]")
        if not subjects:
            continue
        # a story that comes with real text makes a better brief card than a bare headline
        item = {"id": r["id"], "score": r["score"] + (TEXT_BONUS if r["slen"] >= 80 else 0), "subject": subjects[0],
                "publisher": (json.loads(r["publishers"] or "[]") or [""])[0]}
        if r["is_editorial"]:
            eds.append(item)  # opinion titles are opaque, so READ-grade editorials still qualify
        elif r["grade"] in ("NOTE", "SKIM"):
            news.append(item)

    picked: list[dict] = []
    per_subject: dict[str, int] = {}
    order = list(clf.subject_meta)
    best_by_subject: dict[str, dict] = {}
    for it in news:
        best_by_subject.setdefault(it["subject"], it)
    for subj in order:  # coverage pass
        it = best_by_subject.get(subj)
        if it and len(picked) < size:
            picked.append(it)
            per_subject[subj] = 1
    taken = {p["id"] for p in picked}
    for it in news:  # fill pass
        if len(picked) >= size:
            break
        if it["id"] in taken or per_subject.get(it["subject"], 0) >= PER_SUBJECT:
            continue
        picked.append(it)
        taken.add(it["id"])
        per_subject[it["subject"]] = per_subject.get(it["subject"], 0) + 1
    picked.sort(key=lambda p: -p["score"])

    ed_picked: list[dict] = []
    per_pub: dict[str, int] = {}
    for it in eds:
        if len(ed_picked) >= ed_size:
            break
        if per_pub.get(it["publisher"], 0) >= PER_EDITORIAL_PUBLISHER:
            continue
        ed_picked.append(it)
        per_pub[it["publisher"]] = per_pub.get(it["publisher"], 0) + 1

    return [(p["id"], "news", i + 1) for i, p in enumerate(picked)] + \
           [(p["id"], "editorial", i + 1) for i, p in enumerate(ed_picked)]


def build_day(settings: Settings, db: DB, clf: Classifier, day: str) -> int:
    picks = select_day(db, clf, day, settings.brief_size, settings.brief_editorials)
    db.save_brief(day, picks)
    return len(picks)


def update_recent(settings: Settings, db: DB, clf: Classifier) -> list[str]:
    """Rebuild today's and yesterday's brief (late items keep arriving); older days stay frozen."""
    today = date.fromisoformat(today_ist())
    days = [today.isoformat(), (today - timedelta(days=1)).isoformat()]
    for d in days:
        build_day(settings, db, clf, d)
    db.commit()
    return days


def ensure_range(settings: Settings, db: DB, clf: Classifier, date_from: str, date_to: str) -> None:
    """Build briefs for any day in the range that has stories but no brief yet (e.g. first run backfill)."""
    have = db.brief_dates(date_from, date_to)
    days = [r["date_ist"] for r in db.q(
        "SELECT DISTINCT date_ist FROM stories WHERE date_ist BETWEEN ? AND ? AND is_library=0",
        (date_from, date_to))]
    missing = [d for d in days if d not in have]
    for d in missing:
        build_day(settings, db, clf, d)
    if missing:
        db.commit()

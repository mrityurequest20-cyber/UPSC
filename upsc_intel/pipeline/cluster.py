"""Group the same story reported by several outlets, and aggregate a story's items.

Thresholds are deliberately conservative: a wrong merge hides news, a missed merge only
shows a near-duplicate card.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from ..db import DB, iso, utcnow
from .classify import Classifier
from .normalize import publisher_key

WINDOW_DAYS = 3
MAX_MEMBERS = 8


def similar(a: set[str], b: set[str]) -> float:
    """0 when not the same story, otherwise a similarity score (higher = closer)."""
    if not a or not b:
        return 0.0
    shared = len(a & b)
    if a == b and shared >= 2:
        return 2.0
    if shared < 3:
        return 0.0
    jacc = shared / len(a | b)
    contain = shared / min(len(a), len(b))
    if jacc >= 0.5 or (contain >= 0.75 and shared >= 4):
        return jacc + contain
    return 0.0


class Clusterer:
    def __init__(self, db: DB, window_days: int = WINDOW_DAYS):
        self.members: dict[str, list[set[str]]] = defaultdict(list)
        self.index: dict[tuple[bool, str], set[str]] = defaultdict(set)
        self.editorial: dict[str, bool] = {}
        since = iso(utcnow() - timedelta(days=window_days))
        rows = db.q(
            "SELECT story_id, tokens, is_editorial FROM items WHERE story_id IN "
            "(SELECT id FROM stories WHERE last_seen >= ? AND is_library=0)",
            (since,),
        )
        for r in rows:
            toks = set(json.loads(r["tokens"] or "[]"))
            self.add(r["story_id"], toks, bool(r["is_editorial"]))

    def add(self, story_id: str, tokens: set[str], editorial: bool) -> None:
        self.editorial[story_id] = editorial
        if len(self.members[story_id]) < MAX_MEMBERS:
            self.members[story_id].append(tokens)
        for t in tokens:
            self.index[(editorial, t)].add(story_id)

    def find(self, tokens: set[str], editorial: bool) -> str | None:
        if len(tokens) < 2:
            return None
        cands: Counter = Counter()
        for t in tokens:
            for sid in self.index.get((editorial, t), ()):
                cands[sid] += 1
        best, best_score = None, 0.0
        for sid, n in cands.items():
            if n < 2:
                continue
            score = max(similar(tokens, m) for m in self.members[sid])
            if score > best_score:
                best, best_score = sid, score
        return best


TIER_RANK = {"official": 7, "examprep": 6, "premium": 6, "quality": 5, "library": 4, "general": 3, "intl": 3, "watch": 2}


def _rep_key(item: dict) -> tuple:
    return (
        item.get("kind") != "gnews",           # direct links beat Google News redirects
        TIER_RANK.get(item.get("tier"), 1),
        bool(item.get("summary")),
        -(datetime.fromisoformat(item["published_at"]).timestamp() if item.get("published_at") else 0),
    )


def aggregate_story(db: DB, clf: Classifier, story_id: str) -> dict | None:
    items = db.items_for_story(story_id)
    if not items:
        db.delete_story(story_id)
        return None
    rep = max(items, key=_rep_key)
    publishers: list[str] = []
    pub_keys: set[str] = set()
    for it in sorted(items, key=lambda i: (i.get("kind") == "gnews", -TIER_RANK.get(i.get("tier"), 1))):
        key = publisher_key(it.get("publisher"))
        if it.get("publisher") and key not in pub_keys:
            pub_keys.add(key)
            publishers.append(it["publisher"])

    subj_count: Counter = Counter()
    tag_count: Counter = Counter()
    watch: list[str] = []
    for it in items:
        for i, s in enumerate(it.get("subjects") or []):
            subj_count[s] += 3 - min(i, 2)  # first subject of an item weighs most
        tag_count.update(it.get("tags") or [])
        for w in it.get("watch") or []:
            if w not in watch:
                watch.append(w)
    subjects = [s for s, _ in subj_count.most_common(3)]
    tags = [t for t, _ in tag_count.most_common(6)]
    base = max(float(it.get("score") or 0) for it in items)
    score = round(base + clf.coverage_bonus(len(publishers)), 2)
    summary = rep.get("summary") or max((it.get("summary") or "" for it in items), key=len)
    dates = sorted({it["date_ist"] for it in items if it.get("date_ist")})
    fetched = sorted(it["fetched_at"] for it in items if it.get("fetched_at"))

    story = {
        "id": story_id,
        "title": rep["title"],
        "url": rep["url"],
        "date_ist": dates[0] if dates else None,
        "dates": dates,
        "first_seen": fetched[0] if fetched else iso(utcnow()),
        "last_seen": fetched[-1] if fetched else iso(utcnow()),
        "updated_at": iso(utcnow()),
        "n_items": len(items),
        "n_publishers": len(publishers),
        "publishers": publishers,
        "subjects": subjects,
        "gs": clf.gs_for(subjects, tags),
        "tags": tags,
        "watch": watch,
        "score": score,
        "grade": clf.grade(score),
        "is_editorial": int(all(it.get("is_editorial") for it in items)),
        "is_library": int(any(it.get("is_library") for it in items)),
        "is_private": int(all(it.get("is_private") for it in items)),
        "tier": rep.get("tier"),
        "summary": (summary or "")[:700],
        "tokens": rep.get("tokens") or [],
    }
    db.upsert_story(story)
    return story


"""The Daily Brief: every must-know story of a day, and nothing that isn't.

The firehose (hundreds of items a day) stays in the "Everything" tab; the brief is what a
candidate should actually read. Weekly and monthly views are built from the daily briefs, so
"this week we covered…" means exactly what appeared in that week's briefs.

There is no count cap: a busy day (a summit, a Parliament session) has a long brief, a quiet day a short one.
News (stories first reported that day):
1. Every story whose brief score clears `also` (config/topics.yaml → brief). The brief score is the grade
   score lifted by what kind of development the headline reports (a law passed, a Cabinet decision, a pact,
   an exercise, a species…) and lowered by reaction and commentary. Stories at `must_know` or above split in two:
   - "top" (Must-know): NOTE-grade stories whose headline is not a reaction, a preview, a spat or a niche case;
   - "prelims" (Prelims facts): any other story that reports a concrete development (an exercise, an MoU
     signed, an Act in force, a Cabinet approval, a scheme, a species, a verdict), not a preview or a spat.
   Everything else that clears the bar is listed under them ("more": Also in the news).
2. A light day is topped up: at least `floor_cards` cards (from the best remaining Prelims facts) and
   `floor_total` stories in all.
3. Coverage: a syllabus area with no story yet gets its best SKIM-or-better story (as "more").
4. Reports of the same event (near-identical headlines from different outlets that clustering kept apart)
   fold into one card: the best one leads, the others are listed on it.
Editorials and explainers: every SKIM-or-better piece with a syllabus subject, topped up to their floor. The
top-up caps each publisher first, so one paper can't fill the section. Their headlines are opaque ("When we
become too busy to think"), so any grade qualifies for the top-up once a subject matched and the score
clears OPINION_MIN_SCORE.
"""
from __future__ import annotations

import json
import math
from datetime import date, timedelta

from ..config import Settings
from ..db import DB
from .articles import is_stale
from .classify import Classifier
from .normalize import today_ist

TEXT_BONUS = 0.8
OPINION_MIN_SCORE = 0.5
FOLD_WINDOW_DAYS = 14   # word rarity for folding is measured over this many days of stories
ANCHOR_SHARE = 0.025    # a shared word counts as an anchor when at most this share of those stories use it
TWIN_SHARE = 0.0042     # two shared words this rare ("Hormuz", "Strait"; "Tarang", "Shakti") mean the same event
TIER_ORDER = {"top": 0, "prelims": 1, "more": 2}
FOLD_LINK = 3           # a report joins a card by resembling one of its first few reports (no chaining)


def _spread(items: list[dict], size: int) -> list[dict]:
    """Best `size` items; first pass caps each publisher, second pass fills what's left."""
    cap = max(3, size // 3)
    picked: list[dict] = []
    per_pub: dict[str, int] = {}
    for it in items:
        if len(picked) >= size:
            break
        if per_pub.get(it["publisher"], 0) < cap:
            picked.append(it)
            per_pub[it["publisher"]] = per_pub.get(it["publisher"], 0) + 1
    taken = {p["id"] for p in picked}
    for it in items:
        if len(picked) >= size:
            break
        if it["id"] not in taken:
            picked.append(it)
    picked.sort(key=lambda p: -p["score"])
    return picked


class _Rarity:
    """Word rarity over the fortnight up to `day`, for telling one event's reports apart from another's."""

    def __init__(self, db: DB, day: str):
        lo = (date.fromisoformat(day) - timedelta(days=FOLD_WINDOW_DAYS)).isoformat()
        self.df: dict[str, int] = {}
        self.n = 0
        for r in db.q("SELECT tokens FROM stories WHERE is_library=0 AND date_ist BETWEEN ? AND ?", (lo, day)):
            self.n += 1
            for t in set(json.loads(r["tokens"] or "[]")):
                self.df[t] = self.df.get(t, 0) + 1
        self.anchor_max = max(3.0, ANCHOR_SHARE * self.n)
        self.twin_max = max(2.0, TWIN_SHARE * self.n)

    def idf(self, t: str) -> float:
        return math.log((self.n + 1) / (self.df.get(t, 0) + 1))

    def similar(self, a: set[str], b: set[str]) -> float:
        """Weighted word overlap of two headlines; 0 unless they share at least two words, one of them rare.
        Two shared very rare words (names like "Tarang Shakti", "Nomadic Elephant") count as the same event."""
        shared = a & b
        if len(shared) < 2 or not any(self.df.get(t, 0) <= self.anchor_max and not t.isdigit() for t in shared):
            return 0.0
        if sum(1 for t in shared if self.df.get(t, 0) <= self.twin_max and not t.isdigit()) >= 2:
            return 1.0
        return sum(self.idf(t) for t in shared) / (sum(self.idf(t) for t in a | b) or 1.0)


def _fold(items: list[dict], rarity: _Rarity, threshold: float) -> list[list[dict]]:
    """Groups same-event reports; `items` come best first, so each group's first item leads it."""
    groups: list[list[dict]] = []
    for it in items:
        best, best_sim = None, 0.0
        for g in groups:
            sim = max(rarity.similar(it["tokens"], m["tokens"]) for m in g[:FOLD_LINK])
            if sim > best_sim:
                best, best_sim = g, sim
        if best is not None and best_sim >= threshold:
            best.append(it)
        else:
            groups.append([it])
    return groups


def select_day(db: DB, clf: Classifier, day: str, ed_size: int | None = None,
               ex_size: int | None = None) -> list[tuple[str, str, int, str, str | None]]:
    """[(story_id, kind, rank, tier, lead)] for one day. kind: news / editorial / explained; tier: "top"
    (Must-know card), "prelims" (Prelims facts card) or "more" (the list under the cards); lead: the story
    whose card this one is folded into."""
    b = clf.brief
    skim = dict(clf.grade_cut)["SKIM"]
    ed_size = int(b["editorials_floor"] if ed_size is None else ed_size)
    ex_size = int(b["explained_floor"] if ex_size is None else ex_size)
    rows = db.q(
        "SELECT id, title, COALESCE(summary,'') AS summary, score, grade, subjects, tags, is_editorial, is_explained, "
        "publishers, tokens, length(COALESCE(summary,'')) AS slen, a.published FROM stories "
        "LEFT JOIN article_text a ON a.story_id = stories.id WHERE date_ist=? AND is_library=0 "
        "ORDER BY score DESC",
        (day,),
    )
    news, eds, exps = [], [], []
    for r in rows:
        subjects = json.loads(r["subjects"] or "[]")
        if not subjects or is_stale(r["published"] or "", day):  # its own article is weeks old: a feed re-dated it
            continue
        publisher = (json.loads(r["publishers"] or "[]") or [""])[0]
        item = {"id": r["id"], "score": r["score"], "subject": subjects[0], "publisher": publisher,
                "tokens": set(json.loads(r["tokens"] or "[]"))}
        opinion_ok = r["grade"] != "LOW" or r["score"] >= OPINION_MIN_SCORE
        if r["is_editorial"]:
            if opinion_ok:
                eds.append(item)
        elif r["is_explained"]:
            if opinion_ok:
                exps.append(item)
        elif r["grade"] != "LOW":
            title = r["title"] or ""
            event, _, talk = clf.brief_signals(title, publisher)
            item["bs"] = clf.brief_score(r["score"], title, publisher)
            item["note"] = r["grade"] == "NOTE" and talk < 1 and not clf.brief_soft_title(title)
            item["fact"] = clf.brief_fact(title, json.loads(r["tags"] or "[]"), event, talk)
            # a story that comes with real text makes a better card than a bare headline
            item["order"] = item["bs"] + (TEXT_BONUS if r["slen"] >= 80 else 0)
            news.append(item)

    news.sort(key=lambda it: -it["bs"])
    picked: list[dict] = []
    for i, it in enumerate(news):  # 1. the bar and the tiers
        if it["bs"] >= b["also"] or (i < b["floor_total"] and it["bs"] >= b["floor_min"]):  # 2. floor_total
            if it["bs"] >= b["must_know"] and it["note"]:
                it["tier"] = "top"
            elif it["bs"] >= b["must_know"] and it["fact"]:
                it["tier"] = "prelims"
            else:
                it["tier"] = "more"
            picked.append(it)
    cards = sum(1 for it in picked if it["tier"] != "more")
    for it in picked:  # 2. a light day: the best remaining facts become cards
        if cards >= b["floor_cards"]:
            break
        if it["tier"] == "more" and it["fact"] and it["bs"] >= b["floor_min"]:
            it["tier"] = "prelims"
            cards += 1
    covered = {p["subject"] for p in picked}
    taken = {p["id"] for p in picked}
    for subj in clf.subject_meta:  # 3. coverage
        if subj in covered:
            continue
        best = next((it for it in news if it["subject"] == subj and it["id"] not in taken and it["score"] >= skim), None)
        if best:
            best["tier"] = "more"
            picked.append(best)
            covered.add(subj)

    picked.sort(key=lambda it: (TIER_ORDER[it["tier"]], -it["order"]))
    groups = _fold(picked, _Rarity(db, day), b["fold_similarity"])  # 4. same-event reports
    out: list[tuple[str, str, int, str, str | None]] = []
    rank = 0
    for g in groups:
        rank += 1
        out.append((g[0]["id"], "news", rank, g[0]["tier"], None))
    for g in groups:
        for m in g[1:]:
            rank += 1
            out.append((m["id"], "news", rank, g[0]["tier"], g[0]["id"]))

    def opinion(items: list[dict], floor: int) -> list[dict]:
        items.sort(key=lambda p: -p["score"])
        strong = [it for it in items if it["score"] >= skim]
        rest = [it for it in items if it["score"] < skim]
        return sorted(strong + _spread(rest, max(0, floor - len(strong))), key=lambda p: -p["score"])

    out += [(p["id"], "editorial", i + 1, "top", None) for i, p in enumerate(opinion(eds, ed_size))]
    out += [(p["id"], "explained", i + 1, "top", None) for i, p in enumerate(opinion(exps, ex_size))]
    return out


def build_day(settings: Settings, db: DB, clf: Classifier, day: str) -> int:
    picks = select_day(db, clf, day)
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

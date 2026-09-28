"""The syllabus map: every brief card filed under 1-2 micro-topics of the UPSC syllabus (config/syllabus.yaml).

* Tags: Intel AI picks a card's micro-topics as it reads the day's cards (pipeline/glossary.py: stories.extras.syl);
  the keyword rules of config/syllabus.yaml tag every other card, the ones from before and any the AI didn't reach
  (the rules only: no AI call is made for older days).
* data/syllabus.json (syllabus_payload): the syllabus tree, and for each micro-topic its brief cards of the last
  WINDOW_DAYS days (the latest first), how many in the last 30 and 7 days, flashcards from the cards' notes and the
  running stories (dossiers) most of whose reports fall under it. The pages draw the heatmap from it, and each
  device's done marks give its coverage.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import yaml

from ..config import Settings
from ..db import DB, iso
from .classify import TermMatcher
from .normalize import today_ist

log = logging.getLogger("upsc_intel.syllabus")

MAX_TAGS = 2
MIN_SCORE = 2.0       # keyword points a topic needs (a headline hit counts double)
SUBJECT_BONUS = 1.0   # when the card's subject is one of the topic's
STRONG = 1.5          # a topic needs a term this strong, or two different terms
SECOND = 0.5          # a second tag needs half the first one's points
WINDOW_DAYS = 45      # the brief days a topic lists (the working database keeps 45)
MAX_ITEMS = 40        # cards listed per topic (the latest)
MAX_CARDS = 10        # flashcards per topic
DOSSIER_SHARE = 0.34  # a dossier belongs to a topic that holds this share of its tagged reports


def _load(v):
    try:
        return json.loads(v) if isinstance(v, str) and v else v
    except (TypeError, ValueError):
        return None


class Syllabus:
    """config/syllabus.yaml: papers → lines → topics, and the keyword rules."""

    def __init__(self, data: dict):
        self.papers: list[dict] = []
        self.topics: dict[str, dict] = {}
        entries: dict[str, list[tuple[str, float]]] = {}
        for p in data.get("papers") or []:
            lines = []
            for ln in p.get("lines") or []:
                ids = []
                for t in ln.get("topics") or []:
                    tid = str(t["id"])
                    self.topics[tid] = {"id": tid, "name": t["name"], "paper": p["key"], "line_key": ln["key"],
                                        "line": ln.get("line") or "", "ncert": list(ln.get("ncert") or []),
                                        "subj": list(t.get("subj") or []), "prelims": bool(t.get("prelims"))}
                    ids.append(tid)
                    for term, w in (t.get("kw") or {}).items():
                        entries.setdefault(str(term), []).append((tid, float(w)))
                lines.append({"key": ln["key"], "line": ln.get("line") or "", "ncert": list(ln.get("ncert") or []), "topics": ids})
            self.papers.append({"key": p["key"], "name": p.get("name") or p["key"], "lines": lines})
        self.matcher = TermMatcher(entries)

    def rule_tags(self, title: str, text: str = "", subjects: list[str] | tuple = ()) -> list[str]:
        """The keyword rules: the 1-2 topics a card belongs to, best first ([] when none scores MIN_SCORE)."""
        score: dict[str, float] = {}
        strong: dict[str, int] = {}  # a topic's terms of weight STRONG or more, and its terms in all
        terms: dict[str, int] = {}

        def add(tid: str, w: float, times: int) -> None:
            score[tid] = score.get(tid, 0) + times * w
            terms[tid] = terms.get(tid, 0) + 1
            strong[tid] = strong.get(tid, 0) + (w >= STRONG)
        head = self.matcher.find(title or "")
        for vals in head.values():
            for tid, w in vals:
                add(tid, w, 2)
        for term, vals in self.matcher.find(text or "").items():
            if term in head:
                continue
            for tid, w in vals:
                add(tid, w, 1)
        subj = set(subjects or ())
        for tid in score:
            if subj & set(self.topics[tid]["subj"]):
                score[tid] += SUBJECT_BONUS
        # a single weak word ("attitude", "fort") never files a card on its own
        best = sorted((x for x in score.items() if x[1] >= MIN_SCORE and (strong[x[0]] or terms[x[0]] >= 2)),
                      key=lambda x: (-x[1], x[0]))
        if not best:
            return []
        return [tid for tid, s in best[:MAX_TAGS] if s >= best[0][1] * SECOND]

    def valid(self, ids) -> list[str]:
        out = []
        for i in ids or []:
            i = str(i or "").strip()
            if i in self.topics and i not in out:
                out.append(i)
        return out[:MAX_TAGS]

    def prompt_list(self) -> str:
        """For the AI: one line per topic, `id: paper · name`."""
        return "\n".join(f"{t['id']}: {t['paper']} · {t['name']}" for t in self.topics.values())


_CACHE: dict[str, tuple[float, Syllabus]] = {}


def load_syllabus(settings: Settings) -> Syllabus:
    p = Path(settings.config_dir) / "syllabus.yaml"
    mt = p.stat().st_mtime if p.is_file() else 0.0
    hit = _CACHE.get(str(p))
    if hit and hit[0] == mt:
        return hit[1]
    syl = Syllabus(yaml.safe_load(p.read_text(encoding="utf-8")) or {} if p.is_file() else {})
    _CACHE[str(p)] = (mt, syl)
    return syl


def story_text(story: dict) -> str:
    """What the rules read besides the headline: the summary and the AI note's first lines."""
    ai = _load(story.get("ai")) or {}
    parts = [story.get("summary") or "", ai.get("why_in_news") or "", " ".join((ai.get("points") or [])[:4])]
    return " ".join(p for p in parts if p)[:3000]


def tags_of(syl: Syllabus, story: dict) -> tuple[list[str], str]:
    """A card's topics: Intel AI's when it picked any, else the keyword rules' → (ids, "ai" | "rules" | "")."""
    extras = _load(story.get("extras")) or {}
    ai = syl.valid(extras.get("syl"))
    if ai:
        return ai, "ai"
    subjects = _load(story.get("subjects")) or []
    rules = syl.rule_tags(story.get("title") or "", story_text(story), subjects)
    return rules, "rules" if rules else ""


def _grade(row, ai_on: bool) -> str:
    up = (_load(row["triage"]) or {}).get("upsc")
    return {3: "NOTE", 2: "SKIM", 1: "READ", 0: "LOW"}.get(up) if ai_on and isinstance(up, int) else row["grade"]


def syllabus_payload(settings: Settings, db: DB, today: str | None = None, dossiers: dict | None = None) -> dict:
    """data/syllabus.json: the tree, and each topic's brief cards (the latest first), counts, flashcards and dossiers."""
    syl = load_syllabus(settings)
    today = today or today_ist()
    ai_on = (settings.ai_triage or "").lower() == "on"
    since = (date.fromisoformat(today) - timedelta(days=WINDOW_DAYS - 1)).isoformat()
    d30 = (date.fromisoformat(today) - timedelta(days=29)).isoformat()
    d7 = (date.fromisoformat(today) - timedelta(days=6)).isoformat()
    rows = db.q(
        "SELECT b.date_ist AS day, b.kind, COALESCE(b.tier, 'top') AS tier, s.id, s.title, s.url, s.grade, s.triage, s.ai, "
        "s.extras, s.subjects, COALESCE(s.summary, '') AS summary, s.publishers FROM brief_picks b JOIN stories s ON s.id = b.story_id "
        "WHERE b.date_ist >= ? AND b.date_ist <= ? AND b.lead IS NULL AND s.is_private = 0 AND s.is_library = 0 "
        "ORDER BY b.date_ist DESC, b.rank", (since, today))
    items: dict[str, list[dict]] = {t: [] for t in syl.topics}
    cards: dict[str, list[dict]] = {t: [] for t in syl.topics}
    seen: set[str] = set()
    by_story: dict[str, list[str]] = {}
    how = {"ai": 0, "rules": 0, "": 0}
    for r in rows:
        if r["id"] in seen:  # a story in two days' briefs: its latest day
            continue
        seen.add(r["id"])
        tags, src = tags_of(syl, dict(r))
        how[src] += 1
        if not tags:
            continue
        by_story[r["id"]] = tags
        pubs = _load(r["publishers"]) or []
        entry = {"id": r["id"], "d": r["day"], "t": r["title"], "g": _grade(r, ai_on),
                 "k": "ed" if r["kind"] == "editorial" else "x" if r["kind"] == "explained" else r["tier"],
                 "s": pubs[0] if pubs else "", "u": r["url"], "by": src}
        ai = _load(r["ai"]) or {}
        for i, tid in enumerate(tags):
            items[tid].append({**entry, **({"also": True} if i else {})})
            for c in ai.get("flashcards") or []:
                if isinstance(c, dict) and c.get("q") and c.get("a") and len(cards[tid]) < MAX_CARDS:
                    cards[tid].append({"q": c["q"], "a": c["a"], "id": r["id"], "d": r["day"]})
    ds_of: dict[str, list[dict]] = {t: [] for t in syl.topics}
    for d in (dossiers or {}).get("dossiers") or []:
        count: dict[str, int] = {}
        tl = d.get("timeline") or []
        for x in tl:
            for tid in by_story.get(x.get("id"), []):
                count[tid] = count.get(tid, 0) + 1
        tagged = sum(1 for x in tl if x.get("id") in by_story)
        for tid, n in sorted(count.items(), key=lambda x: -x[1])[:2]:
            if tagged and n / tagged >= DOSSIER_SHARE:
                ds_of[tid].append({"key": d["key"], "name": d["name"], "last": d.get("last_day"), "n": d.get("n")})
    topics = {}
    for tid, t in syl.topics.items():
        lst = items[tid]
        topics[tid] = {"name": t["name"], "paper": t["paper"], "line": t["line_key"], "prelims": t["prelims"],
                       "n30": sum(1 for x in lst if x["d"] >= d30), "n7": sum(1 for x in lst if x["d"] >= d7),
                       "n": len(lst), "last": lst[0]["d"] if lst else None, "items": lst[:MAX_ITEMS],
                       "cards": cards[tid], "dossiers": ds_of[tid]}
    return {"generated_at": iso(datetime.now(timezone.utc)), "from": since, "to": today,
            "papers": syl.papers, "topics": topics,
            "stats": {"cards": len(seen), "tagged": len(by_story), "by_ai": how["ai"], "by_rules": how["rules"]}}

"""The week's Mains writing set, from the week's news (one Gemini call a week):

* essays: four topics in the style of the UPSC Essay paper, two per section (A: abstract or philosophical, B: issue-based),
  each with the angles a good essay would cover and the week's stories that feed it;
* a GS4 case study: an administrative dilemma drawn from one of the week's stories (fictionalised: roles, not real
  private people), with UPSC-style questions;
* a GS4 ethics question on a theme from the week.

Written once for the current week (its Monday, IST) from the last seven days' Must-know cards and editorials; earlier
weeks are never written after the fact. The pages mark answers on the reader's own key (static/intel-core.js).
data/weekly.json: the last WEEKS weeks, the latest first.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone

from ..config import Settings
from ..db import DB, iso
from .enrich import Gemini, GeminiStop
from .normalize import today_ist

log = logging.getLogger("upsc_intel.weekly")

WEEKS = 8
MAX_STORIES = 40
MIN_STORIES = 8   # a thin week (a new database) waits for more news

SYSTEM = """You set the weekly writing practice of a UPSC Civil Services aspirant, from the week's news (numbered).
- essays: exactly 4 topics in the style of the UPSC Essay paper: 2 for section "A" (abstract, philosophical, often a
  quote or an aphorism, e.g. "Not all who wander are lost") and 2 for section "B" (issue-based, e.g. "Technology as the
  silent driver of economic growth"). Each is a statement or a question, never a news headline, and draws on themes of
  the week's news. angles: 4-6 dimensions a strong 1000-1200 word essay would cover. links: the numbers of the week's
  stories that give it material (0-4).
- case: one GS4 case study of about 200-260 words, set in India, drawn from a theme of one of the week's stories: a
  public servant (e.g. "You are the District Collector of…") faces an ethical dilemma with competing duties and
  stakeholders. Invent the roles and places; never use a real private person's name. questions: 3 sub-questions in the
  UPSC form (the stakeholders and the ethical issues; the options available with their merits and demerits; the course
  of action you would take and why). links: the story numbers it draws on.
- ethics: one GS4 theory question (10 marks, 150 words) on a value or concept the week's news raises (e.g.
  accountability, probity, compassion, conflict of interest). links: the story numbers.
Plain, exam-like English."""

SCHEMA = {"type": "object", "properties": {
    "essays": {"type": "array", "items": {"type": "object", "properties": {
        "section": {"type": "string", "enum": ["A", "B"]}, "topic": {"type": "string"},
        "angles": {"type": "array", "items": {"type": "string"}}, "links": {"type": "array", "items": {"type": "integer"}}},
        "required": ["section", "topic", "angles", "links"]}},
    "case": {"type": "object", "properties": {
        "title": {"type": "string"}, "scenario": {"type": "string"},
        "questions": {"type": "array", "items": {"type": "string"}}, "links": {"type": "array", "items": {"type": "integer"}}},
        "required": ["title", "scenario", "questions", "links"]},
    "ethics": {"type": "object", "properties": {"question": {"type": "string"}, "links": {"type": "array", "items": {"type": "integer"}}},
               "required": ["question", "links"]}},
    "required": ["essays", "case", "ethics"]}


def week_of(day: str) -> str:
    """The week's key: its Monday."""
    d = date.fromisoformat(day)
    return (d - timedelta(days=d.weekday())).isoformat()


def _stories(db: DB, day: str) -> list[dict]:
    """The last seven days' Must-know cards and editorials (up to `day`), the latest first."""
    since = (date.fromisoformat(day) - timedelta(days=7)).isoformat()
    rows = db.q("SELECT b.date_ist AS day, s.id, s.title, s.ai FROM brief_picks b JOIN stories s ON s.id = b.story_id "
                "WHERE b.date_ist >= ? AND b.date_ist <= ? AND b.lead IS NULL AND COALESCE(b.tier, 'top') = 'top' "
                "AND b.kind IN ('news', 'editorial') AND s.is_private = 0 ORDER BY b.date_ist DESC, b.rank", (since, day))
    out, seen = [], set()
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        ai = json.loads(r["ai"]) if r["ai"] else {}
        line = ((ai.get("points") or [None])[0] or ai.get("why_in_news") or "") if isinstance(ai, dict) else ""
        out.append({"id": r["id"], "day": r["day"], "title": r["title"], "line": str(line)[:240]})
    return out[:MAX_STORIES]


def _clean(reply: dict, stories: list[dict]) -> dict | None:
    """The reply, checked: 2-4 essays with a topic and angles, a case with a scenario and questions, story numbers kept
    only when they exist (as story ids)."""
    def links(xs):
        return [stories[n - 1]["id"] for n in xs or [] if isinstance(n, int) and 1 <= n <= len(stories)][:4]

    def text(x, n=600):
        return " ".join(str(x or "").split())[:n]
    essays = []
    for e in reply.get("essays") or []:
        topic = text(e.get("topic"), 200)
        if len(topic) >= 8 and e.get("section") in ("A", "B"):
            essays.append({"section": e["section"], "topic": topic, "angles": [text(a, 200) for a in e.get("angles") or [] if text(a)][:6],
                           "links": links(e.get("links"))})
    case = reply.get("case") or {}
    case = {"title": text(case.get("title"), 120), "scenario": text(case.get("scenario"), 2400),
            "questions": [text(q, 300) for q in case.get("questions") or [] if text(q)][:4], "links": links(case.get("links"))}
    ethics = reply.get("ethics") or {}
    ethics = {"question": text(ethics.get("question"), 400), "links": links(ethics.get("links"))}
    if len(essays) < 2 or len(case["scenario"]) < 200 or len(case["questions"]) < 2:
        return None
    return {"essays": essays[:4], "case": case, "ethics": ethics if len(ethics["question"]) >= 20 else None}


def build_weekly(settings: Settings, db: DB, today: str | None = None, http=None) -> dict:
    """Writes this week's set once (the first run of the week with enough news). → {"week", "written" | "have" | ...}"""
    if not settings.gemini_api_key:
        return {"enabled": False}
    today = today or today_ist()
    week = week_of(today)
    if db.q("SELECT 1 FROM weekly WHERE week=?", (week,)):
        return {"week": week, "have": True}
    stories = _stories(db, today)
    if len(stories) < MIN_STORIES:
        return {"week": week, "waiting": len(stories)}
    text = "\n".join(f"{n}. {s['day']}: {s['title']}. {s['line']}" for n, s in enumerate(stories, 1))
    gem = Gemini(settings.gemini_api_key, settings.gemini_model, http=http, db=db)
    try:
        reply, model = gem.generate(SYSTEM, text, SCHEMA)
    except GeminiStop as exc:
        return {"week": week, "paused": str(exc)}
    if not reply or reply.get("skipped"):
        return {"week": week, "skipped": (reply or {}).get("skipped") or "empty"}
    data = _clean(reply, stories)
    if not data:
        return {"week": week, "skipped": "incomplete"}
    data.update({"from": stories[-1]["day"], "to": stories[0]["day"], "by": model})
    db.x("INSERT OR REPLACE INTO weekly (week, data, at) VALUES (?,?,?)",
         (week, json.dumps(data, ensure_ascii=False), iso(datetime.now(timezone.utc))))
    db.commit()
    return {"week": week, "written": True}


def weekly_payload(db: DB) -> dict:
    """data/weekly.json: the last WEEKS weeks' sets, the latest first, with the linked stories' headlines and days."""
    weeks = []
    for r in db.q("SELECT week, data FROM weekly ORDER BY week DESC LIMIT ?", (WEEKS,)):
        d = json.loads(r["data"])
        ids = sorted({i for e in d.get("essays") or [] for i in e.get("links") or []} | set((d.get("case") or {}).get("links") or [])
                     | set((d.get("ethics") or {}).get("links") or []))
        stories = {}
        if ids:
            for s in db.q(f"SELECT id, title, date_ist, url FROM stories WHERE id IN ({','.join('?' * len(ids))})", ids):
                stories[s["id"]] = {"t": s["title"], "d": s["date_ist"], "u": s["url"]}
        weeks.append({"week": r["week"], **d, "stories": stories})
    return {"generated_at": iso(datetime.now(timezone.utc)), "weeks": weeks}

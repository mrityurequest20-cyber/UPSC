"""Glossary: the terms a UPSC aspirant should know from each brief card (an Article, an Act, a scheme, a body, an
acronym, a technical term), each with a short textbook explanation, written by Gemini once and kept.

The recent days' cards without terms go to Gemini in batches of BATCH (headline and key lines). A term must appear in
the card's own text, so the pages can mark it there; a term already in the glossary keeps its first explanation.
stories.terms holds a card's term keys ([] when it has none, so it isn't asked again); the glossary table holds each
term once. The day's brief carries its cards' terms (web/app.py brief_payload → days[d].glossary); the pages mark each
term's first mention in a story's text, and a tap shows the meaning.
"""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone

from ..config import Settings
from ..db import DB, iso
from .enrich import GEMINI_PAUSE, Gemini, GeminiStop

log = logging.getLogger("upsc_intel.glossary")

BATCH = 8        # cards per call
MAX_CALLS = 4    # per run: up to 32 cards (a day's cards are covered in a few runs)
PER_CARD = 6     # terms kept per card
TEXT_CHARS = 700

SYSTEM = """You write the glossary of a UPSC Civil Services aspirant's daily current-affairs brief. For each numbered
story (its headline and key lines), pick the 3-6 terms in it that an aspirant should know or revise: Articles and
Schedules of the Constitution, Acts and Bills, schemes and missions, constitutional, statutory and international
bodies, groupings and agreements, economic, scientific and technical terms, acronyms, species, protected areas and
places of note, military exercises. Skip everyday words and people's names.
- term: exactly as it is written in the story's text (the same spelling and capitals), 1-6 words.
- meaning: static, textbook background in at most 35 words: what it is, and for an acronym its full form first; for
  an Article or an Act, what it provides. Never the news of the day. Only what you are sure of.
Answer for every story, using its number."""

SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
    "n": {"type": "integer"},
    "terms": {"type": "array", "items": {"type": "object", "properties": {"term": {"type": "string"}, "meaning": {"type": "string"}},
                                          "required": ["term", "meaning"]}}},
    "required": ["n", "terms"]}}}, "required": ["items"]}


def term_key(term: str) -> str:
    return re.sub(r"\s+", " ", (term or "").strip()).lower()


def card_text(title: str, ai: dict | None, summary: str) -> str:
    """The card's headline and key lines: its AI note's points, else its why-in-news and what, else the reports."""
    ai = ai or {}
    lines = ai.get("points") or [ai.get("why_in_news"), ai.get("what")]
    body = " ".join(x for x in lines if x) or summary or ""
    return f"{title}. {' '.join(body.split())}"[:TEXT_CHARS]


def _todo(db: DB, days: list[str]) -> list[dict]:
    """The days' cards (Must-know, Prelims facts, editorials, explainers) without terms yet, Must-know first."""
    rows = db.q(
        f"SELECT s.id, s.title, COALESCE(s.summary,'') AS summary, s.ai, b.date_ist FROM brief_picks b JOIN stories s ON s.id = b.story_id "
        f"WHERE b.date_ist IN ({','.join('?' * len(days))}) AND COALESCE(b.tier, 'top') IN ('top', 'prelims') AND b.lead IS NULL "
        f"AND s.terms IS NULL AND s.is_private = 0 "
        f"ORDER BY b.date_ist DESC, (b.kind = 'news' AND COALESCE(b.tier, 'top') = 'top') DESC, b.rank", days)
    out, seen = [], set()
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        ai = json.loads(r["ai"]) if r["ai"] else None
        out.append({"id": r["id"], "day": r["date_ist"], "text": card_text(r["title"], ai if isinstance(ai, dict) else None, r["summary"])})
    return out


def terms_of(reply: dict, batch: list[dict]) -> dict[str, list[dict]]:
    """{card id: [{term, meaning}]} from Gemini's reply: a term the card's text doesn't carry, or a meaning too short or
    too long, is dropped. A card missing from the reply is left out (asked again)."""
    out: dict[str, list[dict]] = {}
    for x in (reply or {}).get("items") or []:
        n = x.get("n")
        if not isinstance(n, int) or not 1 <= n <= len(batch):
            continue
        card = batch[n - 1]; low = card["text"].lower()
        keep, keys = [], set()
        for t in x.get("terms") or []:
            term = " ".join(str(t.get("term") or "").split()).strip(" .,:;\"'")
            meaning = " ".join(str(t.get("meaning") or "").split())
            k = term_key(term)
            if not 2 <= len(term) <= 60 or not 12 <= len(meaning) <= 320 or k in keys or k not in low:
                continue
            keys.add(k); keep.append({"term": term, "meaning": meaning})
        out[card["id"]] = keep[:PER_CARD]
    return out


def build_glossary(settings: Settings, db: DB, days: list[str], http=None, pause: float = GEMINI_PAUSE,
                   max_calls: int = MAX_CALLS) -> dict:
    """Finds the terms of the days' cards that have none yet. → {"cards", "terms", "calls", "left"}"""
    if not settings.gemini_api_key or not days:
        return {"enabled": False}
    todo = _todo(db, days)
    if not todo:
        return {"enabled": True, "cards": 0, "terms": 0, "calls": 0, "left": 0}
    gem = Gemini(settings.gemini_api_key, settings.gemini_model, http=http)
    now = iso(datetime.now(timezone.utc))
    cards = new = calls = 0
    note = ""
    for i in range(0, len(todo), BATCH):
        if calls >= max_calls:
            break
        batch = todo[i:i + BATCH]
        if calls and pause:
            time.sleep(pause)
        calls += 1
        try:
            reply, model = gem.generate(SYSTEM, "\n".join(f"{n}. {c['text']}" for n, c in enumerate(batch, 1)), SCHEMA)
        except GeminiStop as exc:
            note = str(exc)
            log.warning("Glossary paused: %s", note)
            break
        except Exception as exc:  # a network hiccup: these wait for the next run
            log.warning("Glossary: %s", type(exc).__name__)
            continue
        if not reply or reply.get("skipped"):
            continue
        day_of = {c["id"]: c["day"] for c in batch}
        for sid, terms in terms_of(reply, batch).items():
            for t in terms:  # the first explanation of a term stays
                new += db.x("INSERT OR IGNORE INTO glossary (key, term, meaning, first_day, at) VALUES (?,?,?,?,?)",
                            (term_key(t["term"]), t["term"], t["meaning"], day_of[sid], now)).rowcount
            db.x("UPDATE stories SET terms=? WHERE id=?", (json.dumps([term_key(t["term"]) for t in terms]), sid))
            cards += 1
        db.commit()
    return {"enabled": True, "cards": cards, "terms": new, "calls": calls, "left": len(todo) - cards,
            **({"paused": note} if note else {})}


def glossary_for(db: DB, keys) -> dict[str, dict]:
    """{key: {"t": term, "m": meaning}} for the given term keys."""
    keys = sorted({k for k in keys if k})
    out: dict[str, dict] = {}
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        for r in db.q(f"SELECT key, term, meaning FROM glossary WHERE key IN ({','.join('?' * len(chunk))})", chunk):
            out[r["key"]] = {"t": r["term"], "m": r["meaning"]}
    return out

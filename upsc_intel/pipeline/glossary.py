"""Study extras of each brief card, from one Gemini call per BATCH cards (headline and key lines):

* glossary: the terms a UPSC aspirant should know (an Article, an Act, a scheme, a body, an acronym, a technical term),
  each with a short textbook explanation. A term must appear in the card's own text, so the pages can mark it; a term
  already in the glossary keeps its first explanation. stories.terms holds the card's term keys; the glossary table
  holds each term once. The day's brief carries its cards' terms (brief_payload → days[d].glossary).
* places: the places the story is about, with their coordinates, for the Places-in-news map. A place in India must lie
  within India's bounds, and any place needs sane coordinates. The places table holds each place once;
  stories.extras.places the card's place keys; the day's brief carries them (days[d].places).
* running topics: the ongoing issue the story belongs to (India–Canada relations, the Waqf Act, Manipur…), reusing
  a known topic's name when it fits, with a few search words. The topics table holds each; stories.extras.topics the
  card's topic keys; pipeline/dossiers.py builds each topic's timeline and "story so far".
* syllabus: the 1-2 micro-topics of the UPSC syllabus (config/syllabus.yaml) the story serves: stories.extras.syl
  (pipeline/syllabus.py tags the other cards by keyword rules).

A card is asked once: stories.terms and stories.extras ([] and {} when it has none).
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
from .syllabus import load_syllabus

log = logging.getLogger("upsc_intel.glossary")

BATCH = 8        # cards per call
MAX_CALLS = 4    # per run: up to 32 cards (a day's cards are covered in a few runs)
PER_CARD = 6     # terms kept per card
TEXT_CHARS = 700
KNOWN_TOPICS = 60  # the most recent running topics offered to Gemini for reuse
PLACE_KINDS = ("country", "state", "city", "district", "protected area", "river", "lake", "sea", "mountain", "island",
               "border", "port", "region", "other")
INDIA_BOX = (6.0, 37.6, 68.0, 97.6)  # lat, lat, lon, lon

SYSTEM = """You prepare study extras for the cards of a UPSC Civil Services aspirant's daily current-affairs brief.
For each numbered story (its headline and key lines) give:
- terms: the 3-6 terms in it that an aspirant should know or revise: Articles and Schedules of the Constitution, Acts
  and Bills, schemes and missions, constitutional, statutory and international bodies, groupings and agreements,
  economic, scientific and technical terms, acronyms, species, protected areas and places of note, military exercises.
  Skip everyday words and people's names.
  - term: exactly as it is written in the story's text (the same spelling and capitals), 1-6 words.
  - meaning: static, textbook background in at most 35 words: what it is, and for an acronym its full form first; for
    an Article or an Act, what it provides. Never the news of the day. Only what you are sure of.
- places: 0-4 places the story is about (where it happened or what it concerns, not every place it names): name as
  commonly written, kind (one of: {kinds}), the country it is in, the Indian state or union territory for a place in
  India (else ""), and its latitude and longitude in decimal degrees (a country or state: its centre). Only places you
  can locate with confidence.
- topics: 0-2 running stories this story is part of: an ongoing issue that runs across days (e.g. "India–Canada
  relations", "Waqf (Amendment) Act", "Manipur violence", "Monsoon session of Parliament"), not a one-off event. Use
  a name from KNOWN TOPICS when one fits, exactly as written; else a short new name. query: 1-3 distinctive words that
  every story on the topic contains (e.g. "Waqf", "Canada", "Manipur"), never generic words like "India" or "government".
- syllabus: the 1-2 topics of the UPSC syllabus the story is most useful for, as ids from SYLLABUS TOPICS exactly as
  written (the first one the best fit); [] when none fits.
Answer for every story, using its number.

KNOWN TOPICS:
{known}

SYLLABUS TOPICS (id: paper · topic):
{syllabus}"""

SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
    "n": {"type": "integer"},
    "terms": {"type": "array", "items": {"type": "object", "properties": {"term": {"type": "string"}, "meaning": {"type": "string"}},
                                          "required": ["term", "meaning"]}},
    "places": {"type": "array", "items": {"type": "object", "properties": {
        "name": {"type": "string"}, "kind": {"type": "string"}, "country": {"type": "string"}, "state": {"type": "string"},
        "lat": {"type": "number"}, "lon": {"type": "number"}}, "required": ["name", "kind", "country", "state", "lat", "lon"]}},
    "topics": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "query": {"type": "string"}},
                                           "required": ["name", "query"]}},
    "syllabus": {"type": "array", "items": {"type": "string"}}},
    "required": ["n", "terms", "places", "topics", "syllabus"]}}}, "required": ["items"]}

GENERIC = {"india", "indian", "government", "centre", "center", "minister", "ministry", "policy", "court", "news", "state",
           "states", "world", "global", "new", "report", "the", "and", "of"}


def term_key(term: str) -> str:
    return re.sub(r"\s+", " ", (term or "").strip()).lower()


def place_key(name: str, country: str) -> str:
    return f"{term_key(name)}|{term_key(country)}"


def topic_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:60]


def card_text(title: str, ai: dict | None, summary: str) -> str:
    """The card's headline and key lines: its AI note's points, else its why-in-news and what, else the reports."""
    ai = ai or {}
    lines = ai.get("points") or [ai.get("why_in_news"), ai.get("what")]
    body = " ".join(x for x in lines if x) or summary or ""
    return f"{title}. {' '.join(body.split())}"[:TEXT_CHARS]


def _todo(db: DB, days: list[str]) -> list[dict]:
    """The days' cards (Must-know, Prelims facts, editorials, explainers) without their extras yet, Must-know first."""
    rows = db.q(
        f"SELECT s.id, s.title, COALESCE(s.summary,'') AS summary, s.ai, b.date_ist FROM brief_picks b JOIN stories s ON s.id = b.story_id "
        f"WHERE b.date_ist IN ({','.join('?' * len(days))}) AND COALESCE(b.tier, 'top') IN ('top', 'prelims') AND b.lead IS NULL "
        f"AND (s.terms IS NULL OR s.extras IS NULL) AND s.is_private = 0 "
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


def places_of(items: list) -> list[dict]:
    """The places with sane coordinates (a place in India within India's bounds), at most 4."""
    out, keys = [], set()
    for p in items or []:
        name = " ".join(str(p.get("name") or "").split())[:60]
        country = " ".join(str(p.get("country") or "").split())[:40]
        lat, lon = p.get("lat"), p.get("lon")
        if not name or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or (lat == 0 and lon == 0):
            continue
        if not -90 <= lat <= 90 or not -180 <= lon <= 180:
            continue
        if term_key(country) in ("india", "bharat") and not (INDIA_BOX[0] <= lat <= INDIA_BOX[1] and INDIA_BOX[2] <= lon <= INDIA_BOX[3]):
            continue
        k = place_key(name, country)
        if k in keys:
            continue
        keys.add(k)
        kind = str(p.get("kind") or "other").lower()
        out.append({"key": k, "name": name, "kind": kind if kind in PLACE_KINDS else "other", "country": country,
                    "state": " ".join(str(p.get("state") or "").split())[:40], "lat": round(float(lat), 4), "lon": round(float(lon), 4)})
    return out[:4]


def topics_of(items: list) -> list[dict]:
    """The running topics with a usable name and search words (generic words dropped), at most 2."""
    out = []
    for t in items or []:
        name = " ".join(str(t.get("name") or "").split()).strip(" .")[:70]
        words = [w for w in re.findall(r"[\w'’-]+", str(t.get("query") or "")) if w.lower() not in GENERIC][:3]
        if len(name) >= 4 and words and topic_key(name):
            out.append({"key": topic_key(name), "name": name, "query": " ".join(words)})
    return out[:2]


def known_topics(db: DB, n: int = KNOWN_TOPICS) -> list[str]:
    return [r["name"] for r in db.q("SELECT name FROM topics ORDER BY last_day DESC, n DESC LIMIT ?", (n,))]


def build_glossary(settings: Settings, db: DB, days: list[str], http=None, pause: float = GEMINI_PAUSE,
                   max_calls: int = MAX_CALLS) -> dict:
    """Finds the terms, places and running topics of the days' cards that have none yet. → {"cards", "terms", "calls", …}"""
    if not settings.gemini_api_key or not days:
        return {"enabled": False}
    todo = _todo(db, days)
    if not todo:
        return {"enabled": True, "cards": 0, "terms": 0, "places": 0, "topics": 0, "calls": 0, "left": 0}
    gem = Gemini(settings.gemini_api_key, settings.gemini_model, http=http, db=db)
    syl = load_syllabus(settings)
    now = iso(datetime.now(timezone.utc))
    cards = new = n_places = n_topics = n_syl = calls = 0
    note = ""
    for i in range(0, len(todo), BATCH):
        if calls >= max_calls:
            break
        batch = todo[i:i + BATCH]
        if calls and pause:
            time.sleep(pause)
        calls += 1
        system = SYSTEM.format(kinds=", ".join(PLACE_KINDS), known="\n".join(f"- {t}" for t in known_topics(db)) or "(none yet)",
                               syllabus=syl.prompt_list() or "(none)")
        try:
            reply, model = gem.generate(system, "\n".join(f"{n}. {c['text']}" for n, c in enumerate(batch, 1)), SCHEMA)
        except GeminiStop as exc:
            note = str(exc)
            log.warning("Study extras paused: %s", note)
            break
        except Exception as exc:  # a network hiccup: these wait for the next run
            log.warning("Study extras: %s", type(exc).__name__)
            continue
        if not reply or reply.get("skipped"):
            continue
        day_of = {c["id"]: c["day"] for c in batch}
        items = {batch[x["n"] - 1]["id"]: x for x in reply.get("items") or [] if isinstance(x.get("n"), int) and 1 <= x["n"] <= len(batch)}
        for sid, terms in terms_of(reply, batch).items():
            d = day_of[sid]
            for t in terms:  # the first explanation of a term stays
                new += db.x("INSERT OR IGNORE INTO glossary (key, term, meaning, first_day, at) VALUES (?,?,?,?,?)",
                            (term_key(t["term"]), t["term"], t["meaning"], d, now)).rowcount
            places = places_of(items[sid].get("places"))
            for p in places:  # the first coordinates of a place stay
                db.x("INSERT OR IGNORE INTO places (key, name, kind, country, state, lat, lon, at) VALUES (?,?,?,?,?,?,?,?)",
                     (p["key"], p["name"], p["kind"], p["country"], p["state"], p["lat"], p["lon"], now))
            topics = topics_of(items[sid].get("topics"))
            for t in topics:
                db.x("INSERT INTO topics (key, name, query, first_day, last_day, n, at) VALUES (?,?,?,?,?,1,?) "
                     "ON CONFLICT(key) DO UPDATE SET first_day=MIN(first_day, excluded.first_day), "
                     "last_day=MAX(last_day, excluded.last_day), n=n+1", (t["key"], t["name"], t["query"], d, d, now))
            tags = syl.valid(items[sid].get("syllabus"))  # ids not in config/syllabus.yaml are dropped
            db.x("UPDATE stories SET terms=?, extras=? WHERE id=?",
                 (json.dumps([term_key(t["term"]) for t in terms]),
                  json.dumps({"places": [p["key"] for p in places], "topics": [t["key"] for t in topics], "syl": tags}), sid))
            cards += 1; n_places += len(places); n_topics += len(topics); n_syl += bool(tags)
        db.commit()
    return {"enabled": True, "cards": cards, "terms": new, "places": n_places, "topics": n_topics, "syllabus": n_syl, "calls": calls,
            "left": len(todo) - cards, **({"paused": note} if note else {})}


def glossary_for(db: DB, keys) -> dict[str, dict]:
    """{key: {"t": term, "m": meaning}} for the given term keys."""
    keys = sorted({k for k in keys if k})
    out: dict[str, dict] = {}
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        for r in db.q(f"SELECT key, term, meaning FROM glossary WHERE key IN ({','.join('?' * len(chunk))})", chunk):
            out[r["key"]] = {"t": r["term"], "m": r["meaning"]}
    return out


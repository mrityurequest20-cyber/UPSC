"""Dossiers: the running stories of the news (India–Canada relations, the Waqf Act, Manipur…), each with its timeline
and a "story so far", and the places-in-news map's data.

The running topics come from two places: the long-running issues listed in config/dossiers.yaml (the seeds: no AI
needed), and the cards' study extras (pipeline/glossary.py: Gemini names the ongoing issue each card belongs to,
reusing a known topic's name, with a few search words). A topic's timeline is its tagged stories plus the stories whose
headline carries all its search words (full-text search over everything stored), from the last WINDOW_DAYS: never a
private or library story, and a matched story only when it is worth reading (Gemini's 2-3, or the rules' NOTE/SKIM).
A topic becomes a dossier once its timeline has MIN_STORIES stories on MIN_DAYS days, the latest in the last LIVE_DAYS;
two dossiers that share most of their reports are one (the bigger stays). The latest in the news show first.

The story so far (a few points in order, the UPSC angle, what to watch) is written by Gemini from the timeline's dated
headlines and key lines, again only when the timeline has changed (topics.sig), and at most every REWRITE_HOURS:
the dossiers without one first, PER_CALL a call, at most MAX_CALLS calls a run. Without a key, or while the quota is out, the timeline shows alone (or with its last summary).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone

from pathlib import Path

import yaml

from ..config import Settings
from ..db import DB, iso
from .enrich import GEMINI_PAUSE, Gemini, GeminiStop
from .glossary import topic_key
from .normalize import today_ist

log = logging.getLogger("upsc_intel.dossiers")

WINDOW_DAYS = 45   # a timeline reaches back this far
LIVE_DAYS = 30     # a dossier in the news this recently is shown
MAX_DOSSIERS = 50
OVERLAP = 0.6      # two dossiers sharing this share of the smaller one's reports are the same story
MAX_ITEMS = 25     # timeline entries kept (the latest)
MIN_STORIES, MIN_DAYS = 2, 2
MAX_CALLS = 2
PER_CALL = 3
REWRITE_HOURS = 6  # a written story so far is rewritten at most this often (a busy topic changes every run)
LINE_CHARS = 220
PLACE_DAYS = 30    # the map's reach

SYSTEM = """You write dossiers on running current-affairs stories for a UPSC Civil Services aspirant. For each numbered
topic you get its dated headlines and key lines, oldest first. Give:
- so_far: 3-6 short points (at most 30 words each) telling the story so far in order, with dates as "12 Sep"; only
  what the lines say.
- upsc: 2-4 short points on why it matters for UPSC: the GS paper and syllabus topic, the constitutional or legal
  provisions, bodies and concepts involved, and the angle a Mains question could take. Static background you are sure
  of is welcome here.
- watch: 0-3 short points on what to watch next (a pending decision, hearing, vote, deadline or visit) as the lines
  suggest; an empty list if they suggest nothing.
- gs: the GS papers it belongs to (GS1, GS2, GS3, GS4).
Answer for every topic, using its number."""

SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
    "n": {"type": "integer"},
    "so_far": {"type": "array", "items": {"type": "string"}},
    "upsc": {"type": "array", "items": {"type": "string"}},
    "watch": {"type": "array", "items": {"type": "string"}},
    "gs": {"type": "array", "items": {"type": "string"}}},
    "required": ["n", "so_far", "upsc", "watch", "gs"]}}}, "required": ["items"]}


def _clip(text: str, n: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0] + "…"


def _load(v):
    try:
        return json.loads(v) if v else None
    except (TypeError, ValueError):
        return None


def worth(row, ai_on: bool) -> bool:
    """A story found by its words is kept when worth reading: Gemini's 2-3 when it has graded it, else NOTE/SKIM."""
    v = _load(row["triage"]) or {}
    if ai_on and isinstance(v.get("upsc"), int):
        return v["upsc"] >= 2
    return row["grade"] in ("NOTE", "SKIM")


def grade_of(row, ai_on: bool) -> str:
    """The story's grade as the pages show it: Gemini's 0-3 in grade words when triage is on, else the rules'."""
    up = (_load(row["triage"]) or {}).get("upsc")
    return {3: "NOTE", 2: "SKIM", 1: "READ", 0: "LOW"}.get(up) if ai_on and isinstance(up, int) else row["grade"]


def gist(row) -> str:
    """The story's one line: its AI note's first point or why-in-news, else its summary."""
    ai = _load(row["ai"]) or {}
    line = (ai.get("points") or [None])[0] or ai.get("why_in_news") or row["summary"] or ""
    return _clip(line, LINE_CHARS)


def load_seeds(settings: Settings) -> list[dict]:
    """The long-running issues of config/dossiers.yaml: [{key, name, query, gs}]."""
    p = Path(settings.config_dir) / "dossiers.yaml"
    items = ((yaml.safe_load(p.read_text(encoding="utf-8")) or {}).get("topics") or []) if p.is_file() else []
    return [{"key": topic_key(x["name"]), "name": x["name"], "query": x["query"], "gs": x.get("gs") or []}
            for x in items if x.get("name") and x.get("query")]


def sync_seeds(db: DB, seeds: list[dict]) -> None:
    """The seeds in the topics table (a Gemini topic of the same name becomes the seed, with the listed search words)."""
    for x in seeds:
        db.x("INSERT INTO topics (key, name, query, n, seed) VALUES (?,?,?,0,1) ON CONFLICT(key) DO UPDATE SET "
             "name=excluded.name, query=excluded.query, seed=1", (x["key"], x["name"], x["query"]))
    db.commit()


def _words(query: str) -> list[str]:
    return [w.lower() for w in re.findall(r"[\w'’]+", query or "") if len(w) >= 2]  # "EU" counts


def timeline(db: DB, topic: dict, today: str, ai_on: bool) -> list[dict]:
    """The topic's stories from the last WINDOW_DAYS, the latest first: its tagged stories and the ones whose headline
    carries its search words (see the module doc)."""
    since = (date.fromisoformat(today) - timedelta(days=WINDOW_DAYS)).isoformat()
    tagged = {r["id"] for r in db.q(
        "SELECT s.id FROM stories s WHERE s.extras IS NOT NULL AND s.date_ist >= ? "
        "AND EXISTS (SELECT 1 FROM json_each(s.extras, '$.topics') j WHERE j.value = ?)", (since, topic["key"]))}
    words = _words(topic.get("query") or "")
    found = set(db.search(topic["query"], limit=150)) if words else set()
    ids = sorted(tagged | found)
    rows = []
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        rows += db.q(
            f"SELECT id, title, url, date_ist, grade, triage, ai, COALESCE(summary,'') AS summary, publishers FROM stories "
            f"WHERE id IN ({','.join('?' * len(chunk))}) AND date_ist >= ? AND date_ist <= ? AND is_private = 0 AND is_library = 0",
            [*chunk, since, today])
    cards = {r["story_id"] for r in db.q(  # a brief card on its day: the pages can open it there
        f"SELECT story_id FROM brief_picks WHERE story_id IN ({','.join('?' * len(ids))}) AND lead IS NULL "
        f"AND COALESCE(tier, 'top') IN ('top', 'prelims')", ids)} if ids else set()
    out = []
    for r in rows:
        if r["id"] not in tagged:
            title = (r["title"] or "").lower()
            if not all(re.search(rf"\b{re.escape(w)}", title) for w in words) or not worth(r, ai_on):
                continue
        pubs = _load(r["publishers"]) or []
        out.append({"id": r["id"], "day": r["date_ist"], "title": r["title"], "url": r["url"], "source": pubs[0] if pubs else "",
                    "grade": grade_of(r, ai_on),
                    "line": gist(r), "tagged": r["id"] in tagged, "card": r["id"] in cards})
    out.sort(key=lambda x: (x["day"], x["tagged"]), reverse=True)
    seen, uniq = set(), []
    for x in out:  # a report republished under the same headline counts once
        k = re.sub(r"\W+", " ", (x["title"] or "").lower()).strip()[:90]
        if k not in seen:
            seen.add(k); uniq.append(x)
    return uniq[:MAX_ITEMS]


def is_dossier(items: list[dict]) -> bool:
    return len(items) >= MIN_STORIES and len({x["day"] for x in items}) >= MIN_DAYS


def signature(items: list[dict]) -> str:
    return hashlib.sha1(",".join(sorted(x["id"] for x in items)).encode()).hexdigest()[:12]


def live_topics(db: DB, today: str) -> list[dict]:
    since = (date.fromisoformat(today) - timedelta(days=LIVE_DAYS)).isoformat()
    return [dict(r) for r in db.q("SELECT * FROM topics WHERE last_day >= ? OR seed = 1 ORDER BY last_day DESC, n DESC LIMIT 200", (since,))]


def candidates(settings: Settings, db: DB, today: str, ai_on: bool) -> list[tuple[dict, list[dict]]]:
    """The dossiers: [(topic, timeline)], the latest in the news first (see the module doc)."""
    sync_seeds(db, load_seeds(settings))
    since = (date.fromisoformat(today) - timedelta(days=LIVE_DAYS)).isoformat()
    found = []
    for t in live_topics(db, today):
        items = timeline(db, t, today, ai_on)
        if is_dossier(items) and items[0]["day"] >= since:
            found.append((t, items))
    kept: list[tuple[dict, list[dict], set]] = []
    for t, items in sorted(found, key=lambda x: -len(x[1])):  # the bigger of two of the same story stays
        ids = {x["id"] for x in items}
        if not any(len(ids & k) >= OVERLAP * min(len(ids), len(k)) for _, _, k in kept):
            kept.append((t, items, ids))
    kept.sort(key=lambda x: (x[1][0]["day"], len(x[1])), reverse=True)
    return [(t, items) for t, items, _ in kept[:MAX_DOSSIERS]]


def _points(xs, n: int, chars: int = 240) -> list[str]:
    return [_clip(str(x), chars) for x in (xs or []) if str(x).strip()][:n]


def build_dossiers(settings: Settings, db: DB, today: str | None = None, http=None, pause: float = GEMINI_PAUSE,
                   max_calls: int = MAX_CALLS) -> dict:
    """Refreshes each live topic's signature and writes the story so far of those whose timeline changed.
    → {"dossiers", "written", "calls", "left"}"""
    today = today or today_ist()
    ai_on = (settings.ai_triage or "").lower() == "on"
    stale = iso(datetime.now(timezone.utc) - timedelta(hours=REWRITE_HOURS))
    todo, n = [], 0
    for t, items in candidates(settings, db, today, ai_on):
        n += 1
        sig = signature(items)
        if sig != t["sig"]:
            db.x("UPDATE topics SET sig=? WHERE key=?", (sig, t["key"]))
        if sig != t["summarized_sig"] and (not t["summary"] or (t["at"] or "") < stale):
            todo.append((t, items, sig))
    db.commit()
    todo.sort(key=lambda x: bool(x[0]["summary"]))  # the ones without a story so far first
    if not settings.gemini_api_key or not todo:
        return {"dossiers": n, "written": 0, "calls": 0, "left": len(todo)}
    gem = Gemini(settings.gemini_api_key, settings.gemini_model, http=http, db=db)
    written = calls = 0
    note = ""
    for i in range(0, len(todo), PER_CALL):
        if calls >= max_calls:
            break
        batch = todo[i:i + PER_CALL]
        if calls and pause:
            time.sleep(pause)
        calls += 1
        text = "\n\n".join(f"{k}. {t['name']}\n" + "\n".join(f"- {x['day']}: {x['title']}. {x['line']}" for x in reversed(items))
                           for k, (t, items, _) in enumerate(batch, 1))
        try:
            reply, model = gem.generate(SYSTEM, text, SCHEMA)
        except GeminiStop as exc:
            note = str(exc)
            log.warning("Dossiers paused: %s", note)
            break
        except Exception as exc:  # a network hiccup: these wait for the next run
            log.warning("Dossiers: %s", type(exc).__name__)
            continue
        if not reply or reply.get("skipped"):
            continue
        for x in reply.get("items") or []:
            k = x.get("n")
            if not isinstance(k, int) or not 1 <= k <= len(batch):
                continue
            t, items, sig = batch[k - 1]
            so_far = _points(x.get("so_far"), 6)
            if len(so_far) < 2:
                continue
            summary = {"so_far": so_far, "upsc": _points(x.get("upsc"), 4), "watch": _points(x.get("watch"), 3),
                       "gs": [g for g in (x.get("gs") or []) if g in ("GS1", "GS2", "GS3", "GS4")], "by": model, "day": today}
            db.x("UPDATE topics SET summary=?, summarized_sig=?, at=? WHERE key=?",
                 (json.dumps(summary, ensure_ascii=False), sig, iso(datetime.now(timezone.utc)), t["key"]))
            written += 1
        db.commit()
    return {"dossiers": n, "written": written, "calls": calls, "left": len(todo) - written, **({"paused": note} if note else {})}


def dossiers_payload(settings: Settings, db: DB, today: str | None = None) -> dict:
    """The dossiers for the pages (data/dossiers.json): the latest in the news first, each with its timeline."""
    today = today or today_ist()
    ai_on = (settings.ai_triage or "").lower() == "on"
    gs = {x["key"]: x["gs"] for x in load_seeds(settings)}
    out = []
    for t, items in candidates(settings, db, today, ai_on):
        summary = _load(t["summary"]) or None
        out.append({"key": t["key"], "name": t["name"], "first_day": items[-1]["day"], "last_day": items[0]["day"],
                    "n": len(items), "days": len({x["day"] for x in items}), "summary": summary,
                    "gs": (summary or {}).get("gs") or gs.get(t["key"]) or [], "seed": bool(t.get("seed")),
                    "fresh": t["summarized_sig"] == signature(items), "timeline": items})
    return {"generated_at": iso(datetime.now(timezone.utc)), "dossiers": out}


def places_payload(settings: Settings, db: DB, today: str | None = None, days: int = PLACE_DAYS) -> dict:
    """The places-in-news map (data/places.json): the places of the last `days` days' cards, each with its stories.
    → {"places": [{k, name, kind, country, state, lat, lon, ids}], "stories": {id: {title, day, grade, url, source}}}"""
    today = today or today_ist()
    ai_on = (settings.ai_triage or "").lower() == "on"
    since = (date.fromisoformat(today) - timedelta(days=days)).isoformat()
    rows = db.q("SELECT id, title, url, date_ist, grade, triage, publishers, extras FROM stories WHERE extras IS NOT NULL "
                "AND date_ist >= ? AND date_ist <= ? AND is_private = 0 AND is_library = 0", (since, today))
    by: dict[str, list[str]] = {}
    stories: dict[str, dict] = {}
    for r in rows:
        keys = (_load(r["extras"]) or {}).get("places") or []
        if not keys:
            continue
        pubs = _load(r["publishers"]) or []
        stories[r["id"]] = {"title": r["title"], "day": r["date_ist"], "url": r["url"], "source": pubs[0] if pubs else "",
                            "grade": grade_of(r, ai_on)}
        for k in keys:
            by.setdefault(k, []).append(r["id"])
    places = []
    ks = sorted(by)
    for i in range(0, len(ks), 500):
        chunk = ks[i:i + 500]
        for p in db.q(f"SELECT * FROM places WHERE key IN ({','.join('?' * len(chunk))})", chunk):
            ids = sorted(by[p["key"]], key=lambda s: stories[s]["day"], reverse=True)
            places.append({"k": p["key"], "name": p["name"], "kind": p["kind"], "country": p["country"], "state": p["state"] or "",
                           "lat": p["lat"], "lon": p["lon"], "ids": ids})
    places.sort(key=lambda p: (-len(p["ids"]), p["name"]))
    return {"generated_at": iso(datetime.now(timezone.utc)), "from": since, "to": today, "places": places, "stories": stories}

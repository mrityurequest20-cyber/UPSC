"""India in global indices and rankings: the tracker behind the "India's Ranks" section.

The indices themselves (name, publisher, what they measure) are listed in config/indices.yaml. India's rank, the
edition and the reasons come only from articles, read by Gemini, in two ways:
* live: the recent days' stories that look like a ranking report for India (the headline names India and a rank or
  an index, or names an index and the text names India) are read in batches. A story reporting India's rank in a
  country ranking updates that index; one naming an index not in the list starts a new entry.
* sweep: an index not looked up for SWEEP_DAYS (a week when nothing was found) is searched for in the free news
  (Bing News; only sites on the free-to-read list are opened) and its latest article read, SWEEP_PER_RUN a run.
A rank is kept only when the article states that number. Each (index, edition) is kept once in `rankings`: the first
report of an edition stands, a later one fills in what it lacked. stories.ranking marks a story as read ({} when it
reports no rank); index_checks remembers when each index was last searched for.
"""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import yaml

from ..config import Settings, load_topics
from ..db import DB, iso
from .normalize import today_ist
from .enrich import GEMINI_PAUSE, Gemini, GeminiStop

log = logging.getLogger("upsc_intel.rankings")

BATCH = 8            # articles per call
MAX_CALLS = 3        # live calls per run
SWEEP_PER_RUN = 4    # indices searched for per run
SWEEP_DAYS = 30      # an index found is searched for again after this long; one not found after a week
TEXT_CHARS = 3200

SYSTEM = """You read news for a UPSC aspirant's tracker of India's position in global indices and rankings. For each
numbered text, say whether it reports India's rank in a country index, report or ranking (countries ranked against
each other; not cities, states, companies or universities). If it does (found: true), give:
- index: the index's name without the year (e.g. "Global Hunger Index")
- publisher: who releases it
- edition: the edition's year as the text gives it (e.g. "2025")
- rank: India's rank, a number the text states
- total: how many countries are ranked, if the text says (else 0)
- previous: India's rank in the previous edition, if the text says (else 0)
- score: India's score or value with its unit, if the text gives one (else "")
- why: 2-4 short points (at most 20 words each) on why India is at this position, as the text explains it: the areas
  or indicators where it does well or badly. An empty list if the text gives no reasons.
Use only what the text says. If it reports no rank for India, set found to false and leave the rest empty."""

SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
    "n": {"type": "integer"}, "found": {"type": "boolean"}, "index": {"type": "string"}, "publisher": {"type": "string"},
    "edition": {"type": "string"}, "rank": {"type": "integer"}, "total": {"type": "integer"}, "previous": {"type": "integer"},
    "score": {"type": "string"}, "why": {"type": "array", "items": {"type": "string"}}},
    "required": ["n", "found", "index", "publisher", "edition", "rank", "total", "previous", "score", "why"]}}},
    "required": ["items"]}

INDIA = re.compile(r"\bIndia(?:n|'s|’s)?\b", re.I)
RANKY = re.compile(r"\b(rank(?:s|ed|ing|ings)?|index|slips?|climbs?|jumps?|position|placed|spot|\d+(?:st|nd|rd|th)|largest)\b", re.I)
INDEXY = re.compile(r"\b(index|ranking|rankings|report)\b", re.I)
ORDINAL = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth"}


def load_indices(settings: Settings) -> list[dict]:
    p = Path(settings.config_dir) / "indices.yaml"
    items = (yaml.safe_load(p.read_text(encoding="utf-8")) or {}).get("indices") or [] if p.is_file() else []
    return [{**x, "better": x.get("better") or "low", "aliases": [a.lower() for a in x.get("aliases") or []]} for x in items]


def looks_like_ranking(title: str, summary: str) -> bool:
    """A headline naming India and a rank or an index, or naming an index while the text names India."""
    return bool((INDIA.search(title) and RANKY.search(title)) or (INDEXY.search(title) and INDIA.search(summary or "")))


def grounded(text: str, n: int) -> bool:
    """The text states the number (39, 39th; "fourth" for the top ten)."""
    if not isinstance(n, int) or not 1 <= n <= 300:
        return False
    if re.search(rf"(?<![\d.,]){n}(?:st|nd|rd|th)?(?!\d|[.,]\d)", text):
        return True
    return n in ORDINAL and bool(re.search(rf"\b{ORDINAL[n]}\b", text, re.I))


def match_index(name: str, indices: list[dict]) -> dict | None:
    nm = " ".join((name or "").lower().split())
    best = None
    for idx in indices:
        for a in [idx["name"].lower(), *idx["aliases"]]:
            if re.search(rf"(?<![a-z]){re.escape(a)}(?![a-z])", nm) and (best is None or len(a) > best[1]):
                best = (idx, len(a))
    return best[0] if best else None


def _slug(name: str) -> str:
    return "x_" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:50]


def _edition(e: str, day: str) -> str:
    m = re.search(r"(19|20)\d\d", e or "")
    return m.group(0) if m else day[:4]


def _keep(db: DB, key: str, name: str, publisher: str, r: dict, day: str, story_id: str, url: str, source: str, now: str) -> bool:
    """Stores an (index, edition); a known edition keeps its rank and only fills in what it lacked. → new?"""
    ed = _edition(r.get("edition", ""), day)
    rid = f"{key}|{ed}"
    why = [" ".join(str(w).split())[:160] for w in r.get("why") or [] if str(w).strip()][:4]
    total = r.get("total") if isinstance(r.get("total"), int) and r.get("total", 0) > 0 else None
    prev = r.get("previous") if isinstance(r.get("previous"), int) and r.get("previous", 0) > 0 else None
    old = db.q("SELECT total, previous, score, why FROM rankings WHERE id=?", (rid,))
    if not old:
        db.x("INSERT INTO rankings (id, index_key, name, publisher, edition, rank, total, previous, score, why, day, story_id, url, "
             "source, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
             (rid, key, name, publisher, ed, r["rank"], total, prev, (r.get("score") or "")[:80], json.dumps(why), day, story_id, url, source, now))
        return True
    o = old[0]
    db.x("UPDATE rankings SET total=COALESCE(total, ?), previous=COALESCE(previous, ?), score=CASE WHEN COALESCE(score,'')='' THEN ? "
         "ELSE score END, why=CASE WHEN COALESCE(why,'[]')='[]' THEN ? ELSE why END WHERE id=?",
         (total, prev, (r.get("score") or "")[:80], json.dumps(why), rid))
    return False


def _extract(gem: Gemini, texts: list[str]) -> list[dict]:
    reply, _ = gem.generate(SYSTEM, "\n\n".join(f"{n}. {t}" for n, t in enumerate(texts, 1)), SCHEMA)
    out = [{}] * len(texts)
    for x in (reply or {}).get("items") or []:
        n = x.get("n")
        if isinstance(n, int) and 1 <= n <= len(texts) and x.get("found"):
            out[n - 1] = x
    return out


def _story_text(db: DB, r) -> str:
    a = db.articles([r["id"]]).get(r["id"])
    body = " ".join((a or {}).get("paragraphs") or []) or r["summary"] or ""
    return f"{r['title']}. {' '.join(body.split())}"[:TEXT_CHARS]


def live(db: DB, gem: Gemini, indices: list[dict], days: list[str], pause: float, max_calls: int, now: str) -> dict:
    rows = db.q(f"SELECT id, title, COALESCE(summary,'') AS summary, url, date_ist, publishers FROM stories "
                f"WHERE date_ist IN ({','.join('?' * len(days))}) AND is_library=0 AND is_private=0 AND ranking IS NULL "
                f"ORDER BY score DESC", days)
    todo = [r for r in rows if looks_like_ranking(r["title"], r["summary"])]
    want = {r["id"] for r in todo}
    for r in rows:  # the rest need no reading
        if r["id"] not in want:
            db.x("UPDATE stories SET ranking='{}' WHERE id=?", (r["id"],))
    read = new = calls = 0
    for i in range(0, len(todo), BATCH):
        if calls >= max_calls:
            break
        batch = todo[i:i + BATCH]
        if calls and pause:
            time.sleep(pause)
        calls += 1
        texts = [_story_text(db, r) for r in batch]
        for r, t, x in zip(batch, texts, _extract(gem, texts)):
            got = {}
            if x and grounded(t, x.get("rank")):
                idx = match_index(x.get("index", ""), indices)
                key = idx["key"] if idx else _slug(x.get("index", ""))
                if key != "x_":
                    pub = (json.loads(r["publishers"] or "[]") or [""])[0]
                    new += _keep(db, key, idx["name"] if idx else x["index"].strip()[:90], idx["publisher"] if idx else (x.get("publisher") or "")[:90],
                                 x, r["date_ist"], r["id"], r["url"] or "", pub, now)
                    got = {"key": key, "rank": x["rank"]}
            db.x("UPDATE stories SET ranking=? WHERE id=?", (json.dumps(got), r["id"]))
            read += 1
        db.commit()
    return {"read": read, "new": new, "calls": calls, "left": len(todo) - read}


def sweep(db: DB, gem: Gemini, indices: list[dict], topics: dict, http=None, limit: int = SWEEP_PER_RUN, now: str = "") -> dict:
    """Looks up the indices not seen for a while in the free news: the latest article about each, read by Gemini."""
    from .articles import FreeReading, is_syndicated, read_page, search_news
    from ..fetchers.http import Http

    today = today_ist()
    checked = {r["key"]: r for r in db.q("SELECT key, at, found FROM index_checks")}

    def due(idx) -> bool:
        c = checked.get(idx["key"])
        if not c:
            return True
        wait = SWEEP_DAYS if c["found"] else 7
        return (c["at"] or "") <= (date.fromisoformat(today) - timedelta(days=wait)).isoformat()
    todo = [idx for idx in indices if due(idx)][:limit]
    if not todo:
        return {"searched": 0, "found": 0}
    fr = FreeReading(topics)
    own = http is None
    http = http or Http(timeout=15, retries=1)
    found = 0
    try:
        texts, meta = [], []
        for idx in todo:
            got = None
            try:
                hits = search_news(http, f"India rank {idx['name']}")
            except Exception as exc:  # the search is down: this index waits for the next run
                log.warning("rank sweep search %s: %s", idx["key"], type(exc).__name__)
                continue
            free = [h for h in hits if fr.is_open(h["url"]) or is_syndicated(h["url"])]
            for h in sorted(free, key=lambda h: h["date"] or "", reverse=True)[:3]:  # the newest report first
                try:
                    paras, cite, published = read_page(http, fr, h["url"])
                except Exception:
                    continue
                if len(paras) >= 3:
                    got = (f"[{idx['name']}] {h['title']}. " + " ".join(paras))[:TEXT_CHARS], cite, (published or h["date"] or today)[:10]
                    break
            if got:
                texts.append(got[0]); meta.append((idx, got[1], got[2]))
            else:
                db.x("INSERT OR REPLACE INTO index_checks (key, at, found) VALUES (?,?,?)", (idx["key"], today, ""))
        if texts:
            for (idx, url, day), t, x in zip(meta, texts, _extract(gem, texts)):
                hit = ""
                if x and grounded(t, x.get("rank")) and (match_index(x.get("index", ""), [idx]) or match_index(x.get("index", ""), indices) is None):
                    src = re.sub(r"^www\.", "", re.sub(r"^https?://([^/]+).*", r"\1", url))
                    _keep(db, idx["key"], idx["name"], idx["publisher"], x, day, "", url, src, now)
                    hit = _edition(x.get("edition", ""), day)
                    found += 1
                db.x("INSERT OR REPLACE INTO index_checks (key, at, found) VALUES (?,?,?)", (idx["key"], today, hit))
        db.commit()
    finally:
        if own:
            http.close()
    return {"searched": len(todo), "found": found}


def update_rankings(settings: Settings, db: DB, days: list[str], http=None, search_http=None, pause: float = GEMINI_PAUSE,
                    max_calls: int = MAX_CALLS, sweep_limit: int = SWEEP_PER_RUN) -> dict:
    if not settings.gemini_api_key:
        return {"enabled": False}
    indices = load_indices(settings)
    gem = Gemini(settings.gemini_api_key, settings.gemini_model, http=http)
    now = iso(datetime.now(timezone.utc))
    out: dict = {"enabled": True}
    try:
        out["live"] = live(db, gem, indices, days, pause, max_calls, now)
        if sweep_limit:
            out["sweep"] = sweep(db, gem, indices, load_topics(settings), http=search_http, limit=sweep_limit, now=now)
    except GeminiStop as exc:
        db.commit()
        out["paused"] = str(exc)
    return out


def rankings_payload(settings: Settings, db: DB) -> dict:
    """The tracker: every index in the list (and any other an article reported), India's latest rank with its reasons
    and source, the change from the previous edition, and the editions seen."""
    indices = load_indices(settings)
    rows = [dict(r) for r in db.q("SELECT * FROM rankings ORDER BY index_key, edition DESC, day DESC")]
    checked = {r["key"]: r["at"] for r in db.q("SELECT key, at FROM index_checks")}
    by: dict[str, list[dict]] = {}
    for r in rows:
        by.setdefault(r["index_key"], []).append(r)
    known = {i["key"] for i in indices}
    extra = [{"key": k, "name": v[0]["name"], "publisher": v[0]["publisher"], "about": "", "area": "other", "better": "low"}
             for k, v in by.items() if k not in known]
    out = []
    for idx in indices + extra:
        hist = by.get(idx["key"]) or []
        latest = hist[0] if hist else None
        prev = latest and (latest["previous"] or (hist[1]["rank"] if len(hist) > 1 else None))
        out.append({"key": idx["key"], "name": idx["name"], "publisher": idx["publisher"], "about": idx.get("about", ""),
                    "area": idx.get("area", "other"), "better": idx.get("better", "low"), "checked": checked.get(idx["key"], ""),
                    "latest": {"edition": latest["edition"], "rank": latest["rank"], "total": latest["total"], "previous": prev,
                               "score": latest["score"] or "", "why": json.loads(latest["why"] or "[]"), "day": latest["day"],
                               "url": latest["url"] or "", "source": latest["source"] or "", "story_id": latest["story_id"] or ""} if latest else None,
                    "history": [{"edition": h["edition"], "rank": h["rank"], "total": h["total"], "day": h["day"]} for h in hist]})
    return {"updated": max((r["at"] for r in rows), default=""), "indices": out}

"""AI triage: Gemini (a free Google AI Studio key) grades every story for UPSC in each run, in batches.

For each story it gives:
* upsc: 0-3. 3 must-know, 2 a useful examinable fact or development, 1 marginal, 0 not UPSC material.
* subject: the best syllabus subject.
* gs: the GS papers it maps to.
* prelims: whether it carries a checkable Prelims fact.
* why: a few words on why it matters (or not).

Headlines, the outlet and a line of text go in batches of BATCH, a few seconds apart for the free per-minute
limit, best-scored stories first so a used-up quota leaves only the minor ones to the rules. A verdict is
kept per story (stories.triage) and asked again only when the headline changes.

How the brief uses it (UPSC_AI_TRIAGE):
* "shadow": the verdicts are kept and the export writes what the brief would be with them
  (data/triage.json), but the brief stays on the rules.
* "on": the brief follows the verdicts (pipeline/brief.py); a story without one keeps the rules.
* "off": no calls at all.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from ..config import Settings
from ..db import DB, iso
from .classify import Classifier
from .enrich import GEMINI_PAUSE, Gemini, GeminiStop

log = logging.getLogger("upsc_intel.triage")

BATCH = 40        # stories per call
MAX_CALLS = 8     # per run: up to 320 stories (a first run's backlog takes a few runs)
MIN_BATCH = 10    # a quiet run with fewer new stories waits for the next, unless one has waited WAIT_MIN
WAIT_MIN = 60
TEXT_CHARS = 220  # of each story's text

SYSTEM = """You triage Indian and world news for a UPSC Civil Services (CSE) aspirant's daily current-affairs brief.
For each numbered story (its kind, headline, outlet and a line of its text) decide:

- upsc: how much it matters for UPSC CSE (Prelims and Mains GS1-GS4, Essay).
  3 = must-know: a significant development the aspirant must make notes on. For example: a law, bill, ordinance
      or rule; a Supreme Court or High Court ruling on constitutional or governance questions; a Cabinet decision;
      a major scheme or policy; RBI or fiscal policy; a key bilateral or multilateral agreement, summit or visit;
      a major report or index with India's rank; a big disaster or security development; a landmark in science,
      space or defence. Roughly the top 5-10% of a day's stories.
  2 = useful: a concrete, examinable development of secondary weight: a scheme or mission detail, a species,
      a place in the news, a military exercise, an award, a report, an appointment to a constitutional or
      statutory post, an MoU, a new index, a state-level policy of wider interest. Also any political,
      constitutional or economic development in India's neighbourhood (Pakistan, China, Nepal, Bhutan, Bangladesh,
      Sri Lanka, Maldives, Myanmar, Afghanistan): a constitutional amendment, an election result or change of
      government, a crisis, an IMF or debt deal. At least 2, and 3 when it directly affects India.
  1 = marginal: syllabus-related but routine: political statements and reactions, previews, spats, local
      administration, minor events, opinion without substance, individual court cases without a wider principle.
  0 = not UPSC material: sports results, entertainment and celebrities, crime without a policy angle, markets and
      stock tips, company earnings, weather alerts, accidents, election horse-race and party politics, lifestyle,
      another country's domestic news with no India or global angle (India's neighbours excepted, see 2), and
      coaching-institute posts: ads, course or test-series promotions, essay or answer-writing challenges,
      toppers' talks, timetables (a coaching site's explainer of a real news topic is judged by its topic).
  Be strict: most stories are 0 or 1. An EDITORIAL or EXPLAINER is judged by its topic's weight.
- subject: the single best subject key from the list below.
- gs: the GS papers it maps to (GS1 history, culture, geography, society; GS2 polity, governance, IR, social
  justice; GS3 economy, environment, S&T, security, disaster, agriculture, infrastructure; GS4 ethics).
- prelims: true when it carries a specific checkable fact (a name, place, species, scheme, index, number, date).
- news: true when it reports a specific new development: something happened, was announced, decided, ruled,
  released, launched or signed. False for an evergreen topic page ("India's Strategic Autonomy", "Making India
  resilient to…"), a general analysis or explainer, or an opinion without a new development.
- why: at most 12 words on why it matters for UPSC, or why it doesn't.

Subjects:
{subjects}

Answer for every story, using its number."""

SCHEMA_ITEM = {"type": "object", "properties": {
    "n": {"type": "integer"}, "upsc": {"type": "integer"}, "subject": {"type": "string"},
    "gs": {"type": "array", "items": {"type": "string", "enum": ["GS1", "GS2", "GS3", "GS4"]}},
    "prelims": {"type": "boolean"}, "news": {"type": "boolean"}, "why": {"type": "string"}},
    "required": ["n", "upsc", "subject", "gs", "prelims", "news", "why"]}
SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": SCHEMA_ITEM}}, "required": ["items"]}


DEDUPE_SYSTEM = """You get the numbered headlines of one day's current-affairs brief. Group the headlines that
report the SAME news event: one speech, one announcement, one Cabinet decision, one court ruling, one meeting or
summit session, one report's release, told by different outlets or from different angles. Headlines about
different events on the same topic stay apart (two different Cabinet decisions; a minister's speech and a
separate bilateral meeting; a bill's passage and a later court challenge to it). Return only groups of two or
more numbers; a headline in no group is its own event."""
DEDUPE_SCHEMA = {"type": "object", "properties": {"groups": {"type": "array", "items": {"type": "array", "items": {"type": "integer"}}}},
                 "required": ["groups"]}
DEDUPE_EVERY_MIN = 40  # a day's cards are grouped again when 3+ new ones came in, or after this long


def mode(settings: Settings) -> str:
    m = (settings.ai_triage or "").lower()
    return m if m in ("on", "shadow", "off") else "off"


VERDICT = "v2"  # v2 added "news": a new version grades every story again, over the next few runs
# The prompt's revision. A change that only affects a few kinds of story re-asks just those, once (recheck):
# 2 made India's neighbourhood politics at least a 2 and coaching-institute posts a 0.
PROMPT_REV = 2
NEIGHBOURS = re.compile(r"\b(Pakistan|Nepal|Bhutan|Bangladesh|Sri Lanka|Lankan|Maldiv\w*|Myanmar|Afghan\w*|Taliban|"
                        r"Kathmandu|Dhaka|Colombo|Islamabad|Thimphu|Kabul|Naypyidaw)\b", re.I)
COACHING = re.compile(r"essay challenge|answer[- ]writing|answer evaluation|test series|mock test|toppers?\b|"
                      r"mentorship|admissions? open|new batch|webinar|scholarship test", re.I)


NEIGHBOUR_TLD = {"lk": "Sri Lanka", "np": "Nepal", "bd": "Bangladesh", "pk": "Pakistan", "mv": "Maldives",
                 "af": "Afghanistan", "mm": "Myanmar", "bt": "Bhutan"}  # an outlet's country, from its web address


def outlet_country(*urls: str) -> str:
    """The neighbour a story's outlet is from: its link, or (a Google News link) the outlet's own address."""
    for url in urls:
        host = urlparse(url or "").hostname or ""
        c = NEIGHBOUR_TLD.get(host.rsplit(".", 1)[-1], "")
        if c:
            return c
    return ""


def recheck(title: str, text: str, url: str, v: dict, origin: str = "") -> bool:
    """A verdict from before PROMPT_REV that the new prompt would likely change: asked again, once."""
    if v.get("r", 1) >= PROMPT_REV:
        return False
    near = NEIGHBOURS.search(f"{title} {text}") or outlet_country(url, origin)
    return bool((v.get("upsc", 0) <= 1 and near) or (v.get("upsc", 0) >= 1 and COACHING.search(title)))


def title_key(title: str) -> str:
    return hashlib.sha1(f"{VERDICT}|{(title or '').strip().lower()}".encode()).hexdigest()[:10]


def _kind(r) -> str:
    return "EDITORIAL" if r["is_editorial"] else "EXPLAINER" if r["is_explained"] else "NEWS"


def _todo(db: DB, days: list[str]) -> list:
    """The days' stories without a verdict for their current headline: the brief's cards first (a new verdict
    version re-checks what readers see before the rest), then best-scored first."""
    rows = db.q(
        f"SELECT id, title, COALESCE(summary,'') AS summary, COALESCE(url,'') AS url, publishers, is_editorial, is_explained, "
        f"triage, score, first_seen, COALESCE((SELECT CASE WHEN json_valid(i.extra) THEN json_extract(i.extra, '$.origin') END "
        f"FROM items i WHERE i.story_id = stories.id AND i.extra LIKE '%origin%' LIMIT 1), '') AS origin "
        f"FROM stories WHERE date_ist IN ({','.join('?' * len(days))}) AND is_library=0 AND is_private=0 "
        f"ORDER BY EXISTS (SELECT 1 FROM brief_picks b WHERE b.story_id = stories.id "
        f"AND COALESCE(b.tier, 'top') IN ('top', 'prelims')) DESC, score DESC", days)
    out = []
    for r in rows:
        t = json.loads(r["triage"]) if r["triage"] else None
        if t and t.get("t") == title_key(r["title"]) and not recheck(r["title"], r["summary"], r["url"], t, r["origin"]):
            continue
        out.append(r)
    return out


def _prompt(batch: list) -> str:
    lines = []
    for n, r in enumerate(batch, 1):
        pub = (json.loads(r["publishers"] or "[]") or [""])[0]
        where = outlet_country(*(r[k] for k in ("url", "origin") if k in r.keys()))  # a neighbour's own outlet: say which country
        pub = f"{pub}, {where}" if where and pub else pub or where
        text = " ".join((r["summary"] or "").split())[:TEXT_CHARS]
        lines.append(f"{n}. [{_kind(r)}] {r['title']} ({pub})" + (f": {text}" if text else ""))
    return "\n".join(lines)


def verdicts(reply: dict, batch: list, subjects: set[str]) -> dict[str, dict]:
    """{story id: verdict} from Gemini's reply; an item with a bad number or score is left out (asked again)."""
    out: dict[str, dict] = {}
    for x in (reply or {}).get("items") or []:
        n, up = x.get("n"), x.get("upsc")
        if not isinstance(n, int) or not 1 <= n <= len(batch) or not isinstance(up, int) or not 0 <= up <= 3:
            continue
        r = batch[n - 1]
        subj = x.get("subject") if x.get("subject") in subjects else ""
        out[r["id"]] = {"upsc": up, "subject": subj, "gs": [g for g in x.get("gs") or [] if g in ("GS1", "GS2", "GS3", "GS4")],
                        "prelims": bool(x.get("prelims")), "news": x.get("news") is not False,
                        "why": str(x.get("why") or "")[:120], "t": title_key(r["title"]), "r": PROMPT_REV}
    return out


def triage(settings: Settings, db: DB, clf: Classifier, days: list[str], http=None, pause: float = GEMINI_PAUSE,
           max_calls: int = MAX_CALLS, min_batch: int = MIN_BATCH) -> dict:
    """Grades the days' stories that have no verdict yet. → {"graded", "calls", "left", ...}"""
    if mode(settings) == "off" or not settings.gemini_api_key or not days:
        return {"enabled": False}
    todo = _todo(db, days)
    if not todo:
        return {"enabled": True, "graded": 0, "calls": 0, "left": 0}
    waited = iso(datetime.now(timezone.utc) - timedelta(minutes=WAIT_MIN))
    if len(todo) < min_batch and not any((r["first_seen"] or "") < waited for r in todo):
        return {"enabled": True, "graded": 0, "calls": 0, "left": len(todo), "waiting": True}  # a call for a few: later
    subjects = set(clf.subject_meta)
    system = SYSTEM.format(subjects="\n".join(f"- {k}: {v['label']}" for k, v in clf.subject_meta.items()))
    gem = Gemini(settings.gemini_api_key, settings.gemini_model, http=http)
    graded = calls = 0
    note = ""
    now = iso(datetime.now(timezone.utc))
    for i in range(0, len(todo), BATCH):
        if calls >= max_calls:
            break
        batch = todo[i:i + BATCH]
        if calls and pause:
            time.sleep(pause)
        calls += 1
        try:
            reply, model = gem.generate(system, _prompt(batch), SCHEMA)
        except GeminiStop as exc:
            note = str(exc)
            log.warning("AI triage paused: %s", note)
            break
        except Exception as exc:  # a network hiccup: these wait for the next run
            log.warning("AI triage: %s", type(exc).__name__)
            continue
        if not reply or reply.get("skipped"):
            continue
        for sid, v in verdicts(reply, batch, subjects).items():
            db.x("UPDATE stories SET triage=? WHERE id=?", (json.dumps({**v, "model": model, "at": now}), sid))
            graded += 1
        db.commit()
    left = len(todo) - graded
    return {"enabled": True, "mode": mode(settings), "graded": graded, "calls": calls, "left": left,
            **({"paused": note} if note else {})}


def _cards(db: DB, day: str) -> list:
    """The day's Must-know and Prelims-facts cards, with the reports already folded into them."""
    return db.q("SELECT b.story_id, s.title FROM brief_picks b JOIN stories s ON s.id = b.story_id WHERE b.date_ist=? "
                "AND b.kind='news' AND COALESCE(b.tier, 'top') IN ('top', 'prelims') ORDER BY b.rank", (day,))


def dedupe(settings: Settings, db: DB, days: list[str], http=None) -> dict:
    """Gemini groups the days' cards that report the same event (kept in ai_groups; the brief folds each group
    into one card). A day is asked again only when its cards changed: 3+ new ones, or DEDUPE_EVERY_MIN later.
    → {"calls", "changed": [days whose groups changed]}"""
    if mode(settings) != "on" or not settings.gemini_api_key:
        return {"enabled": False}
    now = datetime.now(timezone.utc)
    gem = None
    calls, changed = 0, []
    for day in days:
        rows = _cards(db, day)
        ids = [r["story_id"] for r in rows]
        if len(ids) < 2:
            continue
        sig = hashlib.sha1(",".join(sorted(ids)).encode()).hexdigest()[:12]
        prev = db.q("SELECT sig, ids, groups, at FROM ai_groups WHERE day=?", (day,))
        if prev:
            p = prev[0]
            new = set(ids) - set(json.loads(p["ids"] or "[]"))
            if p["sig"] == sig or (len(new) < 3 and (p["at"] or "") > iso(now - timedelta(minutes=DEDUPE_EVERY_MIN))):
                continue
        gem = gem or Gemini(settings.gemini_api_key, settings.gemini_model, http=http)
        calls += 1
        try:
            reply, _ = gem.generate(DEDUPE_SYSTEM, "\n".join(f"{n}. {r['title']}" for n, r in enumerate(rows, 1)), DEDUPE_SCHEMA)
        except GeminiStop as exc:
            log.warning("AI dedupe paused: %s", exc)
            break
        except Exception as exc:
            log.warning("AI dedupe: %s", type(exc).__name__)
            continue
        if not reply or reply.get("skipped"):
            continue
        groups, seen = [], set()
        for g in reply.get("groups") or []:
            members = [ids[n - 1] for n in dict.fromkeys(g) if isinstance(n, int) and 1 <= n <= len(ids) and ids[n - 1] not in seen]
            if len(members) >= 2:
                groups.append(members)
                seen.update(members)
        old = json.loads(prev[0]["groups"] or "[]") if prev else []
        db.x("INSERT OR REPLACE INTO ai_groups (day, sig, ids, groups, at) VALUES (?, ?, ?, ?, ?)",
             (day, sig, json.dumps(ids), json.dumps(groups), iso(now)))
        if sorted(map(sorted, groups)) != sorted(map(sorted, old)):
            changed.append(day)
    db.commit()
    return {"enabled": True, "calls": calls, "changed": changed}

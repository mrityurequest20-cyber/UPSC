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
import time
from datetime import datetime, timedelta, timezone

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
      statutory post, an MoU, a new index, a state-level policy of wider interest.
  1 = marginal: syllabus-related but routine: political statements and reactions, previews, spats, local
      administration, minor events, opinion without substance, individual court cases without a wider principle.
  0 = not UPSC material: sports results, entertainment and celebrities, crime without a policy angle, markets and
      stock tips, company earnings, weather alerts, accidents, election horse-race and party politics, lifestyle,
      another country's domestic news with no India or global angle.
  Be strict: most stories are 0 or 1. An EDITORIAL or EXPLAINER is judged by its topic's weight.
- subject: the single best subject key from the list below.
- gs: the GS papers it maps to (GS1 history, culture, geography, society; GS2 polity, governance, IR, social
  justice; GS3 economy, environment, S&T, security, disaster, agriculture, infrastructure; GS4 ethics).
- prelims: true when it carries a specific checkable fact (a name, place, species, scheme, index, number, date).
- why: at most 12 words on why it matters for UPSC, or why it doesn't.

Subjects:
{subjects}

Answer for every story, using its number."""

SCHEMA_ITEM = {"type": "object", "properties": {
    "n": {"type": "integer"}, "upsc": {"type": "integer"}, "subject": {"type": "string"},
    "gs": {"type": "array", "items": {"type": "string", "enum": ["GS1", "GS2", "GS3", "GS4"]}},
    "prelims": {"type": "boolean"}, "why": {"type": "string"}},
    "required": ["n", "upsc", "subject", "gs", "prelims", "why"]}
SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": SCHEMA_ITEM}}, "required": ["items"]}


def mode(settings: Settings) -> str:
    m = (settings.ai_triage or "").lower()
    return m if m in ("on", "shadow", "off") else "off"


def title_key(title: str) -> str:
    return hashlib.sha1((title or "").strip().lower().encode()).hexdigest()[:10]


def _kind(r) -> str:
    return "EDITORIAL" if r["is_editorial"] else "EXPLAINER" if r["is_explained"] else "NEWS"


def _todo(db: DB, days: list[str]) -> list:
    """The days' stories without a verdict for their current headline, best-scored first."""
    rows = db.q(
        f"SELECT id, title, COALESCE(summary,'') AS summary, publishers, is_editorial, is_explained, triage, score, first_seen "
        f"FROM stories WHERE date_ist IN ({','.join('?' * len(days))}) AND is_library=0 AND is_private=0 "
        f"ORDER BY score DESC", days)
    out = []
    for r in rows:
        t = json.loads(r["triage"]) if r["triage"] else None
        if t and t.get("t") == title_key(r["title"]):
            continue
        out.append(r)
    return out


def _prompt(batch: list) -> str:
    lines = []
    for n, r in enumerate(batch, 1):
        pub = (json.loads(r["publishers"] or "[]") or [""])[0]
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
                        "prelims": bool(x.get("prelims")), "why": str(x.get("why") or "")[:120], "t": title_key(r["title"])}
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

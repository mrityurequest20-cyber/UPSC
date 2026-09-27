"""Claude-written study notes, imported as story write-ups.

The notes are written by a scheduled Claude Code routine that runs on the owner's Claude plan (no API
key). It reads the day's brief from the live site and pushes `notes/YYYY-MM-DD.json` files,
{story_id: note}, to the repository's `claude/ai-notes` branch. The Pages workflow checks that branch
out and runs `python -m upsc_intel import-notes <folder>` before the export, so a note becomes the
story's write-up (`stories.ai`) on the site and in the app, and the Ask bot answers from it.

A note has the write-up fields the site already shows (what, why_in_news, background, significance,
prelims, mains, keywords, when, where, who) plus study extras the Ask bot uses: points (an up-to-8-point
summary), summary60, mcqs, mains_outline, hindi and syllabus. Everything is validated and trimmed here:
the notes are repository content, and anything malformed is skipped rather than published.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from ..db import DB
from .enrich import has_ai_explainer

log = logging.getLogger("upsc_intel")

SOURCE = "claude-notes"
TEXT = {"headline": 200, "what": 700, "why_in_news": 350, "background": 1000, "mains": 350, "when": 160,
        "where": 160, "who": 200, "summary60": 600, "syllabus": 500, "written": 40}
LISTS = {"significance": (5, 240), "prelims": (6, 240), "keywords": (8, 48), "points": (8, 260), "hindi": (8, 320)}


def _text(v, limit: int) -> str:
    return " ".join(str(v).split())[:limit] if isinstance(v, (str, int, float)) else ""


def _list(v, n: int, limit: int) -> list[str]:
    if not isinstance(v, list):
        return []
    return [t for t in (_text(x, limit) for x in v[:n]) if t]


def _mcq(v) -> dict | None:
    if not isinstance(v, dict):
        return None
    options = _list(v.get("options"), 4, 200)
    answer = v.get("answer")
    if len(options) != 4 or not isinstance(answer, int) or not 0 <= answer < 4 or not _text(v.get("q"), 400):
        return None
    return {"q": _text(v["q"], 400), "options": options, "answer": answer, "why": _text(v.get("why"), 400)}


def clean_note(raw) -> dict | None:
    """A validated, trimmed note, or None when it lacks the two fields every write-up needs."""
    if not isinstance(raw, dict):
        return None
    note: dict = {k: _text(raw.get(k), n) for k, n in TEXT.items() if _text(raw.get(k), n)}
    note.update({k: _list(raw.get(k), n, m) for k, (n, m) in LISTS.items() if _list(raw.get(k), n, m)})
    mcqs = [m for m in (_mcq(x) for x in (raw.get("mcqs") or [])[:3]) if m] if isinstance(raw.get("mcqs"), list) else []
    if mcqs:
        note["mcqs"] = mcqs
    outline = raw.get("mains_outline")
    if isinstance(outline, dict):
        o = {"intro": _text(outline.get("intro"), 450), "body": _list(outline.get("body"), 6, 300),
             "way_forward": _list(outline.get("way_forward"), 4, 300), "conclusion": _text(outline.get("conclusion"), 350)}
        if o["intro"] and o["body"]:
            note["mains_outline"] = o
    if not note.get("what") or not note.get("why_in_news"):
        return None
    return note


def import_notes(db: DB, folder: str | Path) -> dict:
    """Stores each valid note as its story's write-up. A write-up from the API enrichment (when a key is
    set) is kept; notes replace only auto write-ups and earlier notes."""
    folder = Path(folder)
    counts = {"files": 0, "notes": 0, "updated": 0, "unknown": 0, "invalid": 0}
    if not folder.is_dir():
        return counts
    for f in sorted(folder.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("skipping %s: %s", f.name, exc)
            continue
        if not isinstance(data, dict):
            continue
        counts["files"] += 1
        for sid, raw in data.items():
            note = clean_note(raw)
            if not note:
                counts["invalid"] += 1
                continue
            counts["notes"] += 1
            rows = db.q("SELECT ai FROM stories WHERE id=?", (str(sid),))
            if not rows:
                counts["unknown"] += 1
                continue
            current = json.loads(rows[0]["ai"]) if rows[0]["ai"] else None
            if current and current.get("source") != SOURCE and has_ai_explainer(current):
                continue
            new = {**note, "source": SOURCE}
            if current != new:
                db.set_story_ai(str(sid), new)
                counts["updated"] += 1
    db.commit()
    return counts

"""Optional AI notes: a 2-line summary, Prelims facts and a Mains angle for top stories.

Runs only when ANTHROPIC_API_KEY is set. Each story is enriched once (result cached in the DB).
Claude is told to use only the fetched text and to say so when the snippets are too thin,
so nothing is invented.
"""
from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from ..config import Settings
from ..db import DB, iso

log = logging.getLogger("upsc_intel.enrich")

SYSTEM = """You write revision notes for an Indian civil-services (UPSC CSE) aspirant.

You get one news story: its headline, the outlets that carried it, and the text snippets that were fetched.
Write notes strictly from that text. Never add facts, numbers, dates, names or scheme details that are not in it.
If the snippets are too thin to support a field, set "insufficient" to true and keep the fields short and generic
rather than guessing.

Fields:
- summary: at most two sentences, plain English, what happened and why it matters.
- prelims: 0 to 4 short, checkable facts from the text (institution, provision, figure, place, species, date).
- mains: one sentence naming the Mains angle (which GS paper theme it feeds and the debate or issue).
- gs: the GS papers it maps to (GS1 history/culture/geography/society, GS2 polity/governance/IR/social justice,
  GS3 economy/environment/S&T/security/disaster, GS4 ethics).
- insufficient: true when the text did not carry enough substance."""

SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "prelims": {"type": "array", "items": {"type": "string"}},
        "mains": {"type": "string"},
        "gs": {"type": "array", "items": {"type": "string", "enum": ["GS1", "GS2", "GS3", "GS4"]}},
        "insufficient": {"type": "boolean"},
    },
    "required": ["summary", "prelims", "mains", "gs", "insufficient"],
    "additionalProperties": False,
}

FALLBACK_MODELS = ("claude-opus-5", "claude-fable-5")  # models whose classifiers can decline


def _story_text(db: DB, story: dict) -> str:
    rows = db.q(
        "SELECT i.publisher, i.section, i.title, i.summary, f.body FROM items i "
        "LEFT JOIN items_fts f ON f.item_id = i.id WHERE i.story_id=? ORDER BY i.tier='official' DESC LIMIT 6",
        (story["id"],),
    )
    parts = [f"Headline: {story['title']}", f"Reported on: {', '.join(story.get('dates') or [])}"]
    for r in rows:
        body = (r["body"] or r["summary"] or "").strip()
        parts.append(
            f"\n--- {r['publisher']}{(' · ' + r['section']) if r['section'] else ''}\n"
            f"Title: {r['title']}\n{body[:3000]}"
        )
    return "\n".join(parts)


def _client(settings: Settings):
    import anthropic

    return anthropic.Anthropic(api_key=settings.anthropic_api_key, max_retries=3, timeout=120)


def enrich_story(client, settings: Settings, db: DB, story: dict) -> dict | None:
    import anthropic

    kwargs = dict(
        model=settings.ai_model,
        max_tokens=4000,
        system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": _story_text(db, story)}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
    )
    if settings.ai_model.startswith(FALLBACK_MODELS):
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    try:
        resp = client.beta.messages.create(**kwargs)
    except anthropic.RateLimitError:
        raise
    except anthropic.BadRequestError as exc:
        log.warning("AI notes: bad request for %s: %s", story["id"], exc.message)
        return None
    except anthropic.APIStatusError as exc:
        log.warning("AI notes: API error %s for %s", exc.status_code, story["id"])
        return None

    if resp.stop_reason == "refusal":
        return {"skipped": "refusal", "model": resp.model, "at": iso(datetime.now(timezone.utc))}
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except ValueError:
        log.warning("AI notes: non-JSON reply for %s", story["id"])
        return None
    data["prelims"] = [p for p in data.get("prelims", []) if p][:4]
    data.update({"model": resp.model, "at": iso(datetime.now(timezone.utc))})
    return data


def enrich_top(settings: Settings, db: DB, limit: int | None = None) -> dict:
    """Enrich the highest-scoring NOTE stories of the last two days that have no notes yet."""
    if not settings.ai_enabled:
        return {"enabled": False}
    import anthropic

    limit = limit or settings.ai_max_per_run
    since = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    rows = db.q(
        "SELECT id, title, dates FROM stories WHERE grade='NOTE' AND ai IS NULL AND is_library=0 "
        "AND is_editorial=0 AND last_seen >= ? ORDER BY score DESC LIMIT ?",
        (since, limit),
    )
    stories = [{"id": r["id"], "title": r["title"], "dates": json.loads(r["dates"] or "[]")} for r in rows]
    if not stories:
        return {"enabled": True, "enriched": 0}
    client = _client(settings)
    done = skipped = 0
    stop = False

    def work(story: dict):
        nonlocal stop
        if stop:
            return story, None
        try:
            return story, enrich_story(client, settings, db, story)
        except (anthropic.RateLimitError, anthropic.APIConnectionError) as exc:
            log.warning("AI notes paused: %s", type(exc).__name__)
            stop = True
            return story, None

    with ThreadPoolExecutor(max_workers=4) as ex:
        for story, ai in ex.map(work, stories):
            if ai is None:
                skipped += 1
                continue
            db.set_story_ai(story["id"], ai)
            done += 1
    db.commit()
    return {"enabled": True, "model": settings.ai_model, "enriched": done, "skipped": skipped}

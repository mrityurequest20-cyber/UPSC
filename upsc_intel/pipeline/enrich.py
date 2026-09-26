"""Explainers for brief stories: What happened · Why in news · Background · Why it matters ·
Prelims facts · Mains question — the format UPSC notes are written in.

Two tiers:
* AI explainer (when ANTHROPIC_API_KEY is set): Claude writes it from the fetched text. News facts
  come only from that text; the Background line may use well-established static knowledge
  (what an institution is, which Article applies) and is left empty when unsure.
* Auto explainer (always available, no key): built from the feed text and the classifier's tags.
  Shorter, extractive, never invents anything.
Each story is explained once; results are cached in the database.
"""
from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

from ..config import Settings
from ..db import DB, iso
from .normalize import clean_summary, today_ist

log = logging.getLogger("upsc_intel.enrich")

SYSTEM = """You write crisp revision notes for an Indian civil-services (UPSC CSE) aspirant, in the
format coaching notes use: What happened, Why in news, Background, Why it matters, Prelims facts,
Mains question.

You get one story: its headline, the outlets that carried it, and the text that was fetched.
Rules:
- Facts about the news event (who, what, numbers, dates, names of schemes/bodies) come ONLY from
  the provided text. Never invent them.
- "background" is static context a student needs (what the institution/law/scheme/concept is, the
  relevant Article or convention). Use only well-established facts; leave it "" if unsure.
- Plain, simple English. No hype. Short sentences.
- If the text is too thin, set "insufficient": true and keep fields short rather than guessing.

Fields:
- headline: a clear factual headline, at most 14 words.
- what: 1-2 sentences, what happened.
- why_in_news: 1 sentence, the trigger that put it in the news now.
- background: 0-3 sentences of static context.
- significance: 2-3 short points on why it matters for India / for the exam.
- prelims: 0-4 short, checkable facts from the text.
- mains: one Mains-style question (15 or 10 marker) this could be asked as.
- gs: the GS papers it maps to (GS1 history/culture/geography/society, GS2 polity/governance/IR/
  social justice, GS3 economy/environment/S&T/security/disaster, GS4 ethics).
- keywords: 3-6 key terms to remember.
- video_query: the best YouTube search query (5-9 words) to find an explainer video on this exact topic.
- insufficient: true when the text did not carry enough substance.

For an EDITORIAL / opinion piece: "what" is the core argument, "why_in_news" is the news peg,
"significance" lists the key arguments, "background" is the context."""

SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "what": {"type": "string"},
        "why_in_news": {"type": "string"},
        "background": {"type": "string"},
        "significance": {"type": "array", "items": {"type": "string"}},
        "prelims": {"type": "array", "items": {"type": "string"}},
        "mains": {"type": "string"},
        "gs": {"type": "array", "items": {"type": "string", "enum": ["GS1", "GS2", "GS3", "GS4"]}},
        "keywords": {"type": "array", "items": {"type": "string"}},
        "video_query": {"type": "string"},
        "insufficient": {"type": "boolean"},
    },
    "required": ["headline", "what", "why_in_news", "background", "significance", "prelims", "mains",
                 "gs", "keywords", "video_query", "insufficient"],
    "additionalProperties": False,
}

FALLBACK_MODELS = ("claude-opus-5", "claude-fable-5")  # models whose classifiers can decline


def has_ai_explainer(ai: dict | None) -> bool:
    return bool(ai and ai.get("what"))


# ─────────────────────────── auto explainer (no key) ───────────────────────────
_SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"“‘(])")
_TRIGGER = re.compile(
    r"\b(approv\w*|launch\w*|notif\w*|sign\w*|rul(ed|ing)|held|releas\w*|announc\w*|appoint\w*|pass(ed|es)|"
    r"declar\w*|extend\w*|issu\w*|designat\w*|conduct\w*|inaugurat\w*|unveil\w*|introduc\w*|clear(ed|s)|"
    r"uph(eld|olds)|struck down|imposed|granted|recorded|report(ed|s)|found|reveal\w*|decid\w*|agreed)\b",
    re.I,
)
_FACT = re.compile(r"\d|%|₹|Rs\.?|crore|lakh|per cent|Article \d+", re.I)


_ABBR = re.compile(r"(\b[A-Z]|\b(Dr|Mr|Mrs|Ms|Shri|Smt|St|No|Nos|Rs|Art|Sec|Govt|Hon|Prof|Lt|Col|Gen|Jr|Sr|vs|etc|U\.S|U\.K))\.$")


def _sentences(text: str) -> list[str]:
    parts: list[str] = []
    for frag in _SENT.split(text or ""):
        if parts and _ABBR.search(parts[-1]):  # "S. Jaishankar", "Dr. Singh", "Rs. 500"
            parts[-1] = parts[-1] + " " + frag
        else:
            parts.append(frag)
    return [p.strip() for p in parts if len(p.strip()) > 25]


_LABEL = re.compile(r"^(news|context|why in (the )?news|in news|about|what'?s the news)\s*[:\-–]\s*", re.I)


def _nice_date(d: str | None) -> str:
    try:
        dt = date.fromisoformat(d or "")
        return f"{dt.day} {dt.strftime('%b')}"
    except ValueError:
        return d or ""


def auto_explain(story: dict, labels: dict) -> dict:
    """No-AI explainer: first sentence = why in news, the next ones = what happened."""
    subj_labels = labels.get("subjects", {})
    watch_labels = labels.get("watch", {})
    title = (story.get("title") or "").strip()
    summary = clean_summary(story.get("summary") or "").replace("…", "").strip()
    sents = [_LABEL.sub("", s) for s in _sentences(summary)]
    sents = [s for s in sents if s and s.lower() != title.lower() and not title.lower().startswith(s.lower()[:60])]
    pubs = story.get("publishers") or [x.get("p") for x in story.get("sources", []) if x.get("p")]
    facts: list[str] = []
    if sents:
        why = sents[0]
        rest = sents[1:]
        facts = [x[:180] for x in rest[1:] if _FACT.search(x)][:2]  # number-bearing lines → Prelims facts
        parts = rest[:1]
        for x in rest[1:]:
            if x[:180] not in facts and len(" ".join(parts)) < 250:
                parts.append(x)
        what = " ".join(parts)
    else:
        who = ", ".join(pubs[:3]) + (f" and {len(pubs) - 3} more" if len(pubs) > 3 else "")
        why = f"Reported on {_nice_date(story.get('date_ist') or story.get('date'))}" + (f" by {who}." if who else ".")
        what = ""
    if len(what) > 420:
        what = what[:420].rsplit(" ", 1)[0] + "…"
    sig = []
    subj = [subj_labels.get(s, s) for s in story.get("subjects") or []]
    papers = [g for g in story.get("gs") or [] if g != "Prelims"]
    if subj:
        sig.append(f"{' / '.join(papers) + ': ' if papers else ''}{', '.join(subj)}")
    prelims_tags = [t for t in story.get("tags") or [] if t not in ("Data/Stats",)]
    if prelims_tags:
        sig.append("Prelims angle: " + ", ".join(prelims_tags))
    for w in story.get("watch") or []:
        sig.append("Easy-miss area: " + watch_labels.get(w, w))
    if len(pubs) >= 3:
        sig.append(f"Widely reported: {len(pubs)} outlets")
    return {"what": what, "why_in_news": why, "background": "", "significance": sig, "prelims": facts,
            "mains": "", "keywords": [], "auto": True}


# ─────────────────────────── AI explainer ───────────────────────────
def _story_text(db: DB, story: dict, kind: str) -> str:
    rows = db.q(
        "SELECT i.publisher, i.section, i.title, i.summary, f.body FROM items i "
        "LEFT JOIN items_fts f ON f.item_id = i.id WHERE i.story_id=? ORDER BY i.tier='official' DESC LIMIT 6",
        (story["id"],),
    )
    parts = [f"Type: {'EDITORIAL / opinion' if kind == 'editorial' else 'NEWS'}",
             f"Headline: {story['title']}", f"Reported on: {', '.join(story.get('dates') or [])}"]
    for r in rows:
        body = (r["body"] or r["summary"] or "").strip()
        parts.append(f"\n--- {r['publisher']}{(' · ' + r['section']) if r['section'] else ''}\n"
                     f"Title: {r['title']}\n{body[:3000]}")
    return "\n".join(parts)


def _client(settings: Settings):
    import anthropic

    return anthropic.Anthropic(api_key=settings.anthropic_api_key, max_retries=3, timeout=120)


def enrich_story(client, settings: Settings, db: DB, story: dict, kind: str = "news") -> dict | None:
    import anthropic

    kwargs = dict(
        model=settings.ai_model,
        max_tokens=4000,
        system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": _story_text(db, story, kind)}],
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
    data["significance"] = [p for p in data.get("significance", []) if p][:3]
    data.update({"model": resp.model, "at": iso(datetime.now(timezone.utc))})
    return data


def enrich_top(settings: Settings, db: DB, limit: int | None = None, days: int = 2) -> dict:
    """Explain the brief stories (news first, then editorials) of the last `days` days."""
    if not settings.ai_enabled:
        return {"enabled": False}
    import anthropic

    limit = limit or settings.ai_max_per_run
    since = (date.fromisoformat(today_ist()) - timedelta(days=days - 1)).isoformat()
    rows = db.q(
        "SELECT s.id, s.title, s.dates, s.ai, b.kind FROM brief_picks b JOIN stories s ON s.id=b.story_id "
        "WHERE b.date_ist >= ? ORDER BY b.date_ist DESC, b.kind DESC, b.rank",
        (since,),
    )
    todo = []
    for r in rows:
        ai = json.loads(r["ai"]) if r["ai"] else None
        if has_ai_explainer(ai) or (ai and ai.get("skipped")):
            continue
        todo.append(({"id": r["id"], "title": r["title"], "dates": json.loads(r["dates"] or "[]")}, r["kind"]))
    todo = todo[:limit]
    if not todo:
        return {"enabled": True, "enriched": 0}
    client = _client(settings)
    done = skipped = 0
    stop = False

    def work(job):
        nonlocal stop
        story, kind = job
        if stop:
            return story, None
        try:
            return story, enrich_story(client, settings, db, story, kind)
        except (anthropic.RateLimitError, anthropic.APIConnectionError) as exc:
            log.warning("AI notes paused: %s", type(exc).__name__)
            stop = True
            return story, None

    with ThreadPoolExecutor(max_workers=4) as ex:
        for story, ai in ex.map(work, todo):
            if ai is None:
                skipped += 1
                continue
            db.set_story_ai(story["id"], ai)
            if ai.get("video_query"):  # re-search the video with the better query next run
                db.x("UPDATE stories SET video_checked_at=NULL WHERE id=? AND (video IS NULL OR video NOT LIKE '%\"id\"%')",
                     (story["id"],))
            done += 1
    db.commit()
    return {"enabled": True, "model": settings.ai_model, "enriched": done, "skipped": skipped}

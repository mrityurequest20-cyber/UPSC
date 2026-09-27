"""Explainers for brief stories: What happened · Why in news · Background · Why it matters ·
Prelims facts · Mains question — the format UPSC notes are written in.

Two tiers:
* AI explainer (when GEMINI_API_KEY, a free Google AI Studio key, or ANTHROPIC_API_KEY is set): the model
  writes it from the free full article the build read (pipeline/articles.py) and the outlets' reports,
  plus a summary in two parts: the current part (what happened, why, the core issue, the details: facts only
  from that text, and a line or Prelims fact carrying a number the text doesn't have is dropped) and the static
  part (the institution, scheme, law or technology behind it: its basis, history, appointment and removal,
  powers… from well-established knowledge, so not checked against the text).
* Auto explainer (always available, no key): built from the feed text and the classifier's tags.
  Shorter, extractive, never invents anything.
Each story is explained once; results are cached in the database.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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
- "static" is the textbook background a student needs to answer any question on the topic, from
  well-established knowledge (not the article). Skip a point rather than guess; never repeat the day's news.
- Plain, simple English. No hype. Short sentences.
- If the text is too thin, set "insufficient": true and keep fields short rather than guessing.
- Write in your own words: never copy whole sentences from the text.

Fields:
- points: the current part of the summary, 6-9 bullet points in this order: (1) what happened; (2) why it
  happened, the trigger or the reason; (3) the core issue or argument, what is at stake or debated; then the
  key details (names, numbers, places, bodies, the decision and its reasons); last, what happens next or the
  implications. One sentence each, at most 30 words, facts only from the text. For an editorial: (1) the news
  peg, (2) the author's thesis, then the main arguments and proposals.
- static: the static part of the summary, 4-7 bullet points (at most 35 words each) on the institution,
  scheme, law, technology, grouping, concept or place behind the story. Cover what applies:
  * an institution or body (Election Commission, RBI, CAG, a tribunal, a commission): its constitutional
    or statutory basis (the Article or Act), when and how it was set up, its composition, appointment,
    tenure and removal, its powers and functions, how it is held accountable, and key reforms or judgments
    on it.
  * a scheme or mission: the ministry, the launch year, its aim, key features and targets.
  * a law, Bill or judgment: the provisions involved, the constitutional basis, earlier landmark cases.
  * technology, space or defence (a satellite, a missile, a navigation system): what it is and how it
    works, the programme's history, and the organisation behind it (for ISRO: when it was formed, under
    which department).
  * an international grouping, agreement or organisation: its members, when it was founded, its aim and
    India's role.
  * a concept, index or place: the definition, who publishes it and how it is measured, location facts.
- headline: a clear factual headline, at most 14 words.
- what: 1-2 sentences, what happened.
- why_in_news: 1 sentence, the trigger that put it in the news now.
- background: 1-2 sentences: the gist of the static part.
- significance: 2-3 short points on why it matters for India / for the exam.
- prelims: 0-4 short, checkable facts from the text.
- mains: one Mains-style question (15 or 10 marker) this could be asked as.
- gs: the GS papers it maps to (GS1 history/culture/geography/society, GS2 polity/governance/IR/
  social justice, GS3 economy/environment/S&T/security/disaster, GS4 ethics).
- keywords: 3-6 key terms to remember.
- when: the date(s) or timeline from the text ("" if none).
- where: the place(s) involved ("" if none).
- who: the key people and bodies involved, with their role ("" if none).
- video_query: the best YouTube search query (5-9 words) to find an explainer video on this exact topic.
- flashcards: 3-4 revision flashcards. q: a short question on one checkable fact from the text (who, what,
  where, which body or Article, how much, when); a: the answer in at most 15 words, from the text.
- mcqs: 2 UPSC Prelims-style questions on this story. At least one statement-based: q introduces them
  ("Consider the following statements about …:"), statements lists 2-3 statements (correct ones from the text,
  incorrect ones plausibly altered), ask is the question ("Which of the statements given above is/are
  correct?" or "How many of the above statements are correct?"), options are four UPSC-style choices ("1 only",
  "1 and 2 only", … or "Only one", "Only two", "All three", "None"). The other may be a direct question with no
  statements (statements [] and ask ""). answer: the index (0-3) of the right option; why: one line explaining
  it from the text. Never make a question whose answer isn't settled by the text.
- insufficient: true when the text did not carry enough substance.

For an EDITORIAL / opinion piece: "what" is the core argument, "why_in_news" is the news peg,
"significance" lists the key arguments, "background" is the context.
For an EXPLAINER: "what" is the explanation in brief, "why_in_news" is the news peg, and
"prelims" carries the definitions and facts the explainer sets out."""

SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "points": {"type": "array", "items": {"type": "string"}},
        "static": {"type": "array", "items": {"type": "string"}},
        "what": {"type": "string"},
        "why_in_news": {"type": "string"},
        "background": {"type": "string"},
        "significance": {"type": "array", "items": {"type": "string"}},
        "prelims": {"type": "array", "items": {"type": "string"}},
        "mains": {"type": "string"},
        "gs": {"type": "array", "items": {"type": "string", "enum": ["GS1", "GS2", "GS3", "GS4"]}},
        "keywords": {"type": "array", "items": {"type": "string"}},
        "when": {"type": "string"},
        "where": {"type": "string"},
        "who": {"type": "string"},
        "video_query": {"type": "string"},
        "insufficient": {"type": "boolean"},
        "flashcards": {"type": "array", "items": {"type": "object", "properties": {"q": {"type": "string"}, "a": {"type": "string"}},
                                                  "required": ["q", "a"], "additionalProperties": False}},
        "mcqs": {"type": "array", "items": {"type": "object", "properties": {
            "q": {"type": "string"}, "statements": {"type": "array", "items": {"type": "string"}}, "ask": {"type": "string"},
            "options": {"type": "array", "items": {"type": "string"}}, "answer": {"type": "integer"}, "why": {"type": "string"}},
            "required": ["q", "statements", "ask", "options", "answer", "why"], "additionalProperties": False}},
    },
    "required": ["headline", "points", "static", "what", "why_in_news", "background", "significance", "prelims", "mains",
                 "gs", "keywords", "when", "where", "who", "video_query", "insufficient", "flashcards", "mcqs"],
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


_LABEL = re.compile(r"^((?i:news|context|why in (the )?news|in news|about|what'?s the news)\s*[:\-–]\s*"
                    r"|(Introduction|Context)\s+(?=[A-Z]))")  # "Introduction The seizure…", not "Introduction of GST…"
# lines that are page furniture, not content: syllabus tags, bylines, source notes
_FURNITURE = re.compile(r"^(general studies\b|gs[- ]?\d\b|topic\s*:|source\s*:|this (article|piece) is (authored|written) by\b|"
                        r"the (writer|author) is\b|(written|authored) by\b)", re.I)
_SYLLABUS = re.compile(r"^(upsc\s+)?syllabus\s*:.*?(\bcontext\s*:\s*|$)", re.I)  # ForumIAS: "UPSC Syllabus: GS-3 Context: …"


def _nice_date(d: str | None) -> str:
    try:
        dt = date.fromisoformat(d or "")
        return f"{dt.day} {dt.strftime('%b')}"
    except ValueError:
        return d or ""


_MONTHS = ("January|February|March|April|May|June|July|August|September|October|November|December|"
           "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec")
WHEN = re.compile(
    rf"\b(?:(?:on|from|by|till|until|since|before|after|in)\s+)?(?:\d{{1,2}}(?:st|nd|rd|th)?\s+(?:{_MONTHS})\.?(?:,?\s+\d{{4}})?"
    rf"|(?:{_MONTHS})\.?\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,\s*\d{{4}})?|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
    rf"|(?:this|next|last)\s+(?:week|month|year)|(?:in|by|till|until)\s+20\d\d)\b")


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if len(w) > 3}


def _dedupe(sents: list[str]) -> list[str]:
    """Drop sentences that repeat an earlier one (several outlets often open with the same fact)."""
    out: list[str] = []
    for s in sents:
        w = _words(s)
        if any(len(w & _words(o)) >= 0.6 * max(1, min(len(w), len(_words(o)))) for o in out):
            continue
        out.append(s)
    return out


# exam-prep series names in headlines ("UPSC Editorial Analysis: …") are not who the story is about
_PREP_PREFIX = re.compile(r"^UPSC\s+((daily\s+)?editorial analysis|issue at a glance|key|essentials|current affairs)"
                          r"\s*[:|\-–]\s*", re.I)
_BARE_YEAR = re.compile(r"^(?:in|by|till|until)\s+(20\d\d)$", re.I)


def five_w(text: str, story: dict, clf=None) -> dict:
    """When / Where / Who lines, only from names and dates actually in the text."""
    day = story.get("date_ist") or story.get("date") or ""
    this_year = int(day[:4]) if day[:4].isdigit() else 0
    when = []
    for m in WHEN.finditer(text or ""):
        phrase = m.group(0).strip()
        year = _BARE_YEAR.match(phrase)
        if year and this_year and int(year.group(1)) < this_year:  # "adopted in 2003" is background
            continue
        if phrase.lower() not in (x.lower() for x in when):
            when.append(phrase)
        if len(when) == 2:
            break
    reported = _nice_date(day)
    out = {"when": " · ".join([f"Reported {reported}"] + when) if reported else " · ".join(when)}
    if clf is not None:
        full = f"{_PREP_PREFIX.sub('', story.get('title') or '')}. {text or ''}"
        out["where"] = ", ".join(clf.places(full))
        out["who"] = ", ".join(clf.people_and_bodies(full))
    return out


CUT_MIN = 140
# a short line ending on a function word is a feed excerpt cut mid-sentence ("Mining is an important source of…")
_DANGLING = re.compile(r"\b(of|the|a|an|to|and|or|in|for|with|on|at|by|from|as|is|are|was|were|that|which|its|their|has|have)$", re.I)


def auto_explain(story: dict, labels: dict, text: str | None = None, clf=None) -> dict:
    """No-AI explainer: first sentence = why in news, the next ones = what happened, plus when / where /
    who. text: all the outlets' summaries of this story together (more to go on than one feed line)."""
    subj_labels = labels.get("subjects", {})
    watch_labels = labels.get("watch", {})
    title = (story.get("title") or "").strip()
    summary = clean_summary(text or story.get("summary") or "").replace("…", "").strip()
    sents = [_LABEL.sub("", _SYLLABUS.sub("", s)) for s in _sentences(summary) if not _FURNITURE.search(s)]
    sents = [s for s in sents if s and s.lower() != title.lower() and not title.lower().startswith(s.lower()[:60])]
    sents = _dedupe(sents)
    sents = [x for x in sents if len(x) >= CUT_MIN or not _DANGLING.search(x.rstrip(" ,;:-–.…"))]
    # a long line without an end mark is a feed excerpt cut mid-sentence; a short one is a standfirst
    if sents and len(sents[-1]) >= CUT_MIN and not re.search(r"[.!?\"”’)]$", sents[-1]):
        sents[-1] += "…"
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
        when = _nice_date(story.get("date_ist") or story.get("date"))
        if story.get("is_editorial") or story.get("editorial"):
            why = f"Opinion piece{' in ' + who if who else ''}, {when}. Open it for the full argument."
        elif story.get("is_explained") or story.get("explained"):
            why = f"Explainer{' by ' + who if who else ''}, {when}. Open it for the full piece."
        else:
            why = f"Reported on {when}" + (f" by {who}." if who else ".")
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
            "mains": "", "keywords": [], "auto": True, **five_w(" ".join(sents), story, clf)}


# ─────────────────────────── AI explainer ───────────────────────────
ARTICLE_CHARS = 12000


def _story_text(db: DB, story: dict, kind: str) -> str:
    art = db.articles([story["id"]]).get(story["id"])
    rows = db.q(
        "SELECT i.publisher, i.section, i.title, i.summary, f.body FROM items i "
        "LEFT JOIN items_fts f ON f.item_id = i.id WHERE i.story_id=? ORDER BY i.tier='official' DESC LIMIT 6",
        (story["id"],),
    )
    label = {"editorial": "EDITORIAL / opinion", "explained": "EXPLAINER"}.get(kind, "NEWS")
    parts = [f"Type: {label}",
             f"Headline: {story['title']}", f"Reported on: {', '.join(story.get('dates') or [])}"]
    if art and not art["miss"] and art["paragraphs"]:
        text = "\n".join(art["paragraphs"])[:ARTICLE_CHARS]
        parts.append(f"\n--- FULL ARTICLE ({art['domain']}{', a free report of the same story' if art['via'] == 'search' else ''})\n{text}")
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
    data = guard(data, _story_text(db, story, kind))
    data["points"] = data.get("points", [])[:MAX_POINTS]
    data["prelims"] = [p for p in data.get("prelims", []) if p][:4]
    data["significance"] = [p for p in data.get("significance", []) if p][:3]
    data.update({"model": resp.model, "at": iso(datetime.now(timezone.utc))})
    return data


# ─────────────────────────── the fact guard ───────────────────────────
_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _numbers(text: str) -> set[str]:
    return {n.replace(",", "").rstrip(".") for n in _NUM.findall(text or "")}


def supported(line: str, source: str) -> bool:
    """Every figure in the line is in the source text (small counts like "two" → "2" are let through)."""
    have = _numbers(source)
    return all(n in have or (n.isdigit() and int(n) <= 12) for n in _numbers(line))


MAX_POINTS, MAX_STATIC = 9, 7


def static_points(items, points: list[str]) -> list[str]:
    """The static part of the summary: general knowledge, so not checked against the text's figures; only blank,
    over-long and repeated lines (a line that restates a current point) go, and at most MAX_STATIC stay."""
    now = {re.sub(r"\W+", " ", p.lower()).strip()[:60] for p in points}
    out, seen = [], set()
    for x in items or []:
        x = " ".join(str(x or "").split())
        k = re.sub(r"\W+", " ", x.lower()).strip()[:60]
        if len(x) < 12 or len(x.split()) > 55 or k in seen or k in now:
            continue
        seen.add(k)
        out.append(x)
    return out[:MAX_STATIC]


def guard(data: dict, source: str) -> dict:
    """Drops summary lines, Prelims facts and flashcards whose figures the text doesn't carry, and MCQs that
    aren't well formed (four distinct options, an answer among them). (An MCQ's wrong statements are wrong on
    purpose, so its figures aren't checked; the static part is general knowledge, see static_points.)"""
    for k in ("points", "prelims"):
        kept = [x for x in data.get(k) or [] if x and supported(x, source)]
        if len(kept) < len(data.get(k) or []):
            log.info("AI notes: dropped %d %s line(s) with figures not in the text", len(data[k]) - len(kept), k)
        data[k] = kept
    data["static"] = static_points(data.get("static"), data.get("points") or [])
    if not str(data.get("background") or "").strip() and data["static"]:
        data["background"] = data["static"][0]
    data["flashcards"] = [{"q": str(c["q"]).strip(), "a": str(c["a"]).strip()} for c in data.get("flashcards") or []
                          if isinstance(c, dict) and c.get("q") and c.get("a") and supported(f"{c['q']} {c['a']}", source)][:4]
    mcqs = []
    for m in data.get("mcqs") or []:
        opts = [str(o).strip() for o in (m.get("options") or [])] if isinstance(m, dict) else []
        if (len(opts) == 4 and len(set(opts)) == 4 and all(opts) and isinstance(m.get("answer"), int) and 0 <= m["answer"] < 4
                and str(m.get("q") or "").strip()):
            mcqs.append({"q": str(m["q"]).strip(), "statements": [str(x).strip() for x in m.get("statements") or [] if str(x).strip()][:4],
                         "ask": str(m.get("ask") or "").strip(), "options": opts, "answer": m["answer"], "why": str(m.get("why") or "").strip()})
    data["mcqs"] = mcqs[:2]
    return data


# ─────────────────────────── Gemini (a free Google AI Studio key) ───────────────────────────
GEMINI_API = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_PAUSE = 4.5  # seconds between calls: the free tier allows about 10-15 requests a minute
GEMINI_FALLBACK = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
BLOCKED = {"SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "LANGUAGE"}
# Of each model's daily limit, the requests the build leaves for the phone (Ask Intel, Mains marking, Hinglish): the
# phone uses the same key. At most a fifth of a small limit.
RESERVE = 25
PACIFIC = ZoneInfo("America/Los_Angeles")  # the free quota resets at midnight Pacific time (12:30 PM IST, 1:30 PM in winter)


class GeminiStop(Exception):
    """The key is refused, or every model's quota is used up: stop for this run."""


def pacific_day(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(PACIFIC).date().isoformat()


def quota_hit(r) -> tuple[str, int | None]:
    """A 429's reason from its details: ("day", the daily limit if Google names it) when the model's daily quota is
    used up, ("minute", None) for the per-minute limit, ("", None) when the reply doesn't say."""
    try:
        details = r.json()["error"].get("details") or []
    except (ValueError, KeyError, TypeError, AttributeError):
        return "", None
    kind = ""
    for d in details:
        for v in (d.get("violations") or []) if isinstance(d, dict) else []:
            qid = str(v.get("quotaId") or "")
            if "PerDay" in qid:
                try:
                    return "day", int(v.get("quotaValue"))
                except (TypeError, ValueError):
                    return "day", None
            if "PerMinute" in qid:
                kind = "minute"
    return kind, None


class Ledger:
    """The build's Gemini requests per model per Pacific day, in the database, so every step of every run knows which
    model is used up until the quota resets (no request is wasted on it every 20 minutes) and when to stop to leave
    RESERVE requests for the phone."""

    def __init__(self, db: DB, reserve: int = RESERVE):
        self.db, self.reserve = db, reserve

    def _row(self, model: str, day: str):
        rows = self.db.q("SELECT calls, quota, out_at FROM gemini_usage WHERE day=? AND model=?", (day, model))
        return rows[0] if rows else None

    def limit(self, model: str, day: str | None = None) -> int | None:
        """The model's daily limit: as Google named it (or as the build found it) on the latest day it ran out."""
        day = day or pacific_day()
        since = (date.fromisoformat(day) - timedelta(days=14)).isoformat()
        rows = self.db.q("SELECT quota FROM gemini_usage WHERE model=? AND day>=? AND quota IS NOT NULL ORDER BY day DESC LIMIT 1",
                         (model, since))
        return rows[0]["quota"] if rows else None

    def usable(self, model: str) -> str:
        """"" when the build may call the model now, else why not ("out": used up today; "reserve": the rest is the phone's)."""
        day = pacific_day()
        row = self._row(model, day)
        if row and row["out_at"]:
            return "out"
        lim = self.limit(model, day)
        if lim and row and row["calls"] >= lim - min(self.reserve, max(2, lim // 5)):
            return "reserve"
        return ""

    def count(self, model: str) -> None:
        self.db.x("INSERT INTO gemini_usage (day, model, calls) VALUES (?,?,1) "
                  "ON CONFLICT(day, model) DO UPDATE SET calls = calls + 1", (pacific_day(), model))
        self.db.commit()

    def out(self, model: str, quota: int | None) -> None:
        """Used up for today: Google's own limit, else the requests the build made today (the phone's aren't seen)."""
        day = pacific_day()
        row = self._row(model, day)
        quota = quota or (row["calls"] if row and row["calls"] else None)
        self.db.x("INSERT INTO gemini_usage (day, model, calls, quota, out_at) VALUES (?,?,0,?,?) "
                  "ON CONFLICT(day, model) DO UPDATE SET quota = COALESCE(?, quota), out_at = ?",
                  (day, model, quota, iso(datetime.now(timezone.utc)), quota, iso(datetime.now(timezone.utc))))
        self.db.commit()

    def today(self) -> dict:
        return {r["model"]: {"calls": r["calls"], "limit": r["quota"], **({"out": r["out_at"]} if r["out_at"] else {})}
                for r in self.db.q("SELECT * FROM gemini_usage WHERE day=? ORDER BY model", (pacific_day(),))}


def rank_models(names: list[str]) -> list[str]:
    """The key's Flash models, best first: the newest stable Flash, the next one, then the newest Flash-Lite
    (higher free quota) and the "latest" aliases."""
    def ver(n: str) -> float:
        m = re.match(r"gemini-(\d+(?:\.\d+)?)-", n)
        return float(m.group(1)) if m else 0.0
    flash = sorted((n for n in names if re.fullmatch(r"gemini-\d+(?:\.\d+)?-flash", n)), key=ver, reverse=True)
    lite = sorted((n for n in names if re.fullmatch(r"gemini-\d+(?:\.\d+)?-flash-lite", n)), key=ver, reverse=True)
    alias = [n for n in ("gemini-flash-latest", "gemini-flash-lite-latest") if n in names]
    return flash[:2] + lite[:1] + alias or list(GEMINI_FALLBACK)


def lite_first(models: list[str]) -> list[str]:
    """For sorting and extraction jobs: Flash-Lite (the bigger free quota) first, which leaves Flash for the notes."""
    return [m for m in models if "lite" in m] + [m for m in models if "lite" not in m]


def gemini_schema(sch: dict) -> dict:
    """JSON Schema → the OpenAPI subset Gemini's responseSchema takes."""
    out: dict = {"type": sch["type"].upper()}
    if "enum" in sch:
        out["enum"] = sch["enum"]
    if sch["type"] == "object":
        out["properties"] = {k: gemini_schema(v) for k, v in sch["properties"].items()}
        out["required"] = list(sch.get("required", []))
        out["propertyOrdering"] = list(sch["properties"])
    elif sch["type"] == "array":
        out["items"] = gemini_schema(sch["items"])
    return out


class Gemini:
    """Gemini's REST API with the key in a header (never in a URL, so it never reaches a log). With the database, the
    day's usage is kept (Ledger); `lite` puts Flash-Lite first (sorting and extraction jobs)."""

    def __init__(self, key: str, model: str = "", http=None, db: DB | None = None, lite: bool = False):
        import httpx

        self.key = key
        self.http = http or httpx.Client(timeout=120)
        self.models: list[str] | None = [model] if model else None
        self.lite = lite
        self.ledger = Ledger(db, reserve=int(os.environ.get("UPSC_GEMINI_RESERVE") or RESERVE)) if db is not None else None

    def _headers(self) -> dict:
        return {"x-goog-api-key": self.key, "Content-Type": "application/json"}

    def pick(self) -> list[str]:
        if self.models is None:
            r = self.http.get(f"{GEMINI_API}/models", headers=self._headers(), params={"pageSize": 200})
            if r.status_code in (400, 401, 403):
                raise GeminiStop(f"the key was refused (HTTP {r.status_code})")
            names = [m.get("name", "").split("/", 1)[-1] for m in (r.json().get("models") or [])
                     if "generateContent" in (m.get("supportedGenerationMethods") or [])] if r.status_code == 200 else []
            self.models = lite_first(rank_models(names)) if self.lite else rank_models(names)
            log.info("Gemini models: %s", ", ".join(self.models))
        return self.models

    def generate(self, system: str, text: str, schema: dict) -> tuple[dict | None, str]:
        """→ (the JSON reply, or {"skipped": reason} for this card; the model that answered). Raises GeminiStop."""
        body = {"systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": text}]}],
                # (a "thinking" model counts its thinking in the output budget: room for both)
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 16384, "responseMimeType": "application/json",
                                     "responseSchema": gemini_schema(schema)}}
        held = []
        for model in list(self.pick()):
            why = self.ledger.usable(model) if self.ledger else ""
            if why:  # used up today, or the rest of today's limit is the phone's
                held.append(why)
                continue
            r = self.http.post(f"{GEMINI_API}/models/{model}:generateContent", headers=self._headers(), json=body)
            if r.status_code in (429, 404) or r.status_code >= 500:
                log.warning("Gemini %s: HTTP %s, trying the next model", model, r.status_code)
                if r.status_code == 429 and self.ledger:
                    kind, quota = quota_hit(r)
                    if kind == "day":  # not again until the quota resets (every run, every step)
                        self.ledger.out(model, quota)
                        log.warning("Gemini %s: today's free quota is used up (limit %s)", model, quota or "not given")
                if r.status_code < 500:  # quota used up or model gone: not again this run (a busy 503 is tried next card)
                    self.models.remove(model)
                continue
            if self.ledger:
                self.ledger.count(model)
            if r.status_code in (401, 403) or (r.status_code == 400 and "API_KEY" in r.text):
                raise GeminiStop(f"the key was refused (HTTP {r.status_code})")
            if r.status_code >= 400:  # a bad request is the same for every card (e.g. an API change): stop, mark nothing
                raise GeminiStop(f"Gemini refused the request (HTTP {r.status_code}): {r.text[:200]}")
            j = r.json()
            cand = (j.get("candidates") or [{}])[0]
            reason = cand.get("finishReason") or (j.get("promptFeedback") or {}).get("blockReason") or ""
            if reason in BLOCKED or (j.get("promptFeedback") or {}).get("blockReason"):
                return {"skipped": reason.lower() or "blocked"}, model
            out = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts") or [] if not p.get("thought"))
            try:
                return json.loads(out), model
            except ValueError:  # cut short or malformed: this card is skipped, not retried every run
                log.warning("Gemini %s: non-JSON reply (%s)", model, reason)
                return {"skipped": f"bad reply ({reason.lower() or 'not JSON'})"}, model
        if held and all(h == "reserve" for h in held):
            raise GeminiStop("the rest of today's free quota is left for the phone (it resets at 12:30 PM IST)")
        if held:
            raise GeminiStop("every model's free quota is used up for today (it resets at 12:30 PM IST)")
        raise GeminiStop("every model's free quota is used up for now")


def enrich_story_gemini(gem: Gemini, db: DB, story: dict, kind: str = "news") -> dict | None:
    text = _story_text(db, story, kind)
    data, model = gem.generate(SYSTEM, text, SCHEMA)
    now = iso(datetime.now(timezone.utc))
    if data.get("skipped"):
        return {**data, "model": model, "at": now}
    data = guard(data, text)
    data["points"] = data.get("points", [])[:MAX_POINTS]
    data["prelims"] = [p for p in data.get("prelims", []) if p][:4]
    data["significance"] = [p for p in data.get("significance", []) if p][:3]
    data.update({"model": model, "by": "Gemini", "src": "article" if "--- FULL ARTICLE" in text else "reports", "at": now})
    return data


def enrich_top(settings: Settings, db: DB, limit: int | None = None, days: int = 2) -> dict:
    """Explain the brief's cards (Must-know and Prelims facts, then explainers, then editorials) of the last
    `days` days; the "Also in the news" list and folded reports don't carry a write-up."""
    if not settings.ai_enabled:
        return {"enabled": False}
    gemini = settings.ai_provider == "gemini"
    limit = limit or (settings.gemini_max_per_run if gemini else settings.ai_max_per_run)
    since = (date.fromisoformat(today_ist()) - timedelta(days=days - 1)).isoformat()
    rows = db.q(
        "SELECT s.id, s.title, s.dates, s.ai, b.kind FROM brief_picks b JOIN stories s ON s.id=b.story_id "
        "WHERE b.date_ist >= ? AND COALESCE(b.tier, 'top') IN ('top', 'prelims') AND b.lead IS NULL "
        "ORDER BY b.date_ist DESC, b.kind DESC, b.rank",
        (since,),
    )
    arts = db.articles([r["id"] for r in rows])
    todo = []
    for r in rows:
        ai = json.loads(r["ai"]) if r["ai"] else None
        a = arts.get(r["id"])
        upgrade = bool(ai and ai.get("src") == "reports" and a and not a["miss"])  # the full article came in since
        # a Gemini note from before flashcards and MCQs, or before the static part: written again once (the recent
        # days only, new cards first)
        older = bool(gemini and ai and ai.get("by") == "Gemini" and ("mcqs" not in ai or "static" not in ai))
        if (has_ai_explainer(ai) and not upgrade and not older) or (ai and ai.get("skipped")) or (ai and ai.get("source") == "claude-notes"):
            continue
        todo.append(({"id": r["id"], "title": r["title"], "dates": json.loads(r["dates"] or "[]")}, r["kind"], older))
    todo = [(s, k) for s, k, _ in sorted(todo, key=lambda x: x[2])]  # (a stable sort: new cards keep their order, first)
    todo = _unique(todo)[:limit]  # a story can sit in two days' briefs
    if not todo:
        return {"enabled": True, "provider": settings.ai_provider, "enriched": 0}
    if gemini:
        return _enrich_gemini(settings, db, todo)
    import anthropic

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
    return {"enabled": True, "provider": "anthropic", "model": settings.ai_model, "enriched": done, "skipped": skipped}


def _unique(todo: list) -> list:
    seen: set[str] = set()
    out = []
    for story, kind in todo:
        if story["id"] not in seen:
            seen.add(story["id"])
            out.append((story, kind))
    return out


def _save(db: DB, story: dict, ai: dict) -> None:
    db.set_story_ai(story["id"], ai)
    if ai.get("video_query"):  # re-search the video with the better query next run
        db.x("UPDATE stories SET video_checked_at=NULL WHERE id=? AND (video IS NULL OR video NOT LIKE '%\"id\"%')",
             (story["id"],))


def _enrich_gemini(settings: Settings, db: DB, todo: list, pause: float = GEMINI_PAUSE, http=None) -> dict:
    """One card at a time, a few seconds apart (the free tier's per-minute limit); stops at a used-up quota."""
    gem = Gemini(settings.gemini_api_key or "", settings.gemini_model, http=http, db=db)
    done = skipped = 0
    note = ""
    for i, (story, kind) in enumerate(todo):
        if i and pause:
            time.sleep(pause)
        try:
            ai = enrich_story_gemini(gem, db, story, kind)
        except GeminiStop as exc:
            note = str(exc)
            log.warning("AI notes paused: %s", note)
            break
        except Exception as exc:  # a network hiccup: this card waits for the next run
            log.warning("AI notes: %s for %s", type(exc).__name__, story["id"])
            skipped += 1
            continue
        if ai is None:
            skipped += 1
            continue
        _save(db, story, ai)
        done += not ai.get("skipped")
        skipped += bool(ai.get("skipped"))
        db.commit()
    return {"enabled": True, "provider": "gemini", "models": gem.models or [], "enriched": done, "skipped": skipped,
            **({"paused": note} if note else {})}

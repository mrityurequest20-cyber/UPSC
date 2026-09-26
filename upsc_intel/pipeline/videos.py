"""Attach the most relevant YouTube explainer to each brief story.

Order of attempts (first confident match wins):
1. The video library: recent uploads from trusted channels (Sansad TV, PIB, DD News, Indian Express,
   Drishti, StudyIQ, ClearIAS, Prep together…) collected from their RSS feeds. Free and precise.
2. YouTube Data API search, when YOUTUBE_API_KEY is set.
3. YouTube's public search results page (low volume, only for brief stories, results cached).
If nothing clears the confidence bar, the story gets a ready-made YouTube search link instead of a
wrong video.
"""
from __future__ import annotations

import json
import logging
import math
import re
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, quote_plus, urlsplit

from ..config import Settings
from ..db import DB, iso, utcnow
from ..fetchers.http import Http
from .normalize import IST, fold, ist_date, key_tokens, title_tokens

log = logging.getLogger("upsc_intel.videos")

TRUSTED = re.compile(
    r"(sansad|pib|dd news|doordarshan|all india radio|news on air|newsonair|rajya sabha tv|indian express|the hindu|"
    r"drishti|studyiq|study iq|vision ias|"
    r"onlyias|only ias|forumias|forum ias|insights|next ias|nextias|vajiram|sleepy classes|clearias|adda247|"
    r"unacademy|mrunal|prep together|shankar ias|iasbaba|rau'?s ias|edukemy|sanskriti|khan global|physics wallah|pw )",
    re.I,
)
DAILY_ANALYSIS = re.compile(
    r"(current affairs|news analysis|newspaper analysis|the hindu|editorial analysis|pib|daily news|"
    r"perspective|big picture|in depth|desh deshantar|news simplified|dns|daily dose|mains answer)",
    re.I,
)
DEVANAGARI = re.compile("[\u0900-\u0DFF]")  # Indic scripts (Devanagari … Sinhala)
NON_NEWS = re.compile(
    r"(vlog|boat rid|riding|\btrip\b|travel|tour guide|trek|hotel|resort|recipe|#shorts|\bshorts\b|prank|reaction|"
    r"\bsong\b|status video|full movie|mcqs?\b|quiz|mock test|expected paper|\bssc\b|\bcgl\b|gk bits)",
    re.I,
)
OTHER_LANGUAGE = re.compile(r"\b(in|explained in)\s+(hindi|telugu|tamil|kannada|malayalam|marathi|bengali|gujarati|odia|urdu)\b", re.I)
BULLETIN = re.compile(
    r"(& more|and more|headlines|bulletin|aaj ki khabar|top news|news in brief|samachar|news@|"
    r"\b\d+\s*news\b|fatafat|superfast|speed news|morning news|evening news|8 pm|9 pm)",
    re.I,
)
GENERIC = set("""
upsc cse ias ips pcs exam exams prelim prelims main mains gs paper current affair affairs daily today live update
news analysis hindu pib express indian india explained explainer key big latest class lecture part episode ep
video full detail details simple important question questions answer answers mcq mcqs quiz topic topics
january february march april may june july august september october november december sept
""".split())
ACCEPT = 0.75
RETRY_AFTER = timedelta(hours=3)
MAX_SEARCHES_PER_RUN = 80


def video_id(url: str) -> str | None:
    parts = urlsplit(url or "")
    if parts.hostname and "youtu.be" in parts.hostname:
        return parts.path.strip("/") or None
    return (parse_qs(parts.query).get("v") or [None])[0]


def video_row(raw, src: dict) -> dict | None:
    vid = video_id(raw.url)
    if not vid:
        return None
    published = raw.published or utcnow()
    return {
        "id": vid, "channel": src.get("name"), "channel_id": src.get("id"), "title": raw.title,
        "url": f"https://www.youtube.com/watch?v={vid}", "published_at": iso(published),
        "date_ist": ist_date(published), "tokens": title_tokens(raw.title), "trusted": 1,
        "source": "feed", "seen_at": iso(utcnow()),
    }


# ── scoring ──
def _clean_title(title: str) -> str:
    return re.sub(r"\s*[|:–-]\s*(explained|upsc|live|watch).*$", "", fold(title or ""), flags=re.I).strip()


def queries(story: dict) -> list[str]:
    """Search queries, most specific first: AI's query, the distinctive terms, then the plain headline."""
    out: list[str] = []
    ai = story.get("ai") or {}
    if ai.get("video_query"):
        out.append(ai["video_query"])
    title = _clean_title(story["title"])
    words = re.findall(r"[A-Za-z][A-Za-z0-9\-']*", title)
    keys = key_tokens(title)
    distinct = [w for w in words if w.lower().strip("'") in keys or (w.isupper() and len(w) >= 3)]
    if len(distinct) >= 2:
        out.append(" ".join(distinct[:6]))
    plain = " ".join(w for w in words if w.lower() not in GENERIC)[:90]
    if plain and plain not in out:
        out.append(plain)
    return out[:2] or [title]


def _query(story: dict) -> str:
    return queries(story)[0]


def _acronyms(text: str) -> set[str]:
    return {w.lower() for w in re.findall(r"\b[A-Z][A-Z0-9]{2,}\b", fold(text or "")) if not w.isdigit()}


def _topic_tokens(text: str) -> set[str]:
    return {t for t in title_tokens(text) if t not in GENERIC and not re.fullmatch(r"(19|20)\d\d|\d{1,2}", t)}


def score_video(story: dict, title: str, channel: str, published: datetime | None, lang: str = "en",
                idf: dict[str, float] | None = None) -> float:
    """0 = unrelated. Words are weighted by rarity (IDF over recent headlines), so 'AFSPA' or
    'Cybercrime' count far more than 'minister' or 'art'. A match must cover at least half of the
    story's weight and include one of its three most distinctive words."""
    s_toks = _topic_tokens(story["title"])
    v_toks = _topic_tokens(title)
    shared = s_toks & v_toks
    if len(shared) < 2 or not s_toks:
        return 0.0
    acronyms = _acronyms(story["title"]) | _acronyms(title)
    default = max(idf.values()) if idf else 1.0

    def w(t: str) -> float:
        base = idf.get(t, default) if idf else 1.0
        return base * (2 if t in acronyms else 1)

    ranked = sorted(s_toks, key=w, reverse=True)[:8]
    total = sum(w(t) for t in ranked)
    cov = sum(w(t) for t in shared if t in ranked) / total if total else 0.0
    if cov < 0.5 or not (set(ranked[:3]) & shared):
        return 0.0
    s_keys = {k for k in key_tokens(story["title"]) if k in s_toks}
    score = cov + 0.1 * min(len(s_keys & shared), 4)
    if TRUSTED.search(channel or ""):
        score += 0.25
    if BULLETIN.search(title):
        score -= 0.5
    if lang == "en" and (DEVANAGARI.search(title) or OTHER_LANGUAGE.search(title)):
        return 0.0  # English preferred (UPSC_VIDEO_LANG=hi or any to allow other languages)
    if NON_NEWS.search(title):
        score -= 0.6
    if published:
        story_day = date.fromisoformat(story.get("date_ist") or ist_date(published))
        delta = (published.astimezone(IST).date() - story_day).days
        if delta < -7:
            return 0.0
        score += 0.2 if -1 <= delta <= 4 else (-0.3 if delta < -3 else 0.0)
    else:
        score -= 0.3  # unknown upload date: could be an old video
    return round(score, 3)


def build_idf(db: DB, days: int = 30) -> dict[str, float]:
    since = iso(utcnow() - timedelta(days=days))
    df: dict[str, int] = {}
    n = 0
    for r in db.q("SELECT tokens FROM stories WHERE last_seen >= ? AND is_library=0", (since,)):
        n += 1
        for t in set(json.loads(r["tokens"] or "[]")):
            df[t] = df.get(t, 0) + 1
    return {t: math.log((n + 1) / (c + 1)) + 1 for t, c in df.items()} if n else {}


# ── candidate sources ──
def _relative_time(text: str | None) -> datetime | None:
    if not text:
        return None
    m = re.search(r"(\d+)\s*(sec|min|h|hr|hour|d|day|w|wk|week|mo|month|y|yr|year)s?\b", text, re.I)
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2).lower()
    per = {"sec": 1 / 86400, "min": 1 / 1440, "h": 1 / 24, "hr": 1 / 24, "hour": 1 / 24, "d": 1, "day": 1,
           "w": 7, "wk": 7, "week": 7, "mo": 30, "month": 30, "y": 365, "yr": 365, "year": 365}
    days = n * per[unit]
    return datetime.now(timezone.utc) - timedelta(days=days)


def search_page(http: Http, query: str) -> list[dict]:
    """Parse YouTube's public search results (ytInitialData). Filter: uploaded this month."""
    resp = http.get("https://www.youtube.com/results",
                    params={"search_query": query, "sp": "EgIIBA=="},  # filter: uploaded this month
                    headers={"Accept-Language": "en-IN,en;q=0.9", "Cookie": "CONSENT=YES+1"})
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", resp.text, re.S)
    if not m:
        return []
    found: list[dict] = []

    def walk(o):
        if isinstance(o, dict):
            v = o.get("videoRenderer")
            if v and v.get("videoId"):
                found.append({
                    "id": v["videoId"],
                    "title": "".join(r.get("text", "") for r in (v.get("title") or {}).get("runs", [])),
                    "channel": ((v.get("ownerText") or {}).get("runs") or [{}])[0].get("text", ""),
                    "published": _relative_time((v.get("publishedTimeText") or {}).get("simpleText")),
                })
                return
            for x in o.values():
                walk(x)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    try:
        walk(json.loads(m.group(1)))
    except ValueError:
        return []
    return found[:15]


def search_api(http: Http, key: str, query: str, since: datetime) -> list[dict]:
    resp = http.get("https://www.googleapis.com/youtube/v3/search", params={
        "part": "snippet", "type": "video", "q": query, "maxResults": 10, "regionCode": "IN",
        "relevanceLanguage": "en", "publishedAfter": since.strftime("%Y-%m-%dT%H:%M:%SZ"), "key": key,
    })
    out = []
    for it in resp.json().get("items", []):
        sn = it.get("snippet") or {}
        try:
            pub = datetime.fromisoformat(sn.get("publishedAt", "").replace("Z", "+00:00"))
        except ValueError:
            pub = None
        out.append({"id": (it.get("id") or {}).get("videoId"), "title": sn.get("title", ""),
                    "channel": sn.get("channelTitle", ""), "published": pub})
    return [o for o in out if o["id"]]


def _best(story: dict, cands: list[dict], lang: str, idf: dict | None = None) -> tuple[float, dict | None]:
    best, best_score = None, 0.0
    for c in cands:
        sc = score_video(story, c["title"], c["channel"], c.get("published"), lang, idf)
        if sc > best_score:
            best, best_score = c, sc
    return best_score, best


def _as_video(c: dict, how: str, score: float) -> dict:
    return {"id": c["id"], "url": f"https://www.youtube.com/watch?v={c['id']}", "title": c["title"],
            "channel": c["channel"], "published": iso(c["published"]) if c.get("published") else None,
            "match": how, "score": score}


def link_brief_videos(settings: Settings, db: DB, days: list[str]) -> dict:
    """Find a video for each brief story of the given days that doesn't have a confident one yet."""
    if not days:
        return {"linked": 0}
    rows = db.q(
        f"SELECT s.id, s.title, s.date_ist, s.tokens, s.ai, s.video, s.video_checked_at FROM brief_picks b "
        f"JOIN stories s ON s.id=b.story_id WHERE b.date_ist IN ({','.join('?' * len(days))}) ORDER BY b.kind, b.rank",
        days,
    )
    lo = (date.fromisoformat(min(days)) - timedelta(days=2)).isoformat()
    hi = (date.fromisoformat(max(days)) + timedelta(days=4)).isoformat()
    library = [{"id": v["id"], "title": v["title"], "channel": v["channel"],
                "published": datetime.fromisoformat(v["published_at"]) if v.get("published_at") else None}
               for v in db.videos_between(lo, hi)]
    http = Http(timeout=settings.http_timeout, retries=1)
    idf = build_idf(db)
    now = utcnow()
    searches = linked = 0
    try:
        for r in rows:
            current = json.loads(r["video"]) if r["video"] else None
            if current and current.get("id"):
                pub = datetime.fromisoformat(current["published"]) if current.get("published") else None
                check = score_video({"title": r["title"], "date_ist": r["date_ist"]}, current.get("title", ""),
                                    current.get("channel", ""), pub, settings.video_lang, idf)
                if check >= ACCEPT:
                    continue
                db.set_story_video(r["id"], None, None)  # matcher got stricter: drop and re-search
                current = None
            if current is not None and r["video_checked_at"] and \
                    now - datetime.fromisoformat(r["video_checked_at"]) < RETRY_AFTER:
                continue
            story = {"id": r["id"], "title": r["title"], "date_ist": r["date_ist"],
                     "tokens": json.loads(r["tokens"] or "[]"), "ai": json.loads(r["ai"]) if r["ai"] else None}
            qs = queries(story)
            query = qs[0]
            score, cand = _best(story, library, settings.video_lang, idf)
            how = "library"
            for q in qs:
                if score >= ACCEPT or searches >= MAX_SEARCHES_PER_RUN or not settings.video_search:
                    break
                try:
                    if settings.youtube_api_key:
                        since = datetime.fromisoformat(story["date_ist"]).replace(tzinfo=IST) - timedelta(days=2)
                        cands, via = search_api(http, settings.youtube_api_key, q, since), "youtube-api"
                    else:
                        cands, via = search_page(http, q), "youtube-search"
                        time.sleep(1.0)
                    searches += 1
                    s2, c2 = _best(story, cands, settings.video_lang, idf)
                    if s2 > score:
                        score, cand, how = s2, c2, via
                except Exception as exc:  # search is best-effort
                    log.info("video search failed for %s: %s", r["id"], exc)
                    break
            if cand and score >= ACCEPT:
                video = _as_video(cand, how, score)
                linked += 1
            else:
                video = {"search_url": f"https://www.youtube.com/results?search_query={quote_plus(query)}",
                         "query": query}
            db.set_story_video(r["id"], video, iso(now))
    finally:
        http.close()
    db.commit()
    return {"linked": linked, "searches": searches}


def daily_videos(db: DB, date_from: str, date_to: str, limit_per_day: int = 12) -> dict[str, list[dict]]:
    """Current-affairs analysis videos from the trusted channels, grouped by day."""
    out: dict[str, list[dict]] = {}
    for v in db.videos_between(date_from, date_to):
        if not DAILY_ANALYSIS.search(v["title"] or ""):
            continue
        day = out.setdefault(v["date_ist"], [])
        if len(day) < limit_per_day:
            day.append({"id": v["id"], "url": v["url"], "title": v["title"], "channel": v["channel"],
                        "published": v["published_at"]})
    return out

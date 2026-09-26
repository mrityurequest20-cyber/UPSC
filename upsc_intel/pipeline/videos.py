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
    r"unacademy|mrunal|prep together|shankar ias|iasbaba|rau'?s ias|edukemy|sanskriti|khan global|physics wallah|pw |"
    r"dd india|dhyeya|upsc wallah)",
    re.I,
)
# established English / Hindi news channels. Videos are only taken from these, TRUSTED (UPSC and official)
# channels and the library: random uploaders re-post titles and real-estate ads match "World Tourism Day".
NATIONAL_NEWS = re.compile(
    r"(wion|ndtv|india today|hindustan times|\bmint\b|livemint|theprint|firstpost|cnn[- ]?news18|\bnews18\b|"
    r"\bani\b|times now|mirror now|business standard|business today|newsx|economic times|\bet now|moneycontrol|"
    r"aaj tak|zee news|zee business|abp news|abp live|india tv|tv9 bharatvarsh|republic|the hindu|indian express|"
    r"the logical indian|the quint|\bscroll\b|the wire|down to earth|mongabay|cnbc[- ]?tv18|ndtv profit|"
    r"bloomberg|reuters|\bbbc\b|al jazeera|dw news|france 24|lok sabha tv|rajya sabha tv)", re.I)
DAILY_ANALYSIS = re.compile(
    r"(current affairs|news analysis|newspaper analysis|the hindu|editorial analysis|pib|daily news|"
    r"perspective|big picture|in depth|desh deshantar|news simplified|dns|daily dose|mains answer|"
    r"करेंट अफेयर्स|समसामयिकी|द हिंदू|न्यूज़ एनालिसिस)",
    re.I,
)
# ── language: Hindi or English only (UPSC_VIDEO_LANG, default "en,hi") ──
DEVANAGARI = re.compile("[\u0900-\u097F]")
OTHER_SCRIPTS = re.compile("[\u0980-\u0DFF\u0600-\u06FF]")  # Bengali … Sinhala, Arabic/Urdu
_LANGS = r"(malayalam|tamil|telugu|kannada|bangla|bengali|marathi|gujarati|odia|oriya|punjabi|assamese|urdu|sinhala|nepali)"
OTHER_LANGUAGE = re.compile(
    rf"(\b(in|explained in)\s+{_LANGS}\b|\b{_LANGS}\s+(news|explanation|explained|class|lecture|video|current affairs|"
    rf"analysis)\b|[|(\[]\s*{_LANGS}\s*[|)\]])", re.I)
# a channel named after another language or a region publishes in that language ("Mission IAS Malayalam",
# "News18 Bangla", "DD NEWS Telangana"); titles can't use this test (a Tamil Nadu story names Tamil Nadu)
REGIONAL_CHANNEL = re.compile(
    rf"(\b{_LANGS}\b|\b(telangana|andhra|kerala|karnataka|assam|odisha|sahyadri|lanka|tamizh|keralam)\b)", re.I)
HINDI = re.compile(r"(\bhindi\b|हिंदी|हिन्दी|\b(kya|kyun|kyon|kaise|samjhiye|jaaniye|puri jankari)\b)", re.I)
HINDI_CHANNEL = re.compile(r"(\bhindi\b|aaj tak|zee news|abp news|news18 india|dhyeya|upsc wallah|sanskriti|khan global)", re.I)
NON_NEWS = re.compile(
    r"(vlog|boat rid|riding|\btrip\b|travel|tour guide|trek|hotel|resort|recipe|#shorts|\bshorts\b|prank|reaction|"
    r"\bsong\b|status video|full movie|mcqs?\b|quiz|mock test|expected paper|\bssc\b|\bcgl\b|gk bits|"
    r"admission|\bfees\b|eligibility|share price|\bstocks?\b|\bipo\b|sensex|nifty|\bbba\b|ipmat|"
    r"\bjee\b|\bneet\b)",
    re.I,
)
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
one two three four five six seven eight nine ten first second third extend extends extended working allows
allowed seeks says said amid over after new take takes looks set sets hold holds held
""".split())
SHORTS = re.compile(r"(#shorts|\bshorts?\b|in \d+ (sec|seconds)\b|\d+ ?sec(ond)? (explainer|video))", re.I)  # not explainers
ACCEPT = 0.9
RETRY_AFTER = timedelta(hours=3)
MAX_SEARCHES_PER_RUN = 150


def allowed_langs(setting: str | None) -> set[str]:
    s = (setting or "en,hi").lower()
    return {"en", "hi", "other"} if s == "any" else {x.strip() for x in s.split(",") if x.strip()}


def video_language(title: str, channel: str = "", hint: str | None = None) -> str:
    """en / hi / other. Other languages are recognised by script, by an explicit mention in the title,
    or by a channel named after a language or a region; library channels carry a lang hint."""
    title, channel = title or "", channel or ""
    if OTHER_SCRIPTS.search(title) or REGIONAL_CHANNEL.search(channel) or OTHER_LANGUAGE.search(title):
        return "other"
    if hint in ("en", "hi"):
        return hint
    if DEVANAGARI.search(title) or HINDI.search(title) or HINDI_CHANNEL.search(channel):
        return "hi"
    return "en"


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
        "id": vid, "channel": src.get("name"), "channel_id": src.get("id"), "title": raw.title, "lang": src.get("lang"),
        "url": f"https://www.youtube.com/watch?v={vid}", "published_at": iso(published),
        "date_ist": ist_date(published), "tokens": title_tokens(raw.title), "trusted": 1,
        "source": "feed", "seen_at": iso(utcnow()),
    }


# ── scoring ──
def _clean_title(title: str) -> str:
    return re.sub(r"\s*[|:–-]\s*(explained|upsc|live|watch).*$", "", fold(title or ""), flags=re.I).strip()


def queries(story: dict, idf: dict[str, float] | None = None) -> list[str]:
    """Search queries, most specific first: AI's query, the story's rarest words (by the same IDF
    weighting the matcher scores with), the distinctive terms, then the plain headline."""
    out: list[str] = []
    ai = story.get("ai") or {}
    if ai.get("video_query"):
        out.append(ai["video_query"])
    title = _clean_title(story["title"])
    words = re.findall(r"[A-Za-z][A-Za-z0-9\-']*", title)
    if idf:
        top = set(sorted(_topic_tokens(title), key=lambda t: -idf.get(t, max(idf.values())))[:5])
        rare: list[str] = []
        for w in words:
            if set(title_tokens(w)) & top and w.lower() not in (x.lower() for x in rare):
                rare.append(w)
        if len(rare) >= 2:
            out.append(" ".join(rare[:6]))
    keys = key_tokens(title)
    distinct = [w for w in words if w.lower().strip("'") in keys or (w.isupper() and len(w) >= 3)]
    if len(distinct) >= 2:
        out.append(" ".join(distinct[:6]))
    plain = " ".join(w for w in words if w.lower() not in GENERIC)[:90]
    if plain and plain not in out:
        out.append(plain)
    return list(dict.fromkeys(out))[:2] or [title]


def _query(story: dict) -> str:
    return queries(story)[0]


def _acronyms(text: str) -> set[str]:
    return {w.lower() for w in re.findall(r"\b[A-Z][A-Z0-9]{2,}\b", fold(text or "")) if not w.isdigit()}


def _topic_tokens(text: str) -> set[str]:
    return {t for t in title_tokens(text) if t not in GENERIC and not re.fullmatch(r"(19|20)\d\d|\d{1,2}", t)}


def score_video(story: dict, title: str, channel: str, published: datetime | None, lang: str = "en,hi",
                idf: dict[str, float] | None = None, hint: str | None = None, known: bool = False) -> float:
    """hint: the video's language when already known; known: the channel is one of our library channels."""
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
    if video_language(title, channel, hint) not in allowed_langs(lang):
        return 0.0  # Hindi or English only by default (UPSC_VIDEO_LANG)
    if SHORTS.search(title):
        return 0.0
    if TRUSTED.search(channel or "") or known:
        score += 0.25
    elif not NATIONAL_NEWS.search(channel or ""):
        return 0.0  # unknown channel
    if BULLETIN.search(title):
        score -= 0.5
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
        sc = score_video(story, c["title"], c["channel"], c.get("published"), lang, idf, c.get("lang"), c.get("known", False))
        if sc > best_score:
            best, best_score = c, sc
    return best_score, best


def _best_by_lang(story: dict, cands: list[dict], lang: str, idf: dict | None) -> dict[str, tuple[float, dict]]:
    """Best candidate per language (en / hi) at or above the acceptance score."""
    out: dict[str, tuple[float, dict]] = {}
    for c in cands:
        sc = score_video(story, c["title"], c["channel"], c.get("published"), lang, idf, c.get("lang"), c.get("known", False))
        if sc < ACCEPT:
            continue
        vl = video_language(c["title"], c["channel"], c.get("lang"))
        if sc > out.get(vl, (0.0, None))[0]:
            out[vl] = (sc, c)
    return out


def _as_video(c: dict, how: str, score: float) -> dict:
    return {"id": c["id"], "url": f"https://www.youtube.com/watch?v={c['id']}", "title": c["title"],
            "channel": c["channel"], "published": iso(c["published"]) if c.get("published") else None,
            "match": how, "score": score, "lang": video_language(c["title"], c["channel"], c.get("lang")),
            "known": bool(c.get("known"))}


def _still_good(story: dict, v: dict | None, want: str, lang: str, idf: dict) -> bool:
    """A stored match survives only if it still passes today's (stricter) rules and language."""
    if not v or not v.get("id"):
        return False
    pub = datetime.fromisoformat(v["published"]) if v.get("published") else None
    return (score_video(story, v.get("title", ""), v.get("channel", ""), pub, lang, idf, v.get("lang"),
                        bool(v.get("known"))) >= ACCEPT
            and video_language(v.get("title", ""), v.get("channel", ""), v.get("lang")) == want)


def link_brief_videos(settings: Settings, db: DB, days: list[str]) -> dict:
    """For each brief story of the given days, find the best English video and the best Hindi one
    (each only when confident); otherwise the card offers a YouTube search."""
    if not days:
        return {"linked": 0}
    rows = db.q(
        f"SELECT s.id, s.title, s.date_ist, s.tokens, s.ai, s.video, s.video_hi, s.video_checked_at FROM brief_picks b "
        f"JOIN stories s ON s.id=b.story_id WHERE b.date_ist IN ({','.join('?' * len(days))}) ORDER BY b.kind, b.rank",
        days,
    )
    lo = (date.fromisoformat(min(days)) - timedelta(days=2)).isoformat()
    hi = (date.fromisoformat(max(days)) + timedelta(days=4)).isoformat()
    library = [{"id": v["id"], "title": v["title"], "channel": v["channel"], "lang": v.get("lang"), "known": True,
                "published": datetime.fromisoformat(v["published_at"]) if v.get("published_at") else None}
               for v in db.videos_between(lo, hi)]
    langs = allowed_langs(settings.video_lang)
    wanted = [x for x in ("en", "hi") if x in langs]
    # a library channel's language tag also applies when that channel turns up in a search
    hints = {(v["channel"] or "").lower(): v["lang"] for v in library if v.get("lang")}
    library_channels = {(v["channel"] or "").lower() for v in library}
    http = Http(timeout=settings.http_timeout, retries=1)
    idf = build_idf(db)
    now = utcnow()
    searches = linked = linked_hi = 0

    def search(q: str) -> tuple[list[dict], str]:
        nonlocal searches
        searches += 1
        if settings.youtube_api_key:
            since = datetime.fromisoformat(story["date_ist"]).replace(tzinfo=IST) - timedelta(days=2)
            return search_api(http, settings.youtube_api_key, q, since), "youtube-api"
        res = search_page(http, q)
        time.sleep(1.0)
        return res, "youtube-search"

    try:
        for r in rows:
            story = {"id": r["id"], "title": r["title"], "date_ist": r["date_ist"],
                     "tokens": json.loads(r["tokens"] or "[]"), "ai": json.loads(r["ai"]) if r["ai"] else None}
            stored = {"en": json.loads(r["video"]) if r["video"] else None,
                      "hi": json.loads(r["video_hi"]) if r["video_hi"] else None}
            have = {k: stored[k] for k in wanted if _still_good(story, stored[k], k, settings.video_lang, idf)}
            if have.get("en") and have.get("hi") and have["en"]["id"] == have["hi"]["id"]:
                have.pop("en")  # one video, one language (the stored Hindi pick came from the channel's tag)
            recently = r["video_checked_at"] and now - datetime.fromisoformat(r["video_checked_at"]) < RETRY_AFTER
            if len(have) == len(wanted) or (recently and all(stored[k] == have.get(k) for k in wanted if stored[k] and stored[k].get("id"))):
                continue
            qs = queries(story, idf)
            found = {k: (v.get("score", ACCEPT), v, v.get("match", "stored")) for k, v in have.items()}
            for k, (sc, c) in _best_by_lang(story, library, settings.video_lang, idf).items():
                if k in wanted and sc > found.get(k, (0.0,))[0]:
                    found[k] = (sc, c, "library")
            plan = [(q, None) for q in qs] + [(qs[0] + " UPSC", "trusted")]
            if "hi" in wanted:
                plan.append((qs[0] + " UPSC Hindi", None))
            for q, only in plan:
                if all(k in found for k in wanted) or searches >= MAX_SEARCHES_PER_RUN or not settings.video_search:
                    break
                if only is None and q.endswith(" UPSC Hindi") and "hi" in found:
                    continue
                try:
                    cands, via = search(q)
                except Exception as exc:  # search is best-effort
                    log.info("video search failed for %s: %s", r["id"], exc)
                    break
                for c in cands:
                    c["lang"] = hints.get((c.get("channel") or "").lower())
                    c["known"] = (c.get("channel") or "").lower() in library_channels
                if only == "trusted":
                    cands = [c for c in cands if TRUSTED.search(c.get("channel") or "") or c["lang"]]
                for k, (sc, c) in _best_by_lang(story, cands, settings.video_lang, idf).items():
                    if k in wanted and sc > found.get(k, (0.0,))[0]:
                        found[k] = (sc, c, via)
            if "en" in found and "hi" in found and found["en"][1]["id"] == found["hi"][1]["id"]:
                keep = found["en"][1].get("lang") or "hi"  # one video, one language: trust the channel's tag
                found.pop("en" if keep == "hi" else "hi")
            video = None
            if "en" in found:
                sc, c, how = found["en"]
                video = c if c.get("url") and c.get("match") else _as_video(c, how, sc)
                linked += 1
            video_hi = None
            if "hi" in found:
                sc, c, how = found["hi"]
                video_hi = c if c.get("url") and c.get("match") else _as_video(c, how, sc)
                linked_hi += 1
            if video is None and video_hi is None:
                video = {"search_url": f"https://www.youtube.com/results?search_query={quote_plus(qs[0])}",
                         "query": qs[0]}
            db.set_story_video(r["id"], video, iso(now), video_hi)
    finally:
        http.close()
    db.commit()
    return {"linked": linked, "linked_hi": linked_hi, "searches": searches}


def daily_videos(db: DB, date_from: str, date_to: str, limit_per_day: int = 12,
                 lang: str = "en,hi") -> dict[str, list[dict]]:
    """Current-affairs analysis videos from the library channels (Hindi / English), grouped by day."""
    out: dict[str, list[dict]] = {}
    ok = allowed_langs(lang)
    for v in db.videos_between(date_from, date_to):
        if not DAILY_ANALYSIS.search(v["title"] or ""):
            continue
        if video_language(v["title"] or "", v["channel"] or "", v.get("lang")) not in ok:
            continue
        day = out.setdefault(v["date_ist"], [])
        if len(day) < limit_per_day:
            day.append({"id": v["id"], "url": v["url"], "title": v["title"], "channel": v["channel"],
                        "published": v["published_at"]})
    return out

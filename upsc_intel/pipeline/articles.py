"""Free full text for the Daily Brief's cards, read at build time.

For each card (Must-know, Prelims facts, editorials, explainers) of the given days that has no text yet:
1. its own outlet's page, when that site is free to read (config/topics.yaml → free_reading);
2. otherwise the same story on a free site, found through Bing News RSS (headline first, then key terms)
   and taken only when the page really is the same story.
Subscriber-only and metered sites are never requested, so no paywall is bypassed. The page's main text is
kept with its key points, which the day file carries for the cards, the Ask bot, the PDF and the practice
questions. This mirrors web/static/intel-core.js (gather, mainText, summarize), which does the same in the
browser for stories the build hasn't read.
"""
from __future__ import annotations

import json
import logging
import math
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, quote_plus, urlsplit

import feedparser
from bs4 import BeautifulSoup

from ..db import DB, iso, utcnow
from ..fetchers.http import Http

log = logging.getLogger("upsc_intel.articles")

MAX_PER_RUN = 40       # stories read per build (a build runs every ~20 minutes)
WORKERS = 6
MISS_RETRY_H = 6       # a story with no free copy is tried again after this many hours
MAX_PARAS = 40
MAX_CHARS = 12000
POINTS = 8

# ─────────────────────────── text (same rules as intel-core.js) ───────────────────────────
STOPW = set(("a an the of in on at to for and or is are was were be been by with from as that this it its into about what "
             "which who whom whose when where why how do does did can could should would will shall may might me my we our you your tell give "
             "show explain please more some any all story news article say says said there their them they he she his her has have had not").split())


def stem(w: str) -> str:
    return w[:5] if len(w) > 5 else w


def words(t: str) -> list[str]:
    seen: dict[str, None] = {}
    for w in re.findall(r"[a-z0-9\u0900-\u097f]+", str(t or "").lower()):
        if len(w) > 1 and w not in STOPW:
            seen.setdefault(stem(w), None)
    return list(seen)


ABBR = re.compile(r"\b(Mr|Mrs|Ms|Dr|St|No|Nos|Rs|Sr|Jr|vs|Prof|Gen|Lt|Col|Capt|Govt|Dept|Hon|Rev|Sh|Smt|Art|Sec|Ch|Vol|approx|[A-Z])\.(?= )")
SENT = re.compile(r"(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+(?=\s|$)|$)")


def sentences_of(t: str) -> list[str]:
    """A sentence ends at . ! or ? followed by a space, so "886.7 sq km" and "Dr. Singh" stay whole."""
    x = ABBR.sub("\\1\u2024", re.sub(r"\s+", " ", str(t or "")))
    return [s.replace("\u2024", ".").strip() for s in SENT.findall(x) if len(s.strip()) > 30]


FURNITURE = re.compile(r"^(source\s*:|upsc syllabus|syllabus\s*:|the post\b.*\b(appeared first|has been created)|read more|also read|"
                       r"click here|subscribe)|has been created based on|appeared first on", re.I)
BOILER = re.compile(r"^(advertisement|also read|read more|read also|follow us|subscribe|sign in|log ?in|download|click here|share|"
                    r"trending|related|©|copyright|all rights reserved|terms|privacy|visitor counter|release id|posted on|"
                    r"reported by|last updated|published on|read time|how may i help|show full article|track latest news)", re.I)


# "Also Read | India, others at risk …" run into the text of a JSON-LD body
INLINE_FURNITURE = re.compile(r"\b(Also Read|Read More|Also Watch|Read Also|ALSO READ)\s*[|:]\s*[^.!?\n]{0,160}?(?=[A-Z][a-z]+ [a-z]|\n|$)")


def is_teaser(t: str) -> bool:
    """A "trending" teaser: a headline run into another story's dateline, or a quoted headline cut off."""
    return bool(re.search(r"\S\s+[A-Z]{4,}(?:[ -][A-Z]{2,})*:\s", t[1:])) or (
        bool(re.match(r"^[‘'\"“]", t)) and bool(re.search(r"(\.\.\.|…)$", t)))


# ─────────────────────────── free sites ───────────────────────────
class FreeReading:
    def __init__(self, topics: dict):
        cfg = topics.get("free_reading") or {}
        self.domains = [str(d).lower() for d in cfg.get("domains") or []]
        self.premium = re.compile(cfg.get("premium_path") or r"$^", re.I)

    @staticmethod
    def domain(url: str) -> str:
        try:
            return (urlsplit(url).hostname or "").lower().removeprefix("www.")
        except ValueError:
            return ""

    def is_open(self, url: str) -> bool:
        d = self.domain(url)
        if not d or self.premium.search(url) or re.search(r"(^|\.)news\.google\.", d):
            return False
        return any(d == x or d.endswith("." + x) for x in self.domains)


# ─────────────────────────── a page's main text ───────────────────────────
def _ld_body(soup: BeautifulSoup) -> str:
    """articleBody from the page's JSON-LD (most news sites publish it), or ""."""
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or tag.get_text() or "")
        except (ValueError, TypeError):
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            d = stack.pop()
            if isinstance(d, list):
                stack.extend(d)
            elif isinstance(d, dict):
                body = d.get("articleBody")
                if isinstance(body, str) and len(body) >= 400:
                    return body
                stack.extend(v for v in d.values() if isinstance(v, (list, dict)))
    return ""


def main_text(html: str) -> list[str]:
    """The article's paragraphs: JSON-LD articleBody when the page has one, else the densest run of prose
    paragraphs (few links, sentence-shaped), minus furniture, menus, "related stories" and teasers."""
    soup = BeautifulSoup(html, "html.parser")
    body = _ld_body(soup)
    if body:
        body = BeautifulSoup(body, "html.parser").get_text(" ") if "<" in body else body
        body = re.sub(r"([a-z0-9%)][.!?][\"”’]?)([A-Z])", r"\1 \2", body)  # "Moscow.The Senate" → two sentences
        body = INLINE_FURNITURE.sub(" ", body)
        paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n|\r\n|\n", body)]
        paras = [p for p in paras if len(p.split()) >= 8 and not FURNITURE.search(p) and not BOILER.match(p)]
        if len(paras) <= 2 and len(body) > 1200:  # one long block: split it into ~3-sentence paragraphs
            sents = sentences_of(body)
            paras = [" ".join(sents[i:i + 3]) for i in range(0, len(sents), 3)]
        if paras:
            return paras[:MAX_PARAS]
    for t in soup(["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "figure", "iframe", "svg"]):
        t.decompose()
    kept = []
    for i, el in enumerate(soup.find_all(["p", "li", "blockquote", "h2", "h3"])):
        if el.name in ("h2", "h3"):
            continue
        t = re.sub(r"\s+", " ", el.get_text(" ")).strip()
        if not t or FURNITURE.search(t) or BOILER.match(t) or is_teaser(t):
            continue
        n = len(t.split())
        link_words = sum(len(a.get_text(" ").split()) for a in el.find_all("a"))
        if link_words * 2 > n:  # mostly links: navigation, "related stories"
            continue
        sentence = bool(re.search(r"[.!?\"”’)]$", t))
        if (n >= 14 and (sentence or n >= 28)) or (el.name == "li" and n >= 8 and sentence):
            kept.append((i, t, n))
    runs: list[list[tuple]] = []
    for k in kept:
        if runs and k[0] - runs[-1][-1][0] <= 4:
            runs[-1].append(k)
        else:
            runs.append([k])
    best = max(runs, key=lambda r: sum(x[2] for x in r), default=[])
    return [x[1] for x in best][:MAX_PARAS]


COMMON = {"gover", "state", "minis", "centr", "india", "offic", "peopl", "year", "years", "month", "today", "new"}


def trim_edges(paras: list[str], story_words: set[str]) -> list[str]:
    """Drops opening paragraphs that share next to nothing with the story (a widget above the article)."""
    sw = story_words - COMMON
    out = list(paras)
    while len(out) > 2 and len([w for w in words(out[0]) if w in sw]) < 2:
        out.pop(0)
    return out


# ─────────────────────────── key points ───────────────────────────
# An editorial opens with a hook (an anecdote, a quote, a scene) and argues later: its points are the sentences
# that argue (should, must, needs to, the case for…), with a lift for the closing paragraphs.
ARGUE = re.compile(r"\b(should|must|need(s|ed)? to|ought to|has to|have to|the case for|it is time|instead|however|therefore|"
                   r"thus|imperative|crucial|way forward|lesson|reform|policy|risks?|challenge|priority|balance)\b", re.I)
ANECDOTE = re.compile(r"\b(I|we|my|our|once upon|years ago|remember|recall(s|ed)?|story goes|was sold|in (18|19)\d\d)\b")


def summarize(sents: list[str], n: int = POINTS, editorial: bool = False) -> list[str]:
    """The sentences carrying the text's most repeated, most specific words: news gets a lift for the lead
    (it puts the facts first), an editorial for argument and its conclusion. Document order is kept."""
    docs = [words(s) for s in sents]
    df: dict[str, int] = {}
    for ws in docs:
        for w in ws:
            df[w] = df.get(w, 0) + 1
    N = len(sents) or 1
    scored = []
    for i, ws in enumerate(docs):
        if len(ws) < 4:
            continue
        sc = sum(math.log(1 + N / df[w]) * (1.4 if df[w] > 1 else 1) for w in ws) / math.sqrt(len(ws))
        if editorial:
            pos = i / N
            sc *= (1.3 if ARGUE.search(sents[i]) else 1) * (0.55 if pos < 0.15 else 1.2 if pos > 0.7 else 1)
            sc *= 0.6 if ANECDOTE.search(sents[i]) else 1
        else:
            sc *= 1.5 if i < 2 else 1.15 if i < 6 else 1
        scored.append((sc, i))
    scored.sort(reverse=True)
    picked: list[int] = []
    for sc, i in scored:
        if len(picked) >= n or not sc:
            break
        a = set(docs[i])
        if any(len(a & set(docs[p])) / (min(len(a), len(docs[p])) or 1) > 0.6 for p in picked):
            continue
        picked.append(i)
    return [sents[i] for i in sorted(picked)]


# ─────────────────────────── finding a free copy ───────────────────────────
GENERIC = set(("minister ministry government govt union centre center state states india indian national new says said opinion "
               "editorial analysis explained explainer express tribune hindu mint civilsdaily forumias upsc prelims mains however "
               "also while after before amid why how what don can will day today year years week month").split())


def search_query(title: str, n: int = 8) -> str:
    toks = re.findall(r"[^\W_][\w'’-]*", str(title))
    return " ".join([w for w in toks if w.lower() not in STOPW
                     and not re.match(r"^(says?|said|amid|over|after|new|its|his|her)$", w, re.I)][:n])


def key_query(title: str, publishers: list[str]) -> str:
    """The headline's names, acronyms and figures, then its longest words: 3-5 terms other outlets repeat."""
    pubs = {w for p in publishers for w in words(p)}
    terms: list[str] = []

    def ok(w: str) -> bool:
        k = w.lower()
        return len(k) > 1 and k not in STOPW and k not in GENERIC and stem(k) not in pubs and k not in {t.lower() for t in terms}

    toks = [re.sub(r"['’]s$", "", re.sub(r"^[^\w]+|[^\w%]+$", "", t)) for t in title.split()]
    toks = [t for t in toks if t]
    title_case = sum(1 for t in toks if t[:1].isupper()) > len(toks) * 0.6
    for i, w in enumerate(toks):
        acronym = bool(re.match(r"^[A-Z][A-Z0-9-]+$", w))
        name = not title_case and i > 0 and bool(re.match(r"^[A-Z][a-z]", w))
        figure = bool(re.match(r"^\d[\d.,]*%?$", w)) and (len(w) >= 3 or w.endswith("%"))
        if (acronym or name or figure) and ok(w) and len(terms) < 5:
            terms.append(w)
    for w in sorted([t for t in toks if re.match(r"^[^\W\d_][\w-]{3,}$", t) and ok(t)], key=len, reverse=True):
        if len(terms) >= 3:
            break
        if ok(w):
            terms.append(w)
    return " ".join(terms[:5])


def search_news(http: Http, q: str) -> list[dict]:
    """Bing News RSS (no key) → [{title, url, snippet, date}] (date: YYYY-MM-DD in UTC, or "")."""
    feed = f"https://www.bing.com/news/search?q={quote_plus(q)}&format=rss&setlang=en-IN&cc=IN"
    parsed = feedparser.parse(http.get(feed).content)
    out = []
    for e in parsed.entries[:15]:
        url = e.get("link") or ""
        target = parse_qs(urlsplit(url).query).get("url")
        if target:
            url = target[0]
        pp = e.get("published_parsed")
        out.append({"title": e.get("title") or "", "url": url, "date": f"{pp.tm_year:04d}-{pp.tm_mon:02d}-{pp.tm_mday:02d}" if pp else "",
                    "snippet": BeautifulSoup(e.get("summary") or "", "html.parser").get_text(" ")})
    return out


def match_of(hit: dict, tw: list[str]) -> float:
    hw = set(words(f"{hit['title']} {hit['snippet']}"))
    shared = sum(1 for w in tw if w in hw)
    return shared / (len(tw) or 1) if shared >= 2 else 0.0


NEAR_DAYS = 2           # a free copy is the same event only if it was published within this many days
MATCH_NEWS = 0.5        # share of the headline's words a search hit must repeat
MATCH_OPINION = 0.75    # an editorial or explainer is one piece: only a syndicated copy (near-identical headline) will do


def near_date(hit_date: str, day: str) -> bool:
    if not hit_date or not day:
        return True
    try:
        return abs((datetime.fromisoformat(hit_date) - datetime.fromisoformat(day)).days) <= NEAR_DAYS
    except ValueError:
        return True


def same_story(paras: list[str], tw: list[str]) -> bool:
    pw = set(words(" ".join(paras)))
    return sum(1 for w in tw if w in pw) / (len(tw) or 1) >= 0.5


# MSN carries licensed, free-to-read copies of Indian outlets' stories (India Today, HT, PTI…). Its pages load
# the text from a public content API, which is read only when the item has no subscription or rendering
# restriction. The API only answers msn.com pages in a browser, so only the build reads it.
MSN_ID = re.compile(r"(?:^|\.)msn\.com/.+/ar-([A-Za-z0-9]+)")


def is_syndicated(url: str) -> bool:
    return bool(MSN_ID.search(url.split("://", 1)[-1]))


def read_msn(http: Http, fr: FreeReading, url: str) -> tuple[list[str], str]:
    """→ (paragraphs, the original outlet's URL when it is free to read, else the MSN URL)."""
    aid = MSN_ID.search(url.split("://", 1)[-1]).group(1)
    j = http.get(f"https://assets.msn.com/content/view/v2/Detail/en-in/{aid}").json()
    if j.get("subscriptionProductType") or j.get("renderingRestriction"):
        raise ValueError("subscriber-only on MSN")
    body = BeautifulSoup(j.get("body") or "", "html.parser")
    paras = [re.sub(r"\s+", " ", p.get_text(" ")).strip() for p in body.find_all("p")]
    paras = [p for p in paras if len(p.split()) >= 8 and not FURNITURE.search(p) and not BOILER.match(p)]
    src = j.get("sourceHref") or ""
    return paras[:MAX_PARAS], (src if src and fr.is_open(src) else url)


def read_page(http: Http, fr: FreeReading, url: str) -> tuple[list[str], str]:
    """→ (paragraphs, the URL to cite)."""
    if is_syndicated(url):
        return read_msn(http, fr, url)
    if not fr.is_open(url):  # never request a subscriber-only or unknown site
        raise ValueError(f"not on the free-to-read list: {fr.domain(url)}")
    resp = http.get(url)
    if not fr.is_open(str(resp.url)):  # redirected off the free list (a login wall, a premium path)
        raise ValueError(f"redirected to {fr.domain(str(resp.url))}")
    return main_text(resp.text), url


def read_story(http: Http, fr: FreeReading, story: dict) -> dict | None:
    """story: {title, summary, date, editorial, opinion, sources: [{u, p}]} → {url, domain, via, paragraphs, points}
    or None. opinion (an editorial or explainer): a free copy must carry a near-identical headline."""
    tw = words(story["title"])
    sw = set(words(f"{story['title']} {story.get('summary') or ''}"))
    tried: set[str] = set()

    def keep(url: str, paras: list[str], via: str) -> dict | None:
        paras = trim_edges(paras, sw)
        text = []
        total = 0
        for p in paras:
            if total + len(p) > MAX_CHARS:
                break
            text.append(p)
            total += len(p)
        sents = [s for p in text for s in sentences_of(p) if not FURNITURE.search(s)]
        if len(sents) < 3:
            return None
        return {"url": url, "domain": fr.domain(url), "via": via, "paragraphs": text,
                "points": summarize(sents, POINTS, editorial=bool(story.get("editorial")))}

    for u in [s["u"] for s in story.get("sources") or [] if s.get("u") and fr.is_open(s["u"])][:3]:
        tried.add(u)
        try:
            paras, cite = read_page(http, fr, u)
            got = keep(cite, paras, "")
            if got:
                return got
        except Exception as exc:  # one outlet failing is normal: try the next
            log.debug("read %s: %s", u, exc)
    queries = list(dict.fromkeys(q for q in (search_query(story["title"]),
                                             key_query(story["title"], [s.get("p") or "" for s in story.get("sources") or []])) if q))
    hits: list[dict] = []
    for q in queries:
        try:
            for h in search_news(http, q):
                if not any(x["url"] == h["url"] for x in hits):
                    hits.append({**h, "match": match_of(h, tw)})
        except Exception as exc:
            log.debug("search %r: %s", q, exc)
            continue
        hits.sort(key=lambda h: -h["match"])
        bar = MATCH_OPINION if story.get("opinion") else MATCH_NEWS
        for h in [x for x in hits if x["match"] >= bar and near_date(x.get("date", ""), story.get("date", ""))
                  and (fr.is_open(x["url"]) or is_syndicated(x["url"])) and x["url"] not in tried][:2]:
            if len(tried) >= 5:
                break
            tried.add(h["url"])
            try:
                paras, cite = read_page(http, fr, h["url"])
                if same_story(paras, tw):
                    got = keep(cite, paras, "search")
                    if got:
                        return got
            except Exception as exc:
                log.debug("read %s: %s", h["url"], exc)
    return None


# ─────────────────────────── the build step ───────────────────────────
def _candidates(db: DB, days: list[str]) -> list[dict]:
    if not days:
        return []
    rows = db.q(
        "SELECT b.story_id, b.date_ist, b.kind, COALESCE(b.tier, 'top') AS tier, s.title, s.summary, s.is_editorial FROM brief_picks b "
        f"JOIN stories s ON s.id = b.story_id WHERE b.date_ist IN ({','.join('?' * len(days))}) AND b.lead IS NULL "
        "AND (b.kind != 'news' OR COALESCE(b.tier, 'top') IN ('top', 'prelims')) "
        "ORDER BY b.date_ist DESC, (b.kind = 'news') DESC, (COALESCE(b.tier, 'top') = 'top') DESC, b.rank", days)
    have = db.articles([r["story_id"] for r in rows])
    retry = (utcnow() - timedelta(hours=MISS_RETRY_H)).isoformat()
    out = []
    for r in rows:
        a = have.get(r["story_id"])
        if a and (not a["miss"] or (a["fetched_at"] or "") > retry):
            continue
        out.append({"id": r["story_id"], "title": r["title"] or "", "summary": r["summary"] or "", "date": r["date_ist"],
                    "editorial": bool(r["is_editorial"]), "opinion": r["kind"] != "news"})
    return out


def read_brief_articles(db: DB, topics: dict, days: list[str], limit: int = MAX_PER_RUN,
                        http: Http | None = None) -> dict:
    """Reads the free full text of the given days' brief cards that don't have it yet."""
    fr = FreeReading(topics)
    todo = _candidates(db, days)[:limit]
    if not todo:
        return {"read": 0, "missed": 0}
    for st in todo:
        st["sources"] = [{"u": r["url"], "p": r["publisher"] or ""} for r in db.q(
            "SELECT url, publisher FROM items WHERE story_id=? AND is_private=0 ORDER BY tier='official' DESC", (st["id"],))]
    own = http is None
    http = http or Http(timeout=15, retries=1)
    try:
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            results = list(ex.map(lambda st: (st, _safe_read(http, fr, st)), todo))
    finally:
        if own:
            http.close()
    now = iso(datetime.now(timezone.utc))
    n_read = 0
    for st, got in results:
        if got:
            n_read += 1
            db.save_article(st["id"], {**got, "fetched_at": now})
        else:
            db.save_article(st["id"], {"miss": True, "fetched_at": now})
    db.commit()
    return {"read": n_read, "missed": len(results) - n_read}


def _safe_read(http: Http, fr: FreeReading, story: dict) -> dict | None:
    try:
        return read_story(http, fr, story)
    except Exception:  # one story never stops the rest
        log.exception("reading %s failed", story["id"])
        return None

"""Text, URL and date normalisation shared by fetchers and the pipeline."""
from __future__ import annotations

import hashlib
import html
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup

IST = timezone(timedelta(hours=5, minutes=30), name="IST")

_WS = re.compile(r"\s+")
_TRACKING = re.compile(
    r"^(utm_[a-z]+|fbclid|gclid|dclid|mc_cid|mc_eid|_gl|ref|ref_src|cmp|ito|s_cid|from|source|ncid|"
    r"campaign|pfrom|pgtype|ocid|sref|share|amp)$",
    re.I,
)


def collapse(text: str | None) -> str:
    return _WS.sub(" ", text or "").strip()


def html_to_text(value: str | None, limit: int | None = None) -> str:
    if not value:
        return ""
    if "<" in value and ">" in value:
        value = BeautifulSoup(value, "html.parser").get_text(" ", strip=True)
    text = collapse(html.unescape(value))
    if limit and len(text) > limit:
        cut = text[:limit].rsplit(" ", 1)[0]
        text = cut + "…"
    return text


def clean_title(title: str | None) -> str:
    t = collapse(html.unescape(title or ""))
    return t.strip(" -|–—")


def strip_publisher_suffix(title: str, publisher: str | None) -> str:
    """Google News titles end with ' - Publisher'."""
    if publisher and title.endswith(" - " + publisher):
        return title[: -(len(publisher) + 3)].strip()
    m = re.match(r"^(.*\S)\s+[-–|]\s+[^-–|]{2,40}$", title)
    return m.group(1) if (m and publisher is None and len(m.group(1)) > 25) else title


def canonical_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return url
    if url.startswith("/"):
        return url  # local library link, keep verbatim (incl. #page=)
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _TRACKING.match(k)]
    path = parts.path
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, urlencode(query), ""))


def make_id(*parts: str) -> str:
    return hashlib.sha1("\x1f".join(p or "" for p in parts).encode("utf-8")).hexdigest()[:20]


def ist_date(dt: datetime | None) -> str:
    return (dt or datetime.now(timezone.utc)).astimezone(IST).date().isoformat()


def today_ist() -> str:
    return datetime.now(IST).date().isoformat()


# ── tokens for clustering ──
STOPWORDS = set("""
a an the and or but if then than of in on at to for from by with without into onto over under about above below
after before during amid amidst as is are was were be been being has have had do does did will would shall should
can could may might must this that these those it its it's he she they them his her their we our you your i me my
not no nor so such too very just also only more most less least much many few some any all each every both either
neither other another same own new says said say saying tells told asks asked amid via per vs versus how why what
when where who whom which while here there today tomorrow yesterday now latest live update updates news report reports
explained explainer key top big major minor day days week year years time times first second third one two three
india india's indian indians govt government centre's out up down off again still yet ahead back set sets get gets
make makes made take takes took seek seeks seeking plan plans call calls called move moves amid hold holds held
""".split())

_TOKEN = re.compile(r"[a-z0-9]+(?:\.[0-9]+)?")


def _stem(tok: str) -> str:
    """Crude plural folding: policies→policy, taxes→tax, reserves→reserve, tigers→tiger."""
    if tok.isdigit() or len(tok) <= 3 or tok.endswith(("ss", "us", "is")):
        return tok
    if tok.endswith("ies") and len(tok) > 4:
        return tok[:-3] + "y"
    if tok.endswith(("ses", "xes", "zes", "ches", "shes")):
        return tok[:-2]
    if tok.endswith("s"):
        return tok[:-1]
    return tok


def title_tokens(title: str) -> list[str]:
    seen: dict[str, None] = {}
    for tok in _TOKEN.findall((title or "").lower().replace("’", "'")):
        if tok in STOPWORDS or (len(tok) < 2 and not tok.isdigit()):
            continue
        seen.setdefault(_stem(tok), None)
    return list(seen)


def key_tokens(title: str) -> set[str]:
    """Distinctive tokens: acronyms, numbers and capitalised words after the first."""
    out: set[str] = set()
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9.\-']*", title or "")
    for i, w in enumerate(words):
        w2 = w.strip(".-'")
        if not w2:
            continue
        if any(ch.isdigit() for ch in w2) or (w2.isupper() and len(w2) >= 2) or (i > 0 and w2[0].isupper()):
            low = _stem(w2.lower())
            if low not in STOPWORDS:
                out.add(low)
    return out


_PUB_ALIASES = {
    "thehindubusinessline": "businessline",
    "hindubusinessline": "businessline",
    "economictimesindiatimes": "economictimes",
    "etgovernment": "economictimes",
    "timesofindiaindiatimes": "timesofindia",
    "toi": "timesofindia",
    "indianexpress": "indianexpress",
    "newindianexpress": "newindianexpress",
    "hindustantimes": "hindustantimes",
    "ht": "hindustantimes",
    "livemint": "mint",
    "businessstandard": "businessstandard",
    "pressinformationbureau": "pib",
    "pibindia": "pib",
    "newsonairgovin": "allindiaradionewsonair",
    "newsonair": "allindiaradionewsonair",
}


def publisher_key(name: str | None) -> str:
    """'The Economic Times' / 'Economic Times' / 'economictimes.indiatimes.com' → one key."""
    n = (name or "").lower().strip()
    n = re.sub(r"^the\s+", "", n)
    n = re.sub(r"\.(com|in|org|net|co\.in|gov\.in)$", "", n)
    n = re.sub(r"[^a-z0-9]", "", n)
    return _PUB_ALIASES.get(n, n)

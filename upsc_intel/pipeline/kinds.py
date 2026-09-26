"""What kind of piece an item is: news, an editorial (opinion) or an explainer.

Editorials and explainers get their own brief sections and only cluster with their own kind,
so an explainer never disappears inside a news card (and a news report never hides an op-ed).

Order of evidence:
1. the source says so (`editorial: true` / `explained: true` in sources.yaml);
2. the headline says so ("UPSC Editorial Analysis: …", "… | Explained", "Mint Explainer | …");
3. the article URL says so (/opinion/, /editorials/, /columns/ · /explained/, /explainers/);
4. a question headline ("What is …?", "Why has …?") from an official, exam-prep or quality
   outlet is an explainer.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

NEWS, EDITORIAL, EXPLAINED = "news", "editorial", "explained"
KINDS = (NEWS, EDITORIAL, EXPLAINED)

EDITORIAL_TITLE = re.compile(
    r"^(upsc\s+)?(daily\s+)?editorial analysis\b|\beditorial analysis\s*[:|]|^editorial\s*[.:|]\s", re.I)
EXPLAINER_TITLE = re.compile(
    r"\|\s*explained\s*$"                  # The Hindu: "What is X? | Explained"
    r"|^explained\s*[:|]"                  # "Explained: …", Deccan Herald "Explained | …"
    r"|^(mint\s+)?explainer\s*[:|]"        # "Explainer: …", "Mint Explainer | …"
    r"|\[explainer\]"                      # Mongabay
    r"|^(an\s+)?expert explains\b"         # Indian Express
    r"|^knowledge nugget\b|^beyond trending\b"  # IE UPSC Essentials
    r"|,\s*explained\s*$|\bexplained in \d+\b"
    r"|^all you need to know\b|^decoding\b|^this week in explainers\b",
    re.I,
)
OPINION_PATH = re.compile(r"/(opinion|opinions|editorials?|columns?|op-ed|oped|edit-page|blogs)/", re.I)
EXPLAINER_PATH = re.compile(r"/(explained|explainers?|theprint-essential)/|[-_]explained(?:[-_/.]|$)", re.I)
QUESTION = re.compile(r"^(what|why|how|who|when|where|is|are|can|does|do|did|will|should|has|have)\b.{12,}\?\s*$", re.I)
QUESTION_TIERS = {"official", "examprep", "quality"}


def content_kind(src: dict, title: str, url: str = "", step_kind: str | None = None) -> str:
    if src.get("editorial"):
        return EDITORIAL
    if src.get("explained"):
        return EXPLAINED
    title = title or ""
    if EDITORIAL_TITLE.search(title):
        return EDITORIAL
    # Google News links are redirects: their path says nothing about the article
    direct = step_kind != "gnews" and "news.google." not in (url or "")
    path = urlsplit(url or "").path if direct else ""
    if path and OPINION_PATH.search(path):
        return EDITORIAL
    if EXPLAINER_TITLE.search(title) or (path and EXPLAINER_PATH.search(path)):
        return EXPLAINED
    if QUESTION.search(title) and src.get("tier") in QUESTION_TIERS:
        return EXPLAINED
    return NEWS


def item_kind(item: dict) -> str:
    """Kind of a stored item row (flags already decided at fetch time)."""
    if item.get("is_editorial"):
        return EDITORIAL
    if item.get("is_explained"):
        return EXPLAINED
    return NEWS

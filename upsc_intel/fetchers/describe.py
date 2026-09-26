"""Fill empty feed summaries from the article's public preview text (og:description).

Some feeds ship headlines only (every Indian Express section feed does), and opinion or
explainer headlines rarely name their topic. The og:description tag is the public blurb that
every link preview shows. Reading it costs one small request per *new* item, and nothing past
the page's <head> is downloaded or parsed.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from bs4 import BeautifulSoup

from ..models import RawItem
from ..pipeline.normalize import canonical_url, clean_title, html_to_text, make_id

log = logging.getLogger("upsc_intel.describe")

MAX_PER_SOURCE = 30
WORKERS = 6
META = ({"property": "og:description"}, {"name": "description"}, {"name": "twitter:description"})


def page_description(http, url: str) -> str:
    head = http.head_html(url)
    soup = BeautifulSoup(head.split("</head>", 1)[0], "html.parser")
    for attrs in META:
        tag = soup.find("meta", attrs=attrs)
        text = html_to_text(tag.get("content") or "", limit=700).strip() if tag else ""
        if len(text) >= 40:
            return text
    return ""


def describe_new(ctx, results) -> int:
    """For sources with `describe: true`, fetch preview text for new items that have none."""
    jobs: list[RawItem] = []
    for res, _state in results:
        src = res.source
        if not src.get("describe") or res.step is None or src["chain"][res.step].get("kind") == "gnews":
            continue
        cands = {}
        for raw in res.items:
            if raw.url and not (raw.summary or "").strip():
                cands[make_id(canonical_url(raw.url) or raw.guid or clean_title(raw.title))] = raw
        known = ctx.db.existing_item_ids(list(cands))
        jobs.extend([raw for iid, raw in cands.items() if iid not in known][:MAX_PER_SOURCE])
    if not jobs:
        return 0

    def work(raw: RawItem) -> int:
        try:
            raw.summary = page_description(ctx.http, raw.url)
        except Exception as exc:  # a preview is a bonus: never fail the source over it
            log.debug("no description for %s: %s", raw.url, exc)
        return int(bool(raw.summary))

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        return sum(ex.map(work, jobs))

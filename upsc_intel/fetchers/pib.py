"""PIB: the day's English release list (allRel.aspx) + the body of each new release.

The PIB RSS redirects to Hindi, so the English HTML list is the reliable primary.
Links use PressReleasePage.aspx (PressReleaseDetail.aspx often renders only chrome).
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from bs4 import BeautifulSoup

from ..models import FetchError, RawItem
from ..pipeline.normalize import IST, collapse

BASE = "https://www.pib.gov.in"
RELEASE_URL = BASE + "/PressReleasePage.aspx?PRID={prid}&reg=3&lang=1"
MAX_BODIES_PER_RUN = 60


def _selected(soup: BeautifulSoup, sel_id: str) -> int | None:
    sel = soup.find("select", id=sel_id)
    opt = sel.find("option", selected=True) if sel else None
    try:
        return int(opt["value"]) if opt else None
    except (KeyError, ValueError):
        return None


def parse_release_list(html: str) -> tuple[str | None, list[dict]]:
    """Returns (listing date YYYY-MM-DD or None, [{ministry, prid, title}])."""
    soup = BeautifulSoup(html, "html.parser")
    day, month, year = (_selected(soup, f"ContentPlaceHolder1_ddl{x}") for x in ("day", "Month", "Year"))
    listing_date = f"{year:04d}-{month:02d}-{day:02d}" if (day and month and year) else None
    area = soup.select_one(".content-area") or soup
    rows: list[dict] = []
    seen: set[str] = set()
    for h3 in area.find_all("h3"):
        ministry = collapse(h3.get_text(" ", strip=True))
        ul = h3.find_next_sibling("ul")
        if not ul:
            continue
        for a in ul.find_all("a", href=True):
            m = re.search(r"PRID=(\d+)", a["href"])
            if not m or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            title = collapse(a.get("title") or a.get_text(" ", strip=True))
            rows.append({"ministry": ministry, "prid": m.group(1), "title": title})
    return listing_date, rows


_POSTED = re.compile(r"Posted On:\s*(\d{1,2} [A-Z]{3} \d{4}\s+\d{1,2}:\d{2}\s*[AP]M)\s*by PIB\s+\w+", re.I)


def parse_release_page(html: str) -> tuple[datetime | None, str]:
    soup = BeautifulSoup(html, "html.parser")
    box = soup.select_one("div#PdfDiv") or soup.select_one("div.innner-page-main-about-us-content-right-part")
    if not box:
        return None, ""
    text = collapse(box.get_text(" ", strip=True))
    published = None
    m = _POSTED.search(text)
    if m:
        try:
            published = datetime.strptime(collapse(m.group(1)).upper(), "%d %b %Y %I:%M%p").replace(tzinfo=IST)
        except ValueError:
            published = None
        text = text[m.end():].strip()
    text = re.sub(r"\*+\s*[A-Z]{2,}/[A-Z/ .-]+$", "", text)  # trailing "***MJPS/..." signature
    return (published.astimezone(timezone.utc) if published else None), text


def fetch_pib(ctx, step: dict, src: dict) -> list[RawItem]:
    resp = ctx.http.get(step["url"])
    listing_date, rows = parse_release_list(resp.text)
    if not rows and "Press Release" not in resp.text:
        raise FetchError("PIB list page did not parse")

    new_rows = [r for r in rows if not ctx.db.seen(f"pib:{r['prid']}")][:MAX_BODIES_PER_RUN]

    def body(row: dict) -> tuple[str, datetime | None, str]:
        try:
            page = ctx.http.get(RELEASE_URL.format(prid=row["prid"]))
            published, text = parse_release_page(page.text)
            return row["prid"], published, text
        except Exception:  # body is a bonus; the headline still counts
            return row["prid"], None, ""

    bodies: dict[str, tuple[datetime | None, str]] = {}
    if new_rows:
        with ThreadPoolExecutor(max_workers=4) as ex:
            for prid, published, text in ex.map(body, new_rows):
                bodies[prid] = (published, text)

    fallback_dt = None
    if listing_date and listing_date != datetime.now(IST).date().isoformat():
        fallback_dt = datetime.fromisoformat(listing_date).replace(hour=12, tzinfo=IST).astimezone(timezone.utc)

    items: list[RawItem] = []
    for row in rows:
        published, text = bodies.get(row["prid"], (None, ""))
        items.append(RawItem(
            title=row["title"],
            url=RELEASE_URL.format(prid=row["prid"]),
            summary=(text[:900] + "…") if len(text) > 900 else text,
            content=text[:12000],
            published=published or fallback_dt,
            publisher="PIB",
            guid=f"pib:{row['prid']}",
            extra={"ministry": row["ministry"], "prid": row["prid"]},
        ))
        if row["prid"] in bodies:
            ctx.db.mark_seen(f"pib:{row['prid']}")
    return items


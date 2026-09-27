"""The brief cards' free full text (pipeline/articles.py): extraction, the free-to-read rule, free copies."""
import json
import re
from pathlib import Path

import pytest
import yaml

from upsc_intel.pipeline import articles as A

ROOT = Path(__file__).resolve().parents[1]
TOPICS = yaml.safe_load((ROOT / "config" / "topics.yaml").read_text(encoding="utf-8"))
FR = A.FreeReading(TOPICS)

ARTICLE = """<html><head><title>x</title></head><body>
<nav><ul><li><a href="/a">Home</a></li><li><a href="/b">India</a></li><li><a href="/c">World</a></li></ul></nav>
<div class="trending"><p><a href="/t1">PM inaugurates new airport terminal in Pune today</a></p></div>
<article>
<p>INS Trishul has arrived at Toulon, France, to take part in the 24th edition of the bilateral maritime exercise Varuna between the Indian Navy and the French Navy.</p>
<p>The exercise began in 1993 and was named Varuna in 2001; it has since become a hallmark of the strategic partnership between India and France at sea.</p>
<p>Also read: Navy chief visits Paris</p>
<p>This edition has a harbour phase with cross-deck visits and a sea phase with anti-submarine drills, air defence serials and replenishment at sea.</p>
<p>Officials said the drills would improve interoperability and help both navies share best practices in the Indian Ocean and the Mediterranean.</p>
</article>
<footer><p>Copyright 2026 All rights reserved by the publisher of this site and its partners worldwide.</p></footer>
</body></html>"""


class Resp:
    def __init__(self, url, text="", data=None):
        self.url, self.text, self._data = url, text, data
        self.content = text.encode()

    def json(self):
        return self._data


class FakeHttp:
    """Serves canned pages; records every URL asked for."""

    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def get(self, url, **kw):
        self.calls.append(url)
        for key, val in self.pages.items():
            if url.startswith(key):
                return val(url) if callable(val) else val
        raise RuntimeError(f"HTTP 404 {url}")


def rss(*items):
    body = "".join(f"<item><title>{t}</title><link>http://www.bing.com/news/apiclick.aspx?url={u}&amp;c=1</link>"
                   f"<description>{d}</description><pubDate>{p}</pubDate></item>" for t, u, d, p in items)
    return f'<?xml version="1.0"?><rss version="2.0"><channel><title>Bing</title>{body}</channel></rss>'


def test_free_list_matches_the_browser_bot():
    js = (ROOT / "upsc_intel" / "web" / "static" / "intel-core.js").read_text(encoding="utf-8")
    block = js[js.index("const OPEN_DOMAINS = ["):js.index("];", js.index("const OPEN_DOMAINS = ["))]
    assert re.findall(r'"([^"]+)"', block) == TOPICS["free_reading"]["domains"]
    prem = re.search(r"const PREMIUM_PATH = /(.+)/i;", js).group(1).replace("\\/", "/")
    assert prem == TOPICS["free_reading"]["premium_path"]
    assert FR.is_open("https://www.ndtv.com/india-news/x") and FR.is_open("https://pib.gov.in/PressRelease.aspx?id=1")
    assert not FR.is_open("https://www.thehindu.com/news/x") and not FR.is_open("https://indianexpress.com/article/x")
    assert not FR.is_open("https://www.hindustantimes.com/ht-premium/x")  # a premium path on a free site


def test_main_text_keeps_the_article_and_drops_furniture():
    paras = A.main_text(ARTICLE)
    assert len(paras) == 4 and paras[0].startswith("INS Trishul")
    assert not any("airport" in p or "Copyright" in p or "Also read" in p for p in paras)


def test_json_ld_body_is_split_into_sentences():
    body = ("India on Saturday told world leaders that endless war must end.The minister raised concern over the Gulf "
            "conflict and the war in Ukraine, and over attacks on shipping. " * 6)
    html = f'<html><head><script type="application/ld+json">{json.dumps({"@type": "NewsArticle", "articleBody": body})}</script></head><body></body></html>'
    paras = A.main_text(html)
    assert paras and "must end. The minister" in " ".join(paras)


def test_own_free_page_is_read_and_a_paywalled_one_never_requested():
    http = FakeHttp({"https://forumias.com/": Resp("https://forumias.com/blog/varuna/", ARTICLE)})
    story = {"title": "Exercise Varuna 2026 begins at Toulon", "date": "2026-09-26",
             "sources": [{"u": "https://www.thehindu.com/news/varuna", "p": "The Hindu"},
                         {"u": "https://forumias.com/blog/varuna/", "p": "ForumIAS"}]}
    got = A.read_story(http, FR, story)
    assert got and got["domain"] == "forumias.com" and got["via"] == "" and len(got["points"]) >= 3
    assert not any("thehindu.com" in u for u in http.calls)


def test_free_copy_must_be_the_same_event_and_recent():
    old_story = ("India ready to help end Russia-Ukraine war, Jaishankar says in Kyiv",
                 "https://www.indiatvnews.com/news/old", "Jaishankar in Kyiv", "Wed, 03 Sep 2026 10:00:00 GMT")
    same = ("Jaishankar at UN urges end to war, flags Gulf and Ukraine risks",
            "https://www.ndtv.com/world-news/jaishankar-un", "Jaishankar at the UN", "Sat, 26 Sep 2026 18:00:00 GMT")
    page = ARTICLE.replace("Varuna", "the UN debate").replace("INS Trishul has arrived at Toulon, France, to take part in",
                                                              "Jaishankar at the UN urged an end to war in the Gulf and Ukraine at")
    http = FakeHttp({"https://www.bing.com/news/search": Resp("https://www.bing.com/news/search", rss(old_story, same)),
                     "https://www.ndtv.com/": Resp("https://www.ndtv.com/world-news/jaishankar-un", page),
                     "https://www.indiatvnews.com/": Resp("https://www.indiatvnews.com/news/old", page)})
    story = {"title": same[0], "date": "2026-09-27", "sources": [{"u": "https://news.google.com/rss/articles/x", "p": "India Today"}]}
    got = A.read_story(http, FR, story)
    assert got and got["domain"] == "ndtv.com" and got["via"] == "search"
    assert not any("indiatvnews" in u for u in http.calls)  # three weeks old: another event


def test_an_editorial_is_never_swapped_for_a_news_report():
    report = ("US Senate passes Russia sanctions bill, India risks tariffs over Russian oil",
              "https://www.ndtv.com/world-news/senate", "Senate bill", "Sat, 26 Sep 2026 18:00:00 GMT")
    http = FakeHttp({"https://www.bing.com/news/search": Resp("https://www.bing.com/news/search", rss(report)),
                     "https://www.ndtv.com/": Resp("https://www.ndtv.com/world-news/senate", ARTICLE)})
    story = {"title": "Tariffs, Russian oil and the uneasy India-US relationship", "date": "2026-09-27",
             "editorial": True, "opinion": True, "sources": [{"u": "https://www.thehindu.com/opinion/x", "p": "The Hindu"}]}
    assert A.read_story(http, FR, story) is None
    assert not any("ndtv.com" in u for u in http.calls)


def test_msn_syndication_only_when_free():
    hit = ("Jaishankar at UN urges end to war, flags Gulf and Ukraine risks",
           "https://www.msn.com/en-in/news/world/jaishankar-at-un/ar-AA2d1AWE", "India Today", "Sat, 26 Sep 2026 18:00:00 GMT")
    body = "".join(f"<p>{p}</p>" for p in A.main_text(ARTICLE.replace("Varuna", "the UN General Assembly debate")))
    body = body.replace("INS Trishul has arrived at Toulon, France, to take part in", "Jaishankar at the UN urged an end to war in the Gulf and Ukraine at")
    free = {"body": body, "sourceHref": "https://www.indiatoday.in/world/story/jaishankar-unga", "subscriptionProductType": 0, "renderingRestriction": 0}
    story = {"title": hit[0], "date": "2026-09-27", "sources": []}
    http = FakeHttp({"https://www.bing.com/news/search": Resp("x", rss(hit)),
                     "https://assets.msn.com/content/view/v2/Detail/en-in/AA2d1AWE": Resp("x", data=free)})
    got = A.read_story(http, FR, story)
    assert got and got["url"] == "https://www.indiatoday.in/world/story/jaishankar-unga"  # cites the original outlet
    locked = FakeHttp({"https://www.bing.com/news/search": Resp("x", rss(hit)),
                       "https://assets.msn.com/content/view/v2/Detail/en-in/AA2d1AWE": Resp("x", data={**free, "subscriptionProductType": 2})})
    assert A.read_story(locked, FR, story) is None


def test_editorial_points_skip_the_anecdote():
    sents = ["Not much seems to have changed since the last copy of the first edition of that book was sold in 1995.",
             "India and the US remain estranged even though both still need each other in a world of power conflicts.",
             "The tariffs on Indian goods over purchases of Russian oil have strained the trade negotiations badly.",
             "New Delhi must diversify its crude imports and should keep talking trade with Washington.",
             "India needs to balance its energy security with its strategic partnership with the United States.",
             "The way forward is a limited trade deal that separates the oil question from the tariff talks."]
    pts = A.summarize(sents, 3, editorial=True)
    assert sents[0] not in pts and any("must" in p or "needs to" in p or "way forward" in p for p in pts)


def test_read_brief_articles_stores_text_and_misses(db, settings):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    for sid, url in (("s1", "https://forumias.com/blog/varuna/"), ("s2", "https://www.thehindu.com/news/x")):
        db.upsert_story({"id": sid, "title": "Exercise Varuna 2026 begins at Toulon" if sid == "s1" else "Closed story here today",
                         "url": url, "date_ist": "2026-09-26", "dates": ["2026-09-26"], "first_seen": now, "last_seen": now,
                         "updated_at": now, "n_items": 1, "n_publishers": 1, "publishers": ["x"], "subjects": ["defence"],
                         "gs": [], "tags": [], "watch": [], "score": 6, "grade": "NOTE", "is_editorial": 0, "is_explained": 0,
                         "is_library": 0, "is_private": 0, "tier": "quality", "summary": "", "tokens": []})
        db.insert_item({"id": "i" + sid, "source_id": "x", "title": "t", "url": url, "date_ist": "2026-09-26", "published_at": now,
                        "is_library": 0, "story_id": sid, "publisher": "P"})
    db.save_brief("2026-09-26", [("s1", "news", 1, "top", None), ("s2", "news", 2, "prelims", None)])
    db.commit()
    http = FakeHttp({"https://forumias.com/": Resp("https://forumias.com/blog/varuna/", ARTICLE),
                     "https://www.bing.com/news/search": Resp("x", rss())})
    assert A.read_brief_articles(db, TOPICS, ["2026-09-26"], http=http) == {"read": 1, "missed": 1, "stale": 0}
    arts = db.articles(["s1", "s2"])
    assert arts["s1"]["points"] and arts["s1"]["domain"] == "forumias.com" and arts["s2"]["miss"] == 1
    assert A.read_brief_articles(db, TOPICS, ["2026-09-26"], http=http) == {"read": 0, "missed": 0, "stale": 0}  # a recent miss waits


AIR_OLD = """<html><body><header><p>Home | National | International | Updated: September 27, 2026 10:00 AM</p></header>
<div class="post-meta">News On AIR | March 25, 2026 7:38 PM</div>
<div class="content"><p>Parliament has passed the Transgender Persons (Protection of Rights) Amendment Bill, 2026, with the Rajya Sabha approving it by voice vote today.</p>
<p>The bill was passed by the Lok Sabha on Tuesday after a debate in which members raised questions about the certification process for identity.</p>
<p>On July 25, 2024 the Supreme Court had asked the government to examine the concerns of the community about the certificate of identity.</p></div>
</body></html>"""


def test_published_date_comes_from_tags_or_a_dateline_never_the_body():
    meta = '<html><head><meta property="article:published_time" content="2026-09-26T08:10:00+05:30"></head><body><p>x</p></body></html>'
    ld = '<html><head><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-08-07T11:00:00Z"}</script></head></html>'
    assert A.published_of(meta) == "2026-09-26" and A.published_of(ld) == "2026-08-07"
    assert A.published_of(AIR_OLD) == "2026-03-25"  # the dateline, not the header's "Updated" nor the 2024 in the text
    body_only = "<html><body><p>On July 25, 2024 the Supreme Court held that the rule was valid for all the states in the country.</p></body></html>"
    assert A.published_of(body_only) == ""
    assert A.is_stale("2026-03-25", "2026-09-26") and not A.is_stale("2026-09-24", "2026-09-26") and not A.is_stale("", "2026-09-26")


def test_an_old_article_filed_under_today_is_kept_with_its_date_and_leaves_the_brief(db, settings):
    from datetime import datetime, timezone

    from upsc_intel.pipeline.brief import select_day
    from upsc_intel.pipeline.classify import Classifier
    from upsc_intel.config import load_topics
    now = datetime.now(timezone.utc).isoformat()
    url = "https://www.newsonair.gov.in/parliament-passes-transgender-persons-amendment-bill-2026/"
    for sid, title, u in (("old", "Parliament passes Transgender Persons Amendment Bill 2026", url),
                          ("new", "Exercise Varuna 2026 begins at Toulon", "https://forumias.com/blog/varuna/")):
        db.upsert_story({"id": sid, "title": title, "url": u, "date_ist": "2026-09-26", "dates": ["2026-09-26"], "first_seen": now,
                         "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1, "publishers": ["x"],
                         "subjects": ["polity" if sid == "old" else "defence"], "gs": [], "tags": [], "watch": [], "score": 9,
                         "grade": "NOTE", "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0,
                         "tier": "quality", "summary": "", "tokens": []})
        db.insert_item({"id": "i" + sid, "source_id": "x", "title": title, "url": u, "date_ist": "2026-09-26", "published_at": now,
                        "is_library": 0, "story_id": sid, "publisher": "P"})
    db.save_brief("2026-09-26", [("old", "news", 1, "top", None), ("new", "news", 2, "top", None)])
    db.commit()
    http = FakeHttp({"https://www.newsonair.gov.in/": Resp(url, AIR_OLD), "https://forumias.com/": Resp("https://forumias.com/blog/varuna/", ARTICLE),
                     "https://www.bing.com/news/search": Resp("x", rss())})
    assert A.read_brief_articles(db, TOPICS, ["2026-09-26"], http=http) == {"read": 2, "missed": 0, "stale": 1}
    assert db.articles(["old"])["old"]["published"] == "2026-03-25" and db.articles(["new"])["new"]["published"] == ""
    ids = [p[0] for p in select_day(db, Classifier(load_topics(settings)), "2026-09-26")]
    assert "old" not in ids and "new" in ids


def test_a_page_read_before_dates_were_kept_is_checked_once(db, settings):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    db.upsert_story({"id": "s1", "title": "Exercise Varuna 2026 begins at Toulon", "url": "https://forumias.com/blog/varuna/",
                     "date_ist": "2026-09-26", "dates": ["2026-09-26"], "first_seen": now, "last_seen": now, "updated_at": now,
                     "n_items": 1, "n_publishers": 1, "publishers": ["x"], "subjects": ["defence"], "gs": [], "tags": [], "watch": [],
                     "score": 6, "grade": "NOTE", "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0,
                     "tier": "quality", "summary": "", "tokens": []})
    db.insert_item({"id": "is1", "source_id": "x", "title": "t", "url": "https://forumias.com/blog/varuna/", "date_ist": "2026-09-26",
                    "published_at": now, "is_library": 0, "story_id": "s1", "publisher": "P"})
    db.save_brief("2026-09-26", [("s1", "news", 1, "top", None)])
    db.save_article("s1", {"url": "https://forumias.com/blog/varuna/", "domain": "forumias.com", "via": "", "paragraphs": ["a"],
                           "points": ["kept"], "fetched_at": now})
    db.x("UPDATE article_text SET published=NULL WHERE story_id='s1'")  # a row from before dates were kept
    db.commit()
    down = FakeHttp({})  # the re-check fails: the text already read stays, marked as checked
    assert A.read_brief_articles(db, TOPICS, ["2026-09-26"], http=down)["read"] == 0
    a = db.articles(["s1"])["s1"]
    assert a["points"] == ["kept"] and not a["miss"] and a["published"] == ""
    assert A.read_brief_articles(db, TOPICS, ["2026-09-26"], http=down) == {"read": 0, "missed": 0, "stale": 0}


def test_a_datelined_lead_is_kept_and_a_glued_subheading_split():
    assert not A.is_teaser("NEW DELHI: The Tamil Nadu government has exempted the department from the RTI Act.")
    assert A.is_teaser("Mamata slams Centre over funds KOLKATA: Mamata Banerjee alleged on Friday that the Centre withheld funds.")
    assert A.is_teaser("Priyanka Jaiswal has four years of experience in digital journalism, news agency reporting and video production.")
    ld = ('<html><head><script type="application/ld+json">{"@type":"NewsArticle","articleBody":"NEW DELHI: The Tamil Nadu government has '
          'exempted the Public (Law and Order) Department from the ambit of the RTI Act. What the exemption meansThe department deals with '
          'policing, public order and law-and-order administration in the state. ' + 'The notification was issued under Section 24(4) of the '
          'law, which lets states exclude intelligence and security organisations from its ambit. ' * 3 + '"}</script></head><body></body></html>')
    text = " ".join(A.main_text(ld))
    assert "meansThe" not in text and "The department deals with policing" in text

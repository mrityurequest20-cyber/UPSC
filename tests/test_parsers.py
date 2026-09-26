from email.message import EmailMessage
from pathlib import Path

from upsc_intel.fetchers.documents import doc_date, extract_sections
from upsc_intel.fetchers.email_imap import parse_email
from upsc_intel.fetchers.gnews import parse_gnews
from upsc_intel.fetchers.html_links import extract_links
from upsc_intel.fetchers.pib import parse_release_list, parse_release_page
from upsc_intel.fetchers.rss import parse_feed
from upsc_intel.fetchers.telegram import parse_channel

FX = Path(__file__).parent / "fixtures"

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>Cabinet approves new scheme</title><link>https://ex.com/a</link>
<description>&lt;p&gt;The Union Cabinet &lt;b&gt;approved&lt;/b&gt; it.&lt;/p&gt;</description>
<pubDate>Sat, 26 Sep 2026 10:00:00 +0530</pubDate></item>
<item><title></title><link>https://ex.com/empty</link></item>
</channel></rss>"""

GNEWS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>G</title>
<item><title>RBI keeps repo rate unchanged - The Hindu</title><link>https://news.google.com/rss/articles/abc</link>
<pubDate>Sat, 26 Sep 2026 08:00:00 GMT</pubDate><source url="https://www.thehindu.com">The Hindu</source></item>
</channel></rss>"""


def test_parse_feed():
    items = parse_feed(RSS)
    assert len(items) == 1
    assert items[0].summary == "The Union Cabinet approved it."
    assert items[0].published.isoformat() == "2026-09-26T04:30:00+00:00"


def test_parse_gnews_strips_publisher():
    (it,) = parse_gnews(GNEWS)
    assert it.title == "RBI keeps repo rate unchanged"
    assert it.publisher == "The Hindu"


def test_pib_list():
    date, rows = parse_release_list((FX / "pib_list.html").read_text())
    assert date == "2026-09-26"
    assert [r["prid"] for r in rows] == ["2315309", "2315400", "2315401"]
    assert rows[1]["ministry"].startswith("Ministry of Environment")


def test_pib_release_page():
    published, text = parse_release_page((FX / "pib_release.html").read_text())
    assert published.isoformat() == "2026-09-26T12:06:00+00:00"
    assert text.startswith("Two wetlands in Bihar")
    assert "VM/SK" not in text


def test_telegram():
    items = parse_channel((FX / "telegram.html").read_text())
    assert [i.url for i in items] == ["https://t.me/upscdaily/102", "https://t.me/upscdaily/101"]
    assert items[1].title.startswith("Daily Current Affairs 26 Sep")
    assert items[1].extra["links"] == ["https://example.com/ca-26-sep"]


def test_extract_links_filters_junk_and_offsite():
    html = """<nav><a href="/login">Login to your account please now</a></nav>
    <a href="/daily-updates/one">Supreme Court on Governor's assent to state Bills explained</a>
    <a href="https://other.com/x">Offsite link that is long enough to count here</a>
    <a href="/about">About us and our amazing team of teachers</a>
    <a href="/daily-updates/one#c">Supreme Court on Governor's assent to state Bills explained</a>"""
    pairs = extract_links(html, "https://site.com/ca", link_pattern="/daily-updates/")
    assert pairs == [("Supreme Court on Governor's assent to state Bills explained", "https://site.com/daily-updates/one")]


def test_parse_email_newsletter():
    msg = EmailMessage()
    msg["Subject"] = "UPSC Essentials: this week"
    msg["From"] = "Indian Express <newsletter@indianexpressonline.org>"
    msg["Date"] = "Sat, 26 Sep 2026 07:00:00 +0530"
    msg["Message-ID"] = "<abc123@ie>"
    msg.set_content("plain text version")
    msg.add_alternative("""<html><body>
      <a href="https://indianexpress.com/article/explained/governor-assent-bills-123/">Why the Governor's assent to state Bills is back in court</a>
      <a href="https://epaper.indianexpress.com/today">Download today's e-paper</a>
      <a href="https://ie.com/unsubscribe">Unsubscribe from this newsletter list now</a>
      <a href="https://ie.com/x">Short</a>
    </body></html>""", subtype="html")
    key, items = parse_email(msg.as_bytes())
    assert key == "abc123@ie"
    titles = [i.title for i in items]
    assert titles[0] == "UPSC Essentials: this week"
    assert "Why the Governor's assent to state Bills is back in court" in titles
    assert any(i.extra.get("epaper") for i in items)
    assert not any("Unsubscribe" in t for t in titles)
    assert all(i.publisher == "Indian Express" for i in items)


def test_documents_markdown_and_dates(tmp_path):
    p = tmp_path / "Vision_IAS_September_2026.md"
    p.write_text("# Polity\n" + "Governor's assent and Article 200 in detail. " * 5 + "\n# Economy\n" + "RBI policy and inflation numbers explained. " * 5)
    secs = extract_sections(p)
    assert [s[0] for s in secs] == ["Polity", "Economy"]
    assert doc_date(p).strftime("%Y-%m") == "2026-09"
    q = tmp_path / "notes-2026-08-15.html"
    q.write_text("<h2>Ramsar sites</h2><p>" + "Bihar gets two new Ramsar wetlands this year. " * 4 + "</p>")
    assert extract_sections(q)[0][0] == "Ramsar sites"
    assert doc_date(q).strftime("%Y-%m-%d") == "2026-08-15"

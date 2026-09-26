from upsc_intel.pipeline.normalize import (
    canonical_url, clean_title, html_to_text, publisher_key, strip_publisher_suffix, title_tokens,
)


def test_canonical_url_drops_tracking_and_fragment():
    u = "https://WWW.TheHindu.com/news/national/story.ece/?utm_source=rss&utm_medium=x&id=5#comments"
    assert canonical_url(u) == "https://www.thehindu.com/news/national/story.ece?id=5"


def test_canonical_url_keeps_library_links():
    assert canonical_url("/files/Vision%20Sept.pdf#page=4") == "/files/Vision%20Sept.pdf#page=4"


def test_strip_publisher_suffix():
    assert strip_publisher_suffix("RBI keeps repo rate unchanged - The Hindu", "The Hindu") == "RBI keeps repo rate unchanged"
    assert strip_publisher_suffix("RBI keeps repo rate unchanged", "The Hindu") == "RBI keeps repo rate unchanged"


def test_clean_title_and_html():
    assert clean_title("  Cabinet&nbsp;approves   &amp; notifies  ") == "Cabinet approves & notifies"
    assert html_to_text("<p>Hello <b>world</b></p>") == "Hello world"
    assert html_to_text("word " * 200, limit=20).endswith("…")


def test_title_tokens_drop_filler_and_stem():
    toks = title_tokens("India's tigers: New survey says tiger reserves grew")
    assert "india" not in toks and "says" not in toks
    assert "tiger" in toks and "reserve" in toks
    assert title_tokens("policies taxes status") == ["policy", "tax", "status"]


def test_publisher_key_merges_variants():
    assert publisher_key("The Economic Times") == publisher_key("Economic Times")
    assert publisher_key("thehindubusinessline.com") == publisher_key("BusinessLine")
    assert publisher_key("The Hindu") != publisher_key("Hindustan Times")

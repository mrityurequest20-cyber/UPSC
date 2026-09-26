"""Daily brief selection, explainers, India-angle and video matching."""
from datetime import datetime, timedelta, timezone

import pytest

from upsc_intel.pipeline.brief import select_day
from upsc_intel.pipeline.cluster import merge_republished, split_mixed_stories
from upsc_intel.pipeline.enrich import _sentences, auto_explain, has_ai_explainer
from upsc_intel.pipeline.kinds import content_kind
from upsc_intel.pipeline.normalize import title_tokens
from upsc_intel.pipeline.videos import ACCEPT, _relative_time, _still_good, queries, score_video, video_language

NOW = datetime.now(timezone.utc)


# ── India angle ──
@pytest.mark.parametrize("title,tier,india", [
    ("Israel strikes Gaza again as ceasefire talks stall", "intl", False),
    ("US Fed cuts interest rates by 25 basis points", "general", False),
    ("Nepal Prime Minister resigns amid protests", "intl", True),          # neighbourhood watch area
    ("WTO ministerial fails to agree on fisheries subsidies", "intl", True),  # global institution
    ("India and Japan sign MoU on semiconductors", "intl", True),
])
def test_india_angle(clf, title, tier, india):
    a = clf.analyze(title)
    assert a.india is india
    if not india:
        assert clf.grade(clf.score(a, tier)) == "LOW"


# ── brief selection ──
def _story(db, sid, day, score, grade, subjects, editorial=False, publisher="The Hindu", summary="", explained=False,
           title=None):
    db.upsert_story({
        "id": sid, "title": title or sid, "url": "https://x/" + sid, "date_ist": day, "dates": [day],
        "first_seen": NOW.isoformat(), "last_seen": NOW.isoformat(), "updated_at": NOW.isoformat(),
        "n_items": 1, "n_publishers": 1, "publishers": [publisher], "subjects": subjects, "gs": [],
        "tags": [], "watch": [], "score": score, "grade": grade, "is_editorial": int(editorial),
        "is_explained": int(explained),
        "is_library": 0, "is_private": 0, "tier": "quality", "summary": summary, "tokens": [],
    })


def test_select_day_covers_syllabus_and_caps_subjects(db, clf):
    day = "2026-09-26"
    for i in range(10):  # ten strong polity stories
        _story(db, f"pol{i}", day, 9 - i * 0.1, "NOTE", ["polity"])
    for i in range(6):  # six middling economy stories
        _story(db, f"eco{i}", day, 4.5 - i * 0.1, "SKIM", ["economy"])
    _story(db, "env", day, 3.5, "SKIM", ["environment"])       # weaker, but the only environment story
    _story(db, "low", day, 1.0, "LOW", ["economy"])            # never in the brief
    _story(db, "read", day, 2.0, "READ", ["economy"])          # READ news is not brief material
    _story(db, "nosubj", day, 8.0, "NOTE", [])                 # unclassified never makes the brief
    _story(db, "lanka", day, 4.9, "SKIM", ["ir"], title="Sri Lanka's Parliament approves 22nd Amendment")
    _story(db, "lanka-big", day, 5.2, "NOTE", ["ir"], title="Nepal Prime Minister resigns as protests spread")
    for i in range(4):
        _story(db, f"ed{i}", day, 2.0, "READ", ["polity"], editorial=True)
    db.commit()
    picks = select_day(db, clf, day, size=20, ed_size=3)
    news = [p[0] for p in picks if p[1] == "news"]
    eds = [p[0] for p in picks if p[1] == "editorial"]
    assert "env" in news                                        # coverage pass
    assert sum(1 for n in news if n.startswith("pol")) == 10    # every NOTE story, whatever its subject
    assert sum(1 for n in news if n.startswith("eco")) == 4     # SKIM filler: max 4 per subject
    assert "lanka" not in news and "lanka-big" in news          # foreign affairs: only as NOTE
    assert not {"low", "read", "nosubj"} & set(news)
    assert eds == ["ed0", "ed1", "ed2"]                         # max 3 per publisher, ed_size respected
    assert [p[2] for p in picks if p[1] == "news"] == list(range(1, len(news) + 1))


def test_editorials_and_explainers_get_their_own_quota(db, clf):
    day = "2026-09-26"
    for i in range(6):  # one paper publishes a lot of opinion
        _story(db, f"hin{i}", day, 4 - i * 0.1, "SKIM", ["polity"], editorial=True)
    _story(db, "trib", day, 2.0, "READ", ["economy"], editorial=True, publisher="The Tribune")
    _story(db, "opaque", day, 1.0, "LOW", ["society"], editorial=True, publisher="Mint")  # LOW but on-syllabus
    _story(db, "essay", day, 1.0, "LOW", [], editorial=True, publisher="Mint")  # personal essay: no subject
    for i in range(3):
        _story(db, f"ie{i}", day, 5 - i * 0.1, "NOTE", ["ir"], explained=True, publisher="Indian Express")
    _story(db, "hexp", day, 3.0, "SKIM", ["environment"], explained=True)
    _story(db, "news", day, 6.0, "NOTE", ["ir"])
    db.commit()
    picks = select_day(db, clf, day, size=5, ed_size=6, ex_size=3)
    kinds = {k: [p[0] for p in picks if p[1] == k] for k in ("news", "editorial", "explained")}
    assert kinds["news"] == ["news"]  # explainers never take news slots
    eds = kinds["editorial"]
    assert len(eds) == 6 and {"trib", "opaque"} <= set(eds) and "essay" not in eds
    assert sum(1 for e in eds if e.startswith("hin")) == 4  # capped first, then the leftover slot is filled
    assert kinds["explained"] == ["ie0", "ie1", "ie2"]  # best first; the quota is respected


@pytest.mark.parametrize("src,title,url,kind", [
    ({"tier": "quality"}, "What is analogue paneer, and why is FSSAI cracking down on it? | Explained",
     "https://www.thehindu.com/news/national/analogue-paneer/article1.ece", "explained"),
    ({"tier": "examprep"}, "UPSC Editorial Analysis: Counterfeit Medicines", "https://www.insightsonindia.com/2026/09/26/x/", "editorial"),
    ({"tier": "quality"}, "Overweight and weak: On the UN", "https://www.thehindu.com/opinion/editorial/overweight/article2.ece", "editorial"),
    ({"tier": "quality"}, "Mint Explainer | What 20-year environmental clearances mean for ports", "", "explained"),
    ({"tier": "examprep"}, "Knowledge Nugget | How does the Election Commission allocate symbols?", "https://indianexpress.com/article/upsc/x/", "explained"),
    ({"tier": "quality"}, "Why did a U.S. court stay Trump's ban on media outlets?", "https://www.thehindu.com/news/international/x/article3.ece", "explained"),
    ({"tier": "general"}, "Why did Rahul Gandhi skip the meeting today?", "https://www.ndtv.com/india-news/x", "news"),
    ({"tier": "quality"}, "Supreme Court upholds sub-classification of Scheduled Castes", "https://www.thehindu.com/news/national/x/article4.ece", "news"),
    ({"tier": "watch"}, "Centre notifies new rules", "https://news.google.com/rss/articles/opinion/abc", "news"),  # redirect path means nothing
    ({"tier": "quality", "explained": True}, "The takeaways from the summit", "", "explained"),
    ({"tier": "quality", "editorial": True}, "What does the IIT-Bombay suicide tell us?", "", "editorial"),
])
def test_content_kind(src, title, url, kind):
    assert content_kind(src, title, url, "gnews" if "news.google" in url else "rss") == kind


def test_split_mixed_stories(db):
    now = NOW.isoformat()
    for iid, ed, ex in (("a", 0, 0), ("b", 0, 0), ("c", 0, 1)):  # an explainer that had joined a news story
        db.insert_item({"id": iid, "source_id": "x", "title": iid, "url": "https://x/" + iid, "date_ist": "2026-09-26",
                        "published_at": now, "is_editorial": ed, "is_explained": ex, "is_library": 0, "story_id": "sa"})
    db.commit()
    assert split_mixed_stories(db) == 1
    assert {r["id"]: r["story_id"] for r in db.q("SELECT id, story_id FROM items")} == {"a": "sa", "b": "sa", "c": "sc"}


def test_brief_prefers_stories_with_text(db, clf):
    day = "2026-09-26"
    _story(db, "bare", day, 6.0, "NOTE", ["polity"])
    _story(db, "texty", day, 5.5, "NOTE", ["polity"], summary="The Supreme Court ruled on Thursday that the " * 3)
    db.commit()
    news = [p[0] for p in select_day(db, clf, day, size=5, ed_size=0) if p[1] == "news"]
    assert news[0] == "texty"


# ── explainers ──
def test_sentence_split_keeps_initials():
    assert _sentences("External Affairs Minister S. Jaishankar signed the UN Convention against Cybercrime. "
                      "It deals with Rs. 500 crore of funds.") == [
        "External Affairs Minister S. Jaishankar signed the UN Convention against Cybercrime.",
        "It deals with Rs. 500 crore of funds."]


def test_auto_explain_uses_lead_sentence_and_tags(clf):
    story = {
        "title": "Two new Ramsar sites in Bihar", "date_ist": "2026-09-26",
        "summary": "News: Two wetlands in Bihar were designated as Ramsar sites on Friday. "
                   "This takes India's tally to 96 sites. The Ramsar Convention was signed in 1971.",
        "subjects": ["environment"], "gs": ["GS3", "Prelims"], "tags": ["Place in news"], "watch": [],
        "publishers": ["PIB", "The Hindu", "Down To Earth"],
    }
    e = auto_explain(story, clf.labels())
    assert e["auto"] and e["why_in_news"].startswith("Two wetlands in Bihar")
    assert "96 sites" in e["what"]
    assert any("Environment" in x for x in e["significance"])
    assert any("Prelims angle" in x for x in e["significance"])
    assert e["prelims"] == ["The Ramsar Convention was signed in 1971."]
    assert not has_ai_explainer(e) or e.get("what")


def test_auto_explain_skips_page_furniture(clf):
    e = auto_explain({"title": "UPSC Editorial Analysis: Counterfeit Medicines", "summary":
                      "General Studies-2; Topic: Issues relating to Health. Introduction The seizure of counterfeit "
                      "medicines in Bengaluru reveals weak drug regulation. Source: The post is based on an article.",
                      "subjects": [], "gs": [], "tags": [], "watch": [], "publishers": ["Insights"]}, clf.labels())
    assert e["why_in_news"] == "The seizure of counterfeit medicines in Bengaluru reveals weak drug regulation."
    bare = {"title": "x", "date_ist": "2026-09-26", "summary": "", "subjects": [], "gs": [], "tags": [], "watch": []}
    assert auto_explain({**bare, "is_explained": 1, "publishers": ["The Hindu"]}, {})["why_in_news"].startswith("Explainer by The Hindu")
    assert auto_explain({**bare, "is_editorial": 1, "publishers": ["The Tribune"]}, {})["why_in_news"].startswith("Opinion piece in The Tribune")


def test_auto_explain_marks_only_real_cuts(clf):
    base = {"title": "Step up regulation", "date_ist": "2026-09-26", "subjects": [], "gs": [], "tags": [], "watch": []}
    standfirst = auto_explain({**base, "summary": "Alternative medicine systems should comply with quality control"}, {})
    assert standfirst["why_in_news"] == "Alternative medicine systems should comply with quality control"
    cut = auto_explain({**base, "summary": "The Union Cabinet on Wednesday approved the scheme " * 4}, {})
    assert cut["why_in_news"].endswith("…")


def test_auto_explain_without_text(clf):
    e = auto_explain({"title": "Some headline", "date_ist": "2026-09-26", "summary": "", "subjects": [],
                      "gs": [], "tags": [], "watch": [], "publishers": ["Lawtext"]}, clf.labels())
    assert e["why_in_news"] == "Reported on 26 Sep by Lawtext." and e["what"] == ""


# ── videos ──
def test_relative_time_parses_short_forms():
    assert all(_relative_time(x) for x in ["1 yr ago", "22 hr ago", "10 mo ago", "Streamed 3 days ago", "2 weeks ago"])
    assert _relative_time(None) is None


def test_queries_start_with_distinctive_terms():
    q = queries({"title": "Centre extends AFSPA in parts of Manipur, Nagaland and Arunachal Pradesh for six months"})
    assert q[0] == "AFSPA Manipur Nagaland Arunachal Pradesh"
    assert queries({"title": "X", "ai": {"video_query": "AFSPA extension explained"}})[0] == "AFSPA extension explained"


IDF = {t: 3.0 for t in title_tokens("afspa manipur nagaland arunachal cybercrime convention tarang shakti periyar "
                                    "mandeep bhandari cbse chairperson species discover survey")}
IDF.update({t: 1.0 for t in title_tokens("centre extend part pradesh six month un india new minister art day")})


@pytest.mark.parametrize("story,video,channel,expected", [
    ("Centre extends AFSPA in parts of Manipur, Nagaland and Arunachal Pradesh for six months",
     "Centre extends AFSPA in disturbed areas of Manipur, Nagaland & Arunachal", "NEWS ON AIR OFFICIAL", True),
    ("UN Convention against Cybercrime", "EAM Dr S Jaishankar Signs Landmark UN Convention Against Cybercrime",
     "DD NEWS", True),
    ("IAS officer Mandeep Bhandari appointed chairperson of CBSE",
     "Who Is Mandeep Bhandari, The New CBSE Chairperson Appointed By The Govt", "NewsX Live", True),
    ("Survey discovers six new species from Periyar Tiger Reserve", "PERIYAR TIGER RESERVE FOREST BOAT RIDING 2026",
     "Some Vlogger", False),
    ("RBI keeps repo rate unchanged", "Supreme Court on stray dogs in Delhi", "DD News", False),
    ("Centre extends AFSPA in parts of Manipur, Nagaland and Arunachal Pradesh for six months",
     "AFSPA Manipur Nagaland Arunachal explained in Hindi", "Some Channel", False),
])
def test_score_video(story, video, channel, expected):
    sc = score_video({"title": story, "date_ist": NOW.date().isoformat()}, video, channel, NOW, "en", IDF)
    assert (sc >= ACCEPT) is expected, sc


def test_old_videos_rejected():
    story = {"title": "UN Convention against Cybercrime", "date_ist": NOW.date().isoformat()}
    old = NOW - timedelta(days=300)
    assert score_video(story, "UN Convention Against Cybercrime explained", "DD News", old, "en", IDF) == 0


@pytest.mark.parametrize("title,foreign,subject", [
    ("Sri Lanka's Parliament approves 22nd Amendment to Constitution", "neighbourhood", "ir"),
    ("Vladimir Putin's United Russia Party retains majority in Parliament", "world", "ir"),
    ("White House reinstates media access: How the US judiciary checks presidential power", "world", "ir"),
    ("India raises 13th Amendment and Tamil devolution with Sri Lanka", "", "polity"),
    ("Parliament passes Transgender Persons Amendment Bill, 2026", "", "polity"),
    ("Trump at UNGA: US pushes UN reform", "", "ir"),  # global institutions are not penalised
])
def test_foreign_affairs_are_not_indian_polity(clf, title, foreign, subject):
    a = clf.analyze(title)
    assert a.foreign == foreign and a.subjects[0] == subject
    if foreign:
        assert clf.grade(clf.score(a, "quality")) != "NOTE"


@pytest.mark.parametrize("title,tier", [
    ("Auction of 91-Day, 182-Day and 364-Day Treasury Bills", "official"),
    ("DAILY CURRENT AFFAIRS IAS | UPSC Prelims and Mains Exam – 22nd September", "examprep"),
    ("Bank of America Corp DE Makes New Investment in Conagra Brands", "watch"),
    ("Settlement Order in the matter of Kaizen Domestic Scheme I", "official"),
    ("General Remittance Advice against: Heena Khatoon, Proprietor of Heena Enterprises [Defaulter]", "official"),
    ("SEBI Order for Compliance - General Remittance Order dated 23.09.2026 in Recovery Certificate No. 8933", "official"),
    ("NITI AAYOG DOCPLAN- SEPTEMBER 2026 Compiled By: Dr. Kumar Sanjay, Director (Library)", "official"),
    ("20 Tranquil Ramsar Sites To Visit In Tamil Nadu!", "watch"),
])
def test_routine_notices_are_not_note(clf, title, tier):
    assert clf.grade(clf.score(clf.analyze(title), tier)) in ("READ", "LOW")


# ── video language: Hindi or English only ──
@pytest.mark.parametrize("title,channel,hint,lang", [
    ("Tarang Shakti & Mission Pégase 26 | UPSC Current Affairs", "Mission IAS Malayalam", None, "other"),
    ("Suvendu Adhikari | CM Hits Back at Baseless Claims", "News18 Bangla", None, "other"),
    ("EAM Dr S Jaishankar Signs UN Convention Against Cybercrime", "DD NEWS Telangana", None, "other"),
    ("World Tourism Day 2026", "Sri Lanka Tourism", None, "other"),
    ("AFSPA explained in Tamil", "Some Channel", None, "other"),
    ("அணை பாதுகாப்பு சட்டம்", "Some Channel", None, "other"),
    ("Tamil Nadu floods: what the IMD warning means", "The Hindu", None, "en"),  # a place is not a language
    ("AFSPA क्या है? | UPSC", "Drishti IAS", "hi", "hi"),
    ("AFSPA kya hai? Manipur me kyun badhaya gaya", "Some Channel", None, "hi"),
    ("Centre extends AFSPA in Manipur", "NEWS ON AIR OFFICIAL", None, "en"),
])
def test_video_language(title, channel, hint, lang):
    assert video_language(title, channel, hint) == lang


def test_video_rules_hindi_ok_regional_and_junk_rejected():
    story = {"title": "Centre extends AFSPA in parts of Manipur, Nagaland and Arunachal Pradesh for six months",
             "date_ist": NOW.date().isoformat()}
    ok_hi = score_video(story, "AFSPA Manipur Nagaland Arunachal extended kya hai", "Drishti IAS", NOW, "en,hi", IDF, "hi")
    assert ok_hi >= ACCEPT
    assert score_video(story, "AFSPA Manipur Nagaland Arunachal extended", "Mission IAS Malayalam", NOW, "en,hi", IDF) == 0
    unknown = score_video(story, "AFSPA Manipur Nagaland Arunachal extended", "Random Uploader", NOW, "en,hi", IDF)
    trusted = score_video(story, "AFSPA Manipur Nagaland Arunachal extended", "Vajiram and Ravi", NOW, "en,hi", IDF)
    assert trusted >= ACCEPT and unknown == 0  # unknown channels are not used at all
    assert score_video(story, "AFSPA Manipur Nagaland Arunachal extended #shorts", "WION", NOW, "en,hi", IDF) < ACCEPT


def test_auto_explain_five_w_from_several_outlets(clf):
    story = {"title": "Centre extends AFSPA in parts of Manipur, Nagaland and Arunachal Pradesh for six months",
             "date_ist": "2026-09-26", "subjects": ["internal_security"], "gs": ["GS3"], "tags": [], "watch": [],
             "publishers": ["PIB", "The Hindu"]}
    text = ("The Ministry of Home Affairs on Friday extended the Armed Forces (Special Powers) Act in eight districts "
            "of Manipur from October 1 for six months. The Ministry of Home Affairs on Friday extended the Armed Forces "
            "(Special Powers) Act in eight Manipur districts. Union Home Minister Amit Shah said the Supreme Court "
            "had upheld the law in 1998.")
    e = auto_explain(story, clf.labels(), text=text, clf=clf)
    assert e["when"] == "Reported 26 Sep · on Friday · from October 1"
    assert e["where"].startswith("Manipur") and "Nagaland" in e["where"]
    assert e["who"].startswith("Amit Shah (Home Minister)") and "Supreme Court" in e["who"]
    assert e["what"].count("eight districts") + e["what"].count("eight Manipur") <= 1  # repeated lead dropped
    bare = auto_explain({**story, "title": "Some headline"}, clf.labels(), text="", clf=clf)
    assert bare["when"] == "Reported 26 Sep" and bare["where"] == "" and bare["who"] == ""


def test_stored_matches_are_rechecked_under_current_rules():
    """A stored match's detected language must not count as 'one of our channels' (regression)."""
    story = {"title": "World Tourism Day 2026 celebrated across India", "date_ist": NOW.date().isoformat()}
    junk = {"id": "x1", "title": "World Tourism Day 2026 celebrated | Bahria Town", "channel": "Bahria Town",
            "published": NOW.isoformat(), "lang": "en", "known": False}
    assert not _still_good(story, junk, "en", "en,hi", IDF)
    lib = {**junk, "channel": "Vajiram and Ravi", "known": True, "title": "World Tourism Day 2026 celebrated India"}
    assert _still_good(story, lib, "en", "en,hi", IDF)
    assert not _still_good(story, lib, "hi", "en,hi", IDF)  # right video, wrong language slot


def test_story_carried_only_by_foreign_outlets_is_foreign(clf):
    t = "22nd Amendment to the Constitution passed in Parliament"
    assert clf.story_foreign(t, "", ["Newswire", "Hiru News", "Ada Derana"]) == "neighbourhood"
    assert clf.story_foreign(t, "", ["Ada Derana", "The Hindu"]) == ""          # an Indian outlet carried it too
    assert clf.story_foreign("India, Sri Lanka sign MoU on energy", "", ["Ada Derana"]) == ""  # India link
    a = clf.analyze(t, "", publisher="Ada Derana")
    assert a.foreign == "neighbourhood" and "polity" not in a.subjects and clf.grade(clf.score(a, "watch")) != "NOTE"


def test_low_value_publishers_and_bare_site_names(clf):
    title = "Supreme Court Refers Question of Law to Constitution Bench in Civil Procedure"
    good = clf.score(clf.analyze(title, publisher="Live Law"), "watch")
    farm = clf.score(clf.analyze(title, publisher="Lawtext"), "watch")
    assert good - farm == pytest.approx(2.0)
    tender = clf.analyze("Tender for RF connector Space qualified SMA RF Connectors", publisher="ISRO e-Procurement Portal")
    assert clf.grade(clf.score(tender, "official")) in ("READ", "LOW")
    assert clf.grade(clf.score(clf.analyze("NITI Aayog", publisher="NITI Aayog"), "official")) == "LOW"


def test_reposted_oped_joins_the_oped(db):
    """Exam-prep sites repost an op-ed under its own headline: that copy is the op-ed, not news."""
    day, now = NOW.date().isoformat(), NOW.isoformat()
    title = "Revisiting India's nuclear doctrine without revising it"
    rows = (("hindu", "sed", 1, title), ("forumias", "sfor", 0, title), ("civils", "sfor", 0, title),
            ("nextias", "snext", 0, "India's Nuclear Doctrine: Review Without Unnecessary Revision"))
    for iid, sid, ed, t in rows:
        db.insert_item({"id": iid, "source_id": iid, "title": t, "url": "https://x/" + iid, "date_ist": day,
                        "published_at": now, "is_editorial": ed, "is_explained": 0, "is_library": 0,
                        "story_id": sid, "tokens": title_tokens(t)})
    db.commit()
    assert merge_republished(db) == {"sed", "sfor"}
    assert merge_republished(db) == set()  # idempotent
    got = {r["id"]: (r["story_id"], r["is_editorial"]) for r in db.q("SELECT id, story_id, is_editorial FROM items")}
    assert got == {"hindu": ("sed", 1), "forumias": ("sed", 1), "civils": ("sed", 1), "nextias": ("snext", 0)}


def test_five_w_ignores_page_furniture(clf):
    story = {"title": "Revisiting India's nuclear doctrine without revising it", "date_ist": "2026-09-26",
             "summary": "Source: The post has been created based on an article published in The Hindu on 26th "
                        "September 2026. UPSC Syllabus: GS-2- International Relations Context: India's nuclear "
                        "doctrine was adopted in 2003 and rests on No-First-Use.",
             "subjects": ["ir"], "gs": ["GS2"], "tags": [], "watch": [], "publishers": ["ForumIAS"]}
    e = auto_explain(story, clf.labels(), clf=clf)
    assert e["why_in_news"].startswith("India's nuclear doctrine was adopted in 2003")
    assert "UPSC" not in e["who"] and "September" not in e["when"] and "2003" not in e["when"]
    prep = auto_explain({**story, "title": "UPSC Editorial Analysis: Counterfeit Medicines", "summary":
                         "Introduction The seizure of counterfeit medicines in Bengaluru shows weak regulation by 2027."},
                        clf.labels(), clf=clf)
    assert "UPSC" not in prep["who"] and "by 2027" in prep["when"]

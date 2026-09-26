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
           title=None, tokens=None):
    db.upsert_story({
        "id": sid, "title": title or sid, "url": "https://x/" + sid, "date_ist": day, "dates": [day],
        "first_seen": NOW.isoformat(), "last_seen": NOW.isoformat(), "updated_at": NOW.isoformat(),
        "n_items": 1, "n_publishers": 1, "publishers": [publisher], "subjects": subjects, "gs": [],
        "tags": [], "watch": [], "score": score, "grade": grade, "is_editorial": int(editorial),
        "is_explained": int(explained),
        "is_library": 0, "is_private": 0, "tier": "quality", "summary": summary, "tokens": tokens or [],
    })


def _news(picks, tier=None):
    return [p[0] for p in picks if p[1] == "news" and not p[4] and (tier is None or p[3] == tier)]


def test_brief_has_no_count_cap_on_a_busy_day(db, clf):
    day = "2026-09-26"
    for i in range(60):  # a Parliament session: sixty real developments, all of them must-know
        _story(db, f"bill{i}", day, 6.0, "NOTE", ["polity"], title=f"Parliament passes Bill number {i}")
    _story(db, "talk", day, 4.0, "SKIM", ["polity"], title="Minister slams Opposition, says protest is a drama")
    _story(db, "ports", day, 2.55, "READ", ["infrastructure"],
           title="Centre notifies Kandla, JNPA, Paradip and Mundra as mega ports")  # low grade, strong event
    _story(db, "env", day, 3.4, "SKIM", ["environment"])  # the only environment story
    _story(db, "low", day, 1.0, "LOW", ["economy"], title="Cabinet approves new scheme")  # LOW never makes it
    _story(db, "nosubj", day, 8.0, "NOTE", [])             # unclassified never makes it
    db.commit()
    picks = select_day(db, clf, day)
    top, more = _news(picks, "top"), _news(picks, "more")
    assert sum(1 for n in top if n.startswith("bill")) == 60   # every must-know story, however many
    assert "ports" in more                                     # a strong development lifts a READ story in
    assert "talk" not in top + more                            # reaction and commentary stay in Everything
    assert "env" in more                                       # coverage: every syllabus area is represented
    assert not {"low", "nosubj"} & set(top + more)
    assert [p[2] for p in picks if p[1] == "news"] == list(range(1, len(top) + len(more) + 1))


def test_brief_floor_fills_a_quiet_day(db, clf):
    day = "2026-09-26"
    for i in range(25):  # a quiet day: nothing clears the bar on its own
        _story(db, f"s{i}", day, 3.6 - i * 0.01, "SKIM", ["economy"])
    _story(db, "weak", day, 1.7, "READ", ["economy"], title="Experts say growth may slow, warns report")
    db.commit()
    picks = select_day(db, clf, day)
    top, more = _news(picks, "top"), _news(picks, "more")
    assert len(top) == clf.brief["floor_cards"] and len(top) + len(more) == 25  # topped up with the best of the day
    assert "weak" not in top + more                                             # but never below the floor score


def test_same_event_reports_fold_into_one_card(db, clf):
    day = "2026-09-26"
    _story(db, "a", day, 7.5, "NOTE", ["internal_security"], title="Centre extends AFSPA in Manipur, Nagaland for six months",
           tokens=["centre", "extend", "afspa", "manipur", "nagaland", "six", "month"], summary="x" * 100)
    _story(db, "b", day, 3.0, "READ", ["internal_security"], title="Govt extends AFSPA in Manipur for six months",
           tokens=["govt", "extend", "afspa", "manipur", "six", "month"])
    _story(db, "c", day, 7.0, "NOTE", ["defence"], title="Exercise VARUNA 2026 begins",
           tokens=["exercise", "varuna", "2026", "begin"])
    db.commit()
    picks = select_day(db, clf, day)
    assert _news(picks) == ["a", "c"]
    assert [(p[0], p[4]) for p in picks if p[4]] == [("b", "a")]  # listed on the AFSPA card, not a card of its own


def test_editorials_and_explainers_have_a_floor_not_a_cap(db, clf):
    day = "2026-09-26"
    for i in range(20):  # a big opinion day: twenty strong editorials, all of them in
        _story(db, f"hin{i}", day, 4 - i * 0.01, "SKIM", ["polity"], editorial=True, publisher=f"Paper {i % 4}")
    _story(db, "essay", day, 1.0, "LOW", [], editorial=True, publisher="Mint")  # personal essay: no subject
    _story(db, "ie0", day, 5.0, "NOTE", ["ir"], explained=True, publisher="Indian Express")
    for i in range(6):  # weaker explainers top the section up to its floor, one paper capped first
        _story(db, f"weak{i}", day, 2.0, "READ", ["economy"], explained=True, publisher="Mint")
    _story(db, "hexp", day, 1.9, "READ", ["environment"], explained=True, publisher="The Hindu")
    _story(db, "news", day, 6.0, "NOTE", ["ir"])
    db.commit()
    picks = select_day(db, clf, day, ed_size=15, ex_size=6)
    kinds = {k: [p[0] for p in picks if p[1] == k] for k in ("news", "editorial", "explained")}
    assert kinds["news"] == ["news"]  # explainers never take news slots
    assert len(kinds["editorial"]) == 20 and "essay" not in kinds["editorial"]
    # topped up to 6: Mint is capped at 3 in the first pass, so The Hindu's piece gets in before Mint's rest
    assert kinds["explained"] == ["ie0", "weak0", "weak1", "weak2", "weak3", "hexp"]


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
    news = _news(select_day(db, clf, day))
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
    assert good - farm == pytest.approx(clf.low_value_penalty)
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


# ── UPSC relevance: what is rejected outright (real headlines from the dashboard audit) ──
@pytest.mark.parametrize("title,publisher,tier,kind", [
    ("President congratulates Suchika Tariyal on creating history by winning Bronze Medal in Mixed Martial Arts at Asian Games", "PIB", "official", "news"),
    ("India beat Iran again in kabaddi final that felt like a rematch", "Indian Express", "quality", "news"),
    ("'File Defamation Case If Report Untrue': Kapil Sibal On Election Commission Dissent Row", "NDTV", "general", "news"),
    ("Uttarakhand BJP core committee discusses names of candidates for Rajya Sabha elections", "The Hindu", "quality", "news"),
    ("IMD issues red alert for heavy to very heavy rainfall in six states tomorrow", "News On AIR", "official", "news"),
    ("School holiday tomorrow, September 26: All CBSE, ICSE, private, govt schools to remain closed in Odisha", "News24Online", "general", "news"),
    ("Railway Recruitment Boards NTPC Graduate Notification 2026: 3,477 Posts, Apply From October 8", "NDTV", "general", "news"),
    ("NBEMS declares NEET PG 2026 results on official website", "News On AIR", "official", "news"),
    ("Rupee gains 15 paise to 95.81 against dollar, likely helped by RBI intervention", "Economic Times", "quality", "news"),
    ("Conagra Brands: The Next Earnings Report Could Change Everything (NYSE:CAG)", "Seeking Alpha", "watch", "news"),
    ("Foundation Stone Laid for 4-Lane Road Over Bridge Between Guntur and Nambur Costing ₹108 Crore", "PIB", "official", "news"),
    ("Tourism department organises nature walk in Kurnool", "The Hindu", "quality", "news"),
    ("Bengaluru man kills wife, dumps body in vacant plot; civic workers find it days later", "Hindustan Times", "general", "news"),
    ("9 PM UPSC Current Affairs Articles 26 September 2026", "Insights on India", "examprep", "news"),
    ("Auction of 91-Day, 182-Day and 364-Day Treasury Bills", "RBI", "official", "news"),
    ("Rajeesh Kumar Quoted in The Economic Times Article on UN Security Council Reforms", "MP-IDSA", "quality", "news"),
    ("Michigan Blue Economy Summit brings the community together to speak on the Blue Economy", "WSMH", "watch", "news"),
    ("Sri Lanka's Parliament approves 22nd Amendment to Constitution", "Ada Derana", "watch", "news"),
    ("Cabinet Approves Transfer of 10 Hectares of Coastal Land for Development of Sajafi Port in Hendijan", "تین نیوز", "watch", "news"),
    ("Why an 87-year-old woman's eviction has become a flashpoint in Spain's housing crisis", "ThePrint", "quality", "explained"),
    ("Why was Israel player Abu Farchi given a red card vs Austria in UEFA Nations League?", "The Hindu", "quality", "explained"),
    ("1790311788.pdf - Drishti IAS", "Drishti IAS", "examprep", "news"),
    ("Indian Railways approves new tri-weekly Amrit Bharat Express between Bhuj in Gujarat & Barauni in Bihar", "DD News", "official", "news"),
])
def test_not_upsc_material_is_rejected(clf, title, publisher, tier, kind):
    a = clf.analyze(title, publisher=publisher, day="2026-09-26")
    assert clf.grade(clf.score(a, tier, kind)) == "LOW", (a.noise, a.rejected, a.foreign, a.foreign_local, a.subjects)


def test_republished_old_video_is_rejected(clf):
    a = clf.analyze("Watch: Telegram under fire: NTA's crackdown explained | Above the Fold | 17.06.2026",
                    publisher="The Hindu", day="2026-09-25")
    assert a.rejected == "old material republished" and clf.grade(clf.score(a, "quality", "explained")) == "LOW"


# ── …and what must stay: the near misses these rules were tuned against ──
@pytest.mark.parametrize("title,summary,publisher,tier,kind", [
    ("Supreme Court Reserves Judgment On Sambhal Mosque Committee's Plea Against Survey Order", "", "Live Law", "quality", "news"),
    ("Centre extends AFSPA in parts of Manipur, Nagaland and Arunachal Pradesh for six months", "", "Economic Times", "quality", "news"),
    ("Arguments by serial practitioner of terrorism will not stand: EAM Jaishankar slams Pakistan at UNGA", "", "Hindustan Times", "quality", "news"),
    ("Expert Explains | Why the Trump-Xi bonhomie doesn't mean an end to US and China's rivalry", "", "Indian Express", "quality", "explained"),
    ("Statement on the attack on a commercial vessel off the coast of Oman", "", "Ministry of External Affairs", "official", "news"),
    ("Merchant Discount Rate on UPI not a tax, cess or surcharge; will not burden consumers: FM",
     "The Finance Minister assured that the MDR will not be passed on to consumers.", "BusinessLine", "quality", "news"),
    ("Infra projects see cost overrun of Rs 2.88 lakh crore in August: MoSPI", "", "Economic Times", "quality", "news"),
    ("S.413 BNSS | Victim's Appeal Against Acquittal By Magistrate Lies Before Sessions Court : Supreme Court", "", "Live Law", "quality", "news"),
    ("Deendayal Port Authority, Assam Petro-Chemicals lay foundation stone for ₹2,300-crore e-methanol plant in Gujarat",
     "India's first port-based green methanol plant will supply green fuel to ships.", "BusinessLine", "quality", "news"),
    ("Three rescued bear cubs begin journey back to wild in Arunachal's Pakke Tiger Reserve", "", "India Today NE", "general", "news"),
    ("Bengaluru's missing corporators: A six-year democratic vacuum",
     "Bengaluru has had no elected council for six years, weakening local self-government under the 74th Amendment.",
     "Deccan Herald", "quality", "editorial"),
    ("Bangladesh, US sign MoU on strategic civil nuclear cooperation", "", "Economic Times", "quality", "news"),
])
def test_upsc_material_is_kept(clf, title, summary, publisher, tier, kind):
    a = clf.analyze(title, summary, publisher=publisher, day="2026-09-26")
    assert clf.grade(clf.score(a, tier, kind)) != "LOW", (clf.score(a, tier, kind), a.noise, a.rejected, a.foreign_local)


def test_rejected_story_stays_rejected_however_widely_carried(clf):
    rejected = clf.score(clf.analyze("Auction of 91-Day, 182-Day and 364-Day Treasury Bills", publisher="RBI"), "official")
    assert clf.grade(clf.story_score(rejected, 12)) == "LOW"
    assert clf.story_score(1.0, 4) > 1.0  # a merely weak story still gets its coverage bonus


def test_watch_areas_need_india_and_subject_gate(clf):
    maine = clf.analyze("Maine Blue Economy Week to spotlight ocean innovation", publisher="Mainebiz")
    assert "marine" not in maine.watch
    upi = clf.analyze("How MDR on UPI works for small merchants", "The charge applies to high-value UPI payments.")
    assert "dpi" in upi.watch and upi.india
    blank = clf.analyze("Some headline with nothing in it")
    assert not blank.subjects and clf.grade(clf.score(blank, "official")) == "LOW"
    assert clf.score(blank, "library") > clf.reject_score  # library pages are not gated

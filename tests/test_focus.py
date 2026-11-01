"""Today's focus (pipeline/focus.py): the day's brief ranked for a reading-time budget, related pieces under their card."""
import json
import re
from datetime import datetime, timezone

from upsc_intel.pipeline import focus as F
from upsc_intel.pipeline.normalize import today_ist

DAY = today_ist()


class Jaccard:
    """A stand-in for pipeline/brief.py's _Rarity: shared words over all words."""
    def similar(self, a, b):
        return len(a & b) / len(a | b) if a and b else 0.0


def it(title, **kw):
    return {"title": title, "tokens": re.findall(r"[a-z0-9]+", title.lower()), "grade": "SKIM", "up": 2, "news": True,
            "fact": False, "n_pub": 1, "tier": "general", "syl": [], "topics": [], "event": 0.0, "talk": 0.0, "soft": False, **kw}


def test_value_puts_gemini_s_grade_first_then_the_event_and_marks_down_routine_and_notices():
    assert F.value(it("Cabinet approves a scheme", up=3), "more") > F.value(it("Cabinet approves a scheme", up=2), "more")
    assert F.value(it("Parliament passes the Mines Bill", up=3, event=2.0), "news") > F.value(it("Minister speaks on mines", up=3), "news")
    assert F.value(it("Minister slams rivals", talk=2.0), "more") < F.value(it("Minister unveils a plan"), "more")
    assert F.value(it("Last date for applications under the scholarship scheme"), "prelims") < F.FACT_MIN
    assert F.value(it("Premature redemption under Sovereign Gold Bond Scheme: redemption price", up=3), "news") < F.CARD_FLOOR
    assert F.value(it("Punjab Cabinet approves service rules for a new cadre"), "prelims") < F.value(it("Centre approves service rules"), "prelims")
    assert F.value(it("Regional workshop under PMAY-G held in Lucknow", event=1.5), "more") < F.value(it("PMAY-G target raised", event=1.5), "more")
    wide = F.value(it("Exercise held", n_pub=40), "more") - F.value(it("Exercise held"), "more")
    assert 0 < wide <= 0.75  # widely reported counts, but a republished release can't outrank a better story


def test_related_pieces_go_under_their_card_and_two_cards_are_never_merged():
    items = {
        "c1": it("ISRO launches NVS-03 navigation satellite NavIC", up=3, event=1.5),
        "c2": it("Quad leaders summit in Manila next month", up=3),
        "c3": it("BRICS summit New Delhi declaration adopted", up=3, event=1.0),
        "x1": it("NVS-03 navigation satellite NavIC explained", grade="NOTE", up=3),
        "e1": it("BRICS summit New Delhi declaration and the Global South", grade="NOTE", up=3),
        "f1": it("Exercise Austrahind India Australia troops", fact=True),
        "f2": it("Exercise Austrahind India Australia troops conclude", fact=True),  # the same fact again
        "l1": it("RBI revises capital adequacy norms for banks", up=3),
        "l2": it("Last date for scholarship applications", up=2),
        "r1": it("When someone does your push ups", grade="READ", up=1),
        "g1": it("Glacial lake outburst floods meaning causes", up=3, news=False),
    }
    day = {"news": ["c2", "c1", "c3"], "prelims": ["f1", "f2"], "more": ["l1", "l2", "g1"], "editorials": ["e1", "r1"],
           "explained": ["x1"]}
    f = F.focus_day(day, items, Jaccard())
    assert sorted(f["cards"]) == ["c1", "c2", "c3"] and f["cards"][0] == "c1"  # three cards, best first
    assert f["attach"]["c1"] == ["x1"] and f["attach"]["c3"] == ["e1"]  # the explainer and the editorial on its event
    assert f["facts"] == ["f1"] and f["attach"]["f1"] == ["f2"]  # a Prelims fact, its repeat folded under it
    assert f["lines"] == ["l1"]  # the news line; the notice is out
    assert f["eds"] == []  # the READ op-ed isn't in the focus (the other editorial is under its card)
    assert f["bg"] == ["g1"]  # an evergreen piece is a background read, not a line
    assert set(f["must"]) == {"c1", "c2", "c3"}
    assert f["min"] == {"c1": 3, "c2": 3, "c3": 3, "g1": 3}  # each full read's minutes, as the cards show them


def test_minutes_match_the_cards_estimate():
    assert F.minutes(it("A", grade="NOTE", n_pub=6), "editorials") == 8
    assert F.minutes(it("A"), "explained") == 5 and F.minutes(it("A", grade="NOTE"), "news") == 4


def test_a_must_know_card_that_is_a_routine_notice_is_not_guaranteed():
    items = {"c1": it("India Australia defence partnership", up=3, event=1.0),
             "c2": it("Premature redemption under Sovereign Gold Bond Scheme redemption price", up=3)}
    f = F.focus_day({"news": ["c2", "c1"]}, items, Jaccard())
    assert f["cards"] == ["c1", "c2"] and f["must"] == ["c1"]


def test_editorials_and_background_reads_are_one_per_topic():
    items = {"e1": it("The collegium cannot remain a closed door affair", grade="NOTE", up=3),
             "e2": it("The collegium cannot remain secret", grade="SKIM", up=2),
             "e3": it("Climate finance after the COP", grade="SKIM", up=2)}
    f = F.focus_day({"editorials": ["e2", "e1", "e3"]}, items, Jaccard())
    assert f["eds"] == ["e1", "e3"] and f["attach"]["e1"] == ["e2"]


def test_each_day_of_the_brief_carries_its_focus(db, settings, clf):
    from upsc_intel.web.app import brief_payload
    now = datetime.now(timezone.utc).isoformat()
    for sid, title, grade in (("a", "Parliament passes the Mines and Minerals Amendment Bill", "NOTE"),
                              ("b", "Exercise Garuda Shakti 2026 begins with France", "SKIM")):
        db.upsert_story({"id": sid, "title": title, "url": f"https://pib.gov.in/{sid}", "date_ist": DAY, "dates": [DAY],
                         "first_seen": now, "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1,
                         "publishers": ["PIB"], "subjects": ["polity"], "gs": ["GS2"], "tags": [], "watch": [], "score": 8.0,
                         "grade": grade, "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0,
                         "tier": "official", "summary": title, "tokens": re.findall(r"\w+", title.lower())})
    db.x("UPDATE stories SET triage=? WHERE id='a'", (json.dumps({"upsc": 3, "news": True}),))
    db.save_brief(DAY, [("a", "news", 1, "top"), ("b", "news", 2, "prelims")])
    db.commit()
    p = brief_payload(settings, db, clf, DAY, DAY)
    f = p["days"][DAY]["focus"]
    assert f["cards"] == ["a"] and f["must"] == ["a"] and f["facts"] == ["b"] and f["lines"] == []
    week = brief_payload(settings, db, clf, DAY, DAY, full=False)
    assert "focus" not in week["days"][DAY]  # a week or month review carries only the cards

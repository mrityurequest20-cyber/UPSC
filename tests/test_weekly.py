"""The week's Mains writing set (pipeline/weekly.py) and the syllabus topics' Mains bank (pipeline/syllabus.py)."""
import json
import re
from datetime import date, datetime, timedelta, timezone

from upsc_intel.pipeline import syllabus as S
from upsc_intel.pipeline import weekly as W

MONDAY = "2026-09-28"


class Resp:
    def __init__(self, status, data=None):
        self.status_code, self._data = status, data or {}
        self.text = json.dumps(self._data)

    def json(self):
        return self._data


REPLY = {"essays": [{"section": "A", "topic": "Not all who wander are lost", "angles": ["Exploration", "Doubt"], "links": [1, 99]},
                    {"section": "B", "topic": "Federalism is a conversation, not a contract", "angles": ["Finance Commission"], "links": [2]},
                    {"section": "C", "topic": "A bad section", "angles": [], "links": []}],
         "case": {"title": "The flooded district", "scenario": "You are the District Collector of a flood-hit district. " * 8,
                  "questions": ["Who are the stakeholders?", "What are your options?", "What will you do and why?"], "links": [3]},
         "ethics": {"question": "What does accountability mean for a public servant in a disaster?", "links": [3]}}


class FakeGemini:
    def __init__(self, reply=REPLY):
        self.reply, self.calls = reply, []

    def get(self, url, headers=None, params=None):
        return Resp(200, {"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]})

    def post(self, url, headers=None, json=None):
        self.calls.append(json)
        return Resp(200, {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": __import__("json").dumps(self.reply)}]}}]})


def story(db, sid, title, day, ai=None, subjects=("polity",), brief=True):
    now = datetime.now(timezone.utc).isoformat()
    db.upsert_story({"id": sid, "title": title, "url": f"https://www.thehindu.com/{sid}", "date_ist": day, "dates": [day],
                     "first_seen": now, "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1, "publishers": ["The Hindu"],
                     "subjects": list(subjects), "gs": ["GS2"], "tags": [], "watch": [], "score": 5.0, "grade": "NOTE",
                     "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0, "tier": "national",
                     "summary": title, "tokens": re.findall(r"\w+", title.lower())})
    if ai:
        db.x("UPDATE stories SET ai=? WHERE id=?", (json.dumps(ai), sid))
    if brief:
        db.save_brief(day, [(sid, "news", 1, "top")])


def week(db, n=10):
    by = {}
    for i in range(n):
        d = (date.fromisoformat(MONDAY) - timedelta(days=i % 7)).isoformat()
        story(db, f"s{i}", f"Story number {i} about the Finance Commission", d, ai={"points": [f"Point {i}."]}, brief=False)
        by.setdefault(d, []).append(f"s{i}")
    for d, ids in by.items():  # a day's brief is saved whole
        db.save_brief(d, [(sid, "news", n, "top") for n, sid in enumerate(ids, 1)])
    db.commit()


def test_the_week_is_its_monday():
    assert W.week_of("2026-09-28") == "2026-09-28" and W.week_of("2026-10-04") == "2026-09-28" and W.week_of("2026-10-05") == "2026-10-05"


def test_the_weekly_set_is_written_once_from_the_weeks_news(db, settings):
    settings.gemini_api_key = "test-key"
    week(db)
    http = FakeGemini()
    res = W.build_weekly(settings, db, today=MONDAY, http=http)
    assert res == {"week": MONDAY, "written": True}
    prompt = http.calls[0]["contents"][0]["parts"][0]["text"]
    assert "1. 2026-09-28: Story number 0 about the Finance Commission. Point 0." in prompt  # the latest first, with its note's line
    p = W.weekly_payload(db)
    w = p["weeks"][0]
    assert w["week"] == MONDAY and [e["section"] for e in w["essays"]] == ["A", "B"]  # a section that isn't A or B is dropped
    # numbered the latest day first, in brief order: 1 s0, 2 s7 (both Monday), 3 s1 (Sunday)…; a number out of range is dropped
    assert w["essays"][0]["links"] == ["s0"] and w["essays"][1]["links"] == ["s7"] and w["case"]["links"] == ["s1"]
    assert w["ethics"]["question"].startswith("What does")
    assert set(w["stories"]) == {"s0", "s7", "s1"} and w["stories"]["s0"]["t"].startswith("Story number 0")
    assert W.build_weekly(settings, db, today="2026-10-01", http=http) == {"week": MONDAY, "have": True} and len(http.calls) == 1


def test_the_set_draws_on_every_day_of_the_week_not_just_the_busiest(db, settings):
    busy = [(f"b{i}", MONDAY) for i in range(20)]  # a busy Monday: 20 Must-know cards
    rest = [(f"d{i}", (date.fromisoformat(MONDAY) - timedelta(days=i)).isoformat()) for i in range(1, 7)]
    for sid, d in busy + rest:
        story(db, sid, f"Story {sid}", d, brief=False)
    db.save_brief(MONDAY, [(sid, "news", n, "top") for n, (sid, _) in enumerate(busy, 1)])
    for sid, d in rest:
        db.save_brief(d, [(sid, "news", 1, "top")])
    story(db, "old", "Story from eight days ago", (date.fromisoformat(MONDAY) - timedelta(days=7)).isoformat())
    db.commit()
    got = W._stories(db, MONDAY)
    assert [x["id"] for x in got[:W.PER_DAY]] == [f"b{i}" for i in range(W.PER_DAY)]  # the day's top cards, in brief order
    assert {x["day"] for x in got} == {MONDAY} | {d for _, d in rest} and len(got) == W.PER_DAY + 6 and "old" not in {x["id"] for x in got}


def test_a_thin_week_waits_and_an_incomplete_reply_is_not_kept(db, settings):
    settings.gemini_api_key = "test-key"
    week(db, n=3)
    assert W.build_weekly(settings, db, today=MONDAY, http=FakeGemini())["waiting"] == 3
    week(db, n=12)
    bad = {**REPLY, "case": {"title": "x", "scenario": "Too short.", "questions": ["Q?"], "links": []}}
    assert W.build_weekly(settings, db, today=MONDAY, http=FakeGemini(bad))["skipped"] == "incomplete"
    assert db.q("SELECT * FROM weekly") == []
    settings.gemini_api_key = None
    assert W.build_weekly(settings, db, today=MONDAY) == {"enabled": False}


def test_a_topics_mains_bank_holds_judgments_reports_and_data(db, settings):
    pts = ["The Supreme Court ruled that the Election Commission must publish the deleted names.",
           "A parliamentary committee report flagged gaps in the revision of the rolls.",
           "About 65 lakh names were removed from the draft roll in Bihar.",
           "The Commission said it will hold meetings with parties."]
    story(db, "ec1", "Election Commission revises the electoral rolls", MONDAY, ai={"points": pts})
    db.commit()
    p = S.syllabus_payload(settings, db, today=MONDAY)
    bank = p["topics"]["gs2-election-commission"]["bank"]
    assert [x["x"] for x in bank["cases"]] == [pts[0]] and [x["x"] for x in bank["reports"]] == [pts[1]] and [x["x"] for x in bank["data"]] == [pts[2]]
    assert bank["data"][0] == {"x": pts[2], "id": "ec1", "d": MONDAY}
    assert "bank" in p["topics"]["gs3-space"] and p["topics"]["gs3-space"]["bank"] == {}

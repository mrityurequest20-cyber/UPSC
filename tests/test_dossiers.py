"""Dossiers and the places map (pipeline/dossiers.py): running stories with their timelines and story so far, and the
last month's cards by place."""
import json
import re
from datetime import date, datetime, timedelta, timezone

from upsc_intel.pipeline import dossiers as D
from upsc_intel.pipeline.normalize import today_ist

DAY = today_ist()  # the API reads today


def ago(n):
    return (date.fromisoformat(DAY) - timedelta(days=n)).isoformat()


class Resp:
    def __init__(self, status, data=None):
        self.status_code, self._data = status, data or {}
        self.text = json.dumps(self._data)

    def json(self):
        return self._data


class FakeGemini:
    """A story so far for each numbered topic, naming the topic's number."""
    def __init__(self):
        self.calls = []

    def get(self, url, headers=None, params=None):
        return Resp(200, {"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]})

    def post(self, url, headers=None, json=None):
        self.calls.append(json)
        prompt = json["contents"][0]["parts"][0]["text"]
        items = [{"n": int(n), "so_far": [f"Topic {n} began.", f"Topic {n} moved on."], "upsc": ["GS2: polity."],
                  "watch": ["The verdict."], "gs": ["GS2", "GS9"]} for n in re.findall(r"^(\d+)\. ", prompt, re.M)]
        text = __import__("json").dumps({"items": items})
        return Resp(200, {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": text}]}}]})


def story(db, sid, title, day, grade="NOTE", topics=(), places=(), private=0, body="", triage=None):
    now = datetime.now(timezone.utc).isoformat()
    db.upsert_story({"id": sid, "title": title, "url": f"https://www.thehindu.com/{sid}", "date_ist": day, "dates": [day], "first_seen": now,
                     "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1, "publishers": ["The Hindu"],
                     "subjects": ["polity"], "gs": ["GS2"], "tags": [], "watch": [], "score": 5.0, "grade": grade,
                     "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": private, "tier": "national",
                     "summary": f"{title}. {body}", "tokens": re.findall(r"\w+", title.lower())})
    if topics or places:
        db.x("UPDATE stories SET extras=? WHERE id=?", (json.dumps({"places": list(places), "topics": list(topics)}), sid))
    if triage is not None:
        db.x("UPDATE stories SET triage=? WHERE id=?", (json.dumps({"upsc": triage}), sid))
    db.insert_item({"id": f"i-{sid}", "source_id": "hindu", "title": title, "summary": body, "date_ist": day, "story_id": sid,
                    "is_private": private})


def topic(db, key, name, query, first, last, n=1):
    db.x("INSERT INTO topics (key, name, query, first_day, last_day, n) VALUES (?,?,?,?,?,?)", (key, name, query, first, last, n))


def seed(db):
    story(db, "w1", "Lok Sabha passes the Waqf (Amendment) Bill", ago(10), topics=["waqf"])
    story(db, "w2", "Supreme Court hears the Waqf Act challenge", ago(3), grade="SKIM")   # found by its words
    story(db, "w3", "Waqf board row in Kerala", ago(2), grade="READ")                      # found, but only background
    story(db, "w4", "SC reserves verdict on the Waqf Act", DAY, topics=["waqf"])
    story(db, "w5", "Minority affairs ministry notes", ago(1), body="The Waqf rules are due.")  # the headline doesn't say it
    story(db, "w6", "Waqf Bill introduced", ago(60), topics=["waqf"])                      # too old
    story(db, "w7", "Waqf: a subscriber's analysis", ago(1), topics=["waqf"], private=1)   # never on the public site
    story(db, "c1", "Cheetahs moved to Gandhi Sagar", ago(1), topics=["cheetah"])           # one story: no dossier
    topic(db, "waqf", "Waqf (Amendment) Act", "Waqf", ago(60), DAY, 3)
    topic(db, "cheetah", "Project Cheetah", "cheetah cheetahs", ago(1), ago(1))
    topic(db, "old", "An old topic", "old", ago(80), ago(40))
    db.commit()


def test_a_dossier_is_its_timeline_and_story_so_far(db, settings):
    seed(db)
    p = D.dossiers_payload(settings, db, DAY)
    assert [d["key"] for d in p["dossiers"]] == ["waqf"]  # the Cheetah topic has one story; the old one is out of date
    w = p["dossiers"][0]
    assert [x["id"] for x in w["timeline"]] == ["w4", "w2", "w1"] and (w["n"], w["days"]) == (3, 3)
    assert (w["first_day"], w["last_day"], w["summary"], w["fresh"]) == (ago(10), DAY, None, False)
    assert w["timeline"][0]["line"].startswith("SC reserves verdict") and w["timeline"][1]["tagged"] is False
    settings.gemini_api_key = "test-key"
    http = FakeGemini()
    assert D.build_dossiers(settings, db, DAY, http=http, pause=0) == {"dossiers": 1, "written": 1, "calls": 1, "left": 0}
    prompt = http.calls[0]["contents"][0]["parts"][0]["text"]
    assert prompt.index("Lok Sabha passes") < prompt.index("SC reserves verdict")  # oldest first
    w = D.dossiers_payload(settings, db, DAY)["dossiers"][0]
    assert w["fresh"] and w["summary"]["so_far"] == ["Topic 1 began.", "Topic 1 moved on."] and w["summary"]["gs"] == ["GS2"]
    assert w["summary"]["day"] == DAY and w["summary"]["by"]
    # written once: the same timeline isn't summarised again
    assert D.build_dossiers(settings, db, DAY, http=http, pause=0)["calls"] == 0 and len(http.calls) == 1
    # a new story changes the timeline: the old summary shows (not fresh) until the next is written
    story(db, "w8", "Waqf Act verdict today", DAY, topics=["waqf"])
    db.commit()
    assert D.dossiers_payload(settings, db, DAY)["dossiers"][0]["fresh"] is False
    assert D.build_dossiers(settings, db, DAY, http=http, pause=0)["calls"] == 0  # written within the last 6 hours: it waits
    db.x("UPDATE topics SET at='2020-01-01T00:00:00+00:00'")
    db.commit()
    assert D.build_dossiers(settings, db, DAY, http=http, pause=0)["written"] == 1


def test_with_ai_grades_a_found_story_needs_a_2(db, settings):
    seed(db)
    db.x("UPDATE stories SET triage=? WHERE id='w3'", (json.dumps({"upsc": 2}),))
    db.x("UPDATE stories SET triage=? WHERE id='w2'", (json.dumps({"upsc": 0}),))
    db.commit()
    settings.ai_triage = "on"
    w = D.dossiers_payload(settings, db, DAY)["dossiers"][0]
    assert [x["id"] for x in w["timeline"]] == ["w4", "w3", "w1"] and w["timeline"][1]["grade"] == "SKIM"


def test_no_key_keeps_the_timeline(db, settings):
    seed(db)
    assert D.build_dossiers(settings, db, DAY) == {"dossiers": 1, "written": 0, "calls": 0, "left": 1}


def test_the_places_map(db, settings, clf):
    story(db, "k1", "Floods in Kerala", ago(1), places=["kerala|india"])
    story(db, "k2", "Kerala's new port", DAY, places=["kerala|india", "vizhinjam|india"])
    story(db, "u1", "India–UAE trade talks", ago(5), places=["abu dhabi|united arab emirates"])
    story(db, "old", "Kerala in 2025", ago(45), places=["kerala|india"])
    story(db, "pv", "Kerala: premium", DAY, places=["kerala|india"], private=1)
    for k, n, c, lat, lon in [("kerala|india", "Kerala", "India", 10.5, 76.3), ("vizhinjam|india", "Vizhinjam", "India", 8.38, 76.99),
                              ("abu dhabi|united arab emirates", "Abu Dhabi", "United Arab Emirates", 24.45, 54.38)]:
        db.x("INSERT INTO places (key, name, kind, country, state, lat, lon) VALUES (?,?,?,?,?,?,?)", (k, n, "city", c, "", lat, lon))
    db.commit()
    p = D.places_payload(settings, db, DAY)
    assert [x["name"] for x in p["places"]] == ["Kerala", "Abu Dhabi", "Vizhinjam"]  # most stories first
    assert p["places"][0]["ids"] == ["k2", "k1"] and (p["places"][0]["lat"], p["places"][0]["lon"]) == (10.5, 76.3)
    assert set(p["stories"]) == {"k1", "k2", "u1"} and p["stories"]["k2"]["day"] == DAY  # not the old or private ones
    assert (p["from"], p["to"]) == (ago(30), DAY)


def test_the_api_and_the_brief_link_dossiers(db, settings, clf):
    from fastapi.testclient import TestClient
    from upsc_intel.web.app import brief_payload, create_app
    seed(db)
    db.save_brief(DAY, [("w4", "news", 1, "top")])
    db.commit()
    card = [s for s in brief_payload(settings, db, clf, DAY, DAY)["stories"] if s["id"] == "w4"][0]
    assert "topics" not in card  # not linked before the build has seen it make a dossier
    settings.gemini_api_key = "test-key"
    D.build_dossiers(settings, db, DAY, http=FakeGemini(), pause=0)
    card = [s for s in brief_payload(settings, db, clf, DAY, DAY)["stories"] if s["id"] == "w4"][0]
    assert card["topics"] == [{"k": "waqf", "n": "Waqf (Amendment) Act"}]
    w = D.dossiers_payload(settings, db, DAY)["dossiers"][0]["timeline"]
    assert [x["card"] for x in w] == [True, False, False]  # w4 is a brief card; w2 and w1 aren't
    with TestClient(create_app(settings, scheduler=False)) as c:
        assert [d["key"] for d in c.get("/api/dossiers").json()["dossiers"]] == ["waqf"]
        assert c.get("/api/places").json()["places"] == []

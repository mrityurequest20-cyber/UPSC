"""Glossary (pipeline/glossary.py): Gemini picks each brief card's key terms with a short meaning, once; the day's
brief carries them for the pages to mark."""
import json
import re
from datetime import datetime, timezone

from upsc_intel.pipeline import glossary as G

DAY = "2026-09-27"


class Resp:
    def __init__(self, status, data=None):
        self.status_code, self._data = status, data or {}
        self.text = json.dumps(self._data)

    def json(self):
        return self._data


class FakeGemini:
    """Terms by headline: every card gets "Article 142" and "CEPA" (whether or not its text has them) plus a term with
    a too-short meaning; each card's meaning of CEPA names its number (the first one kept stays)."""
    def __init__(self):
        self.calls = []

    def get(self, url, headers=None, params=None):
        return Resp(200, {"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]})

    def post(self, url, headers=None, json=None):
        self.calls.append(json)
        prompt = json["contents"][0]["parts"][0]["text"]
        items = []
        for m in re.finditer(r"^(\d+)\. (.+)$", prompt, re.M):
            n = int(m.group(1))
            items.append({"n": n, "terms": [
                {"term": "Article 142", "meaning": "Lets the Supreme Court pass any order needed to do complete justice in a case."},
                {"term": "CEPA", "meaning": f"Comprehensive Economic Partnership Agreement (version {n}): a broad trade pact."},
                {"term": "RBI", "meaning": "Short."}]})
        text = __import__("json").dumps({"items": items})
        return Resp(200, {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": text}]}}]})


def story(db, sid, title, summary, ai=None):
    now = datetime.now(timezone.utc).isoformat()
    db.upsert_story({"id": sid, "title": title, "url": f"https://pib.gov.in/{sid}", "date_ist": DAY, "dates": [DAY], "first_seen": now,
                     "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1, "publishers": ["PIB"],
                     "subjects": ["polity"], "gs": ["GS2"], "tags": [], "watch": [], "score": 6.0, "grade": "NOTE",
                     "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0, "tier": "official",
                     "summary": summary, "tokens": re.findall(r"\w+", title.lower())})
    if ai:
        db.x("UPDATE stories SET ai=? WHERE id=?", (json.dumps(ai), sid))


def seed(db):
    story(db, "sc", "Supreme Court invokes Article 142 in the Waqf case", "The bench used Article 142 to end the dispute.")
    story(db, "fta", "India and UAE review CEPA gains", "", ai={"by": "Gemini", "points": ["Trade under CEPA crossed $100 billion.",
                                                                                                "Article 142 is not involved here."]})
    story(db, "plain", "Monsoon arrives in Kerala", "The IMD said the monsoon set in over Kerala.")
    db.save_brief(DAY, [("sc", "news", 1, "top"), ("fta", "news", 2, "prelims"), ("plain", "news", 3, "top"),
                        ("gone", "news", 4, "more")])  # a list line gets no glossary
    db.commit()


def test_terms_are_found_once_and_kept(db, settings):
    seed(db)
    settings.gemini_api_key = "test-key"
    http = FakeGemini()
    res = G.build_glossary(settings, db, [DAY], http=http, pause=0)
    assert res == {"enabled": True, "cards": 3, "terms": 2, "calls": 1, "left": 0}
    prompt = http.calls[0]["contents"][0]["parts"][0]["text"]
    assert "1. Supreme Court invokes Article 142 in the Waqf case. The bench used Article 142" in prompt  # Must-know first
    assert "Trade under CEPA crossed $100 billion." in prompt  # a card's AI note's points are its text
    terms = {r["id"]: json.loads(r["terms"]) for r in db.q("SELECT id, terms FROM stories")}
    assert terms == {"sc": ["article 142"], "fta": ["article 142", "cepa"], "plain": []}  # only terms its text carries
    g = G.glossary_for(db, ["article 142", "cepa", "rbi", "nope"])
    assert set(g) == {"article 142", "cepa"} and g["cepa"]["t"] == "CEPA"  # a too-short meaning is dropped
    assert "version 3" in g["cepa"]["m"]  # (the Prelims-facts card comes after the two Must-know ones)
    # asked once: a card with terms (or with none) isn't asked again
    assert G.build_glossary(settings, db, [DAY], http=http, pause=0)["calls"] == 0 and len(http.calls) == 1
    # a new card later keeps the first meaning of a known term
    story(db, "fta2", "CEPA talks with Oman begin", "India and Oman start CEPA talks.")
    db.save_brief(DAY, [("sc", "news", 1, "top"), ("fta", "news", 2, "prelims"), ("fta2", "news", 3, "top")])
    db.commit()
    assert G.build_glossary(settings, db, [DAY], http=http, pause=0)["terms"] == 0
    assert "version 3" in G.glossary_for(db, ["cepa"])["cepa"]["m"]


def test_the_day_brief_carries_its_cards_glossary(db, settings, clf):
    from upsc_intel.web.app import brief_payload
    seed(db)
    settings.gemini_api_key = "test-key"
    G.build_glossary(settings, db, [DAY], http=FakeGemini(), pause=0)
    p = brief_payload(settings, db, clf, DAY, DAY)
    assert set(p["days"][DAY]["glossary"]) == {"article 142", "cepa"}
    assert p["days"][DAY]["glossary"]["article 142"]["m"].startswith("Lets the Supreme Court")
    assert "glossary" not in brief_payload(settings, db, clf, DAY, DAY, full=False)["days"][DAY]  # a review: cards only


def test_no_key_no_calls(db, settings):
    seed(db)
    settings.gemini_api_key = None
    assert G.build_glossary(settings, db, [DAY]) == {"enabled": False}

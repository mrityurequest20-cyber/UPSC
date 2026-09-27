"""Gemini (a free Google AI Studio key) writing the brief cards' study notes (pipeline/enrich.py)."""
import json
from datetime import datetime, timezone

from upsc_intel.pipeline import enrich as E

ARTICLE = ["NEW DELHI: The Tamil Nadu government has exempted the Public (Law and Order) Department from the ambit of the "
           "Right to Information Act, classifying it as an intelligence and security organisation under Section 24(4).",
           "A Gazette notification issued on September 26 places the department under the exemption framework.",
           "Even exempted bodies must disclose information on allegations of corruption and human-rights violations.",
           "Tamil Nadu has used the provision before for the State Vigilance Commission and 17 other bodies."]
NOTE = {"headline": "Tamil Nadu exempts its law and order department from RTI", "what": "The State exempted the department.",
        "points": ["Tamil Nadu exempted the Public (Law and Order) Department from the RTI Act under Section 24(4).",
                   "The Gazette notification is dated September 26.",
                   "Exempted bodies must still disclose information on corruption and human-rights violations.",
                   "The State has used the provision for 17 other bodies before.",
                   "The move affects 4,500 pending RTI applications."],  # a figure the article doesn't have
        "why_in_news": "A Gazette notification.", "background": "Section 24 of the RTI Act, 2005 lists exempt organisations.",
        "significance": ["Transparency", "Federalism"], "prelims": ["Section 24(4) of the RTI Act", "Exempted in 2019"],
        "mains": "Discuss.", "gs": ["GS2"], "keywords": ["RTI"], "when": "26 Sep", "where": "Tamil Nadu", "who": "State govt",
        "video_query": "RTI section 24 exemption explained", "insufficient": False}


class Resp:
    def __init__(self, status, data=None):
        self.status_code, self._data = status, data or {}
        self.text = json.dumps(self._data)

    def json(self):
        return self._data


class FakeGemini:
    """Answers the models list and generateContent; `busy` models answer 429 (quota used up)."""
    def __init__(self, busy=(), reply=NOTE):
        self.busy, self.reply, self.calls = set(busy), reply, []

    def get(self, url, headers=None, params=None):
        self.calls.append(("GET", url, headers))
        names = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.5-flash-image",
                 "text-embedding-004", "gemini-1.5-flash"]
        return Resp(200, {"models": [{"name": f"models/{n}", "supportedGenerationMethods":
                                      ["embedContent"] if "embedding" in n else ["generateContent"]} for n in names]})

    def post(self, url, headers=None, json=None):
        self.calls.append(("POST", url, headers))
        model = url.split("/models/")[1].split(":")[0]
        if model in self.busy:
            return Resp(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}})
        assert json["generationConfig"]["responseMimeType"] == "application/json"
        assert json["generationConfig"]["responseSchema"]["properties"]["points"]["type"] == "ARRAY"
        return Resp(200, {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": __import__("json").dumps(self.reply)}]}}]})


def card(db, sid="tn"):
    now = datetime.now(timezone.utc).isoformat()
    db.upsert_story({"id": sid, "title": "Tamil Nadu government exempts Public (Law and Order) Department from RTI Act",
                     "url": "https://timesofindia.indiatimes.com/x.cms", "date_ist": "2026-09-27", "dates": ["2026-09-27"],
                     "first_seen": now, "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1,
                     "publishers": ["Times of India"], "subjects": ["polity"], "gs": ["GS2"], "tags": [], "watch": [], "score": 9,
                     "grade": "NOTE", "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0, "tier": "quality",
                     "summary": "", "tokens": []})
    db.save_brief("2026-09-27", [(sid, "news", 1, "top", None)])
    db.save_article(sid, {"url": "https://timesofindia.indiatimes.com/x.cms", "domain": "timesofindia.indiatimes.com", "via": "",
                          "paragraphs": ARTICLE, "points": ["quoted"], "fetched_at": now, "published": "2026-09-27"})
    db.commit()
    return {"id": sid, "title": "Tamil Nadu government exempts Public (Law and Order) Department from RTI Act", "dates": ["2026-09-27"]}


def test_the_best_flash_models_first():
    names = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-3-flash-preview",
             "gemini-flash-latest", "gemini-2.5-flash-image"]
    assert E.rank_models(names) == ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"]
    assert E.rank_models([]) == E.GEMINI_FALLBACK


def test_schema_is_in_geminis_form():
    g = E.gemini_schema(E.SCHEMA)
    assert g["type"] == "OBJECT" and g["properties"]["gs"]["items"] == {"type": "STRING", "enum": ["GS1", "GS2", "GS3", "GS4"]}
    assert "additionalProperties" not in g and g["propertyOrdering"][0] == "headline" and "points" in g["required"]


def test_notes_are_written_from_the_full_article_and_a_made_up_figure_is_dropped(db, settings):
    story = card(db)
    settings.gemini_api_key = "test-key"
    http = FakeGemini()
    res = E._enrich_gemini(settings, db, [(story, "news")], pause=0, http=http)
    assert res["enriched"] == 1 and res["models"][0] == "gemini-2.5-flash"
    ai = json.loads(db.q("SELECT ai FROM stories WHERE id='tn'")[0]["ai"])
    assert ai["by"] == "Gemini" and ai["src"] == "article" and ai["model"] == "gemini-2.5-flash"
    assert len(ai["points"]) == 4 and not any("4,500" in p for p in ai["points"])  # the article has no 4,500
    assert ai["prelims"] == ["Section 24(4) of the RTI Act"]  # "2019" isn't in the article either
    sent = [c for c in http.calls if c[0] == "POST"][0]
    assert "key=" not in sent[1] and sent[2]["x-goog-api-key"] == "test-key"  # the key only ever travels in a header


def test_a_used_up_quota_falls_back_then_pauses(db, settings):
    story = card(db)
    settings.gemini_api_key = "test-key"
    res = E._enrich_gemini(settings, db, [(story, "news")], pause=0, http=FakeGemini(busy={"gemini-2.5-flash"}))
    assert res["enriched"] == 1 and json.loads(db.q("SELECT ai FROM stories")[0]["ai"])["model"] == "gemini-2.0-flash"
    db.x("UPDATE stories SET ai=NULL")
    busy = {"gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"}
    res = E._enrich_gemini(settings, db, [(story, "news"), (card(db, "b"), "news")], pause=0, http=FakeGemini(busy=busy))
    assert res["enriched"] == 0 and "quota" in res["paused"] and db.q("SELECT ai FROM stories WHERE ai IS NOT NULL") == []


def test_the_card_summary_uses_the_ai_points_and_names_the_writer(db, settings, clf):
    from upsc_intel.web.app import brief_payload
    card(db)
    ai = {**NOTE, "points": NOTE["points"][:4], "by": "Gemini", "src": "article", "model": "gemini-2.5-flash"}
    db.set_story_ai("tn", ai)
    db.commit()
    p = brief_payload(settings, db, clf, "2026-09-27", "2026-09-27")
    s = next(x for x in p["stories"] if x["id"] == "tn")
    assert s["sum"]["points"] == NOTE["points"][:4] and s["sum"]["by"] == "Gemini" and s["sum"]["domain"] == "timesofindia.indiatimes.com"
    assert s["explain"]["what"] == NOTE["what"] and "points" not in s["explain"] and s["ai"] is None  # sent once, not three times


def test_a_refused_request_stops_the_run_without_marking_cards(db, settings):
    story = card(db)
    settings.gemini_api_key = "test-key"

    class Refuses(FakeGemini):
        def post(self, url, headers=None, json=None):
            return Resp(400, {"error": {"code": 400, "message": "Invalid JSON payload: unknown field"}})
    res = E._enrich_gemini(settings, db, [(story, "news")], pause=0, http=Refuses())
    assert res["enriched"] == 0 and "HTTP 400" in res["paused"] and db.q("SELECT ai FROM stories WHERE ai IS NOT NULL") == []

    class Garbled(FakeGemini):
        def post(self, url, headers=None, json=None):
            return Resp(200, {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"text": '{"headline": "cut'}]}}]})
    res = E._enrich_gemini(settings, db, [(story, "news")], pause=0, http=Garbled())
    assert res["skipped"] == 1 and json.loads(db.q("SELECT ai FROM stories")[0]["ai"])["skipped"] == "bad reply (max_tokens)"

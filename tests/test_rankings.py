"""India's Ranks (pipeline/rankings.py): India's rank in global indices, only as an article states it."""
import json
import re
from datetime import datetime, timezone

from upsc_intel.pipeline import rankings as R

DAY = "2026-09-27"


class Resp:
    def __init__(self, status, data=None):
        self.status_code, self._data = status, data or {}
        self.text = json.dumps(self._data)

    def json(self):
        return self._data


class FakeGemini:
    """Reads the numbered texts: a Hunger Index text → rank 102 of 127 (previously 105), a passport text → rank 77
    (no total), an 'Ocean Health Index' → an index not in the list, a text giving a rank it doesn't state → 58."""
    def __init__(self):
        self.calls = []

    def get(self, url, headers=None, params=None):
        return Resp(200, {"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]})

    def post(self, url, headers=None, json=None):
        self.calls.append(json)
        prompt = json["contents"][0]["parts"][0]["text"]
        items = []
        for m in re.finditer(r"^(\d+)\. (.+)$", prompt, re.M):
            n, t = int(m.group(1)), m.group(2)
            none = {"n": n, "found": False, "index": "", "publisher": "", "edition": "", "rank": 0, "total": 0, "previous": 0, "score": "", "why": []}
            if "Hunger" in t:
                items.append({**none, "found": True, "index": "Global Hunger Index", "publisher": "Concern Worldwide", "edition": "2025",
                              "rank": 102, "total": 127 if "127" in t else 0, "previous": 105, "score": "27.3 (serious)",
                              "why": ["High child wasting pulls the score down.", "Child mortality has improved."]})
            elif "passport" in t.lower():
                items.append({**none, "found": True, "index": "Henley Passport Index", "publisher": "Henley & Partners", "edition": "2026",
                              "rank": 77, "total": 199 if "199" in t else 0, "why": []})
            elif "Ocean" in t:
                items.append({**none, "found": True, "index": "Ocean Health Index", "publisher": "OHI", "edition": "2026", "rank": 40})
            elif "Invented" in t:
                items.append({**none, "found": True, "index": "Global Innovation Index", "publisher": "WIPO", "edition": "2026", "rank": 58})
            else:
                items.append(none)
        text = __import__("json").dumps({"items": items})
        return Resp(200, {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": text}]}}]})


def story(db, sid, title, summary=""):
    now = datetime.now(timezone.utc).isoformat()
    db.upsert_story({"id": sid, "title": title, "url": f"https://www.thehindu.com/{sid}", "date_ist": DAY, "dates": [DAY], "first_seen": now,
                     "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1, "publishers": ["The Hindu"],
                     "subjects": ["social_justice"], "gs": ["GS2"], "tags": [], "watch": [], "score": 5.0, "grade": "SKIM",
                     "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0, "tier": "national",
                     "summary": summary, "tokens": re.findall(r"\w+", title.lower())})


def test_the_prefilter_and_the_checks():
    assert R.looks_like_ranking("India slips to 105th in Global Hunger Index", "")
    assert R.looks_like_ranking("Henley Passport Index 2026 released", "India is at 77.")
    assert not R.looks_like_ranking("Cabinet approves fertiliser subsidy", "India will spend more.")
    assert R.grounded("India ranks 102nd of 127 countries.", 102) and R.grounded("the fourth-largest economy", 4)
    assert not R.grounded("It scored 27.3 points.", 27) and not R.grounded("Rs 1,39 crore", 39) and not R.grounded("x", 0)


def test_live_stories_update_the_tracker(db, settings):
    idx = R.load_indices(settings)
    assert len(idx) >= 30 and R.match_index("Global Hunger Index", idx)["key"] == "hunger"
    story(db, "ghi", "India ranks 102nd in Global Hunger Index 2025", "India is 102nd of 127 countries, up from 105th.")
    story(db, "pp", "Indian passport climbs to 77th", "India's passport is at 77 in the Henley Passport Index.")
    story(db, "ohi", "India at 40th in Ocean Health Index", "India ranked 40.")
    story(db, "fake", "Invented report puts India high in rankings", "No number here.")
    story(db, "cab", "Cabinet approves fertiliser subsidy", "India will spend more on subsidies.")
    db.commit()
    settings.gemini_api_key = "test-key"
    http = FakeGemini()
    res = R.update_rankings(settings, db, [DAY], http=http, pause=0, sweep_limit=0)
    assert res["live"] == {"read": 4, "new": 3, "calls": 1, "left": 0}
    assert "Cabinet approves" not in http.calls[0]["contents"][0]["parts"][0]["text"]  # not a ranking story: not sent
    marks = {r["id"]: json.loads(r["ranking"]) for r in db.q("SELECT id, ranking FROM stories")}
    assert marks["ghi"] == {"key": "hunger", "rank": 102} and marks["cab"] == {} and marks["fake"] == {}  # 58 isn't in its text
    assert R.update_rankings(settings, db, [DAY], http=http, pause=0, sweep_limit=0)["live"]["read"] == 0 and len(http.calls) == 1  # read once
    p = R.rankings_payload(settings, db)
    by = {x["key"]: x for x in p["indices"]}
    ghi = by["hunger"]["latest"]
    assert (ghi["rank"], ghi["total"], ghi["previous"], ghi["edition"], ghi["score"]) == (102, 127, 105, "2025", "27.3 (serious)")
    assert ghi["why"][0].startswith("High child wasting") and ghi["source"] == "The Hindu" and ghi["url"].endswith("/ghi")
    assert by["passport"]["latest"]["rank"] == 77 and by["passport"]["latest"]["total"] is None
    assert by["x_ocean_health"]["area"] == "other"  # an index not in the list starts a new entry
    assert by["innovation"]["latest"] is None  # an ungrounded rank is not kept
    # a second report of the same edition keeps the rank and fills in what was missing
    story(db, "pp2", "Passport index: India 77th of 199", "The Henley Passport Index puts India at 77 of 199.")
    db.commit()
    R.update_rankings(settings, db, [DAY], http=http, pause=0, sweep_limit=0)
    pp = {x["key"]: x for x in R.rankings_payload(settings, db)["indices"]}["passport"]
    assert (pp["latest"]["rank"], pp["latest"]["total"], len(pp["history"])) == (77, 199, 1)


def test_the_sweep_looks_up_indices_in_the_free_news(db, settings, monkeypatch):
    from upsc_intel.pipeline import articles
    settings.gemini_api_key = "test-key"
    searched = []

    def search(http, q):
        searched.append(q)
        if "Hunger" in q:
            return [{"title": "Paywalled", "url": "https://www.hindustantimes.com/premium/x", "date": "2025-10-10", "snippet": ""},
                    {"title": "GHI 2025: India at 102", "url": "https://www.ndtv.com/india-news/ghi", "date": "2025-10-10", "snippet": ""}]
        return []

    def read(http, fr, url):
        assert fr.is_open(url)  # only free sites are opened
        return (["The Global Hunger Index 2025 ranks India 102nd of 127 countries.", "Child wasting remains high.", "It was 105th last year."],
                url, "2025-10-10")
    monkeypatch.setattr(articles, "search_news", search)
    monkeypatch.setattr(articles, "read_page", read)
    real = R.load_indices(settings)
    res = R.update_rankings(settings, db, [DAY], http=FakeGemini(), search_http=object(), pause=0, sweep_limit=3)
    assert res["sweep"] == {"searched": 3, "found": 0} and searched == [f"India rank {i['name']}" for i in real[:3]]
    checks = {r["key"]: r["found"] for r in db.q("SELECT key, found FROM index_checks")}
    assert checks == {i["key"]: "" for i in real[:3]}  # nothing found: looked up again in a week
    R.update_rankings(settings, db, [DAY], http=FakeGemini(), search_http=object(), pause=0, sweep_limit=3)
    assert searched[3:] == [f"India rank {i['name']}" for i in real[3:6]]  # the next three, not the same ones
    monkeypatch.setattr(R, "load_indices", lambda s: [i for i in real if i["key"] == "hunger"])
    res = R.update_rankings(settings, db, [DAY], http=FakeGemini(), search_http=object(), pause=0, sweep_limit=3)
    assert res["sweep"] == {"searched": 1, "found": 1}
    hunger = R.rankings_payload(settings, db)["indices"][0]["latest"]
    assert (hunger["rank"], hunger["total"], hunger["edition"], hunger["day"]) == (102, 127, "2025", "2025-10-10")
    assert hunger["url"] == "https://www.ndtv.com/india-news/ghi" and hunger["source"] == "ndtv.com"  # the free copy, cited
    assert db.q("SELECT found FROM index_checks WHERE key='hunger'")[0]["found"] == "2025"  # found: looked up again in a month


def test_one_card_per_index_and_official_figures_win(db, settings, monkeypatch):
    assert R._slug("WorldSkills Competition 2026") == R._slug("WorldSkills") == "x_worldskills"
    assert R._slug("Ocean Health Index") == "x_ocean_health" and R._slug("Index") == "x_"
    assert R.official("https://www.pib.gov.in/PressReleasePage.aspx?PRID=1") and R.official("https://mea.gov.in/x")
    assert not R.official("https://timesofindia.indiatimes.com/x") and not R.official("https://gov.in.example.com/x")
    now = datetime.now(timezone.utc).isoformat()
    toi = {"edition": "2026", "rank": 10, "total": 0, "previous": 39, "score": "", "why": ["Six silver medals."]}
    # the old key of an unlisted index (before filler words were dropped), and a second report under the new key
    R._keep(db, "x_worldskills_competition", "WorldSkills Competition", "", {**toi, "previous": 13, "why": []}, DAY, "pib", "https://www.pib.gov.in/x", "PIB", now)
    R._keep(db, "x_worldskills", "WorldSkills", "", toi, DAY, "toi", "https://timesofindia.indiatimes.com/x", "Times of India", now)
    db.commit()
    real = R.load_indices(settings)
    unlisted = [i for i in real if i["key"] != "worldskills"]
    monkeypatch.setattr(R, "load_indices", lambda s: unlisted)
    by = {x["key"]: x for x in R.rankings_payload(settings, db)["indices"]}
    assert "x_worldskills_competition" not in by  # merged into one card
    w = by["x_worldskills"]["latest"]
    assert (w["rank"], w["previous"], w["source"]) == (10, 13, "PIB")  # the official release's figures
    monkeypatch.setattr(R, "load_indices", lambda s: real)  # once the list has it, it takes over the "Other" card
    by = {x["key"]: x for x in R.rankings_payload(settings, db)["indices"]}
    assert "x_worldskills" not in by and by["worldskills"]["latest"]["rank"] == 10 and by["worldskills"]["area"] == "society"
    # a newspaper report of an edition an official release already gave doesn't change it; the reverse replaces it
    R._keep(db, "hunger", "Global Hunger Index", "", {**toi, "rank": 105, "previous": 0, "why": ["A reason."]}, DAY, "a", "https://www.ndtv.com/a", "NDTV", now)
    R._keep(db, "hunger", "Global Hunger Index", "", {**toi, "rank": 102, "previous": 105, "why": []}, DAY, "b", "https://pib.gov.in/b", "PIB", now)
    R._keep(db, "hunger", "Global Hunger Index", "", {**toi, "rank": 99}, DAY, "c", "https://www.thehindu.com/c", "The Hindu", now)
    db.commit()
    h = {x["key"]: x for x in R.rankings_payload(settings, db)["indices"]}["hunger"]["latest"]
    assert (h["rank"], h["previous"], h["source"], h["why"]) == (102, 105, "PIB", ["A reason."])  # the report's reasons kept

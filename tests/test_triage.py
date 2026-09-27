"""AI triage (pipeline/triage.py): Gemini grades every story for UPSC; the brief follows it when it's on."""
import json
import re
from datetime import datetime, timezone

from upsc_intel.pipeline import triage as T
from upsc_intel.pipeline.brief import audit_day, select_day

DAY = "2026-09-27"


class Resp:
    def __init__(self, status, data=None):
        self.status_code, self._data = status, data or {}
        self.text = json.dumps(self._data)

    def json(self):
        return self._data


class FakeGemini:
    """Grades by headline: Cabinet/Bill → 3, exercise/species → 2 (a Prelims fact), Bigg Boss/IPL → 0, else 1."""
    def __init__(self):
        self.calls = []

    def get(self, url, headers=None, params=None):
        return Resp(200, {"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]})

    def post(self, url, headers=None, json=None):
        self.calls.append((url, headers, json))
        prompt = json["contents"][0]["parts"][0]["text"]
        items = []
        for m in re.finditer(r"^(\d+)\. \[(\w+)\] (.+)$", prompt, re.M):
            t = m.group(3)
            up = 3 if re.search(r"Cabinet|Bill", t) else 2 if re.search(r"[Ee]xercise|species", t) else 0 if re.search(r"Bigg Boss|IPL", t) else 1
            subj = "polity" if "Bill" in t else "defence" if "xercise" in t else "economy"
            items.append({"n": int(m.group(1)), "upsc": up, "subject": subj, "gs": ["GS2"], "prelims": up == 2,
                          "news": not t.startswith("Strengthening"), "why": f"graded {up}"})
        text = __import__("json").dumps({"items": items})
        return Resp(200, {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": text}]}}]})


def story(db, sid, title, score=6.0, grade="SKIM", subjects=("economy",), **kw):
    now = datetime.now(timezone.utc).isoformat()
    db.upsert_story({"id": sid, "title": title, "url": f"https://pib.gov.in/{sid}", "date_ist": DAY, "dates": [DAY], "first_seen": now,
                     "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1, "publishers": ["PIB"],
                     "subjects": list(subjects), "gs": ["GS3"], "tags": [], "watch": [], "score": score, "grade": grade,
                     "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0, "tier": "official",
                     "summary": "A line of text about the story for the grader to read.", "tokens": re.findall(r"\w+", title.lower()), **kw})


def seed(db):
    story(db, "cab", "Cabinet approves new fertiliser subsidy scheme", score=5.0, grade="SKIM")
    story(db, "bill", "Parliament passes the Waqf Amendment Bill", score=4.0, grade="LOW", subjects=())
    story(db, "ex", "Exercise Varuna begins off Toulon", score=5.5, grade="SKIM", subjects=("defence",))
    story(db, "bb", "Bigg Boss contestant slams housemate", score=6.8, grade="NOTE")
    story(db, "gen", "Minister says economy is doing well", score=5.0, grade="SKIM")
    db.commit()


def test_verdicts_keep_only_well_formed_items():
    batch = [{"id": "a", "title": "One"}, {"id": "b", "title": "Two"}]
    reply = {"items": [{"n": 1, "upsc": 3, "subject": "polity", "gs": ["GS2", "GS9"], "prelims": True, "why": "x" * 300},
                       {"n": 2, "upsc": 7, "subject": "polity"}, {"n": 9, "upsc": 1, "subject": "polity"},
                       {"n": 2, "upsc": 0, "subject": "astrology", "gs": [], "prelims": False, "why": "no"}]}
    v = T.verdicts(reply, batch, {"polity", "economy"})
    assert v["a"]["upsc"] == 3 and v["a"]["gs"] == ["GS2"] and len(v["a"]["why"]) == 120 and v["a"]["t"] == T.title_key("One")
    assert v["b"] == {"upsc": 0, "subject": "", "gs": [], "prelims": False, "news": True, "why": "no", "t": T.title_key("Two")}


def test_stories_are_graded_in_batches_once_per_headline(db, settings, clf):
    seed(db)
    settings.gemini_api_key, settings.ai_triage = "test-key", "shadow"
    http = FakeGemini()
    res = T.triage(settings, db, clf, [DAY], http=http, pause=0, min_batch=1)
    assert res == {"enabled": True, "mode": "shadow", "graded": 5, "calls": 1, "left": 0}
    url, headers, body = http.calls[0]
    assert "key=" not in url and headers["x-goog-api-key"] == "test-key"
    assert "1. [NEWS] Bigg Boss contestant slams housemate (PIB)" in body["contents"][0]["parts"][0]["text"]  # best score first
    v = json.loads(db.q("SELECT triage FROM stories WHERE id='cab'")[0]["triage"])
    assert v["upsc"] == 3 and v["model"] == "gemini-2.5-flash"
    assert T.triage(settings, db, clf, [DAY], http=http, pause=0, min_batch=1)["graded"] == 0 and len(http.calls) == 1  # nothing new
    db.x("UPDATE stories SET title='Cabinet approves fertiliser subsidy of Rs 37,000 crore' WHERE id='cab'")
    assert T.triage(settings, db, clf, [DAY], http=http, pause=0, min_batch=1)["graded"] == 1  # a new headline is graded again
    settings.ai_triage = "off"
    assert T.triage(settings, db, clf, [DAY], http=http, pause=0, min_batch=1) == {"enabled": False}


def test_the_brief_follows_the_verdicts_only_when_on(db, settings, clf):
    seed(db)
    settings.gemini_api_key, settings.ai_triage = "test-key", "shadow"
    T.triage(settings, db, clf, [DAY], http=FakeGemini(), pause=0, min_batch=1)
    rules = {sid: tier for sid, kind, _, tier, lead in select_day(db, clf, DAY)}
    ai = {sid: tier for sid, kind, _, tier, lead in select_day(db, clf, DAY, use_ai=True)}
    assert "bb" in rules and "bb" not in ai  # rules took the Bigg Boss story (a NOTE score); Gemini says 0
    assert "bill" not in rules and ai["bill"] == "top"  # rules graded it LOW (no subject); Gemini says must-know
    assert ai["cab"] == "top" and ai["ex"] == "prelims" and ai["gen"] == "more"


def test_must_know_is_capped_on_a_heavy_day(db, settings, clf):
    for i in range(6):
        story(db, f"c{i}", f"Cabinet approves item number {i} of the reform package", score=6.0 - i * 0.1)
    db.commit()
    settings.gemini_api_key, settings.ai_triage = "test-key", "on"
    T.triage(settings, db, clf, [DAY], http=FakeGemini(), pause=0, min_batch=1)
    clf.brief["must_know_max"] = 4
    try:
        tiers = [tier for sid, kind, _, tier, lead in select_day(db, clf, DAY, use_ai=True) if kind == "news" and lead is None]
    finally:
        clf.brief.pop("must_know_max")
    assert tiers.count("top") <= 4 and len(tiers) >= 4


def test_audit_lists_what_the_ai_moves(db, settings, clf):
    seed(db)
    settings.gemini_api_key, settings.ai_triage = "test-key", "shadow"
    assert audit_day(db, clf, DAY) is None  # nothing graded yet
    T.triage(settings, db, clf, [DAY], http=FakeGemini(), pause=0, min_batch=1)
    a = audit_day(db, clf, DAY)
    assert a["graded"] == 5 and a["upsc"] == {"0": 1, "1": 1, "2": 1, "3": 2}
    assert [x["title"] for x in a["dropped"]] == ["Bigg Boss contestant slams housemate"] and a["dropped"][0]["why"] == "graded 0"
    assert "Parliament passes the Waqf Amendment Bill" in [x["title"] for x in a["to_must_know"]]


def test_payload_leads_with_the_ai_subject_when_on(db, settings, clf):
    from upsc_intel.pipeline.brief import build_day
    from upsc_intel.web.app import brief_payload
    seed(db)
    settings.gemini_api_key, settings.ai_triage = "test-key", "on"
    T.triage(settings, db, clf, [DAY], http=FakeGemini(), pause=0, min_batch=1)
    build_day(settings, db, clf, DAY)
    db.commit()
    p = brief_payload(settings, db, clf, DAY, DAY)
    s = next(x for x in p["stories"] if x["id"] == "bill")
    assert s["subjects"][0] == "polity" and s["gs"] == ["GS2"] and "bill" in p["days"][DAY]["news"]
    assert "bb" not in {i for k in ("news", "prelims", "more") for i in p["days"][DAY][k]}


def test_a_quiet_run_waits_for_more_stories(db, settings, clf):
    seed(db)
    settings.gemini_api_key, settings.ai_triage = "test-key", "on"
    http = FakeGemini()
    assert T.triage(settings, db, clf, [DAY], http=http, pause=0)["waiting"] and not http.calls  # 5 new stories: later
    db.x("UPDATE stories SET first_seen='2026-09-27T01:00:00+00:00' WHERE id='gen'")  # one has waited an hour
    assert T.triage(settings, db, clf, [DAY], http=http, pause=0)["graded"] == 5


def test_must_know_is_topped_up_from_the_rules_on_a_light_day(db, settings, clf):
    story(db, "r1", "Cabinet approves pact with Brazil on critical minerals", score=9.0, grade="NOTE")
    story(db, "r2", "Minister reviews flood relief in Assam districts", score=9.0, grade="NOTE")
    db.commit()
    settings.gemini_api_key, settings.ai_triage = "test-key", "on"

    class TwoOnly(FakeGemini):  # r1 a 3; r2 a 2 (a useful development, not must-know)
        def post(self, url, headers=None, json=None):
            r = super().post(url, headers, json)
            items = __import__("json").loads(r._data["candidates"][0]["content"]["parts"][0]["text"])["items"]
            for x in items:
                x["upsc"], x["prelims"] = (3, False) if x["n"] == 1 else (2, False)
            r._data["candidates"][0]["content"]["parts"][0]["text"] = __import__("json").dumps({"items": items})
            return r
    T.triage(settings, db, clf, [DAY], http=TwoOnly(), pause=0, min_batch=1)
    rules = {sid: tier for sid, kind, _, tier, lead in select_day(db, clf, DAY)}
    ai = {sid: tier for sid, kind, _, tier, lead in select_day(db, clf, DAY, use_ai=True)}
    assert rules["r2"] == "top" and ai["r2"] == "top"  # the rules' Must-know pick that Gemini rates 2 fills the floor of 8
    assert ai["r1"] == "top"


def test_also_in_the_news_is_capped(db, settings, clf):
    for i in range(12):
        story(db, f"m{i}", f"Exercise number {i} held at a naval base", score=3.0 + i * 0.01)  # 2s the rules don't take
    db.commit()
    settings.gemini_api_key, settings.ai_triage = "test-key", "on"
    T.triage(settings, db, clf, [DAY], http=FakeGemini(), pause=0, min_batch=1)
    clf.brief.update(more_max=5, prelims_max=0)  # (no fact cards: all twelve are lines)
    try:
        lines = [sid for sid, kind, _, tier, lead in select_day(db, clf, DAY, use_ai=True) if tier == "more" and kind == "news"]
    finally:
        clf.brief.pop("more_max")
        clf.brief["prelims_max"] = 30
    assert len(lines) <= 5 + len(clf.subject_meta)  # (plus at most one line per uncovered subject)
    assert "m11" in lines and "m0" not in lines  # the stronger ones stay


class Grouper(FakeGemini):
    """Triage as FakeGemini; for the same-event call, groups the headlines that share their first word."""
    def post(self, url, headers=None, json=None):
        sys = json["systemInstruction"]["parts"][0]["text"]
        if "SAME news event" not in sys:
            return super().post(url, headers, json)
        self.calls.append((url, headers, json))
        lines = re.findall(r"^(\d+)\. (\S+)", json["contents"][0]["parts"][0]["text"], re.M)
        by = {}
        for n, w in lines:
            by.setdefault(w, []).append(int(n))
        text = __import__("json").dumps({"groups": [g for g in by.values() if len(g) > 1]})
        return Resp(200, {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": text}]}}]})


def test_cards_on_the_same_event_fold_into_one(db, settings, clf):
    from upsc_intel.pipeline.brief import build_day
    story(db, "j1", "Jaishankar at UNGA: ten big messages on terrorism and the Global South Cabinet", score=7.0, grade="NOTE", subjects=("ir",))
    story(db, "j2", "Jaishankar says reformed multilateralism is now more urgent Bill", score=6.9, grade="NOTE", subjects=("ir",))
    story(db, "j3", "Jaishankar pushes for immediate UN reform as post-1945 order fades Cabinet", score=6.8, grade="NOTE", subjects=("ir",))
    story(db, "c1", "Cabinet approves ECLGS 5.0 for small businesses", score=7.5, grade="NOTE")
    db.commit()
    settings.gemini_api_key, settings.ai_triage = "test-key", "on"
    http = Grouper()
    T.triage(settings, db, clf, [DAY], http=http, pause=0, min_batch=1)
    build_day(settings, db, clf, DAY)
    db.commit()
    cards = lambda: {sid: lead for sid, kind, _, tier, lead in select_day(db, clf, DAY, use_ai=True) if kind == "news"}
    assert sum(1 for s in ("j1", "j2", "j3") if cards()[s] is None) == 3  # the rules keep three cards
    res = T.dedupe(settings, db, [DAY], http=http)
    assert res == {"enabled": True, "calls": 1, "changed": [DAY]}
    build_day(settings, db, clf, DAY)
    db.commit()
    c = cards()
    assert c["j1"] is None and c["j2"] == "j1" and c["j3"] == "j1" and c["c1"] is None  # one Jaishankar card
    n = len(http.calls)
    assert T.dedupe(settings, db, [DAY], http=http) == {"enabled": True, "calls": 0, "changed": []}  # same cards: no call
    assert len(http.calls) == n
    settings.ai_triage = "shadow"
    assert T.dedupe(settings, db, [DAY], http=http) == {"enabled": False}


def test_an_evergreen_page_is_a_line_not_a_card(db, settings, clf):
    story(db, "ev", "Strengthening parliamentary oversight of every Bill", score=7.0, grade="NOTE")  # graded 3, not news
    story(db, "nw", "Cabinet approves the National Research Foundation scheme", score=6.0)
    db.commit()
    settings.gemini_api_key, settings.ai_triage = "test-key", "on"
    T.triage(settings, db, clf, [DAY], http=FakeGemini(), pause=0, min_batch=1)
    ai = {sid: tier for sid, kind, _, tier, lead in select_day(db, clf, DAY, use_ai=True)}
    assert ai["nw"] == "top" and ai["ev"] == "more"


def test_the_brief_cards_are_graded_first(db, settings, clf):
    seed(db)
    db.save_brief(DAY, [("gen", "news", 1, "top", None)])  # the lowest-scored story is a card
    db.commit()
    rows = T._todo(db, [DAY])
    assert rows[0]["id"] == "gen" and [r["id"] for r in rows[1:]] == ["bb", "ex", "cab", "bill"]

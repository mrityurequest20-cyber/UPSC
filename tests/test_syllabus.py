"""The syllabus map (pipeline/syllabus.py, config/syllabus.yaml): every brief card filed under its micro-topics."""
import json
import re
from datetime import date, datetime, timedelta, timezone

import yaml

from upsc_intel.config import load_topics
from upsc_intel.pipeline import syllabus as S
from upsc_intel.pipeline.normalize import today_ist

DAY = today_ist()


def ago(n):
    return (date.fromisoformat(DAY) - timedelta(days=n)).isoformat()


def story(db, sid, title, day, subjects=("polity",), summary="", ai=None, extras=None, triage=None):
    now = datetime.now(timezone.utc).isoformat()
    db.upsert_story({"id": sid, "title": title, "url": f"https://www.thehindu.com/{sid}", "date_ist": day, "dates": [day],
                     "first_seen": now, "last_seen": now, "updated_at": now, "n_items": 1, "n_publishers": 1, "publishers": ["The Hindu"],
                     "subjects": list(subjects), "gs": ["GS2"], "tags": [], "watch": [], "score": 5.0, "grade": "NOTE",
                     "is_editorial": 0, "is_explained": 0, "is_library": 0, "is_private": 0, "tier": "national",
                     "summary": summary, "tokens": re.findall(r"\w+", title.lower())})
    for col, v in (("ai", ai), ("extras", extras), ("triage", triage)):
        if v is not None:
            db.x(f"UPDATE stories SET {col}=? WHERE id=?", (json.dumps(v), sid))


def test_the_syllabus_file_is_sound(settings):
    data = yaml.safe_load((settings.config_dir / "syllabus.yaml").read_text(encoding="utf-8"))
    subjects = set(load_topics(settings)["subjects"])
    ids = [t["id"] for p in data["papers"] for ln in p["lines"] for t in ln["topics"]]
    assert len(ids) == len(set(ids)) and len(ids) >= 90
    assert [p["key"] for p in data["papers"]] == ["GS1", "GS2", "GS3", "GS4"]
    for p in data["papers"]:
        for ln in p["lines"]:
            assert ln["line"] and ln["topics"], ln["key"]
            for t in ln["topics"]:
                assert t["id"].startswith(p["key"].lower() + "-") and len(t.get("kw") or {}) >= 3, t["id"]
                assert set(t["subj"]) <= subjects, (t["id"], set(t["subj"]) - subjects)
                assert all(0 < w <= 3 for w in t["kw"].values()), t["id"]


def test_the_rules_file_a_card_under_its_topics(settings):
    syl = S.load_syllabus(settings)
    assert S.Syllabus.rule_tags(syl, "ISRO launches NavIC satellite NVS-03 from Sriharikota", "", ["science_tech"])[0] == "gs3-space"
    assert syl.rule_tags("How the Chief Election Commissioner can be removed", "", ["polity"])[0] == "gs2-election-commission"
    assert syl.rule_tags("RBI keeps repo rate unchanged, retail inflation eases", "", ["economy"]) == ["gs3-banking-monetary", "gs3-inflation"]
    assert syl.rule_tags("Tiger reserve notified in Rajasthan", "", ["environment"])[0] == "gs3-protected-areas"
    assert syl.rule_tags("CJI Surya Kant inaugurates a victims' rights centre", "", ["polity"]) == ["gs2-judiciary"]  # not "Kant" the thinker
    assert syl.rule_tags("UPSC Key: what to read today", "", []) == []  # a coaching headline names no body
    assert syl.rule_tags("A quiet day in the city", "", ["polity"]) == []


def test_intel_ais_tags_win_and_unknown_ids_are_dropped(settings):
    syl = S.load_syllabus(settings)
    row = {"title": "RBI keeps repo rate unchanged", "summary": "", "subjects": ["economy"],
           "extras": json.dumps({"places": [], "topics": [], "syl": ["gs3-inflation", "nope", "gs3-inflation"]})}
    assert S.tags_of(syl, row) == (["gs3-inflation"], "ai")
    row["extras"] = json.dumps({"places": [], "topics": [], "syl": []})  # the AI found none: the rules decide
    assert S.tags_of(syl, row) == (["gs3-banking-monetary"], "rules")


def test_the_map_lists_each_topics_cards_counts_flashcards_and_dossiers(db, settings):
    cards = [{"q": "Who appoints the CEC?", "a": "The President, on a selection committee's advice."}]
    story(db, "ec1", "Election Commission revises SIR notices", ago(0), ai={"flashcards": cards})
    story(db, "ec2", "Chief Election Commissioner defends the roll revision", ago(3))
    story(db, "ec3", "Election Commission meets parties on the roll revision", ago(12))
    story(db, "old", "Election Commission announced a schedule", ago(60))  # outside the window
    story(db, "sp", "ISRO's PSLV places a satellite in orbit", ago(1), subjects=["science_tech"],
          extras={"places": [], "topics": [], "syl": ["gs3-space"]})
    story(db, "none", "A quiet day in the city", ago(1))
    for d, ids in ((ago(0), ["ec1"]), (ago(1), ["sp", "none", "ec2"]), (ago(3), ["ec2"]), (ago(12), ["ec3"]), (ago(60), ["old"])):
        db.save_brief(d, [(i, "news", n, "top" if n == 1 else "more") for n, i in enumerate(ids, 1)])
    db.commit()
    ds = {"dossiers": [{"key": "sir", "name": "Revision of electoral rolls (SIR)", "last_day": ago(0), "n": 3,
                        "timeline": [{"id": "ec1"}, {"id": "ec2"}, {"id": "ec3"}, {"id": "zzz"}]}]}
    p = S.syllabus_payload(settings, db, today=DAY, dossiers=ds)
    ec = p["topics"]["gs2-election-commission"]
    assert [x["id"] for x in ec["items"]] == ["ec1", "ec2", "ec3"]  # the latest first, a card in two briefs once
    assert (ec["n30"], ec["n7"], ec["n"], ec["last"]) == (3, 2, 3, ago(0))
    assert ec["items"][1]["d"] == ago(1) and ec["items"][0]["k"] == "top" and ec["items"][1]["k"] == "more"
    assert ec["cards"] == [{"q": cards[0]["q"], "a": cards[0]["a"], "id": "ec1", "d": ago(0)}]
    assert ec["dossiers"] == [{"key": "sir", "name": "Revision of electoral rolls (SIR)", "last": ago(0), "n": 3}]
    assert p["topics"]["gs3-space"]["items"][0]["by"] == "ai" and ec["items"][0]["by"] == "rules"
    assert p["stats"] == {"cards": 5, "tagged": 4, "by_ai": 1, "by_rules": 3}
    tree = {x["key"]: x for x in p["papers"]}
    line = next(ln for ln in tree["GS2"]["lines"] if "gs2-election-commission" in ln["topics"])
    assert "constitutional" in line["line"].lower() and p["topics"]["gs2-election-commission"]["line"] == line["key"]


def test_brief_cards_carry_their_syllabus_topics(db, settings, clf):
    from upsc_intel.web.app import brief_payload
    story(db, "ec1", "Election Commission revises SIR notices", DAY)
    db.save_brief(DAY, [("ec1", "news", 1, "top")])
    db.commit()
    p = brief_payload(settings, db, clf, DAY, DAY)
    s = next(x for x in p["stories"] if x["id"] == "ec1")
    assert s["syl"][0] == {"k": "gs2-election-commission", "n": "Election Commission: appointment, removal and powers", "p": "GS2"}

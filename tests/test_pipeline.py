"""End-to-end: fake sources → run_fetch → stories, fallback switching, API, static export."""
import json
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from upsc_intel import fetchers
from upsc_intel.config import build_chain
from upsc_intel.fetchers import describe as describe_mod
from upsc_intel.models import FetchError, RawItem
from upsc_intel.pipeline import run as run_mod

NOW = datetime.now(timezone.utc)


def fake_sources(settings, public_only=False):
    srcs = [
        {"id": "hindu", "name": "The Hindu", "kind": "fake_ok", "tier": "quality"},
        {"id": "ie", "name": "Indian Express", "kind": "fake_ok2", "tier": "quality"},
        {"id": "flaky", "name": "Flaky Site", "kind": "fake_fail", "tier": "quality",
         "fallbacks": [{"kind": "fake_backup"}]},
        {"id": "ed", "name": "The Hindu", "section": "Editorial", "kind": "fake_ed", "tier": "quality", "editorial": True},
        {"id": "exp", "name": "Indian Express", "section": "Explained", "kind": "fake_exp", "tier": "examprep",
         "explained": True, "describe": True},
    ]
    srcs.append({"id": "yt-dd", "name": "DD News", "kind": "fake_video", "role": "video", "tier": "official"})
    if not public_only:
        srcs.append({"id": "secret", "name": "Paid Newsletter", "kind": "fake_private", "tier": "premium", "private": True})
    for s in srcs:
        s.setdefault("section", "")
        s["chain"] = build_chain(s)
    return srcs


CALLS = {"fail": 0, "backup": 0}


@pytest.fixture
def fake_env(monkeypatch):
    CALLS.update(fail=0, backup=0)

    def ok(ctx, step, src):
        return [
            RawItem("Supreme Court constitution bench upholds sub-classification of Scheduled Castes",
                    "https://thehindu.com/sc-subclass", "The Court ruled 6:1 on reservation.", published=NOW),
            RawItem("Actor's new film breaks box office records", "https://thehindu.com/film", published=NOW),
        ]

    def ok2(ctx, step, src):
        return [RawItem("Supreme Court upholds sub-classification of Scheduled Castes, constitution bench rules",
                        "https://indianexpress.com/sc?utm_source=rss", published=NOW)]

    def fail(ctx, step, src):
        CALLS["fail"] += 1
        raise FetchError("HTTP 500")

    def backup(ctx, step, src):
        CALLS["backup"] += 1
        return [RawItem("Two new Ramsar sites designated in Bihar", "https://flaky.com/ramsar", published=NOW)]

    def ed(ctx, step, src):
        return [RawItem("On the sub-classification verdict and the idea of equality", "https://thehindu.com/ed",
                        published=NOW)]

    def private(ctx, step, src):
        return [RawItem("Premium explainer: Governor's assent to Bills under Article 200",
                        "https://paid.example.com/gov", published=NOW)]

    monkeypatch.setitem(fetchers.FETCHERS, "fake_ok", ok)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_ok2", ok2)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_fail", fail)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_backup", backup)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_ed", ed)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_private", private)
    # headline-only explainer feed: the summary comes from the page's preview text (no network in tests)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_exp", lambda ctx, step, src: [
        RawItem("What is sub-classification of Scheduled Castes, and why did the Supreme Court allow it?",
                "https://indianexpress.com/article/explained/sc-subclass", published=NOW)])
    preview = lambda http, url: "The Supreme Court allowed States to sub-classify Scheduled Castes for reservation."  # noqa: E731
    monkeypatch.setattr(describe_mod, "page_description", preview)
    monkeypatch.setattr(run_mod, "page_description", preview)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_video", lambda ctx, step, src: [
        RawItem("Two new Ramsar sites designated in Bihar | Wetlands explained", "https://www.youtube.com/watch?v=abcDEF12345",
                published=NOW)])
    monkeypatch.setattr(run_mod, "load_sources", fake_sources)
    import upsc_intel.web.app as web_app
    monkeypatch.setattr(web_app, "load_sources", fake_sources)


def test_run_merges_grades_and_falls_back(settings, db, fake_env):
    res = run_mod.run_fetch(settings, db, force=True)
    assert res["n_ok"] == 7 and not res["failed"]
    assert res["described"] == 1
    # video sources feed the video library, never the news feed
    assert db.q("SELECT COUNT(*) AS n FROM videos")[0]["n"] == 1
    assert not db.q("SELECT 1 FROM items WHERE source_id='yt-dd'")
    stories = db.stories_between("2000-01-01", "2100-01-01", include_low=True, library=None)
    sc = [s for s in stories if "sub-classification" in s["title"] and not s["is_editorial"] and not s["is_explained"]]
    assert len(sc) == 1, [s["title"] for s in stories]
    assert sc[0]["n_publishers"] == 2 and sc[0]["grade"] == "NOTE"
    assert "polity" in sc[0]["subjects"]
    film = [s for s in stories if "box office" in s["title"]][0]
    assert film["grade"] == "LOW"
    ed = [s for s in stories if s["is_editorial"]]
    assert len(ed) == 1  # editorials never merge into news stories
    exp = [s for s in stories if s["is_explained"]]
    assert len(exp) == 1 and "sub-classify" in exp[0]["summary"]  # nor do explainers; preview text filled in
    assert CALLS == {"fail": 1, "backup": 1}

    # second run: fallback still saves the run; after FAIL_SWITCH runs the backup becomes active
    run_mod.run_fetch(settings, db, force=True)
    st = db.get_source_state("flaky")
    assert st["active_step"] == 1 and st["last_step_kind"] == "fake_backup"
    run_mod.run_fetch(settings, db, force=True)
    assert CALLS["fail"] == 2  # third run went straight to the backup
    # re-running never duplicates items
    assert db.counts()["items"] == 7


def test_reclassify_is_stable_and_drops_empty_stories(settings, db, fake_env):
    run_mod.run_fetch(settings, db, force=True)
    before = {r["id"]: r["story_id"] for r in db.q("SELECT id, story_id FROM items")}
    db.x("INSERT INTO stories (id, title, date_ist, score, grade, is_library) VALUES ('sorphan', 'x', '2026-09-26', 9, 'NOTE', 0)")
    db.commit()
    assert run_mod.reclassify(settings, db) == len(before)
    assert {r["id"]: r["story_id"] for r in db.q("SELECT id, story_id FROM items")} == before
    assert not db.q("SELECT 1 FROM stories WHERE id='sorphan'")


def test_primary_is_reprobed_and_recovers(settings, db, fake_env, monkeypatch):
    st = {**db.get_source_state("flaky"), "active_step": 1, "runs_since_probe": fetchers.PROBE_EVERY}
    db.save_source_state(st)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_fail",
                        lambda ctx, step, src: [RawItem("Primary back online with a proper headline", "https://flaky.com/p")])
    run_mod.run_fetch(settings, db, only=["flaky"])
    assert db.get_source_state("flaky")["active_step"] == 0


def test_api_and_marks(settings, db, fake_env):
    run_mod.run_fetch(settings, db, force=True)
    from upsc_intel.web.app import create_app

    app = create_app(settings, scheduler=False)
    with TestClient(app) as c:
        meta = c.get("/api/meta").json()
        assert meta["mode"] == "server" and meta["counts"]["stories"] >= 4
        today = meta["today"]
        day = c.get("/api/stories", params={"from": today, "to": today}).json()["stories"]
        assert all(s["grade"] != "LOW" for s in day)
        withlow = c.get("/api/stories", params={"from": today, "to": today, "include_low": "true"}).json()["stories"]
        assert len(withlow) > len(day)
        sid = day[0]["id"]
        assert c.post("/api/marks", json={"story_id": sid, "starred": True, "note": "revise"}).status_code == 200
        assert c.get("/api/marks").json()[sid] == {"starred": True, "read": False, "note": "revise"}
        assert c.post("/api/stories/by_ids", json={"ids": [sid]}).json()["stories"][0]["id"] == sid
        hits = c.get("/api/search", params={"q": "Ramsar"}).json()["stories"]
        assert hits and "Ramsar" in hits[0]["title"]
        assert c.get("/api/stories", params={"from": "bad", "to": today}).status_code == 400
        assert c.get("/files/../../etc/passwd").status_code == 404
        brief = c.get("/api/brief", params={"from": today, "to": today}).json()
        picks = brief["days"][today]["news"]
        assert picks and set(picks) <= {s["id"] for s in brief["stories"]}
        by_id = {s["id"]: s for s in brief["stories"]}
        assert all(by_id[i]["grade"] in ("NOTE", "SKIM") for i in picks)
        assert all("explain" in s and s["explain"]["why_in_news"] for s in brief["stories"])
        assert brief["days"][today]["editorials"]
        exp = [by_id[i] for i in brief["days"][today]["explained"]]
        assert len(exp) == 1 and exp[0]["explained"] and "sub-classify" in exp[0]["explain"]["why_in_news"]
        assert meta["brief_explained"] == settings.brief_explained and "Indian Express" in meta["explained_sources"]
        ramsar = next(s for s in brief["stories"] if "Ramsar" in s["title"])
        assert ramsar["video"] and ramsar["video"]["id"] == "abcDEF12345"  # matched from the library
        srcs = c.get("/api/sources").json()["sources"]
        assert {s["id"] for s in srcs} >= {"hindu", "flaky"}
        assert c.get("/").status_code == 200


def test_static_export_excludes_private(settings, db, fake_env, tmp_path):
    run_mod.run_fetch(settings, db, force=True)
    from upsc_intel.static_export import export_static

    out = export_static(settings, db, tmp_path / "site", days=5)
    html = (out / "index.html").read_text()
    assert "window.UPSC_STATIC = true" in html
    meta = json.loads((out / "data" / "meta.json").read_text())
    assert meta["mode"] == "static" and meta["months"] and meta["refresh_min"] == settings.site_refresh_min
    assert "static/app.js?v=" in html  # cache-busted, so a new build never runs a stale script
    blob = "".join((out / "data" / f"stories-{m}.json").read_text() for m in meta["months"])
    assert "Ramsar" in blob
    assert "Premium explainer" not in blob and "paid.example.com" not in blob
    assert "box office" not in blob  # LOW is not exported
    briefs = "".join((out / "data" / f"brief-{m}.json").read_text() for m in meta["months"])
    assert "Ramsar" in briefs and "explain" in briefs and '"explained":["' in briefs
    assert "Premium explainer" not in briefs


def test_archive_keeps_finished_months_forever(settings, db, fake_env, tmp_path):
    """A finished month is frozen into the archive and stays on the site after the database pruned it."""
    from upsc_intel.static_export import export_static

    run_mod.run_fetch(settings, db, force=True)
    old_day = (date.fromisoformat(NOW.date().isoformat()).replace(day=1) - timedelta(days=40)).isoformat()
    old_month = old_day[:7]
    db.x("UPDATE stories SET date_ist=?, first_seen=?, last_seen=? WHERE is_editorial=1", (old_day, old_day, old_day))
    db.x("UPDATE story_dates SET date_ist=? WHERE story_id IN (SELECT id FROM stories WHERE is_editorial=1)", (old_day,))
    db.x("UPDATE items SET date_ist=? WHERE is_editorial=1", (old_day,))
    db.commit()
    arch = tmp_path / "archive"
    out = export_static(settings, db, tmp_path / "site1", days=90, archive=arch)
    assert (arch / f"brief-{old_month}.json").is_file() and (arch / f"stories-{old_month}.json").is_file()
    this_month = NOW.date().isoformat()[:7]
    assert not (arch / f"brief-{this_month}.json").exists()  # the current month is still live
    frozen = (arch / f"stories-{old_month}.json").read_text()
    assert "sub-classification" in frozen

    # the database forgets the old month; the site still has it, exactly as frozen
    db.x("DELETE FROM items WHERE date_ist=?", (old_day,))
    db.x("DELETE FROM stories WHERE date_ist=?", (old_day,))
    db.commit()
    out = export_static(settings, db, tmp_path / "site2", days=90, archive=arch)
    meta = json.loads((out / "data" / "meta.json").read_text())
    assert old_month in meta["months"] and this_month in meta["months"]
    assert (out / "data" / f"stories-{old_month}.json").read_text() == frozen
    assert old_day in meta["date_counts"]  # the calendar still marks the day
    # private exports never write to the (public) archive
    export_static(settings, db, tmp_path / "site3", days=90, archive=tmp_path / "arch2", include_private=True)
    assert not (tmp_path / "arch2").exists()


def test_export_labels_match_briefs_and_cli_checkpoints(settings, db, fake_env, tmp_path, monkeypatch):
    """A day backfilled on a first run has no brief yet: the export builds it before labelling the
    cards, and the CLI closes the database so CI's cached upsc.db holds everything (no WAL left)."""
    run_mod.run_fetch(settings, db, force=True)
    db.x("DELETE FROM brief_picks")
    db.commit()
    db.close()
    import upsc_intel.__main__ as cli
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    assert cli.main(["export-static", "--out", str(tmp_path / "site"), "--days", "5"]) == 0
    wal = settings.db_path.with_name(settings.db_path.name + "-wal")
    assert not wal.exists() or wal.stat().st_size == 0
    data = tmp_path / "site" / "data"
    stories = [s for f in data.glob("stories-*.json") for s in json.loads(f.read_text())["stories"]]
    picked = {i for f in data.glob("brief-*.json") for day in json.loads(f.read_text())["days"].values()
              for ids in day.values() for i in ids}
    assert picked and {s["id"] for s in stories if s.get("in_brief")} == picked & {s["id"] for s in stories}


def test_old_items_are_dropped(settings, db, fake_env, monkeypatch):
    old = NOW - timedelta(days=settings.max_item_age_days + 5)
    monkeypatch.setitem(fetchers.FETCHERS, "fake_ok",
                        lambda ctx, step, src: [RawItem("A very old story about an old scheme launch", "https://x.com/old", published=old)])
    run_mod.run_fetch(settings, db, only=["hindu"])
    assert not db.q("SELECT 1 FROM items WHERE url='https://x.com/old'")


def test_refresh_button_forces_every_source(settings, db, fake_env, monkeypatch):
    """The server's Refresh fetches every source now, even ones fetched a minute ago."""
    run_mod.run_fetch(settings, db, force=True)
    seen = {}

    def fake_run_fetch(settings_, db_, **kw):
        seen.update(kw)
        return {}

    monkeypatch.setattr(run_mod, "run_fetch", fake_run_fetch)
    from upsc_intel.web.app import Runner

    Runner(settings, db, public_only=False).run_once(force=True)
    assert seen.get("force") is True
    due = [s for s in fake_sources(settings) if fetchers.is_due(s, db.get_source_state(s["id"]), 15, NOW)]
    assert not due  # without force nothing would have been fetched


def test_story_mostly_rejected_stays_rejected(db, clf):
    from upsc_intel.pipeline.cluster import aggregate_story
    now = NOW.isoformat()
    for iid, title, score in (("w1", "Weather tomorrow: IMD forecasts rain in 23 states", 2.0),
                              ("w2", "Weather Today: storm alert in 11 states", clf.reject_score - 5),
                              ("w3", "Rain Alert for 23 States", clf.reject_score - 5)):
        db.insert_item({"id": iid, "source_id": iid, "title": title, "url": "https://x/" + iid, "date_ist": NOW.date().isoformat(),
                        "published_at": now, "fetched_at": now, "is_library": 0, "story_id": "sw", "score": score,
                        "publisher": iid, "subjects": ["disaster"]})
    db.commit()
    assert aggregate_story(db, clf, "sw")["grade"] == "LOW"


def test_one_rejected_copy_does_not_sink_a_real_story(db, clf):
    from upsc_intel.pipeline.cluster import aggregate_story
    now = NOW.isoformat()
    for iid, title, score in (("y1", "SkyStriker munition strikes during India-US Yudh Abhyas 2026", 4.0),
                              ("y2", "SkyStriker munition strikes during India-US Yudh Abhyas", clf.reject_score - 5)):
        db.insert_item({"id": iid, "source_id": iid, "title": title, "url": "https://x/" + iid, "date_ist": NOW.date().isoformat(),
                        "published_at": now, "fetched_at": now, "is_library": 0, "story_id": "sy", "score": score,
                        "publisher": iid, "subjects": ["security"]})
    db.commit()
    assert aggregate_story(db, clf, "sy")["grade"] != "LOW"

"""End-to-end: fake sources → run_fetch → stories, fallback switching, API, static export."""
import json
from datetime import datetime, timedelta, timezone

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

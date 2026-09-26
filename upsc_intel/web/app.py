"""FastAPI app: JSON API + the dashboard + the live background scheduler."""
from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..config import Settings, get_settings, load_sources, load_topics
from ..db import DB, iso
from ..pipeline.classify import Classifier
from ..pipeline.normalize import publisher_key, today_ist

log = logging.getLogger("upsc_intel.web")
STATIC_DIR = Path(__file__).parent / "static"
MAX_SOURCES_PER_STORY = 12


def story_out(s: dict) -> dict:
    """Compact story shape shared by the API and the static export."""
    srcs = []
    seen = set()
    ordered = sorted(s.get("sources") or [], key=lambda x: x.get("kind") == "gnews")  # direct links first
    for x in ordered:
        key = publisher_key(x.get("publisher"))
        if key in seen:
            continue
        seen.add(key)
        srcs.append({"p": x.get("publisher"), "s": x.get("section") or "", "u": x.get("url"),
                     "t": x.get("title"), "k": x.get("kind"), "at": x.get("published")})
    return {
        "id": s["id"],
        "title": s.get("title"),
        "url": s.get("url"),
        "date": s.get("date_ist"),
        "dates": s.get("dates") or [],
        "first_seen": s.get("first_seen"),
        "last_seen": s.get("last_seen"),
        "updated_at": s.get("updated_at"),
        "grade": s.get("grade"),
        "score": s.get("score"),
        "gs": s.get("gs") or [],
        "subjects": s.get("subjects") or [],
        "tags": s.get("tags") or [],
        "watch": s.get("watch") or [],
        "n_pub": s.get("n_publishers") or len({x["p"] for x in srcs}),
        "editorial": bool(s.get("is_editorial")),
        "library": bool(s.get("is_library")),
        "private": bool(s.get("is_private")),
        "tier": s.get("tier"),
        "summary": s.get("summary") or "",
        "sources": srcs[:MAX_SOURCES_PER_STORY],
        "n_src": len(srcs),
        "ai": s.get("ai") or None,
    }


def sources_out(settings: Settings, db: DB, public_only: bool = False) -> list[dict]:
    states = db.all_source_states()
    out = []
    for src in load_sources(settings, public_only=public_only):
        st = states.get(src["id"], {})
        chain = src["chain"]
        active = min(int(st.get("active_step") or 0), len(chain) - 1)
        out.append({
            "id": src["id"], "name": src.get("name"), "section": src.get("section") or "",
            "tier": src.get("tier"), "editorial": bool(src.get("editorial")),
            "watchlist": bool(src.get("watchlist")), "private": bool(src.get("private")),
            "chain": [c.get("kind") for c in chain], "active_step": active,
            "using": st.get("last_step_kind") or chain[active].get("kind"),
            "last_ok_at": st.get("last_ok_at"), "last_attempt_at": st.get("last_attempt_at"),
            "last_count": st.get("last_count") or 0, "total_items": st.get("total_items") or 0,
            "fail_streak": st.get("fail_streak") or 0, "last_error": st.get("last_error"),
            "interval": src.get("interval") or settings.fetch_interval_min,
        })
    return out


def build_meta(settings: Settings, db: DB, clf: Classifier, topics: dict, *, mode: str,
               running: bool = False, next_run_at: str | None = None) -> dict:
    lo, hi = db.date_range()
    return {
        "mode": mode,
        "version": __version__,
        "now": iso(datetime.now(timezone.utc)),
        "today": today_ist(),
        "interval_min": settings.fetch_interval_min,
        "next_run_at": next_run_at,
        "running": running,
        "last_run": db.last_run(),
        "date_min": lo,
        "date_max": hi,
        "date_counts": db.date_counts(days=400),
        "counts": db.counts(),
        "labels": clf.labels(),
        "gs_papers": topics.get("gs_papers") or {},
        "ai_enabled": settings.ai_enabled,
        "imap_enabled": settings.imap_enabled,
    }


class Runner:
    """Background fetch loop (APScheduler) with a manual trigger."""

    def __init__(self, settings: Settings, db: DB, public_only: bool):
        self.settings, self.db, self.public_only = settings, db, public_only
        self.running = False
        self.scheduler = None
        self._lock = threading.Lock()

    def run_once(self) -> None:
        from ..pipeline.run import run_fetch

        with self._lock:
            if self.running:
                return
            self.running = True
        try:
            res = run_fetch(self.settings, self.db, public_only=self.public_only)
            log.info("fetch done: %s new items, %s new stories in %ss",
                     res.get("n_new"), res.get("n_new_stories"), res.get("duration_s"))
            if self.settings.ai_enabled:
                from ..pipeline.enrich import enrich_top

                enrich_top(self.settings, self.db)
        except Exception:
            log.exception("fetch cycle failed")
        finally:
            self.running = False

    def trigger(self) -> bool:
        if self.running:
            return False
        threading.Thread(target=self.run_once, daemon=True).start()
        return True

    def start(self) -> None:
        from apscheduler.schedulers.background import BackgroundScheduler

        self.scheduler = BackgroundScheduler(timezone="UTC")
        self.scheduler.add_job(self.run_once, "interval", minutes=self.settings.fetch_interval_min,
                               next_run_time=datetime.now(timezone.utc) + timedelta(seconds=3),
                               id="fetch", max_instances=1, coalesce=True)
        self.scheduler.start()

    def next_run_at(self) -> str | None:
        if not self.scheduler:
            return None
        job = self.scheduler.get_job("fetch")
        return iso(job.next_run_time) if job and job.next_run_time else None

    def stop(self) -> None:
        if self.scheduler:
            self.scheduler.shutdown(wait=False)


def _valid_date(value: str, name: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise HTTPException(400, f"{name} must be YYYY-MM-DD") from exc


def create_app(settings: Settings | None = None, scheduler: bool = True, public_only: bool = False) -> FastAPI:
    settings = settings or get_settings()
    settings.ensure_dirs()
    db = DB(settings.db_path)
    runner = Runner(settings, db, public_only)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if scheduler:
            runner.start()
        yield
        runner.stop()

    app = FastAPI(title="UPSC Intel", version=__version__, lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.state.db, app.state.runner, app.state.settings = db, runner, settings

    def classifier() -> tuple[Classifier, dict]:
        topics = load_topics(settings)
        return Classifier(topics), topics

    @app.get("/api/meta")
    def meta():
        clf, topics = classifier()
        return build_meta(settings, db, clf, topics, mode="server", running=runner.running,
                          next_run_at=runner.next_run_at())

    @app.get("/api/stories")
    def stories(date_from: str = Query(..., alias="from"), date_to: str = Query(..., alias="to"),
                include_low: bool = False, since: str | None = None):
        a, b = _valid_date(date_from, "from"), _valid_date(date_to, "to")
        if (date.fromisoformat(b) - date.fromisoformat(a)).days > 93:
            raise HTTPException(400, "range too large (max ~3 months)")
        rows = db.stories_between(a, b, include_low=include_low, library=False, since=since,
                                  include_private=not public_only)
        return {"from": a, "to": b, "generated_at": iso(datetime.now(timezone.utc)),
                "stories": [story_out(s) for s in rows]}

    @app.post("/api/stories/by_ids")
    def stories_by_ids(payload: dict = Body(...)):
        ids = [i for i in (payload.get("ids") or []) if isinstance(i, str)][:1000]
        by_id = {s["id"]: s for s in db.stories_by_ids(ids)}
        return {"stories": [story_out(by_id[i]) for i in ids if i in by_id]}

    @app.get("/api/library")
    def library():
        return {"stories": [story_out(s) for s in db.library_stories()]}

    @app.get("/api/search")
    def search(q: str = Query(..., min_length=2), limit: int = 200):
        ids = db.search(q, limit=min(limit, 500))
        by_id = {s["id"]: s for s in db.stories_by_ids(ids)}
        return {"q": q, "stories": [story_out(by_id[i]) for i in ids if i in by_id]}

    @app.get("/api/sources")
    def sources():
        return {"sources": sources_out(settings, db, public_only=public_only)}

    @app.get("/api/marks")
    def marks():
        return db.get_marks()

    @app.post("/api/marks")
    def set_mark(payload: dict = Body(...)):
        sid = payload.get("story_id")
        if not sid or not isinstance(sid, str):
            raise HTTPException(400, "story_id required")
        note = payload.get("note")
        if note is not None and len(note) > 5000:
            raise HTTPException(400, "note too long")
        return db.set_mark(sid, starred=payload.get("starred"), read=payload.get("read"), note=note)

    @app.post("/api/refresh")
    def refresh():
        started = runner.trigger()
        return JSONResponse({"started": started, "running": True}, status_code=202 if started else 200)

    @app.get("/files/{path:path}")
    def files(path: str):
        base = settings.inbox_dir.resolve()
        target = (base / path).resolve()
        if base not in target.parents or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target)

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    return app

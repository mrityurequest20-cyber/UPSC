"""One fetch cycle: due sources → fallback chains → normalise → classify → cluster → store."""
from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

from ..config import Settings, load_sources, load_topics
from ..db import DB, iso, utcnow
from ..fetchers import FetchContext, SourceResult, is_due, run_source
from ..fetchers.http import Http
from ..models import RawItem
from .classify import Classifier
from .cluster import Clusterer, aggregate_story
from .normalize import IST, canonical_url, clean_title, ist_date, make_id, title_tokens

log = logging.getLogger("upsc_intel")
RUN_LOCK = threading.Lock()


def build_item(raw: RawItem, src: dict, clf: Classifier, now: datetime, cutoff: str) -> dict | None:
    title = clean_title(raw.title)
    if not title or not raw.url or len(title) < 8:
        return None
    published = raw.published or now
    if published > now + timedelta(hours=2):  # bad feed clocks
        published = now
    date_ist = ist_date(published)
    is_library = src.get("kind") == "documents"
    if date_ist < cutoff and not is_library:
        return None
    url = raw.url
    canon = canonical_url(url)
    hint = raw.extra.get("ministry", "") if raw.extra else ""
    a = clf.analyze(title, raw.summary or "", hint)
    tier = src.get("tier", "general")
    return {
        "id": make_id(canon or raw.guid or title),
        "source_id": src["id"],
        "source_name": src.get("name"),
        "section": src.get("section") or (raw.extra or {}).get("ministry") or "",
        "publisher": raw.publisher or src.get("name"),
        "kind": src.get("_step_kind") or src.get("kind"),
        "tier": tier,
        "url": url,
        "title": title,
        "summary": raw.summary or "",
        "published_at": iso(published),
        "fetched_at": iso(now),
        "date_ist": date_ist,
        "is_editorial": int(bool(src.get("editorial"))),
        "is_library": int(is_library),
        "is_private": int(bool(src.get("private"))),
        "tokens": title_tokens(title),
        "subjects": a.subjects,
        "tags": a.tags,
        "watch": a.watch,
        "score": clf.score(a, tier),
        "extra": raw.extra or {},
        "_content": raw.content or "",
    }


def run_fetch(settings: Settings, db: DB, *, only: list[str] | None = None, public_only: bool = False,
              force: bool = False) -> dict:
    if not RUN_LOCK.acquire(blocking=False):
        return {"skipped": True, "reason": "a fetch is already running"}
    try:
        return _run(settings, db, only=only, public_only=public_only, force=force)
    finally:
        RUN_LOCK.release()


def _run(settings: Settings, db: DB, *, only, public_only, force) -> dict:
    t0 = time.monotonic()
    now = utcnow()
    sources = load_sources(settings, public_only=public_only)
    if only:
        sources = [s for s in sources if any(s["id"] == o or s["id"].startswith(o) for o in only)]
        force = True
    clf = Classifier(load_topics(settings))
    states = db.all_source_states()
    due = [s for s in sources if force or is_due(s, states.get(s["id"], {}), settings.fetch_interval_min, now)]
    run_id = now.strftime("%Y%m%dT%H%M%S")
    db.save_run({"id": run_id, "started_at": iso(now), "n_sources": len(due)})

    http = Http(timeout=settings.http_timeout)
    ctx = FetchContext(settings=settings, db=db, http=http)
    results: list[tuple[SourceResult, dict]] = []
    try:
        with ThreadPoolExecutor(max_workers=max(1, settings.concurrency)) as ex:
            futs = {ex.submit(run_source, ctx, s, states.get(s["id"]) or db.get_source_state(s["id"])): s
                    for s in due}
            for fut in as_completed(futs):
                src = futs[fut]
                try:
                    results.append(fut.result())
                except Exception as exc:  # defensive: run_source already catches per-step errors
                    log.exception("source %s crashed", src["id"])
                    results.append((SourceResult(src, [], False, None, []),
                                    {**db.get_source_state(src["id"]), "last_error": str(exc)}))
    finally:
        http.close()

    cutoff = (datetime.now(IST).date() - timedelta(days=settings.max_item_age_days)).isoformat()
    clusterer = Clusterer(db)
    touched: set[str] = set(ctx.stale_story_ids)
    new_stories: set[str] = set()
    n_items = n_new = 0
    for res, st in results:
        src = dict(res.source)
        if res.step is not None:
            src["_step_kind"] = src["chain"][res.step].get("kind")
        built = [b for b in (build_item(r, src, clf, now, cutoff) for r in res.items) if b]
        n_items += len(built)
        existing = db.existing_item_ids([b["id"] for b in built])
        src_new = 0
        for item in built:
            if item["id"] in existing:
                continue
            existing.add(item["id"])
            toks = set(item["tokens"])
            editorial = bool(item["is_editorial"])
            sid = None
            if not item["is_library"]:
                sid = clusterer.find(toks, editorial)
            if sid is None:
                sid = "s" + item["id"]
                new_stories.add(sid)
            item["story_id"] = sid
            if db.insert_item(item):
                src_new += 1
                touched.add(sid)
                if not item["is_library"]:
                    clusterer.add(sid, toks, editorial)
        n_new += src_new
        st["total_items"] = int(st.get("total_items") or 0) + src_new
        db.save_source_state(st)
        for a in res.attempts:
            db.log_fetch(run_id=run_id, source_id=src["id"], step=a.step, step_kind=a.kind, ok=int(a.ok),
                         n_items=a.n, n_new=src_new if a.ok else 0, error=a.error,
                         started_at=iso(now), duration_ms=a.ms)
    db.commit()

    for sid in touched:
        aggregate_story(db, clf, sid)
    pruned = prune(settings, db, clf)
    db.x("DELETE FROM fetch_log WHERE id < (SELECT MAX(id) - 50000 FROM fetch_log)")
    db.commit()

    failed = [r.source["id"] for r, _ in results if not r.ok]
    summary = {
        "id": run_id,
        "started_at": iso(now),
        "finished_at": iso(utcnow()),
        "n_sources": len(due),
        "n_ok": len(due) - len(failed),
        "n_items": n_items,
        "n_new": n_new,
        "n_new_stories": len(new_stories & touched),
        "note": f"failed: {', '.join(sorted(failed))}"[:1000] if failed else "",
    }
    db.save_run(summary)
    summary.update({"failed": failed, "pruned": pruned, "warnings": ctx.warnings,
                    "duration_s": round(time.monotonic() - t0, 1)})
    return summary


def prune(settings: Settings, db: DB, clf: Classifier) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=settings.keep_days)).date().isoformat()
    stale = db.delete_items("date_ist < ? AND is_library=0", (cutoff,))
    for sid in stale:
        aggregate_story(db, clf, sid)
    return len(stale)


def reclassify(settings: Settings, db: DB) -> int:
    """Re-tag every stored item after editing topics.yaml (does not re-cluster)."""
    clf = Classifier(load_topics(settings))
    rows = db.q("SELECT id, title, summary, tier, extra FROM items")
    for r in rows:
        extra = json.loads(r["extra"] or "{}") if r["extra"] else {}
        a = clf.analyze(r["title"] or "", r["summary"] or "", (extra or {}).get("ministry", ""))
        db.update_item(r["id"], subjects=a.subjects, tags=a.tags, watch=a.watch, score=clf.score(a, r["tier"] or "general"))
    db.commit()
    sids = [r["story_id"] for r in db.q("SELECT DISTINCT story_id FROM items WHERE story_id IS NOT NULL")]
    for sid in sids:
        aggregate_story(db, clf, sid)
    db.commit()
    return len(rows)

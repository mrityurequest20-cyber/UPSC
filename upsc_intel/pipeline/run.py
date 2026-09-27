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
from ..fetchers.describe import describe_new, page_description
from ..fetchers.http import Http
from ..models import RawItem
from .articles import read_brief_articles
from .triage import dedupe as ai_dedupe
from .triage import triage as ai_triage
from .brief import build_day, recent_days, update_recent
from .classify import Classifier
from .cluster import Clusterer, aggregate_story, merge_republished, split_mixed_stories
from .kinds import EDITORIAL, EXPLAINED, NEWS, content_kind, item_kind
from .normalize import IST, canonical_url, clean_title, ist_date, make_id, title_tokens
from .videos import link_brief_videos, video_row

log = logging.getLogger("upsc_intel")
RUN_LOCK = threading.Lock()
MIGRATION_KINDS = "migration:kinds-v1"  # re-label stored items as news / editorial / explained once
MIGRATION_CLASSIFY = "migration:classify-v5"  # re-grade once: UPSC-relevance rejection rules
MIGRATION_BRIEF = "migration:brief-v3"  # rebuild every stored brief once: Must-know / Prelims facts / Also tiers


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
    a = clf.analyze(title, raw.summary or "", hint, publisher=raw.publisher or src.get("name") or "", day=date_ist)
    tier = src.get("tier", "general")
    step_kind = src.get("_step_kind") or src.get("kind")
    kind = NEWS if is_library else content_kind(src, title, url, step_kind)
    return {
        "id": make_id(canon or raw.guid or title),
        "source_id": src["id"],
        "source_name": src.get("name"),
        "section": src.get("section") or (raw.extra or {}).get("ministry") or "",
        "publisher": raw.publisher or src.get("name"),
        "kind": step_kind,
        "tier": tier,
        "url": url,
        "title": title,
        "summary": raw.summary or "",
        "published_at": iso(published),
        "fetched_at": iso(now),
        "date_ist": date_ist,
        "is_editorial": int(kind == EDITORIAL),
        "is_explained": int(kind == EXPLAINED),
        "is_library": int(is_library),
        "is_private": int(bool(src.get("private"))),
        "tokens": title_tokens(title),
        "subjects": a.subjects,
        "tags": a.tags,
        "watch": a.watch,
        "score": clf.score(a, tier, kind),
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
    if not db.seen(MIGRATION_KINDS):
        log.info("one-time: labelling stored items as news / editorial / explained")
        backfill_descriptions(settings, db, sources)
        reclassify(settings, db)
        db.mark_seen(MIGRATION_KINDS)
        db.mark_seen(MIGRATION_CLASSIFY)
        db.commit()
    elif not db.seen(MIGRATION_CLASSIFY):
        log.info("one-time: re-grading stored items (foreign affairs, routine notices)")
        reclassify(settings, db)
        db.mark_seen(MIGRATION_CLASSIFY)
        db.commit()
    clf = Classifier(load_topics(settings))
    if not db.seen(MIGRATION_BRIEF):
        log.info("one-time: rebuilding stored briefs (Must-know / Prelims facts / Also in the news)")
        for (d,) in db.conn.execute("SELECT DISTINCT date_ist FROM stories WHERE is_library=0").fetchall():
            build_day(settings, db, clf, d)
        db.mark_seen(MIGRATION_BRIEF)
        db.commit()
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
        n_described = describe_new(ctx, results)
    finally:
        http.close()

    cutoff = (datetime.now(IST).date() - timedelta(days=settings.max_item_age_days)).isoformat()
    clusterer = Clusterer(db)
    touched: set[str] = set(ctx.stale_story_ids)
    new_stories: set[str] = set()
    n_items = n_new = 0
    n_videos = 0
    for res, st in results:
        src = dict(res.source)
        if src.get("role") == "video":  # video library, not news cards
            for raw in res.items:
                row = video_row(raw, src)
                if row and db.upsert_video(row):
                    n_videos += 1
            st["total_items"] = int(st.get("total_items") or 0) + len(res.items)
            db.save_source_state(st)
            for a in res.attempts:
                db.log_fetch(run_id=run_id, source_id=src["id"], step=a.step, step_kind=a.kind, ok=int(a.ok),
                             n_items=a.n, n_new=0, error=a.error, started_at=iso(now), duration_ms=a.ms)
            continue
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
            kind = item_kind(item)
            sid = None
            if not item["is_library"]:
                sid = clusterer.find(toks, kind)
            if sid is None:
                sid = "s" + item["id"]
                new_stories.add(sid)
            item["story_id"] = sid
            if db.insert_item(item):
                src_new += 1
                touched.add(sid)
                if not item["is_library"]:
                    clusterer.add(sid, toks, kind)
        n_new += src_new
        st["total_items"] = int(st.get("total_items") or 0) + src_new
        db.save_source_state(st)
        for a in res.attempts:
            db.log_fetch(run_id=run_id, source_id=src["id"], step=a.step, step_kind=a.kind, ok=int(a.ok),
                         n_items=a.n, n_new=src_new if a.ok else 0, error=a.error,
                         started_at=iso(now), duration_ms=a.ms)
    db.commit()

    touched |= merge_republished(db)
    for sid in touched:
        aggregate_story(db, clf, sid)
    pruned = prune(settings, db, clf)
    db.x("DELETE FROM fetch_log WHERE id < (SELECT MAX(id) - 50000 FROM fetch_log)")
    db.commit()

    triage_stats = {}
    if not only:
        try:  # Gemini grades the new stories before the brief is picked (a used-up quota leaves them to the rules)
            triage_stats = ai_triage(settings, db, clf, recent_days())
        except Exception:
            log.exception("AI triage failed")
    brief_days = update_recent(settings, db, clf)
    if not only:
        try:  # Gemini folds cards that report the same event (a speech told three ways is one card)
            dd = ai_dedupe(settings, db, brief_days)
            for d in dd.get("changed") or []:
                build_day(settings, db, clf, d)
            db.commit()
            triage_stats["dedupe"] = dd
        except Exception:
            log.exception("AI dedupe failed")
    video_stats = {}
    article_stats = {}
    if not only:
        try:
            video_stats = link_brief_videos(settings, db, brief_days)
        except Exception:  # videos are a bonus; never fail the run over them
            log.exception("video linking failed")
        try:  # the brief cards' free full text: summaries, the PDF and practice questions read it
            article_stats = read_brief_articles(db, load_topics(settings), brief_days)
            if article_stats.get("stale"):  # an old article a feed filed under today: rebuild without it
                for d in brief_days:
                    build_day(settings, db, clf, d)
                db.commit()
        except Exception:
            log.exception("reading the brief's articles failed")

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
    summary.update({"failed": failed, "pruned": pruned, "warnings": ctx.warnings, "new_videos": n_videos,
                    "described": n_described,
                    "videos": video_stats, "articles": article_stats, "triage": triage_stats,
                    "duration_s": round(time.monotonic() - t0, 1)})
    return summary


def backfill_descriptions(settings: Settings, db: DB, sources: list[dict], days: int = 4, limit: int = 300) -> int:
    """One-time: give recent items of `describe` sources the preview text they were stored without."""
    ids = [s["id"] for s in sources if s.get("describe")]
    if not ids:
        return 0
    since = (datetime.now(IST).date() - timedelta(days=days)).isoformat()
    rows = db.q(f"SELECT id, url FROM items WHERE source_id IN ({','.join('?' * len(ids))}) AND date_ist >= ? "
                f"AND COALESCE(summary,'') = '' AND kind != 'gnews' ORDER BY date_ist DESC LIMIT ?", [*ids, since, limit])
    http = Http(timeout=settings.http_timeout)

    def work(row):
        try:
            return row["id"], page_description(http, row["url"])
        except Exception:
            return row["id"], ""

    try:
        with ThreadPoolExecutor(max_workers=6) as ex:
            found = [(i, d) for i, d in ex.map(work, rows) if d]
    finally:
        http.close()
    for item_id, text in found:
        db.x("UPDATE items SET summary=? WHERE id=?", (text, item_id))
        db.x("UPDATE items_fts SET body=? WHERE item_id=?", (text, item_id))
    db.commit()
    return len(found)


def prune(settings: Settings, db: DB, clf: Classifier) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=settings.keep_days)).date().isoformat()
    stale = db.delete_items("date_ist < ? AND is_library=0", (cutoff,))
    for sid in stale:
        aggregate_story(db, clf, sid)
    return len(stale)


def reclassify(settings: Settings, db: DB) -> int:
    """Re-tag every stored item after editing topics.yaml or sources.yaml (kinds included).
    Items whose kind changed leave their old cluster; nothing else is re-clustered."""
    clf = Classifier(load_topics(settings))
    sources = {s["id"]: s for s in load_sources(settings)}
    rows = db.q("SELECT id, source_id, kind, url, title, summary, tier, extra, is_library, publisher, date_ist FROM items")
    for r in rows:
        extra = json.loads(r["extra"] or "{}") if r["extra"] else {}
        tier = r["tier"] or "general"
        src = sources.get(r["source_id"]) or {"tier": tier}
        kind = NEWS if r["is_library"] else content_kind(src, r["title"] or "", r["url"] or "", r["kind"])
        a = clf.analyze(r["title"] or "", r["summary"] or "", (extra or {}).get("ministry", ""),
                        publisher=r["publisher"] or "", day=r["date_ist"] or "")
        db.update_item(r["id"], subjects=a.subjects, tags=a.tags, watch=a.watch, score=clf.score(a, tier, kind),
                       is_editorial=int(kind == EDITORIAL), is_explained=int(kind == EXPLAINED))
    db.commit()
    split_mixed_stories(db)
    merge_republished(db, window_days=settings.max_item_age_days + 1)
    sids = {r["story_id"] for r in db.q("SELECT DISTINCT story_id FROM items WHERE story_id IS NOT NULL")}
    sids |= {r["id"] for r in db.q("SELECT id FROM stories")}  # stories left empty are deleted
    for sid in sids:
        aggregate_story(db, clf, sid)
    db.commit()
    for (d,) in db.conn.execute("SELECT DISTINCT date_ist FROM brief_picks").fetchall():
        build_day(settings, db, clf, d)
    db.commit()
    return len(rows)

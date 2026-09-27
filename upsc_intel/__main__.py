"""CLI: python -m upsc_intel <command>"""
from __future__ import annotations

import argparse
import json
import logging
import sys

from .config import get_settings, load_sources
from .db import DB


_OPEN: list[DB] = []


def _db(settings) -> DB:
    """Opened databases are closed when the command ends, which checkpoints SQLite's write-ahead
    log into upsc.db: CI caches that one file between runs."""
    settings.ensure_dirs()
    db = DB(settings.db_path)
    _OPEN.append(db)
    return db


def cmd_fetch(args) -> int:
    from .pipeline.run import run_fetch

    s = get_settings()
    db = _db(s)
    res = run_fetch(s, db, only=args.only or None, public_only=args.public_only, force=args.force)
    print(json.dumps(res, indent=2))
    if args.enrich and s.ai_enabled:
        from .pipeline.enrich import enrich_top

        print(json.dumps(enrich_top(s, db), indent=2))
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    from .web.app import create_app

    s = get_settings()
    app = create_app(s, scheduler=not args.no_scheduler, public_only=args.public_only)
    uvicorn.run(app, host=args.host or s.host, port=args.port or s.port, log_level="info")
    return 0


def cmd_sources(args) -> int:
    s = get_settings()
    db = _db(s)
    states = db.all_source_states()
    rows = []
    for src in load_sources(s, public_only=args.public_only):
        st = states.get(src["id"], {})
        step = int(st.get("active_step") or 0)
        rows.append((
            src["id"], src.get("tier"),
            st.get("last_step_kind") or src["chain"][min(step, len(src["chain"]) - 1)].get("kind"),
            st.get("last_count", "-"), st.get("total_items", 0), (st.get("last_ok_at") or "never")[:16],
            (st.get("last_error") or "")[:60],
        ))
    print(f"{'source':34} {'tier':9} {'using':8} {'last':>5} {'total':>6}  {'last ok':16}  error")
    for r in rows:
        print(f"{r[0][:34]:34} {r[1]:9} {r[2]:8} {str(r[3]):>5} {r[4]:>6}  {r[5]:16}  {r[6]}")
    return 0


def cmd_reclassify(args) -> int:
    from .pipeline.run import reclassify

    s = get_settings()
    print(f"re-tagged {reclassify(s, _db(s))} items")
    return 0


def cmd_enrich(args) -> int:
    from .pipeline.enrich import enrich_top

    s = get_settings()
    if not s.ai_enabled:
        print("Set GEMINI_API_KEY (free, from Google AI Studio) or ANTHROPIC_API_KEY to enable AI notes.", file=sys.stderr)
        return 1
    print(json.dumps(enrich_top(s, _db(s), limit=args.limit), indent=2))
    return 0


def cmd_import_notes(args) -> int:
    from .pipeline.notes import import_notes

    s = get_settings()
    print(json.dumps(import_notes(_db(s), args.folder)))
    return 0


def cmd_articles(args) -> int:
    from datetime import date, timedelta

    from .config import load_topics
    from .pipeline.articles import read_brief_articles
    from .pipeline.normalize import today_ist

    s = get_settings()
    t = date.fromisoformat(args.day or today_ist())
    days = [(t - timedelta(days=i)).isoformat() for i in range(args.days)]
    print(json.dumps(read_brief_articles(_db(s), load_topics(s), days, limit=args.limit)))
    return 0


def cmd_export(args) -> int:
    from .static_export import export_static

    s = get_settings()
    out = export_static(s, _db(s), args.out, days=args.days, include_private=args.include_private,
                        snapshot=args.snapshot, archive=args.archive)
    print(f"static site written to {out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="upsc_intel", description="UPSC Intel: live current-affairs dashboard")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="run one fetch cycle now")
    f.add_argument("--only", nargs="*", help="source ids (or id prefixes) to fetch")
    f.add_argument("--public-only", action="store_true", help="skip email / library / private feeds")
    f.add_argument("--force", action="store_true", help="ignore per-source intervals")
    f.add_argument("--enrich", action="store_true", help="also write AI notes (needs ANTHROPIC_API_KEY)")
    f.set_defaults(fn=cmd_fetch)

    sv = sub.add_parser("serve", help="run the dashboard + live scheduler")
    sv.add_argument("--host")
    sv.add_argument("--port", type=int)
    sv.add_argument("--no-scheduler", action="store_true", help="serve only, don't fetch in the background")
    sv.add_argument("--public-only", action="store_true")
    sv.set_defaults(fn=cmd_serve)

    so = sub.add_parser("sources", help="source health table")
    so.add_argument("--public-only", action="store_true")
    so.set_defaults(fn=cmd_sources)

    rc = sub.add_parser("reclassify", help="re-tag stored items after editing config/topics.yaml")
    rc.set_defaults(fn=cmd_reclassify)

    en = sub.add_parser("enrich", help="write AI notes for the brief cards (needs GEMINI_API_KEY, free, or ANTHROPIC_API_KEY)")
    en.add_argument("--limit", type=int)
    en.set_defaults(fn=cmd_enrich)

    im = sub.add_parser("import-notes", help="store Claude-written study notes (notes/*.json) as story write-ups")
    im.add_argument("folder")
    im.set_defaults(fn=cmd_import_notes)

    ar = sub.add_parser("articles", help="read the free full text of the brief's cards (free sites only)")
    ar.add_argument("--day", help="last day (YYYY-MM-DD, default today IST)")
    ar.add_argument("--days", type=int, default=2, help="how many days back from --day")
    ar.add_argument("--limit", type=int, default=40)
    ar.set_defaults(fn=cmd_articles)

    ex = sub.add_parser("export-static", help="build the static site (GitHub Pages)")
    ex.add_argument("--out", default="site")
    ex.add_argument("--days", type=int, default=62)
    ex.add_argument("--include-private", action="store_true",
                    help="also export email/library/private items (never do this for a public site)")
    ex.add_argument("--snapshot", action="store_true",
                    help="frozen copy: no auto-refresh, no export button (for sharing a point-in-time view)")
    ex.add_argument("--archive", default=None,
                    help="folder of frozen past months: finished months are saved there and always published")
    ex.set_defaults(fn=cmd_export)

    args = p.parse_args(argv)
    try:
        return args.fn(args)
    finally:
        while _OPEN:
            _OPEN.pop().close()


if __name__ == "__main__":
    raise SystemExit(main())

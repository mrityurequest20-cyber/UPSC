"""`quantdesk intraday …` commands.

  live      real-time paper trading on today's session (Yahoo or Kite bars; NSE/Kite/model chain)
  replay    re-run recorded sessions (--date / --last N) or synthetic ones (--synthetic N)
  thoughts  the analyst's reads, newest last
  trades    intraday trades with setup, structure, P&L, R, grade
  review    the written session review(s)
  stats     performance across sessions: by setup, structure, day type, time of day, exit
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pandas as pd

from ..core.calendar import TradingCalendar
from ..journal.journal import Journal
from .engine import IntradayEngine, run_live, run_replay
from .feeds import ReplayFeed
from .recorder import SessionRecorder
from .sim import IntradayBroker


def paths(cfg, account: str) -> dict:
    base = cfg.runtime_dir / "intraday"
    acct = base if account == "live" else base / account
    acct.mkdir(parents=True, exist_ok=True)
    return {"journal": acct / "journal.db", "broker": acct / "broker.json", "reviews": acct / "reviews",
            "data": base / "data"}


def _chain_source(cfg, name: str, kite=None):
    if name == "nse":
        from .chains import NSEOptionChain
        return NSEOptionChain()
    if name == "kite":
        from .chains import KiteOptionChain
        return KiteOptionChain(kite)
    return "model"


def _say(quiet: bool):
    return (lambda *a: None) if quiet else (lambda *a: print(*a, flush=True))


def cmd_live(cfg, a):
    p = paths(cfg, "live")
    syms = a.symbols.split(",") if a.symbols else None
    feed_name = a.feed or cfg.get("intraday.feed", "yahoo")
    underlyings = syms or cfg.get("intraday.underlyings")
    if feed_name == "kite":
        from .feeds import KiteIntradayFeed
        feed = KiteIntradayFeed(cfg, underlyings + [cfg.get("universe.volatility_index")])
        kite = feed.kite
    else:
        from .feeds import YahooIntradayFeed
        feed, kite = YahooIntradayFeed(cfg), None
    chains = _chain_source(cfg, a.chain or cfg.get("intraday.chain", "nse"), kite)
    broker = IntradayBroker(cfg, starting_cash=cfg.get("intraday.capital"), state_path=p["broker"],
                            adverse_ticks=cfg.get("intraday.adverse_ticks", 1))
    j = Journal(p["journal"], autocommit_every=1)
    eng = IntradayEngine(cfg, feed, chains, j, broker, SessionRecorder(p["data"]), _say(a.quiet), underlyings, p["reviews"])
    stop = dt.time.fromisoformat(a.until) if a.until else None
    print(run_live(eng, stop))


def _synthetic_bars(cfg, n: int, seed: int):
    from .synthetic import simulate_sessions
    cal = TradingCalendar(cfg.holidays())
    end = pd.Timestamp.today().normalize()
    days = [d.date() for d in cal.trading_days(end - pd.Timedelta(days=int((n + 8) * 1.6) + 10), end)]
    bars, meta = simulate_sessions(days, seed=seed)
    return bars, meta, days[-n:]


def cmd_replay(cfg, a):
    account = a.account or ("synthetic" if a.synthetic else "replay")
    p = paths(cfg, account)
    if a.fresh:
        for k in ("journal", "broker"):
            if p[k].exists():
                p[k].unlink()
    broker = IntradayBroker(cfg, starting_cash=cfg.get("intraday.capital"), state_path=p["broker"],
                            adverse_ticks=cfg.get("intraday.adverse_ticks", 1))
    j = Journal(p["journal"])
    if a.synthetic:
        bars, meta, days = _synthetic_bars(cfg, a.synthetic, a.seed)
        chains_for = lambda d: "model"
        label = lambda d: f"synthetic {meta.loc[d, 'type']}"
    else:
        rec = SessionRecorder(p["data"])
        avail = rec.days()
        if not avail:
            sys.exit(f"no recorded sessions under {p['data']} — run `quantdesk intraday live` first, or use --synthetic N")
        days = [dt.date.fromisoformat(a.date)] if a.date else avail[-(a.last or 1):]
        syms = cfg.get("intraday.underlyings") + [cfg.get("universe.volatility_index")]
        bars = rec.load_bars(syms, upto=max(days))

        def chains_for(d):
            from .chains import RecordedChains
            snaps = rec.load_chains(d)
            return RecordedChains(snaps) if snaps and a.chain != "model" else "model"
        label = lambda d: "recorded"
    results = []
    rec_out = SessionRecorder(p["data"] if not a.synthetic else paths(cfg, account)["journal"].parent / "data")
    for d in days:
        feed = ReplayFeed(bars, d)
        if a.synthetic:
            syms = cfg.get("intraday.underlyings") + [cfg.get("universe.volatility_index")]
            for sym in syms:
                rec_out.record_bars(sym, bars[sym][bars[sym].index.date == d])
        eng = IntradayEngine(cfg, feed, chains_for(d), j, broker, None, _say(a.quiet), None, p["reviews"])
        start = broker.cash()
        review = run_replay(eng)
        results.append((d, label(d), len(eng.closed), broker.cash() - start))
        if a.show_review:
            print(review, "\n")
        print(f"{d} [{label(d)}]  trades {len(eng.closed):>2}  day P&L ₹{broker.cash() - start:>+10,.0f}  "
              f"account ₹{broker.cash():,.0f}", flush=True)
    j.commit()
    tot = sum(r[3] for r in results)
    print(f"\n{len(results)} session(s), net ₹{tot:+,.0f}; journal → {p['journal']}")


def _journal(cfg, a) -> Journal:
    return Journal(paths(cfg, a.account or "live")["journal"])


def cmd_thoughts(cfg, a):
    j = _journal(cfg, a)
    th = j.thoughts(a.date, a.symbol)
    if th.empty:
        print("no thoughts recorded")
        return
    for r in th.tail(a.n).itertuples():
        print(f"{str(r.ts)[:16]}  {r.symbol:<9} {r.bias:<8} {r.score:+.2f} c{r.conviction:.2f} {r.day_type:<12} | {r.action}")
        if a.verbose:
            print("   ", r.narrative)
            for e in json.loads(r.evidence):
                print(f"      {e['direction']:+.2f}×{e['weight']:.1f}  {e['factor']:<11} {e['observation']}")


def cmd_trades(cfg, a):
    t = _journal(cfg, a).trades()
    if a.date:
        t = t[t["opened_at"].str.startswith(a.date)]
    if t.empty:
        print("no trades")
        return
    t["structure"] = t["meta"].map(lambda m: json.loads(m).get("structure"))
    t["time"] = t["opened_at"].str[11:16] + "–" + t["closed_at"].fillna("").str[11:16]
    cols = ["id", "opened_at", "time", "strategy", "symbol", "structure", "units", "pnl", "r_multiple", "exit_reason", "grade"]
    t["opened_at"] = t["opened_at"].str[:10]
    print(t[cols].tail(a.n).to_string(index=False, float_format=lambda v: f"{v:,.2f}"))
    if a.id:
        r = t[t["id"] == a.id]
        if not r.empty:
            full = _journal(cfg, a).df("SELECT * FROM trades WHERE id=?", (a.id,)).iloc[0]
            print(f"\n{full['rationale']}\n\nSizing: {full['sizing']}\nReview: {full['review']}\nLessons: {full['lessons']}")


def cmd_review(cfg, a):
    rd = paths(cfg, a.account or "live")["reviews"]
    files = sorted(rd.glob("*.md")) if rd.exists() else []
    if a.date:
        files = [f for f in files if f.stem == a.date]
    if not files:
        print("no session reviews yet")
        return
    for f in files[-(a.n if a.n else 1):]:
        print(f.read_text(encoding="utf-8"), "\n")


def cmd_stats(cfg, a):
    j = _journal(cfg, a)
    t = j.trades("closed")
    if t.empty:
        print("no closed trades")
        return
    t["day"] = t["opened_at"].str[:10]
    t["structure"] = t["meta"].map(lambda m: json.loads(m).get("structure"))
    t["day_type"] = t["context"].map(lambda c: json.loads(c).get("regime"))
    t["hour"] = t["opened_at"].str[11:13] + ":00"

    def table(by):
        g = t.groupby(by)
        out = pd.DataFrame({"trades": g.size(), "win %": g["pnl"].apply(lambda x: (x > 0).mean() * 100),
                            "avg R": g["r_multiple"].mean(), "net ₹": g["pnl"].sum(), "fees ₹": g["fees"].sum()})
        return out.sort_values("net ₹", ascending=False).to_string(float_format=lambda v: f"{v:,.2f}")

    daily = t.groupby("day")["pnl"].sum()
    cap = cfg.get("intraday.capital", 500000)
    eq = cap + daily.cumsum()
    dd = (eq / eq.cummax() - 1).min()
    print(f"{len(t)} trades over {len(daily)} sessions · net ₹{t['pnl'].sum():,.0f} ({t['pnl'].sum() / cap:+.2%} of capital) · "
          f"win {(t['pnl'] > 0).mean():.0%} · avg {t['r_multiple'].mean():+.2f}R · profit factor "
          f"{t[t.pnl > 0].pnl.sum() / max(-t[t.pnl <= 0].pnl.sum(), 1):.2f} · costs ₹{t['fees'].sum():,.0f} · "
          f"green days {(daily > 0).mean():.0%} · worst day ₹{daily.min():,.0f} · max DD {dd:.2%}")
    for by in ("strategy", "structure", "day_type", "exit_reason", "hour", "symbol"):
        print(f"\nBy {by}:\n{table(by)}")


def cmd_export_site(cfg, a):
    from ..web.export_site import export_site
    out = export_site(cfg, a.account or "live", Path(a.out), a.sessions, a.label, a.note)
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB): open it in any browser, or host it anywhere static")


def register(sub):
    s = sub.add_parser("intraday", help="real-time intraday options desk (paper)")
    ss = s.add_subparsers(dest="icmd", required=True)
    x = ss.add_parser("live", help="trade today's session in real time (paper)")
    x.add_argument("--feed", choices=["yahoo", "kite"])
    x.add_argument("--chain", choices=["nse", "kite", "model"])
    x.add_argument("--symbols", help="e.g. NIFTY,BANKNIFTY")
    x.add_argument("--until", help="HH:MM to stop early")
    x.add_argument("--quiet", action="store_true")
    x.set_defaults(fn=cmd_live)
    x = ss.add_parser("replay", help="replay recorded or synthetic sessions")
    x.add_argument("--date")
    x.add_argument("--last", type=int)
    x.add_argument("--synthetic", type=int, help="N synthetic sessions (offline demo)")
    x.add_argument("--seed", type=int, default=11)
    x.add_argument("--chain", choices=["recorded", "model"], default="recorded")
    x.add_argument("--account", help="journal/broker namespace (default: replay or synthetic)")
    x.add_argument("--fresh", action="store_true", help="reset that account first")
    x.add_argument("--show-review", action="store_true")
    x.add_argument("--quiet", action="store_true")
    x.set_defaults(fn=cmd_replay)
    x = ss.add_parser("export-site", help="write the web app + an account's data as one read-only HTML file")
    x.add_argument("--account", help="live (default), replay, synthetic")
    x.add_argument("--out", default="quantdesk-snapshot.html")
    x.add_argument("--sessions", type=int, default=3, help="sessions of thoughts to include")
    x.add_argument("--label")
    x.add_argument("--note")
    x.set_defaults(fn=cmd_export_site)
    for name, fn, help_ in (("thoughts", cmd_thoughts, "the analyst's reads"), ("trades", cmd_trades, "intraday trades"),
                            ("review", cmd_review, "session reviews"), ("stats", cmd_stats, "performance breakdown")):
        x = ss.add_parser(name, help=help_)
        x.add_argument("--account", help="live (default), replay, synthetic")
        x.add_argument("--date")
        x.add_argument("--symbol")
        x.add_argument("--id")
        x.add_argument("-n", type=int, default=40)
        x.add_argument("-v", "--verbose", action="store_true")
        x.set_defaults(fn=fn)
    return s

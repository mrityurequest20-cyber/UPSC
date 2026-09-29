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
from .engine import IntradayEngine, close_out, run_live, run_replay
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


def _live_engine(cfg, a) -> IntradayEngine:
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
    return IntradayEngine(cfg, feed, chains, j, broker, SessionRecorder(p["data"]), _say(a.quiet), underlyings, p["reviews"])


def cmd_live(cfg, a):
    if a.close_out:
        print(close_out(_live_engine(cfg, a)), flush=True)
        return
    stop = dt.time.fromisoformat(a.until) if a.until else None
    if a.handover and not stop:
        sys.exit("--handover needs --until HH:MM")
    if not a.forever:
        print(run_live(_live_engine(cfg, a), stop, handover=a.handover), flush=True)
        return
    # always-on host (Docker / systemd): one fresh engine per NSE session, asleep in between
    import time
    from .feeds import IST, session_bounds
    cal = TradingCalendar(cfg.holidays())
    while True:
        now = pd.Timestamp.now(tz=IST)
        if cal.is_trading_day(now.date()) and now < session_bounds(now.date())[1]:
            try:
                print(run_live(_live_engine(cfg, a)), flush=True)
            except Exception as exc:                    # a bad day must not kill the service
                print(f"session failed: {exc!r}; retrying in 5 min", flush=True)
                time.sleep(300)
                continue
        nxt = cal.next_trading_day(now.date())
        wake = session_bounds(nxt)[0] - pd.Timedelta(minutes=15)
        print(f"next session {nxt:%a %d-%b}; sleeping until {wake:%a %H:%M} IST", flush=True)
        while pd.Timestamp.now(tz=IST) < wake:
            time.sleep(min(600, max(1, (wake - pd.Timestamp.now(tz=IST)).total_seconds())))


def cmd_command(cfg, a):
    """Queue pause / resume / flatten / close for the running engine (same queue the app uses)."""
    from ..web.intraday_api import IntradayAPI
    try:
        r = IntradayAPI(cfg).command(a.account or "live", {"cmd": a.cmd, "arg": a.id})
    except ValueError as exc:
        sys.exit(str(exc))
    print(f"queued {r['queued']['cmd']}{' ' + a.id if a.id else ''}: the engine applies it on its next minute")


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
    from ..web.export_site import export_site, publish_site
    if a.dir:
        out = publish_site(cfg, a.account or "live", Path(a.dir), a.sessions, a.label, a.note)
        print(f"published {out}/ (data.json {(out / 'data.json').stat().st_size / 1e6:.2f} MB): serve the folder from "
              f"any static host; the page re-reads data.json every minute", flush=True)
        return
    out = export_site(cfg, a.account or "live", Path(a.out), a.sessions, a.label, a.note)
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB): open it in any browser, or host it anywhere static")


def cmd_doctor(cfg, a):
    """Can this machine run the live desk? Market-data reachability, the calendar, expiries."""
    import time
    from .chains import NSEOptionChain
    from .feeds import IST, YahooIntradayFeed
    cal = TradingCalendar(cfg.holidays())
    now = pd.Timestamp.now(tz=IST)
    print(f"now {now:%a %Y-%m-%d %H:%M} IST · {'NSE trading day' if cal.is_trading_day(now.date()) else 'not an NSE trading day'}"
          f" · next session {cal.next_trading_day(now.date()):%a %d-%b}")
    syms = cfg.get("intraday.underlyings") + [cfg.get("universe.volatility_index")]
    feed, yahoo_ok = YahooIntradayFeed(cfg), True
    for sym in syms:
        t0 = time.time()
        try:
            df = feed.history(sym, 2)
            if df.empty:
                raise RuntimeError("no bars returned")
            lag = (now - df.index[-1]).total_seconds() / 60
            print(f"  yahoo  {sym:<10} ok   {len(df):>4} 1m bars · last {df.index[-1]:%d-%b %H:%M} "
                  f"({lag:,.0f} min ago) · {time.time() - t0:.1f}s")
        except Exception as exc:
            yahoo_ok = False
            print(f"  yahoo  {sym:<10} FAIL {exc!s:.160}")
    for u in cfg.get("intraday.underlyings"):
        spec = cfg.instrument_spec(u)
        exps = cal.expiries(now.date(), 40, int(spec.get("expiry_weekday", 1)), bool(spec.get("weekly_expiry", True)))
        print(f"  calendar {u:<8} next expiries {', '.join(f'{e:%a %d-%b}' for e in exps[:3])}")
    nse = NSEOptionChain()
    try:
        t0 = time.time()
        exps = nse.expiries("NIFTY")
        ch = nse.chain("NIFTY", exps[0])
        print(f"  nse    NIFTY      ok   expiries {', '.join(f'{e:%d-%b}' for e in exps[:3])} · {len(ch)} strikes "
              f"· spot {ch.attrs.get('spot')} · {time.time() - t0:.1f}s")
        nse_ok = True
    except Exception as exc:
        nse_ok = False
        print(f"  nse    NIFTY      FAIL {exc!s:.160}")
    print("verdict:", "ready" if yahoo_ok and nse_ok else
          "ready, pricing options off the model chain (NSE unreachable from here)" if yahoo_ok else
          "NOT ready: no bars from Yahoo, so the desk has nothing to read")
    if not yahoo_ok:
        sys.exit(1)


def register(sub):
    s = sub.add_parser("intraday", help="real-time intraday options desk (paper)")
    ss = s.add_subparsers(dest="icmd", required=True)
    x = ss.add_parser("live", help="trade today's session in real time (paper)")
    x.add_argument("--feed", choices=["yahoo", "kite"])
    x.add_argument("--chain", choices=["nse", "kite", "model"])
    x.add_argument("--symbols", help="e.g. NIFTY,BANKNIFTY")
    x.add_argument("--until", help="HH:MM to stop early (squares off, unless --handover)")
    x.add_argument("--handover", action="store_true",
                   help="stop at --until WITHOUT squaring off; the next `live` run resumes the session")
    x.add_argument("--forever", action="store_true", help="always-on hosts: trade every NSE session, sleep in between")
    x.add_argument("--close-out", action="store_true",
                   help="square off today's open positions now and close the session (the kill switch)")
    x.add_argument("--quiet", action="store_true")
    x.set_defaults(fn=cmd_live)
    x = ss.add_parser("doctor", help="check this machine can run the live desk (Yahoo, NSE, calendar)")
    x.set_defaults(fn=cmd_doctor)
    x = ss.add_parser("command", help="pause / resume / flatten / close a position on the running engine")
    x.add_argument("cmd", choices=["pause", "resume", "flatten", "close"])
    x.add_argument("id", nargs="?", help="trade id (for close)")
    x.add_argument("--account", help="live (default)")
    x.set_defaults(fn=cmd_command)
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
    x = ss.add_parser("export-site", help="the web app + an account's data as a read-only static site")
    x.add_argument("--account", help="live (default), replay, synthetic")
    x.add_argument("--out", default="quantdesk-snapshot.html")
    x.add_argument("--dir", help="write a live-updating static site into this folder instead (index.html + data.json)")
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

"""The intraday engine — one loop for live paper trading and for replays.

Every completed minute:
  1. pull new 1m bars (and ticks, if the feed has them) and record them;
  2. refresh the option chain every few minutes; recalibrate option marks from it;
  3. compute the session state and let the analyst form a view (evidence, bias, day type,
     vol view, vetoes, narrative);
  4. manage open positions: invalidation level, premium stop/target, underlying target,
     breakeven trail, time stop, 15:15 square-off;
  5. scan the playbook; size through intraday risk; execute on the sim broker at bid/ask;
  6. journal the thought (every few minutes, on a bias change, and on every trade event).
At the close: square off, write the session review.
"""
from __future__ import annotations

import datetime as dt
import logging
import time
from pathlib import Path

import numpy as np
import pandas as pd

from ..core.calendar import TradingCalendar
from ..core.types import OPTIONS, Instrument, Order, Trade, TradeLeg, new_trade_id
from ..journal.journal import Journal, trade_from_dict, trade_to_dict
from .analyst import Analyst, MarketView
from .chains import ChainSource, IntradayPricer, ModelOptionChain, chain_analytics, fill_iv
from .features import session_state
from .feeds import IST, IntradayFeed, ReplayFeed, session_bounds
from .orderflow import FootprintBuilder
from .playbook import Playbook, TradePlan
from .risk import IntradayRisk
from .sim import IntradayBroker, QuoteMarker

log = logging.getLogger(__name__)


class IntradayEngine:
    def __init__(self, cfg, feed: IntradayFeed, chains: ChainSource | str | None, journal: Journal,
                 broker: IntradayBroker, recorder=None, say=print, underlyings: list[str] | None = None,
                 review_dir: Path | None = None):
        ic = cfg.get("intraday", {}) or {}
        self.cfg, self.feed, self.journal, self.broker, self.recorder = cfg, feed, journal, broker, recorder
        self.say = say or (lambda *_: None)
        self.underlyings = underlyings or ic.get("underlyings", ["NIFTY", "BANKNIFTY"])
        self.vix = cfg.get("universe.volatility_index", "INDIAVIX")
        self.cal = TradingCalendar(cfg.holidays())
        self.pricer = IntradayPricer(cfg.get("backtest.risk_free", 0.065), cfg.get("backtest.dividend_yield", 0.012))
        self.chains = ModelOptionChain(cfg, self.cal, self.model_state, self.pricer) if chains in (None, "model") else chains
        self.analyst, self.playbook, self.risk = Analyst(cfg), Playbook(cfg, self.pricer), IntradayRisk(cfg)
        self.marker = QuoteMarker(self.pricer)
        self.refresh_min = ic.get("chain_refresh_min", 3)
        self.think_every = ic.get("thought_every_min", 5)
        self.stale_min = ic.get("chain_stale_min", 12)
        self.history_days = ic.get("history_days", 6)
        self.expiry_min_days = ic.get("expiry_min_days", 1)
        self.review_dir = review_dir
        self.bars: dict[str, pd.DataFrame] = {}
        self.last_ts: dict[str, pd.Timestamp] = {}
        self.chain_df: dict[str, pd.DataFrame] = {}
        self.chain_an: dict[str, dict] = {}
        self.chain_at: dict[str, pd.Timestamp] = {}
        self.expiry: dict[str, dt.date] = {}
        self.open_trades: list[Trade] = []
        self.closed: list[Trade] = []
        self.views: dict[str, MarketView] = {}
        self.last_thought: dict[str, pd.Timestamp] = {}
        self.last_bias: dict[str, str] = {}
        self.flow = {u: FootprintBuilder(float(cfg.instrument_spec(u).get("tick", 0.05))) for u in self.underlyings}
        self.feature_cache: dict[str, dict] = {u: {} for u in self.underlyings}
        self.day: dt.date | None = None
        self.day_start_equity = broker.cash()
        self.paused = bool(journal.get_state("intraday_paused", False))
        self.events_today: list[str] = []

    # ---- helpers ----------------------------------------------------------------------------------
    def lot(self, u: str) -> int:
        return int(self.cfg.instrument_spec(u).get("lot_size", 1))

    def model_state(self, u: str, ts) -> tuple[float, float]:
        """Spot and ATM IV for the model chain: last 1m close, India VIX × iv_beta."""
        df = self.bars[u]
        S = float(df.loc[:ts]["close"].iloc[-1])
        v = self.bars.get(self.vix)
        vix = float(v.loc[:ts]["close"].iloc[-1]) if v is not None and len(v.loc[:ts]) else 14.0
        return S, vix / 100 * float(self.cfg.instrument_spec(u).get("iv_beta", 1.0))

    def pick_expiry(self, u: str, today: dt.date) -> dt.date:
        try:
            exps = self.chains.expiries(u, today) if isinstance(self.chains, ModelOptionChain) else self.chains.expiries(u)
        except Exception as exc:
            spec = self.cfg.instrument_spec(u)
            exps = self.cal.expiries(today, 70, int(spec.get("expiry_weekday", 1)), bool(spec.get("weekly_expiry", True)))
            self.journal.event(pd.Timestamp.now(tz=IST), "WARN", "chain", f"{u} expiries from calendar ({exc})")
        exps = [e for e in exps if (e - today).days >= self.expiry_min_days]
        return exps[0]

    def equity(self, now) -> float:
        val = 0.0
        for t in self.open_trades:
            S = self.spot(t.symbol)
            val += sum(l.qty * self.marker.mid(l.instrument, S, now) for l in t.legs)
        return self.broker.cash() + val

    def spot(self, u: str) -> float:
        return float(self.bars[u]["close"].iloc[-1])

    # ---- session lifecycle ------------------------------------------------------------------------------
    def start_session(self, day: dt.date) -> None:
        self.day = day
        for sym in self.underlyings + [self.vix]:
            h = self.feed.history(sym, self.history_days)
            self.bars[sym] = h.tail(375 * self.history_days) if h is not None else \
                pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
            self.last_ts[sym] = h.index[-1] if h is not None and len(h) else None
        self.expiry = {u: self.pick_expiry(u, day) for u in self.underlyings}
        self.events_today = [n for d, n in self.cfg.events() if d == day]
        self._restore(day)
        self.day_start_equity = self.broker.cash() + sum(t.entry_cost for t in self.open_trades)
        self.risk.reset(day, self.day_start_equity)
        self.risk.trades_today = len([t for t in self.closed if t.opened_at.date() == day]) + len(self.open_trades)
        exp = ", ".join(f"{u} {e:%d-%b}" for u, e in self.expiry.items())
        self.say(f"── session {day} · capital ₹{self.day_start_equity:,.0f} · expiries {exp} · chain {self.chains.name} "
                 f"· feed {self.feed.name}{' · events: ' + ', '.join(self.events_today) if self.events_today else ''}")
        self.journal.event(session_bounds(day)[0], "INFO", "session", f"session start; expiries {exp}; chain {self.chains.name}")

    def step(self) -> bool:
        now = self.feed.now()
        self._commands(now)
        got = False
        for sym in self.underlyings + [self.vix]:
            new = self.feed.poll(sym, self.last_ts.get(sym))
            if new is None or new.empty:
                continue
            self.bars[sym] = pd.concat([self.bars.get(sym), new]) if sym in self.bars and len(self.bars[sym]) else new
            self.last_ts[sym] = new.index[-1]
            if self.recorder:
                self.recorder.record_bars(sym, new)
            got = got or sym in self.underlyings
        if self.feed.has_ticks:
            for u in self.underlyings:
                for t in self.feed.trades(u):
                    self.flow[u].add(t)
        if not got:
            return False
        for u in self.underlyings:
            if u not in self.bars or self.bars[u].empty or self.bars[u].index[-1].date() != self.day:
                continue
            self._refresh_chain(u, now)
            s = session_state(self.bars[u], now, cache=self.feature_cache[u])
            if s is None:
                continue
            view = self.analyst.assess(u, s, self.chain_an.get(u), self._vix_state(), self.expiry[u] == self.day,
                                       ", ".join(self.events_today) or None, self._flow_state(u, now))
            self.views[u] = view
            exits = self._manage(u, view, now)
            action = self._maybe_enter(u, view, s, now)
            self._think(u, view, now, "; ".join(exits + [action]) if exits else action, force=bool(exits))
        if now.time() >= self.risk.square_off:
            for t in list(self.open_trades):
                self._close(t, now, "square_off", f"intraday square-off at {self.risk.square_off:%H:%M}")
        self._snapshot(now)
        self._persist()
        self._heartbeat(now)
        self.journal.commit()
        return True

    def end_session(self) -> str:
        now = self.feed.now()
        for t in list(self.open_trades):
            self._close(t, now, "square_off", "end of session")
        review = self.session_review()
        self.journal.event(now, "INFO", "session_review", review[:2000])
        self.journal.set_state("intraday_open", {"day": str(self.day), "trades": []})
        self.journal.commit()
        if self.review_dir:
            self.review_dir.mkdir(parents=True, exist_ok=True)
            (self.review_dir / f"{self.day}.md").write_text(review, encoding="utf-8")
        return review

    # ---- data -------------------------------------------------------------------------------------------
    def _refresh_chain(self, u: str, now) -> None:
        at = self.chain_at.get(u)
        if at is not None and (now - at) < pd.Timedelta(minutes=self.refresh_min):
            return
        try:
            ch = self.chains.chain(u, self.expiry[u], spot=self.spot(u), ts=now)
            if not ch.attrs.get("spot") or ch.attrs["spot"] != ch.attrs["spot"]:
                ch.attrs["spot"] = self.spot(u)
            ch = fill_iv(ch, self.pricer)
            self.chain_df[u] = ch
            self.chain_an[u] = chain_analytics(ch, self.pricer)
            self.chain_at[u] = now
            self.marker.calibrate(ch, self.lot(u))
            if self.recorder and ch.attrs.get("source") != "model":
                self.recorder.record_chain(ch)
        except Exception as exc:
            self.chain_at[u] = now
            self.journal.event(now, "WARN", "chain", f"{u} chain refresh failed: {exc}")

    def _vix_state(self) -> dict | None:
        v = self.bars.get(self.vix)
        if v is None or v.empty:
            return None
        today = v[v.index.date == self.day]
        prev = v[v.index.date < self.day]
        if today.empty:
            return None
        base = float(prev["close"].iloc[-1]) if len(prev) else float(today["open"].iloc[0])
        return {"last": float(today["close"].iloc[-1]), "chg": float(today["close"].iloc[-1]) / base - 1}

    def _flow_state(self, u: str, now) -> dict | None:
        fb = self.flow.get(u)
        if not self.feed.has_ticks or fb is None or not fb.bars:
            return None
        recent = [b for b in fb.bars if b.start >= now - pd.Timedelta(minutes=30)]
        if not recent:
            return None
        st = recent[-1].stacked
        return {"source": "ticks", "delta_30": sum(b.delta for b in recent), "volume_30": sum(b.volume for b in recent),
                "stacked_buy": st["buy"], "stacked_sell": st["sell"]}

    # ---- trading ------------------------------------------------------------------------------------------
    def _maybe_enter(self, u: str, view: MarketView, s: dict, now) -> str:
        if self.paused:
            return "standing aside: new entries paused from the app"
        if view.vetoes:
            return f"standing aside: {view.vetoes[0]}"
        if u not in self.chain_df:
            return "standing aside: no option chain"
        age = now - self.chain_at.get(u, now)
        if self.chain_df[u].attrs.get("source") != "model" and age > pd.Timedelta(minutes=self.stale_min):
            return f"standing aside: option chain {age.seconds // 60} min old"
        eq = self.equity(now)
        gate = self.risk.gate(now, eq, self.open_trades, u)
        if gate:
            return f"standing aside: {gate[0]}"
        plans = self.playbook.scan(view, s, self.chain_df[u], now)
        if not plans:
            return "watching: no setup has triggered"
        plan = max(plans, key=lambda p: p.conviction)
        lots, notes = self.risk.size(plan, eq)
        if lots < 1:
            self.journal.decision(now, plan.setup, u, "rejected", " | ".join(notes), 0, {"plan": plan.describe()})
            return f"setup {plan.setup} found but sized to 0 lots ({notes[-1]})"
        return self._open(plan, lots, notes, view, s, now)

    def _open(self, plan: TradePlan, lots: int, notes: list[str], view: MarketView, s: dict, now) -> str:
        u = plan.symbol
        t = Trade(id=new_trade_id("I"), strategy=plan.setup, family="intraday", symbol=u, direction=plan.direction,
                  kind=OPTIONS, legs=[], units=lots, opened_at=now, entry_underlying=view.spot,
                  initial_risk=plan.planned_risk_per_lot() * lots, stop=plan.invalidation, target=plan.target_underlying,
                  exit_rules={"premium_stop": plan.premium_stop, "premium_target": plan.premium_target,
                              "time_stop_min": plan.time_stop_min, "credit": plan.is_credit},
                  rationale=(f"[{plan.setup}] Trigger: {plan.trigger}. Thesis: {plan.thesis} "
                             f"Structure: {plan.describe()} (vol view {view.vol_view}). Market read: {view.narrative}"),
                  context={"regime": view.day_type, "bias": view.bias, "score": round(view.score, 3),
                           "conviction": round(view.conviction, 3), "vol_view": view.vol_view,
                           "evidence": [(e.factor, round(e.direction, 2), e.observation) for e in view.evidence],
                           "levels": {k: round(float(v), 2) for k, v in view.levels.items() if v == v and v is not None},
                           "chain": {k: v for k, v in view.chain.items() if isinstance(v, (int, float, str))}},
                  meta={"structure": plan.structure, "expiry": str(plan.expiry), "quote_source": plan.quote_source,
                        "entry_net_premium_per_lot": plan.net_premium, "max_loss": plan.max_loss_per_lot(),
                        "legs_plan": [(l.strike, l.right, l.ratio, round(l.price, 2), round(l.iv, 2), round(l.delta, 3))
                                      for l in plan.legs], **plan.notes})
        for leg in plan.legs:
            inst = Instrument.option(u, plan.expiry, leg.strike, leg.right, plan.lot_size)
            qty = leg.ratio * lots * plan.lot_size
            fill = self.broker.execute(Order(inst, qty, t.id, "open"), leg.price, now)
            if fill is None:
                for done in t.legs:
                    self.broker.execute(Order(done.instrument, -done.qty, t.id, "unwind"), done.entry_price, now)
                return f"order for {inst.symbol} rejected; nothing opened"
            self.journal.fill(now, t.id, inst.symbol, qty, fill.price, fill.fees, fill.fee_breakdown)
            t.legs.append(TradeLeg(inst, qty, fill.price))
            t.fees += fill.fees
        t.pnl = -t.fees
        t.last_mark = {l.instrument.symbol: l.entry_price for l in t.legs}
        self.open_trades.append(t)
        self.risk.trades_today += 1
        self.journal.open_trade(t, notes)
        msg = f"ENTER {plan.setup} {lots}×{plan.describe()} | stop {plan.invalidation or '—'} | {plan.trigger}"
        self.say(f"  {now:%H:%M} {u:<9} ▲ {msg}")
        return msg

    def _manage(self, u: str, view: MarketView, now) -> list[str]:
        out = []
        S = view.spot
        for t in [x for x in self.open_trades if x.symbol == u]:
            marks = {l.instrument.symbol: self.marker.mid(l.instrument, S, now) for l in t.legs}
            t.update_excursions(marks)
            t.bars_held = int((now - t.opened_at).total_seconds() // 60)
            gross = t.value(marks) - t.entry_cost
            prem = abs(t.entry_cost)
            r = t.exit_rules
            credit = r.get("credit", t.entry_cost < 0)
            reason = note = None
            if t.stop is not None and ((t.direction > 0 and S <= t.stop) or (t.direction < 0 and S >= t.stop)):
                reason, note = "invalidation", f"underlying {S:,.2f} through {t.stop:,.2f}"
            elif t.meta.get("range") and not (t.meta["range"][0] <= S <= t.meta["range"][1]):
                reason, note = "range_break", f"underlying {S:,.2f} left the value area {t.meta['range']}"
            elif gross <= -prem * r["premium_stop"]:
                reason, note = "premium_stop", f"P&L ₹{gross:,.0f} hit the {'credit ×' if credit else ''}{r['premium_stop']} stop"
            elif gross >= prem * r["premium_target"]:
                reason, note = "premium_target", f"P&L ₹{gross:,.0f} reached the {r['premium_target']:.0%} target"
            elif t.target is not None and ((t.direction > 0 and S >= t.target) or (t.direction < 0 and S <= t.target)):
                reason, note = "underlying_target", f"underlying reached {t.target:,.2f}"
            elif t.mfe > 0.5 * prem * r["premium_target"] and gross <= 0:
                reason, note = "breakeven_stop", "gave back a half-target open profit: out at breakeven"
            elif t.bars_held >= r["time_stop_min"] and gross < 0.1 * prem:
                reason, note = "time_exit", f"no progress in {t.bars_held} min"
            if reason:
                out.append(self._close(t, now, reason, note))
        return out

    def _close(self, t: Trade, now, reason: str, note: str) -> str:
        S = self.spot(t.symbol)
        for l in t.legs:
            px = self.marker.exit_price(l.instrument, l.qty, S, now)
            fill = self.broker.execute(Order(l.instrument, -l.qty, t.id, "close"), px, now)
            if fill is None:
                self.journal.event(now, "ERROR", "execution", f"exit {l.instrument.symbol} rejected for {t.id}")
                continue
            self.journal.fill(now, t.id, l.instrument.symbol, -l.qty, fill.price, fill.fees, fill.fee_breakdown)
            l.exit_price = fill.price
            t.fees += fill.fees
        t.pnl = sum(l.qty * ((l.exit_price or l.entry_price) - l.entry_price) for l in t.legs) - t.fees
        t.mae, t.mfe = min(t.mae, t.pnl), max(t.mfe, t.pnl)
        t.status, t.closed_at, t.exit_reason, t.exit_note, t.exit_underlying = "closed", now, reason, note, S
        t.bars_held = int((now - t.opened_at).total_seconds() // 60)
        self.open_trades.remove(t)
        self.closed.append(t)
        v = self.views.get(t.symbol)
        rv = self.journal.close_trade(t, v.day_type if v else None)
        self.risk.on_close(t.pnl, now)
        msg = f"EXIT {t.strategy} {reason}: ₹{t.pnl:,.0f} ({t.r_multiple:+.2f}R, grade {rv['grade']}) — {note}"
        self.say(f"  {now:%H:%M} {t.symbol:<9} ▼ {msg}")
        return msg

    # ---- remote control (the app writes commands; the engine executes them) ----------------------------------
    def _commands(self, now) -> None:
        cmds = self.journal.get_state("intraday_cmds") or []
        done = set(self.journal.get_state("intraday_cmds_done") or [])
        todo = [c for c in cmds if c.get("id") not in done]
        for c in todo:
            cmd, arg = c.get("cmd"), c.get("arg")
            if cmd == "pause":
                self.paused = True
            elif cmd == "resume":
                self.paused = False
            elif cmd in ("flatten", "close"):
                for t in list(self.open_trades):
                    if cmd == "flatten" or t.id == arg:
                        self._close(t, now, "manual", f"{'flattened' if cmd == 'flatten' else 'closed'} from the app")
                if cmd == "flatten":
                    self.paused = True
            done.add(c.get("id"))
            self.journal.event(now, "WARN", "remote", f"{cmd}{' ' + str(arg) if arg else ''} from the app")
            self.say(f"  {now:%H:%M} remote command: {cmd} {arg or ''}")
        if todo:
            self.journal.set_state("intraday_cmds_done", sorted(done))
            self.journal.set_state("intraday_paused", self.paused)

    def _heartbeat(self, now) -> None:
        """Everything the app's Live screen needs, in one small state row updated every minute."""
        eq = self.equity(now)
        views = {}
        for u, v in self.views.items():
            views[u] = {"spot": v.spot, "bias": v.bias, "score": v.score, "conviction": v.conviction, "day_type": v.day_type,
                        "vol_view": v.vol_view, "iv": v.iv, "rv": v.rv, "narrative": v.narrative, "vetoes": v.vetoes,
                        "levels": {k: float(x) for k, x in v.levels.items() if x is not None and x == x},
                        "chg": v.state.get("chg"), "vwap": v.state.get("vwap"), "phase": v.state.get("phase"),
                        "expiry": str(self.expiry.get(u)),
                        "evidence": [{"factor": e.factor, "category": e.category, "direction": e.direction,
                                      "weight": e.weight, "observation": e.observation} for e in v.evidence]}
        positions = []
        for t in self.open_trades:
            S = self.spot(t.symbol)
            marks = {l.instrument.symbol: self.marker.mid(l.instrument, S, now) for l in t.legs}
            positions.append({"id": t.id, "setup": t.strategy, "symbol": t.symbol, "structure": t.meta.get("structure"),
                              "lots": t.units, "opened": str(t.opened_at), "pnl": t.value(marks) - t.entry_cost - t.fees,
                              "stop": t.stop, "target": t.target, "entry_underlying": t.entry_underlying, "spot": S,
                              "legs": [{"symbol": l.instrument.symbol, "qty": l.qty, "entry": l.entry_price,
                                        "mark": marks[l.instrument.symbol]} for l in t.legs],
                              "rationale": t.rationale[:600]})
        self.journal.set_state("intraday_live", {
            "ts": str(now), "day": str(self.day), "equity": eq, "day_start_equity": self.day_start_equity,
            "day_pnl": eq - self.day_start_equity, "paused": self.paused, "halted": self.risk.halted,
            "trades_today": self.risk.trades_today, "feed": self.feed.name, "chain": self.chains.name,
            "views": views, "positions": positions})

    # ---- journaling ------------------------------------------------------------------------------------------
    def _think(self, u: str, view: MarketView, now, action: str, force: bool = False) -> None:
        last = self.last_thought.get(u)
        changed = self.last_bias.get(u) != view.bias
        trade_event = action.startswith(("ENTER", "EXIT")) or force
        if last is None or trade_event or changed or now - last >= pd.Timedelta(minutes=self.think_every):
            self.journal.thought(view, action)
            self.last_thought[u], self.last_bias[u] = now, view.bias
            if not trade_event:
                self.say(f"  {now:%H:%M} {u:<9} · {view.bias:<8} {view.score:+.2f} c{view.conviction:.2f} "
                         f"{view.day_type:<12} IV/RV {view.vol_view:<7} | {action}")

    def _snapshot(self, now) -> None:
        if now.minute % 5:
            return
        eq = self.equity(now)
        self.journal.snapshot(now, equity=eq, cash=self.broker.cash(), drawdown=min(0.0, eq / self.day_start_equity - 1),
                              open_trades=len(self.open_trades), gross=0.0, net_delta=0.0, vega=0.0,
                              open_risk=sum(t.initial_risk for t in self.open_trades),
                              regime=",".join(f"{u}:{v.day_type}" for u, v in self.views.items()))

    def _persist(self) -> None:
        self.journal.set_state("intraday_open", {"day": str(self.day), "trades": [trade_to_dict(t) for t in self.open_trades]})

    def _restore(self, day: dt.date) -> None:
        st = self.journal.get_state("intraday_open") or {}
        if st.get("day") == str(day) and st.get("trades"):
            self.open_trades = [trade_from_dict(d) for d in st["trades"]]
            self.say(f"  restored {len(self.open_trades)} open position(s) after a restart")

    # ---- review ------------------------------------------------------------------------------------------------
    def session_review(self) -> str:
        day = self.day
        trades = [t for t in self.closed if t.opened_at.date() == day]
        th = self.journal.thoughts(str(day))
        end_eq = self.broker.cash()
        L = [f"# Intraday session review — {day}", "",
             f"Capital ₹{self.day_start_equity:,.0f} → ₹{end_eq:,.0f} (**{end_eq / self.day_start_equity - 1:+.2%}**, "
             f"₹{end_eq - self.day_start_equity:+,.0f}); {len(trades)} trade(s); chain source {self.chains.name}; "
             f"feed {self.feed.name}.", ""]
        for u in self.underlyings:
            tu = th[th["symbol"] == u] if not th.empty else th
            if tu.empty:
                continue
            first, lastr = tu.iloc[0], tu.iloc[-1]
            L += [f"## {u}", f"- Opened read ({str(first.ts)[11:16]}): {first.narrative}",
                  f"- Closing read ({str(lastr.ts)[11:16]}): {lastr.narrative}"]
            flips = tu[tu["bias"] != tu["bias"].shift()]
            if len(flips) > 1:
                L.append("- Bias path: " + " → ".join(f"{str(r.ts)[11:16]} {r.bias}" for r in flips.itertuples()))
            types = tu["day_type"].value_counts()
            L.append(f"- Day type (share of reads): " + ", ".join(f"{k} {v / len(tu):.0%}" for k, v in types.items()))
            L.append("")
        if trades:
            L += ["## Trades", "", "| Time | Setup | Structure | Lots | P&L ₹ | R | Exit | Grade |", "|---|---|---|---:|---:|---:|---|---|"]
            for t in trades:
                L.append(f"| {t.opened_at:%H:%M}–{t.closed_at:%H:%M} | {t.strategy} {t.symbol} | {t.meta.get('structure')} | "
                         f"{t.units} | {t.pnl:,.0f} | {t.r_multiple:+.2f} | {t.exit_reason} | "
                         f"{self._grade(t.id)} |")
            L.append("")
            for t in trades:
                L += [f"**{t.id} · {t.strategy} {t.symbol}** — {t.rationale}", f"Exit: {t.exit_reason} — {t.exit_note}.", ""]
            wins = sum(t.pnl > 0 for t in trades)
            L.append(f"Win rate {wins}/{len(trades)}, net ₹{sum(t.pnl for t in trades):,.0f}, costs ₹{sum(t.fees for t in trades):,.0f}.")
        else:
            reasons = th["action"].str.extract(r"^(standing aside|watching)[^:]*: (.*)$")[1].dropna().value_counts().head(4) \
                if not th.empty else pd.Series(dtype=int)
            L.append("No trades. Most common reasons: " + "; ".join(f"{k} (x{v})" for k, v in reasons.items()))
        return "\n".join(L)

    def _grade(self, tid: str) -> str:
        r = self.journal.df("SELECT grade FROM trades WHERE id=?", (tid,))
        return r["grade"].iloc[0] if not r.empty else "?"


# ---- drivers ------------------------------------------------------------------------------------------
def run_replay(engine: IntradayEngine) -> str:
    feed = engine.feed
    assert isinstance(feed, ReplayFeed)
    engine.start_session(feed.day)
    while feed.advance():
        engine.step()
    return engine.end_session()


def run_live(engine: IntradayEngine, stop_at: dt.time | None = None) -> str:
    """Wall-clock loop: waits for the open, steps a few seconds after each minute closes."""
    now = engine.feed.now()
    if not engine.cal.is_trading_day(now.date()):
        return f"{now.date()} is not an NSE trading day"
    open_ts, close_ts = session_bounds(now.date())
    if now < open_ts:
        engine.say(f"waiting for the open ({open_ts:%H:%M})…")
        time.sleep((open_ts - now).total_seconds() + 5)
    engine.start_session(now.date())
    end = pd.Timestamp(dt.datetime.combine(now.date(), stop_at), tz=IST) if stop_at else close_ts
    while engine.feed.now() < end + pd.Timedelta(seconds=30):
        try:
            engine.step()
        except Exception as exc:                        # keep the loop alive; journal the failure
            log.exception("step failed")
            engine.journal.event(engine.feed.now(), "ERROR", "engine", repr(exc))
        n = engine.feed.now()
        time.sleep(max(1.0, 60 - n.second + 4))
    return engine.end_session()

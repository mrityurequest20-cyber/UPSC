# QuantDesk: a quantitative trading desk for Indian markets

QuantDesk is an automated trading system for **NSE equities and index options (NIFTY, BANKNIFTY)**. One engine runs every part of the desk, in order:

1. Reads charts and statistics.
2. Detects the market regime.
3. Runs eight quantitative strategies.
4. Sizes every trade through a risk manager.
5. Executes on a paper (or, when explicitly enabled, live Zerodha Kite) account.
6. Runs pre-market, intraday and post-market checks.
7. Keeps a journal that reviews and grades every trade.

The same code path runs backtests, paper trading and live trading. What you backtest is what trades.

> Not investment advice. Paper trading is the default. Live trading needs three separate opt-ins (see [Live trading](#live-trading)). Run it on paper for a few months before a single live lot.

```
data ─► analytics ─► regime ─► strategies ─► allocator ─► risk manager ─► broker ─► journal ─► review
 (Yahoo/CSV/       (indicators,  (HMM +      (8 books:     (regime ×      (sizing,       (paper /    (SQLite:     (grades,
  synthetic)        vol, GARCH,   trend/vol   trend, MR,    recent         limits, DD      Kite)       plans,       lessons,
                    stats, chart) rules)      momentum,     performance)   de-risk, kill   + Indian    fills,       daily/weekly
                                              pairs, 3×                    switch)         costs       checks)      reviews)
                                              options)
       └──────────── routine checks: pre-market ▸ intraday ▸ post-market ────────────┘
```

## Quick start

```bash
cd trading
pip install -r requirements.txt

python -m quantdesk --source synthetic demo       # the daily desk, offline, ~90 s
python -m quantdesk intraday replay --synthetic 5 # the intraday options desk, offline, ~1 min
python -m quantdesk serve --host 0.0.0.0          # the website, on your phone (prints a private link)
python -m pytest                                  # 120 tests
```

The demo writes everything to `runtime/demo/`:

| File | What it is |
|---|---|
| `backtest_report.html` | Tearsheet with equity vs NIFTY, drawdown, monthly heatmap, P&L by strategy, risk statistics, a Monte Carlo drawdown distribution, and journal excerpts |
| `backtest_journal.db` | Every decision, fill, trade review and snapshot of the backtest |
| `market_analysis.txt` | The morning read for NIFTY, BANKNIFTY and RELIANCE, plus a universe scan |
| `paper_daily_log.md` | 12 simulated sessions of paper trading, each with pre-market checks, EOD cycle, post-market checks and the daily review |
| `paper_review.md`, `desk_report.html` | The multi-day journal review, plus checks and analysis as a page |

On real data, remove `--source synthetic`. Yahoo Finance is the default source (`RELIANCE.NS`, `^NSEI`, `^NSEBANK`, `^INDIAVIX`). You can also put CSVs in `data/csv/` and pass `--source csv`.

```bash
python -m quantdesk analyze NIFTY RELIANCE        # chart structure, stats, vol, regime, options read
python -m quantdesk options BANKNIFTY             # expected moves, model chain, costed structures
python -m quantdesk scan                          # universe dashboard
python -m quantdesk backtest --report bt.html --mc
python -m quantdesk backtest --strategies pairs,vrp_condor --start 2020-01-01
python -m quantdesk walkforward --strategy trend_rider --grid "fast=10,20;slow=50,100"
```

## The daily routine (paper or live)

```bash
python -m quantdesk schedule    # prints the cron lines below (IST)
```

| When (IST) | Command | What happens |
|---|---|---|
| 08:40 | `paper premarket` | Checks trading day, data freshness/quality, broker, kill switch, risk state, reconciliation, stops in place, expiry watch, event risk (RBI/FOMC), VIX level, and queued orders. A FAIL on a hard check blocks new entries for the day. |
| 09:20 (live only) | `--live paper open` | Executes queued orders against live Kite quotes |
| every 30 min | `paper intraday` | Stop breaches and proximity, intraday P&L vs the daily loss limit |
| 16:45 | `paper run` | EOD cycle. Fills yesterday's queue at today's open, then checks stops, marks to market, settles expiries, runs the risk state machine, lets strategies manage their trades and generate new ideas, sizes and queues them, and snapshots. It is idempotent and catches up on missed days. |
| 16:50 / Fri 18:00 | `paper review [--days 7]` | Daily and weekly journal review: P&L, per-strategy stats, grades, recurring lessons, risk events, failing checks |

Other commands:
- `paper status` shows the account.
- `journal trades|events|decisions|show --id …|export` reads the journal.
- `risk reset` re-arms the kill switch after a post-mortem.
- `touch runtime/KILL` stops all order flow instantly.

## Daily desk UI with GoCharting charts

`python -m quantdesk serve` (standard library only, `127.0.0.1` by default) serves the phone-friendly intraday app at `/` (see [The website](#the-website-use-it-from-your-phone)) and the daily desk at **`/daily`**, which has:
- a watchlist with regimes
- the chart
- the analysis for the selected symbol
- a paper order ticket
- open positions with Close buttons
- queued orders with Cancel
- the latest journal reviews
- routine checks

**Charting uses the [GoCharting SDK](https://gocharting.com/sdk/docs)**, integrated the way GoCharting's reference implementation ([gocharting-sdk-demo](https://github.com/GoChartingInc/gocharting-sdk-demo)) does it:

- **Datafeed** (`quantdesk/web/static/datafeed.js`)
  - `getBars` returns UDF arrays (`{s,t,o,h,l,c,v}`, unix seconds).
  - `resolveSymbol` supplies `segment` and `exchange_info`. Symbols are keyed `NSE:INDEX:NIFTY` and `NSE:EQUITY:RELIANCE`, with timezone `Asia/Kolkata`.
  - `searchSymbols` and polled `subscribeTicks` are also implemented.
- **Broker bridge:** QuantDesk's open positions (with stop/target), queued orders and fills go to `chartInstance.setBrokerAccounts(...)` every 20 s and after every action.
- **Trade from chart:** the SDK's `appCallback` events all route to the paper broker through the same kill switch and risk gate:
  - `PLACE_ORDER` places an order.
  - `CLOSE_POSITION` and the exit X close a position.
  - `MODIFY_POSITION` drags the stop or target.
  - `CANCEL_ORDER` cancels a queued order.

  Each action is journaled as a `manual` trade and gets a review like any other. Chart orders are paper-only by design.
- **Fallback:** if the SDK can't load (no network, no license, blocked domain), a built-in candlestick chart takes over. It shows SMA50/200, journal entry/exit markers, and open-trade stop, target and entry levels, with a crosshair tooltip. The desk always works.

**License:** `@gocharting/chart-sdk` is a private package, and production use needs a commercial license from GoCharting. QuantDesk loads the SDK's hosted build from `https://gocharting.com/sdk/library/<license-key>/index.umd.js`. It ships with the public demo key from GoCharting's own CodePen. Put your key in `web.gocharting.license_key` or `GOCHARTING_LICENSE_KEY`.

## Intraday options desk (real time)

`python -m quantdesk intraday live` runs from 09:15 to 15:30 IST in paper mode. Every closed minute it:

1. **reads the market:** new 1-minute bars (Yahoo free, or Kite ticks) and a fresh option chain every 3 minutes (NSE's free chain, Kite quotes, or a model). Everything is recorded to `runtime/intraday/data/`, so the desk builds its own intraday history.
2. **thinks:** the analyst gathers weighted **evidence** in six groups:
   - **trend:** VWAP side and slope, 5m EMA9/21, Supertrend, 15m slope
   - **structure:** opening range, initial balance, value area and POC, prior-day high/low, CPR
   - **momentum:** 5m RSI
   - **flow:** CVD slope and price/CVD divergence (tick delta when a tick feed is attached)
   - **options:** PCR, OI walls, max pain on expiry day
   - **volatility:** India VIX change, ATM IV vs realised vol

   From that it forms a **bias, a conviction and a day type** (trend / balance / volatile). It gives a **premium view** (IV rich, fair or cheap), lists explicit **no-trade flags**, and writes a narrative. The read is journaled every 5 minutes, on every bias flip, and on every trade.
3. **picks a setup** from the playbook:
   - **opening-range breakout**
   - **trend pullback** to VWAP or EMA21
   - **flag breakout** (continuation after a 30-minute consolidation)
   - **value-area rejection** (fades only when the tape is balanced)
   - **range premium-selling iron fly** (balance day with rich IV)

   The structure follows the vol view: buy the option when premium is fair or cheap, a debit spread when it's rich, a defined-risk fly for range days. Strikes come from the real chain by delta. Each plan fixes its **invalidation level, targets, premium stop and time stop before entry**.
4. **sizes and executes (simulated):**
   - **Sizing:** 1% of capital at risk to the plan's stop, scaled by conviction.
   - **Caps:** lots, premium outlay and margin.
   - **Daily limits:** 6 trades a day, 2 open, −2.5% daily stop, cooldown after 2 losses.
   - **Entry window:** new trades only between 09:20 and 14:45.
   - **Fills:** buys at the ask, sells at the bid, plus a tick, plus the full cost stack (STT 0.15% on premium sold).
5. **manages:** open options are marked with the IV implied by their last real quote, repriced with the live spot and minute-level time to expiry, so delta, gamma and theta all show up in P&L. Exits happen on invalidation, premium stop/target, underlying target, breakeven trail or time stop. Everything is squared off by 15:15.
6. **reviews:** every trade gets a grade and lessons. The session review (how the read evolved, the bias path, each trade's why and how it ended) goes to `runtime/intraday/reviews/<date>.md`.

```bash
python -m quantdesk intraday live                       # Yahoo 1m bars + NSE option chain (free; best effort)
python -m quantdesk intraday live --feed kite --chain kite   # real-time ticks + real quotes (Kite Connect)
python -m quantdesk intraday replay --last 5            # re-run recorded real sessions through the same engine
python -m quantdesk intraday replay --synthetic 20      # offline practice on synthetic sessions
python -m quantdesk intraday thoughts -v                # what it thought, with the evidence
python -m quantdesk intraday trades --id <id>           # full rationale, sizing, review for one trade
python -m quantdesk intraday stats                      # by setup, structure, day type, exit, hour
python -m quantdesk intraday review                     # the written session review
```

**Data reality check.**
- Yahoo's 1-minute bars cover only ~7 days, may lag, and carry little or no volume for indices; the desk falls back to TWAP and flags it. So record every session.
- NSE's option-chain API is free but throttled and changes without notice (the v3 endpoint is used).
- Kite Connect (`KITE_API_KEY`/`KITE_ACCESS_TOKEN`) gives real-time ticks, depth and real option quotes.

**Order flow and the GoCharting plan.** `quantdesk/intraday/orderflow.py` already computes:
- volume profile (POC, value area, high/low-volume nodes)
- footprint bars from ticks (buy/sell volume per price, delta, diagonal imbalances, stacked imbalances)
- CVD and divergences

With Kite, full-mode snapshots are classified with the quote rule and fed into it. A true tick-by-tick trade feed (e.g. what GoCharting's order-flow subscription is built on) plugs in through the same `Trade` records. When that data is attached, the analyst's `flow` evidence switches from the bar approximation to real delta.

**On synthetic sessions** (built-in simulator: trend, range, reversal and volatile days) the desk made **+4.0% over 8 traded sessions** (10-session run, 40 trades, win rate 42%, profit factor 1.69, max drawdown −2.3%). Flag breakouts and ORB earned; VWAP pullbacks and value-area fades lost. That proves the machinery, not an edge. Judge it only on recorded real sessions (`intraday replay --last N`) and weeks of live paper trading.

## The website (use it from your phone)

`python -m quantdesk serve` serves a mobile-first web app, plus the daily desk at `/daily`:

| Tab | What's there |
|---|---|
| **Live** | equity, today's P&L, engine status (running / paused / not running), **Pause / Resume / Flatten**, the analyst's current read per underlying (bias, conviction, day type, IV vs RV, narrative, evidence bars), the intraday chart (1m/5m/15m candles, VWAP, OR/IB/value/prior-day/OI-wall levels, entry/exit markers, touch crosshair; **Pro chart** switches to GoCharting), open positions with legs, marks, "Why?" and Close |
| **Thinking** | the running feed of market reads; tap one to see its evidence |
| **Trades** | every trade with grade, P&L and R; tap for the rationale, market read, sizing, exit, review, lessons and fills |
| **Stats** | net P&L, win rate, profit factor, drawdown, equity by session, P&L by setup, tables by day type, structure, exit, hour and underlying |
| **Reviews** | the written session reviews |

**On your phone:**

```bash
python -m quantdesk serve --host 0.0.0.0     # prints http://<your-LAN-IP>:8765/?token=…
```

Open that link once on the phone, on the same Wi-Fi. The token is remembered in an HttpOnly cookie. Then use **Add to Home Screen** (it installs like an app, with its own icon, standalone and dark-mode aware).

**Away from home:** install [Tailscale](https://tailscale.com) on the computer and the phone, then open `http://<computer's tailscale name>:8765/?token=…`. Don't port-forward it to the open internet.

**Share a read-only snapshot:** `python -m quantdesk intraday export-site --account live --out site.html` writes the whole app plus an account's data as one HTML file. Host it anywhere static; the controls are off in a snapshot.

**How the pieces fit:** the engine (`intraday live`) and the website are separate processes sharing the journal. Commands from the phone are queued, and the engine applies them on its next minute. Everything is paper-only; the website can pause, close or flatten, but never places real orders.

## The quantitative stack

**Analytics** (`quantdesk/analytics/`):
- **Indicators:** EMA/SMA/Wilder, RSI, MACD, Bollinger, ATR, ADX/DI, Supertrend, Donchian, Keltner, stochastic, OBV, VWAP, Kaufman efficiency ratio, chandelier stops.
- **Realised volatility:** close-to-close, Parkinson, Garman-Klass, Rogers-Satchell, Yang-Zhang and EWMA, plus a vol cone.
- **GARCH(1,1)** by quasi-MLE, with the recursion run as an IIR filter. The rolling forecast is causal: it refits quarterly and filters forward.
- **Tests:** ADF with AIC lag choice and MacKinnon p-values, Engle-Granger cointegration, OU half-life, Hurst exponent (rolling and vectorised), Lo-MacKinlay variance ratio, and a Kalman-filter dynamic hedge ratio.
- **Regimes:** a 2-state Gaussian HMM (Baum-Welch, scaled forward-backward) fitted causally and forward-filtered, combined with trend and volatility rules into `trending_up | trending_down | range | stressed`.
- **Chart reading:** confirmed swing pivots, clustered support and resistance, HH/HL structure, floor pivots, candlestick patterns, gaps and 52-week context, all turned into a narrative.

**Options** (`quantdesk/options/`):
- BSM and Black-76 pricing, Greeks (checked against finite differences), and IV by Newton with a Brent fallback.
- Delta-to-strike solving that respects the smile.
- A parametric put-skew model plus SVI fitting for real chains.
- The NSE expiry calendar: NIFTY weekly on Tuesday; monthly on the last Tuesday; moved back a day when that day is a holiday.
- Multi-leg structures: condor, fly, verticals, straddle and strangle. Each reports max profit and loss, breakevens, net Greeks, probability of profit, and **expected P&L under your own vol forecast**, which is the number that says whether premium is rich or cheap.

**Strategies** (`quantdesk/strategies/`):

| Strategy | Market | Edge hypothesis | Entry → exit |
|---|---|---|---|
| `trend_rider` | stocks | Trends persist | Fresh EMA20/50 cross above SMA200 with ADX ≥ 20 → chandelier trail or opposite cross |
| `breakout` | stocks | Compression precedes expansion | 55-day high out of a Bollinger squeeze on volume → 20-day low |
| `mean_reversion` | stocks | Short-term overreaction in an uptrend reverts | z < −2 or RSI(3) < 15, above SMA200, rolling Hurst < 0.55 → z > 0 or 8 bars |
| `momentum` | stocks | 12-1 month cross-sectional momentum | Top 3 by risk-adjusted 12-1 month return, monthly rebalance with a rank buffer |
| `pairs` | stock futures | Cointegrated spreads mean-revert | Engle-Granger p < 0.05, half-life < 40 days, \|z\| > 2 → \|z\| < 0.4, z-stop 3.8, re-tested monthly |
| `vrp_condor` | index options | Variance risk premium (IV > forecast RV) | IV rank > 40%, IV − GARCH > 1.5 pts, not stressed, no event, positive model EV → 16Δ/6Δ condor, 50% TP, 1.5× SL, exit at 1 DTE |
| `trend_spread` | index options | Trends plus cheap IV | Confirmed index trend with IV rank < 55% → 55Δ/25Δ debit vertical |
| `long_vol` | index options | Vol too cheap vs forecast, or coiled | GARCH − IV > 2 pts or squeeze, IV rank < 25% → ATM straddle |

The **allocator** scales each idea's risk by a (strategy family × regime) weight and a shrunk tilt from the strategy's own recent R-multiples. Strategies never size positions or send orders.

**Risk** (`quantdesk/risk/`):
- Per-trade risk: 0.75% of equity to the stop; 2.5% worst-case loss for defined-risk option structures.
- Portfolio caps: total and per-strategy open risk, gross delta-notional, per-symbol exposure, net vega, net delta, margin, and orders per day.
- Linear de-risking from a 6% drawdown, reaching a **15% drawdown kill switch** that flattens and halts.
- A daily loss limit that blocks new entries.

**Costs** (`quantdesk/execution/costs.py`):
- Brokerage, STT, exchange charges, SEBI fee, stamp duty and GST, per segment.
- STT on F&O as revised in the Union Budget 2026-27: **0.15% on option premium (sell side) and 0.05% on futures**, effective 1-Apr-2026.
- Volatility-aware slippage for stocks and futures; half-spread for options.
- Current NSE lot sizes: **NIFTY 65, BANKNIFTY 30** (circular NSE/FAOP/70616).

**Backtesting** (`quantdesk/backtest/`):
- Event-driven and daily.
- **Decisions at the close of bar t fill at the open of t+1.**
- Stops fill intrabar at the worse of the open and the stop (the stop is assumed hit first if both the stop and the target are touched).
- Entries that gap through their stop are cancelled.
- Options are marked with VIX-based IV plus skew and settled at intrinsic on expiry.
- Deterministic.
- Walk-forward optimisation, trade-order and block bootstrap Monte Carlo, and the Probabilistic and **Deflated Sharpe Ratio**, so a backtest Sharpe gets discounted for sample length, fat tails and the number of variants tried.

**Journal** (`quantdesk/journal/`): SQLite with one row per trade, holding:
- the plan in words
- the context snapshot
- the sizing arithmetic
- fills with a cost breakdown
- MAE and MFE
- an automatic review

Grades weight **process 60% and outcome 40%**, so a planned −1R stop-out beats a lucky +2R that ignored the plan. Lessons are generated automatically, for example: round-tripped a 1R open profit, stopped out inside noise, costs ate 30% of gross, regime changed mid-trade. Every rejected idea is kept too, with the limit that bound it.

## How we know there's no look-ahead

`tests/test_causality.py` recomputes every indicator, every strategy's feature table, the GARCH forecast, the HMM and the regime frame on truncated history. It then asserts they equal the full-history values at the cut. Other tests check that:
- the engine fills at the next open
- stops gap correctly
- books reconcile to the rupee (Σ trade P&L = equity change; broker fees = trade fees)
- two runs are identical
- the paper runner never processes a day twice
- the kill switch blocks new orders but never closes
- the GoCharting datafeed adapter works against a live server, run under Node

## Results on the synthetic market (read the caveat)

There's no market data in the build environment, so the demo runs on a built-in simulator. The simulator is calibrated to NIFTY 2015-26: 11.3% CAGR, 15% vol, −39% max drawdown. It includes regime switching, GJR-GARCH clustering, crash jumps, a VIX with a variance risk premium, momentum, and cointegrated pairs.

On it, the combined book (2018 → Sep-2026, ₹20 L) returned **~5% CAGR at ~7% vol with a −15% max drawdown**. Buy-and-hold made 11.2% with a −39% drawdown. Sharpe against the 6.5% risk-free rate was about −0.2, after ₹1.9 L of costs. **That is not a good result, and it's reported as is.** Pairs, breakout and momentum made money. Trend-rider and mean-reversion lost it; the latter mostly to delivery STT. Synthetic data proves the machinery works; it says nothing about edge. Run `backtest` and `walkforward` on real NSE data, and trust only out-of-sample, cost-inclusive, DSR-adjusted numbers.

## Live trading

Live trading needs all of the following:
- `account.mode: live` in config
- the `--live` flag
- `KITE_API_KEY` / `KITE_ACCESS_TOKEN` in the environment
- `pip install kiteconnect`
- no `runtime/KILL` file

Every order is a marketable LIMIT inside a ±1% band, never a bare MARKET order, and there's a per-order notional cap. The Kite adapter follows the kiteconnect API but has **not been exercised against a real account**. Paper-trade first, then go live with one lot.

## Configuration

Everything is in `config/quantdesk.yaml`: account, universe, contract specs, costs, slippage, risk limits, strategy parameters, allocator weights, regime settings, calendar (2026 NSE holidays, events), check thresholds, desk UI and live guard rails. Overlay your own values with `--config my.yaml`.

**Re-verify lot sizes, STT, expiry weekday and holidays whenever NSE or SEBI issue a circular.** The holiday list is marked with which dates were cross-checked.

## Known limitations

- **Options history:** there's no free historical NSE option-chain data, so option P&L in backtests is model-priced (VIX × IV beta + skew). Real chains have wider, stickier spreads around events. Plug a chain source into `OptionPricer` and `SVI.fit` when you have one.
- **Futures:** futures are priced off spot, and basis and roll cost are ignored. Pair legs ignore lot rounding.
- **Intraday data:** the free path (Yahoo + NSE) is best effort. For real-time decisions use Kite. The intraday desk models only index options on NIFTY and BANKNIFTY.
- **Kite:** the Kite path and GoCharting's full SDK are untested from this environment. Both are behind guards and have fallbacks.

## Layout

```
trading/
  config/quantdesk.yaml       all parameters
  quantdesk/
    analytics/                indicators, volatility, stats, regime (HMM), chart reading
    options/                  pricing, surface (skew/SVI), chain, structures
    strategies/               8 strategies + base contract
    risk/                     manager (sizing/limits/kill switch), allocator, metrics (PSR/DSR)
    execution/                costs, paper broker, Kite adapter
    engine/                   engine (backtest = paper = live), live runner (daily routine, chart orders)
    backtest/                 runner, walk-forward, Monte Carlo
    journal/                  SQLite journal, trade and period reviews
    ops/                      routine checks
    reporting/                HTML tearsheet, market analysis
    intraday/                 real-time desk: feeds, chains (NSE/Kite/model), order flow, features, analyst,
                              playbook, risk, sim broker, engine, recorder, synthetic sessions, CLI
    web/                      server (token auth), intraday API, mobile app (PWA), daily desk, GoCharting datafeed
    data/                     Yahoo, CSV, synthetic market, validation
  tests/                      120 tests
```

## Sources for the market rules

- NSE lot-size revision (NIFTY 75→65, BANKNIFTY 35→30), circular NSE/FAOP/70616: [HDFC Sky](https://hdfcsky.com/news/nse-revises-market-lot-sizes-for-major-index-derivatives-effective-january-2026), [NSE circular](https://nsearchives.nseindia.com/content/circulars/FAOP70616.pdf)
- STT on F&O raised in Budget 2026-27: [ICICI Direct](https://www.icicidirect.com/futures-and-options/articles/stt-changes-in-budget-2026-what-f-o-traders-need-to-know), [ClearTax](https://cleartax.in/s/securities-transaction-tax-stt)
- NIFTY weekly expiry on Tuesday: [Share.Market](https://www.share.market/buzz/insights/weekly-expiry-days-in-indian-fo-markets/)
- NSE 2026 trading holidays (circular CMTR71775): [NSE](https://www.nseindia.com/resources/exchange-communication-holidays)
- GoCharting SDK: [docs](https://gocharting.com/sdk/docs), [reference demo](https://github.com/GoChartingInc/gocharting-sdk-demo)

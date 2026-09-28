"""Export the web app as ONE self-contained HTML file (a read-only snapshot).

The page is the same app the desk serves, with the account's data embedded and a small
shim answering its /api/i/* calls from that data. Controls are disabled (there is no
engine behind a snapshot). Use it to share or host a session read-only:

    python -m quantdesk intraday export-site --account synthetic --out site.html
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .intraday_api import IntradayAPI

STATIC = Path(__file__).resolve().parent / "static" / "app"

SHIM = r"""
window.QD_DEMO = true;
(function () {
  const D = JSON.parse(document.getElementById("qd-data").textContent);
  const reply = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
  window.fetch = async function (url) {
    const u = new URL(String(url), "https://snapshot.local/");
    const q = Object.fromEntries(u.searchParams.entries());
    switch (u.pathname) {
      case "/api/i/accounts": return reply([{ id: "snapshot", label: D.short || "Snapshot" }]);
      case "/api/i/state": return reply(D.state);
      case "/api/i/thoughts": {
        let rows = D.thoughts.filter((t) => (!q.symbol || t.symbol === q.symbol) && (!q.before || t.id < Number(q.before)));
        return reply(rows.slice(0, Number(q.n || 40)));
      }
      case "/api/i/trades": return reply(D.trades.slice(0, Number(q.n || 100)));
      case "/api/i/trade": return D.trade[q.id] ? reply(D.trade[q.id]) : reply({ error: "no such trade" }, 404);
      case "/api/i/reviews": return reply(Object.keys(D.reviews).sort().reverse());
      case "/api/i/review": return D.reviews[q.date] ? reply({ date: q.date, markdown: D.reviews[q.date] }) : reply({ error: "no such review" }, 404);
      case "/api/i/stats": return reply(D.stats);
      case "/api/i/chart": return reply(D.chart[(q.symbol || "NIFTY") + "|" + (q.interval || "1m")] || { bars: null });
      case "/api/config": return reply({ gocharting: { enabled: false } });
      default: return reply({ error: "not available in a snapshot" }, 404);
    }
  };
})();
"""


def _body_and_style(html: str) -> tuple[str, str]:
    style = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    body = re.sub(r"<script[^>]*></script>\s*", "", body)
    return style, body


def export_site(cfg, account: str, out: Path, sessions: int = 3, label: str | None = None, note: str | None = None) -> Path:
    api = IntradayAPI(cfg)
    j = api.j(account)
    state = api.state(account)
    days = sorted({str(t)[:10] for t in j.df("SELECT DISTINCT substr(ts,1,10) AS d FROM thoughts")["d"]})[-sessions:]
    th = j.df("SELECT * FROM thoughts WHERE substr(ts,1,10) >= ? ORDER BY id DESC", (days[0] if days else "0",))
    thoughts = []
    for r in th.to_dict("records"):
        for k in ("evidence", "vetoes", "levels", "chain"):
            r[k] = json.loads(r[k]) if r.get(k) else None
        thoughts.append(r)
    trades = api.trades(account, 1000)
    data = {
        "label": label or f"{account.capitalize()} snapshot",
        "short": "Demo" if account == "synthetic" else "Snapshot",
        "state": {**state, "age_sec": 0},
        "thoughts": thoughts,
        "trades": trades,
        "trade": {t["id"]: api.trade(account, t["id"]) for t in trades},
        "reviews": {d: api.review(account, d)["markdown"] for d in api.reviews(account)},
        "stats": api.stats(account),
        "chart": {f"{s}|{iv}": api.chart(account, s, None, iv)
                  for s in cfg.get("intraday.underlyings", ["NIFTY", "BANKNIFTY"]) for iv in ("1m", "5m", "15m")},
    }
    from .server import _clean
    payload = json.dumps(_clean(data), separators=(",", ":")).replace("</", "<\\/")
    style, body = _body_and_style((STATIC / "index.html").read_text(encoding="utf-8"))
    # the host pads the page for phone safe areas; the sticky header must not add them twice
    style = style.replace("header{position:sticky;top:0;", "header{position:sticky;top:env(safe-area-inset-top,0px);")
    style = style.replace("padding:calc(10px + env(safe-area-inset-top)) 16px 10px;", "padding:10px 16px;")
    style += ("\n.note-demo{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:10px 12px;"
              "margin-bottom:12px;font-size:13px;color:var(--ink2)}.note-demo b{color:var(--ink)}")
    note = note or ("Read-only snapshot of the intraday desk. Controls are off here; they work on your own desk while it runs.")
    body = body.replace('<section data-view="live">',
                        f'<section data-view="live">\n    <div class="note-demo" role="note"><b>{data["label"]}.</b> {note}</div>', 1)
    app_js = (STATIC / "app.js").read_text(encoding="utf-8")
    html = (f"<title>QuantDesk</title>\n<style>{style}</style>\n{body}\n"
            f'<script type="application/json" id="qd-data">{payload}</script>\n'
            f"<script>{SHIM}</script>\n<script>{app_js}</script>\n")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out

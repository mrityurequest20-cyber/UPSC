"""The web app as a read-only static site, in two shapes.

export_site   ONE self-contained HTML file with the account's data embedded (a frozen snapshot):
                  python -m quantdesk intraday export-site --account synthetic --out site.html
publish_site  a folder (index.html, app.js, data.json, PWA manifest + icons) whose page re-fetches
              data.json every minute; re-publish it every few minutes while the desk runs and the
              site stays live. This is what the GitHub Actions workflow pushes to GitHub Pages:
                  python -m quantdesk intraday export-site --dir _site

Either way a small shim answers the app's /api/i/* calls from the data, and the controls are
off (a static site has no engine behind it to command).
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path


from .intraday_api import IntradayAPI

STATIC = Path(__file__).resolve().parent / "static" / "app"

# Answers the app's /api/i/* calls from one data object D (same JSON the server would return).
ROUTES = r"""
function qdAnswer(D, url) {
  const reply = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
  const u = new URL(String(url), "https://snapshot.local/");
  const q = Object.fromEntries(u.searchParams.entries());
  switch (u.pathname) {
    case "/api/i/accounts": return reply([{ id: "snapshot", label: D.short || "Snapshot" }]);
    case "/api/i/state": {
      const ts = D.state.heartbeat && D.state.heartbeat.ts;
      // a published desk ages in real time (no heartbeat yet = offline); a frozen snapshot never goes stale
      const age = !D.live ? 0 : ts ? Math.max(0, (Date.now() - Date.parse(String(ts).replace(" ", "T"))) / 1000) : null;
      return reply(Object.assign({}, D.state, { age_sec: age }));
    }
    case "/api/i/thoughts": {
      const rows = D.thoughts.filter((t) => (!q.symbol || t.symbol === q.symbol) && (!q.before || t.id < Number(q.before)));
      return reply(rows.slice(0, Number(q.n || 40)));
    }
    case "/api/i/trades": return reply(D.trades.slice(0, Number(q.n || 100)));
    case "/api/i/trade": return D.trade[q.id] ? reply(D.trade[q.id]) : reply({ error: "trade details not in this snapshot" }, 404);
    case "/api/i/reviews": return reply(Object.keys(D.reviews).sort().reverse());
    case "/api/i/review": return D.reviews[q.date] ? reply({ date: q.date, markdown: D.reviews[q.date] }) : reply({ error: "no such review" }, 404);
    case "/api/i/stats": return reply(D.stats);
    case "/api/i/chart": return reply(D.chart[(q.symbol || "NIFTY") + "|" + (q.interval || "1m")] || { bars: null });
    case "/api/config": return reply({ gocharting: { enabled: false } });
    default: return reply({ error: "not available on a read-only site" }, 404);
  }
}
"""

# one-file snapshot: the data is embedded in the page
SHIM = ROUTES + r"""
window.QD_DEMO = true;
(function () {
  const D = JSON.parse(document.getElementById("qd-data").textContent);
  window.fetch = async (url) => qdAnswer(D, url);
})();
"""

# published site: the page fetches data.json (re-published every few minutes while the desk runs)
LIVE_SHIM = ROUTES + r"""
window.QD_DEMO = true;
window.QD_PUBLISHED = true;
(function () {
  const realFetch = window.fetch.bind(window);
  let D = null, at = 0, pending = null;
  function load() {
    if (pending) return pending;
    if (D && Date.now() - at < 60000) return Promise.resolve(D);
    // no-cache = revalidate with the server (ETag), so an unchanged file costs a 304, not a download
    pending = realFetch("data.json", { cache: "no-cache" })
      .then((r) => { if (!r.ok) throw new Error("data.json: HTTP " + r.status); return r.json(); })
      .then((d) => { D = d; at = Date.now(); return D; })
      .catch((e) => { if (!D) throw e; return D; })
      .finally(() => { pending = null; });
    return pending;
  }
  window.fetch = async (url) => qdAnswer(await load(), url);
})();
"""


def _body_and_style(html: str) -> tuple[str, str]:
    style = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    body = re.sub(r"<script[^>]*></script>\s*", "", body)
    return style, body


def site_data(cfg, account: str, sessions: int = 3, label: str | None = None, live: bool = False,
              max_trade_details: int = 150) -> dict:
    """Everything the app reads, as one JSON-able object (the same shapes the server's API returns)."""
    api = IntradayAPI(cfg)
    if live and not (api._dir(account) / "journal.db").exists():
        # the live site goes up before the desk's first minute: publish an empty desk, not an error
        from ..journal.journal import Journal
        api._dir(account).mkdir(parents=True, exist_ok=True)
        Journal(api._dir(account) / "journal.db").commit()
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
    short = "Live paper" if live else ("Demo" if account == "synthetic" else "Snapshot")
    return {
        "label": label or ("Live paper desk" if live else f"{account.capitalize()} snapshot"),
        "short": short, "live": live,
        "state": {**state, "age_sec": 0},
        "thoughts": thoughts,
        "trades": trades,
        "trade": {t["id"]: api.trade(account, t["id"]) for t in trades[:max_trade_details]},
        "reviews": {d: api.review(account, d)["markdown"] for d in api.reviews(account)},
        "stats": api.stats(account),
        "chart": {f"{s}|{iv}": api.chart(account, s, None, iv)
                  for s in cfg.get("intraday.underlyings", ["NIFTY", "BANKNIFTY"]) for iv in ("1m", "5m", "15m")},
    }


def _json(data) -> str:
    from .server import _clean
    return json.dumps(_clean(data), separators=(",", ":"))


def _note_css() -> str:
    return ("\n.note-demo{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:10px 12px;"
            "margin-bottom:12px;font-size:13px;color:var(--ink2)}.note-demo b{color:var(--ink)}")


def _with_note(body: str, label: str, note: str) -> str:
    return body.replace('<section data-view="live">',
                        f'<section data-view="live">\n    <div class="note-demo" role="note"><b>{label}.</b> {note}</div>', 1)


def export_site(cfg, account: str, out: Path, sessions: int = 3, label: str | None = None, note: str | None = None) -> Path:
    data = site_data(cfg, account, sessions, label)
    payload = _json(data).replace("</", "<\\/")
    style, body = _body_and_style((STATIC / "index.html").read_text(encoding="utf-8"))
    # the host pads the page for phone safe areas; the sticky header must not add them twice
    style = style.replace("header{position:sticky;top:0;", "header{position:sticky;top:env(safe-area-inset-top,0px);")
    style = style.replace("padding:calc(10px + env(safe-area-inset-top)) 16px 10px;", "padding:10px 16px;")
    style += _note_css()
    note = note or ("Read-only snapshot of the intraday desk. Controls are off here; they work on your own desk while it runs.")
    body = _with_note(body, data["label"], note)
    app_js = (STATIC / "app.js").read_text(encoding="utf-8")
    html = (f"<title>QuantDesk</title>\n<style>{style}</style>\n{body}\n"
            f'<script type="application/json" id="qd-data">{payload}</script>\n'
            f"<script>{SHIM}</script>\n<script>{app_js}</script>\n")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out


def publish_site(cfg, account: str, out_dir: Path, sessions: int = 3, label: str | None = None,
                 note: str | None = None) -> Path:
    """A static, installable (PWA) read-only site that stays current: index.html + app.js load
    data.json and re-fetch it every minute. Re-run this every few minutes while the desk trades
    and push the folder to any static host (the GitHub Actions workflow publishes it to Pages)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    data = site_data(cfg, account, sessions, label, live=True)
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    for asset in ("manifest.webmanifest", "icon-192.png", "apple-touch-icon.png"):
        html = html.replace(f'href="/{asset}"', f'href="{asset}"')
    html = re.sub(r'<script src="/static/datafeed.js"></script>\s*', "", html)
    html = html.replace('<script src="/static/app/app.js"></script>', f"<script>{LIVE_SHIM}</script>\n<script src=\"app.js\"></script>")
    html = html.replace("</style>", _note_css() + "\n</style>", 1)
    note = note or ("Paper trades only. The desk runs by itself on NSE trading days, 09:15–15:30 IST, and this page "
                    "refreshes every few minutes while it does. Read-only: nothing here can place an order.")
    html = _with_note(html, data["label"], note)
    (out / "index.html").write_text(html, encoding="utf-8")
    shutil.copyfile(STATIC / "app.js", out / "app.js")
    for icon in ("icon-192.png", "icon-512.png", "apple-touch-icon.png"):
        shutil.copyfile(STATIC / icon, out / icon)
    man = json.loads((STATIC / "manifest.webmanifest").read_text(encoding="utf-8"))
    man.update({"start_url": "./", "scope": "./"})
    for ic in man.get("icons", []):
        ic["src"] = ic["src"].lstrip("/")
    (out / "manifest.webmanifest").write_text(json.dumps(man, indent=2), encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    tmp = out / "data.json.tmp"
    tmp.write_text(_json(data), encoding="utf-8")
    tmp.replace(out / "data.json")                     # atomic: a reader never sees half a file
    return out

/* QuantDesk mobile/web app — the intraday desk from a phone.
 * Live: account, controls (pause / resume / flatten), the analyst's current read per underlying
 * with its weighted evidence, the intraday chart with VWAP, levels and trade markers, positions.
 * Thinking: the running feed of reads. Trades: journal with full detail. Stats. Reviews.
 * All server text is inserted with textContent. Polling pauses while the page is hidden. */
"use strict";
const $ = (s) => document.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const S = { account: "live", tab: "live", sym: "NIFTY", interval: "1m", state: null, thBefore: null, thSym: "" };
const TABS = [
	["live", "Live", "M3 12h4l3-8 4 16 3-8h4"],
	["thinking", "Thinking", "M12 3a6 6 0 0 0-3 11v3h6v-3a6 6 0 0 0-3-11zM9 21h6"],
	["trades", "Trades", "M4 6h16M4 12h16M4 18h10"],
	["stats", "Stats", "M5 20V10M12 20V4M19 20v-7"],
	["reviews", "Reviews", "M6 3h9l4 4v14H6zM9 12h7M9 16h7"],
];

// ---- tiny helpers ----------------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v == null) continue;
		if (k === "class") e.className = v;
		else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else e.setAttribute(k, v);
	}
	for (const k of kids.flat()) if (k != null && k !== false) e.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
	return e;
}
function svg(tag, attrs, parent) {
	const e = document.createElementNS(NS, tag);
	for (const k in attrs) e.setAttribute(k, attrs[k]);
	if (parent) parent.appendChild(e);
	return e;
}
const inr = (v, sign) => {
	if (v == null || !isFinite(v)) return "—";
	const a = Math.abs(v), s = v < 0 ? "−" : sign ? "+" : "";
	return s + (a >= 1e7 ? "₹" + (a / 1e7).toFixed(2) + " Cr" : a >= 1e5 ? "₹" + (a / 1e5).toFixed(2) + " L" : "₹" + Math.round(a).toLocaleString("en-IN"));
};
const num = (v, d = 2) => (v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 2) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%");
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const ist = (t, withDate) => new Date(typeof t === "number" ? t * 1000 : t).toLocaleString("en-IN", {
	timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false, ...(withDate ? { day: "2-digit", month: "short" } : {}) });
function toast(msg, bad) {
	const t = $("#toast");
	t.textContent = msg;
	t.style.color = bad ? "var(--bad)" : "var(--ink)";
	t.style.display = "block";
	clearTimeout(toast.t);
	toast.t = setTimeout(() => (t.style.display = "none"), 3200);
}
async function api(path, opt) {
	const sep = path.includes("?") ? "&" : "?";
	const r = await fetch(path + (path.startsWith("/api/i/") ? sep + "account=" + encodeURIComponent(S.account) : ""), opt);
	const j = await r.json().catch(() => ({}));
	if (r.status === 401) { location.href = "/"; throw new Error("sign in again"); }
	if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
	return j;
}
const post = (p, b) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

// ---- shell -------------------------------------------------------------------------------------------
function buildTabs() {
	const nav = $("#tabs");
	for (const [id, label, path] of TABS) {
		const ic = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
		svg("path", { d: path, "stroke-linecap": "round", "stroke-linejoin": "round" }, ic);
		nav.appendChild(h("button", { role: "tab", "aria-selected": String(id === S.tab), "data-tab": id, onclick: () => show(id) }, ic, label));
	}
}
function show(tab) {
	S.tab = tab;
	store("qd.tab", tab);
	document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
	document.querySelectorAll("main > section").forEach((s) => (s.hidden = s.dataset.view !== tab));
	refresh(true);
	scrollTo(0, 0);
}
function setTheme(t) {
	if (t) document.documentElement.setAttribute("data-theme", t);
	store("qd.theme", t || "");
}
function seg(el, items, current, onpick) {
	el.textContent = "";
	for (const [val, label] of items)
		el.appendChild(h("button", { "aria-pressed": String(val === current), onclick: () => { onpick(val); seg(el, items, val, onpick); } }, label));
}

// ---- live ----------------------------------------------------------------------------------------------
async function loadLive(full) {
	let st;
	try { st = await api("/api/i/state"); } catch (e) { return noAccount(e); }
	S.state = st;
	const hb = st.heartbeat || {};
	$("#eq").textContent = inr(st.equity);
	const dp = $("#daypnl");
	dp.textContent = hb.day_pnl != null ? `${inr(hb.day_pnl, true)} (${pct(hb.day_pnl / (hb.day_start_equity || 1))})` : "—";
	dp.className = cls(hb.day_pnl);
	$("#k-trades").textContent = hb.trades_today ?? "—";
	$("#k-open").textContent = (hb.positions || []).length;
	const kt = $("#k-total");
	kt.textContent = inr(st.total_pnl, true);
	kt.className = cls(st.total_pnl);
	const stale = st.age_sec == null || st.age_sec > 180;
	$("#k-age").textContent = hb.ts ? ist(hb.ts, true) : "never";
	const status = window.QD_DEMO ? "Snapshot" : st.paused ? "Paused" : hb.halted ? "Daily limit hit" : stale ? "Not running" : "Running";
	$("#status").textContent = `${status} · ${hb.feed || "?"} / ${hb.chain || "?"}`;
	$("#dot").className = "dot " + (window.QD_DEMO ? "" : st.paused ? "paused" : stale ? "stale" : "on");
	$("#btn-pause").textContent = st.paused ? "Resume entries" : "Pause new entries";
	const bn = $("#banner");
	bn.hidden = !(stale && S.account === "live") || !!window.QD_DEMO;
	bn.textContent = stale ? "The engine isn't running right now (no heartbeat in the last 3 minutes). Start it with `quantdesk intraday live`; you're seeing its last state." : "";
	renderView(hb.views || {});
	renderPositions(hb.positions || []);
	const ct = $("#closedtoday");
	ct.textContent = "";
	if (!st.closed_today.length) ct.appendChild(h("div", { class: "empty" }, "No closed trades this session."));
	for (const t of st.closed_today) ct.appendChild(tradeItem(t));
	if (full) loadChart();
}

function noAccount(e) {
	$("#viewcard").textContent = "";
	$("#viewcard").appendChild(h("div", { class: "empty" }, e.message + ". Run `quantdesk intraday live` (or `intraday replay --synthetic 5`) to create one."));
}

function renderView(views) {
	const syms = Object.keys(views);
	if (syms.length && !syms.includes(S.sym)) S.sym = syms[0];
	seg($("#symseg"), (syms.length ? syms : [S.sym]).map((s) => [s, s]), S.sym, (v) => { S.sym = v; renderView(views); loadChart(); });
	const v = views[S.sym];
	const c = $("#viewcard");
	c.textContent = "";
	if (!v) { c.appendChild(h("div", { class: "empty" }, "No market read yet for " + S.sym + ".")); return; }
	c.appendChild(h("div", { class: "row" },
		h("div", { class: "grow" }, h("div", { style: "font-size:24px;font-weight:650" }, num(v.spot)),
			h("span", { class: cls(v.chg) }, pct(v.chg)), " ", h("span", { class: "muted small" }, `${v.phase || ""} · expiry ${v.expiry || "—"}`)),
		h("span", { class: "chip " + v.bias }, h("i"), `${v.bias} ${v.score >= 0 ? "+" : ""}${v.score.toFixed(2)}`)));
	c.appendChild(h("div", { class: "row", style: "margin-top:10px" }, h("span", { class: "small muted" }, "Conviction"),
		h("div", { class: "meter", role: "meter", "aria-valuenow": v.conviction.toFixed(2), "aria-valuemin": "0", "aria-valuemax": "1" },
			h("i", { style: `width:${Math.round(v.conviction * 100)}%` })), h("b", { class: "small" }, v.conviction.toFixed(2))));
	c.appendChild(h("div", { class: "kv" }, h("div", {}, h("span", {}, "Day type"), h("b", {}, v.day_type)),
		h("div", {}, h("span", {}, "Premium"), h("b", {}, v.vol_view)),
		h("div", {}, h("span", {}, "ATM IV / RV"), h("b", {}, `${num(v.iv, 1)} / ${num(v.rv, 1)}`)),
		h("div", {}, h("span", {}, "VWAP"), h("b", {}, num(v.vwap)))));
	c.appendChild(h("p", { class: "narr" }, v.narrative));
	if (v.vetoes && v.vetoes.length) c.appendChild(h("p", { class: "small", style: "color:var(--warn)" }, "No-trade flags: " + v.vetoes.join("; ")));
	c.appendChild(evidence(v.evidence || []));
}

function evidence(list) {
	const box = h("div", { class: "ev", role: "table", "aria-label": "Evidence" });
	const sorted = [...list].sort((a, b) => Math.abs(b.direction * b.weight) - Math.abs(a.direction * a.weight));
	for (const e of sorted) {
		const w = Math.min(50, Math.abs(e.direction) * Math.min(e.weight, 1.2) / 1.2 * 50);
		const bar = h("div", { class: "dbar", title: `${e.direction >= 0 ? "+" : ""}${e.direction.toFixed(2)} × ${e.weight}` },
			h("i", { style: `${e.direction >= 0 ? "left:50%" : "right:50%"};width:${w}%;background:${e.direction >= 0 ? "var(--up)" : "var(--down)"}` }));
		box.append(h("span", { class: "f" }, e.factor), bar, h("span", { class: "o" }, e.observation));
	}
	return box;
}

function renderPositions(ps) {
	const el = $("#positions");
	el.textContent = "";
	if (!ps.length) { el.appendChild(h("div", { class: "empty" }, "Flat. No open positions.")); return; }
	for (const p of ps) {
		const legs = h("div", { class: "leg" }, h("b", {}, "Leg"), h("b", {}, "Qty"), h("b", {}, "Entry"), h("b", {}, "Mark"),
			p.legs.map((l) => [h("span", {}, l.symbol), h("span", {}, l.qty), h("span", {}, num(l.entry)), h("span", {}, num(l.mark))]));
		el.appendChild(h("div", { class: "item", style: "cursor:default" },
			h("div", { class: "top" }, h("b", {}, `${p.symbol} · ${p.setup}`), h("span", { class: "chip" }, p.structure),
				h("span", { class: "grow" }), h("b", { class: cls(p.pnl) }, inr(p.pnl, true))),
			h("div", { class: "small muted" }, `${p.lots} lot(s) since ${ist(p.opened)} · spot ${num(p.spot)} · stop ${p.stop != null ? num(p.stop) : "—"} · target ${p.target != null ? num(p.target) : "—"}`),
			legs,
			h("div", { class: "row", style: "margin-top:8px" }, h("button", { class: "small", onclick: () => openTrade(p.id) }, "Why?"),
				h("button", { class: "small danger", onclick: () => command("close", p.id, `Close ${p.symbol} ${p.setup}?`) }, "Close"))));
	}
}

async function command(cmd, arg, confirmText) {
	if (window.QD_DEMO) return toast("This is a snapshot. Pause, Close and Flatten work on your own desk while it runs.");
	if (confirmText && !confirm(confirmText)) return;
	try {
		await post("/api/i/command", { cmd, arg });
		toast(`${cmd} queued — applied on the engine's next minute`);
		loadLive(false);
	} catch (e) { toast(e.message, true); }
}

// ---- chart ------------------------------------------------------------------------------------------
const tt = () => $("#tt");
function showTT(ev, lines) {
	const el = tt();
	el.textContent = "";
	lines.forEach((l, i) => el.appendChild(h("div", i ? {} : { style: "color:var(--ink2)" }, l)));
	el.style.display = "block";
	const x = Math.min(ev.clientX + 12, innerWidth - el.offsetWidth - 8);
	el.style.left = Math.max(8, x) + "px";
	el.style.top = Math.max(8, ev.clientY - el.offsetHeight - 12) + "px";
}
const hideTT = () => (tt().style.display = "none");

// GoCharting "Pro chart": full charting (indicators, drawings) on the same recorded intraday bars.
function loadScript(url, timeout) {
	return new Promise((resolve) => {
		if (window.GoChartingSDK) return resolve(true);
		let done = false;
		const fin = (v) => { if (!done) { done = true; resolve(v); } };
		const sc = document.createElement("script");
		sc.src = url;
		sc.onload = () => { const t0 = Date.now(); (function w() { if (window.GoChartingSDK && window.GoChartingSDK.createChart) fin(true); else if (Date.now() - t0 > 5000) fin(false); else setTimeout(w, 100); })(); };
		sc.onerror = () => fin(false);
		setTimeout(() => fin(false), timeout);
		document.head.appendChild(sc);
	});
}
async function togglePro() {
	const btn = $("#btn-pro");
	if (S.pro) { S.pro = false; btn.textContent = "Pro chart"; $("#chart").style.height = ""; return loadChart(); }
	btn.textContent = "Loading…";
	let cfg;
	try { cfg = await api("/api/config"); } catch (e) { cfg = { gocharting: {} }; }
	const g = cfg.gocharting || {};
	if (!g.enabled || !(await loadScript(g.sdkUrl, 12000))) { btn.textContent = "Pro chart"; return toast("GoCharting SDK couldn't load (network or license); using the built-in chart", true); }
	S.pro = true;
	btn.textContent = "Simple chart";
	const el = $("#chart");
	el.textContent = "";
	el.style.height = "460px";
	$("#chartlegend").textContent = "";
	const acct = encodeURIComponent(S.account);
	window.GoChartingSDK.createChart("#chart", {
		symbol: "NSE:INDEX:" + S.sym, interval: S.interval, licenseKey: g.licenseKey,
		theme: (document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")),
		datafeed: window.createQuantDeskDatafeed("", { resolutions: ["1m", "5m", "15m"],
			udf: (sym, iv, f, t, cb) => `/api/i/udf?account=${acct}&symbol=${sym}&interval=${iv}` + (f != null ? `&from=${f}` : "") + (t != null ? `&to=${t}` : "") + (cb ? `&countback=${cb}` : "") }),
		onError: () => { S.pro = false; btn.textContent = "Pro chart"; loadChart(); toast("GoCharting error; back to the built-in chart", true); },
	});
}

async function loadChart() {
	if (S.pro) return;
	let d;
	try { d = await api(`/api/i/chart?symbol=${S.sym}&interval=${S.interval}`); } catch (e) { return; }
	S.chart = d;
	drawCandles();
}

function niceTicks(lo, hi, n) {
	const span = hi - lo || 1, st0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(st0))), f = st0 / mag;
	const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
	for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
	return out;
}

function drawCandles() {
	const el = $("#chart"), d = S.chart;
	el.textContent = "";
	$("#chartday").textContent = d && d.day ? `${d.symbol} · ${d.day} · ${d.interval}` : "";
	if (!d || !d.bars) { el.appendChild(h("div", { class: "empty" }, "No bars recorded yet for this account.")); return; }
	const B = d.bars, n = B.t.length, W = Math.max(320, el.clientWidth), H = el.clientHeight || 300;
	const L = 6, R = 58, T = 8, PH = H - 70, VT = H - 56, VH = 30, Bt = 22;
	let lo = Math.min(...B.l), hi = Math.max(...B.h);
	const lv = Object.entries(d.levels || {}).filter(([, v]) => v > lo - (hi - lo) * 0.3 && v < hi + (hi - lo) * 0.3);
	lv.forEach(([, v]) => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
	const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
	const step = (W - L - R) / n, X = (i) => L + (i + 0.5) * step, Y = (v) => T + (hi - v) / (hi - lo) * PH;
	const vmax = Math.max(...B.v, 1), VY = (v) => VT + VH - (v / vmax) * VH;
	const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${d.symbol} intraday candles` }, el);
	niceTicks(lo, hi, 5).forEach((v) => {
		svg("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: "var(--grid)", "stroke-width": 1 }, g);
		svg("text", { x: W - R + 4, y: Y(v) + 4 }, g).textContent = num(v, v > 1000 ? 0 : 1);
	});
	const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor((W - L - R) / 70))));
	B.t.forEach((t, i) => { if (i % every === 0) svg("text", { x: X(i), y: H - 6, "text-anchor": i === 0 ? "start" : "middle" }, g).textContent = ist(t); });
	const bw = Math.max(1, Math.min(8, step * 0.7));
	for (let i = 0; i < n; i++) {
		const up = B.c[i] >= B.o[i], col = up ? "var(--up)" : "var(--down)";
		svg("line", { x1: X(i), x2: X(i), y1: Y(B.h[i]), y2: Y(B.l[i]), stroke: col, "stroke-width": 1 }, g);
		svg("rect", { x: X(i) - bw / 2, y: Y(Math.max(B.o[i], B.c[i])), width: bw, height: Math.max(1, Math.abs(Y(B.o[i]) - Y(B.c[i]))), fill: col }, g);
		svg("rect", { x: X(i) - bw / 2, y: VY(B.v[i]), width: bw, height: VT + VH - VY(B.v[i]), fill: col, "fill-opacity": 0.3 }, g);
	}
	let path = "";
	d.vwap.forEach((v, i) => (path += (path ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)));
	svg("path", { d: path, fill: "none", stroke: "var(--s2)", "stroke-width": 2, "stroke-linejoin": "round" }, g);
	const names = { or_high: "OR high", or_low: "OR low", vah: "VAH", val: "VAL", poc: "POC", pdh: "PDH", pdl: "PDL", call_wall: "Call wall", put_wall: "Put wall", ib_high: "IB high", ib_low: "IB low" };
	// levels: every line drawn, labels merged when they would collide (≤ 12px apart)
	const lvl = lv.filter(([k]) => names[k]).sort((a, b) => Y(a[1]) - Y(b[1]));
	const groups = [];
	for (const [k, v] of lvl) {
		svg("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: k.includes("wall") ? "var(--warn)" : "var(--axis)", "stroke-width": 1 }, g);
		const last = groups[groups.length - 1];
		if (last && Y(v) - last.y < 12) last.names.push(names[k]);
		else groups.push({ y: Y(v), names: [names[k]] });
	}
	for (const gr of groups) {
		const t = svg("text", { x: L + 4, y: gr.y - 3, class: "lvl" }, g);
		t.style.fill = "var(--ink2)";
		t.textContent = gr.names.join(" · ");
	}
	const tIndex = (t) => { let best = 0; for (let i = 0; i < n; i++) if (Math.abs(B.t[i] - t) < Math.abs(B.t[best] - t)) best = i; return best; };
	const byBar = new Map();
	(d.markers || []).forEach((m) => {
		const i = tIndex(m.t);
		(byBar.get(i) || byBar.set(i, []).get(i)).push(m);
		const upTri = m.kind === "entry" ? m.dir >= 0 : m.dir < 0, s = 6;
		const y = m.price ? Y(m.price) + (upTri ? 10 : -10) : Y(B.c[i]), x = X(i);
		const pts = upTri ? `${x},${y - s} ${x - s},${y + s} ${x + s},${y + s}` : `${x},${y + s} ${x - s},${y - s} ${x + s},${y - s}`;
		svg("polygon", { points: pts, fill: m.kind === "entry" ? "var(--ink)" : "var(--surface)", stroke: "var(--ink)", "stroke-width": 1.5 }, g);
	});
	const cross = svg("line", { y1: T, y2: VT + VH, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" }, g);
	const hit = svg("rect", { x: L, y: T, width: W - L - R, height: VT + VH - T, fill: "transparent" }, g);
	const move = (e) => {
		const r = g.getBoundingClientRect(), xx = (e.clientX - r.left) / r.width * W;
		const i = Math.max(0, Math.min(n - 1, Math.round((xx - L) / step - 0.5)));
		cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
		const rows = [ist(B.t[i]), `O ${num(B.o[i])}  H ${num(B.h[i])}`, `L ${num(B.l[i])}  C ${num(B.c[i])}`, `VWAP ${num(d.vwap[i])}`];
		(byBar.get(i) || []).forEach((m) => rows.push((m.kind === "entry" ? "▲ " : "▽ ") + m.text));
		showTT(e, rows);
	};
	hit.addEventListener("pointermove", move);
	hit.addEventListener("pointerdown", move);
	hit.addEventListener("pointerleave", () => { hideTT(); cross.setAttribute("visibility", "hidden"); });
	const lg = $("#chartlegend");
	lg.textContent = "";
	lg.append(h("span", {}, h("i", { style: "background:var(--up);height:8px" }), "up"), h("span", {}, h("i", { style: "background:var(--down);height:8px" }), "down"),
		h("span", {}, h("i", { style: "background:var(--s2)" }), "VWAP"), h("span", {}, "▲ entry ▽ exit"));
}

// ---- thinking ---------------------------------------------------------------------------------------
async function loadThoughts(reset) {
	if (reset) { S.thBefore = null; $("#thoughts").textContent = ""; }
	const syms = Object.keys((S.state && S.state.heartbeat && S.state.heartbeat.views) || { NIFTY: 1, BANKNIFTY: 1 });
	seg($("#thseg"), [["", "All"], ...syms.map((s) => [s, s])], S.thSym, (v) => { S.thSym = v; loadThoughts(true); });
	let rows;
	try { rows = await api(`/api/i/thoughts?n=30${S.thSym ? "&symbol=" + S.thSym : ""}${S.thBefore ? "&before=" + S.thBefore : ""}`); }
	catch (e) { $("#thoughts").textContent = e.message; return; }
	const list = $("#thoughts");
	if (reset && !rows.length) list.appendChild(h("div", { class: "empty" }, "No thoughts recorded yet."));
	for (const r of rows) {
		const trade = /^(ENTER|EXIT)/.test(r.action || "");
		const more = h("div", { hidden: "" }, r.evidence ? evidence(r.evidence) : null);
		list.appendChild(h("div", { class: "item", "aria-expanded": "false", onclick: (e) => {
			const it = e.currentTarget;
			more.hidden = !more.hidden;
			it.classList.toggle("open", !more.hidden);
			it.setAttribute("aria-expanded", String(!more.hidden));
		} },
			h("div", { class: "top" }, h("span", { class: "t" }, ist(r.ts, true)), h("b", {}, r.symbol),
				h("span", { class: "chip " + r.bias }, h("i"), `${r.bias} ${r.score >= 0 ? "+" : ""}${Number(r.score).toFixed(2)}`),
				h("span", { class: "small muted" }, `${r.day_type} · c${Number(r.conviction).toFixed(2)}`)),
			h("div", { class: "act" + (trade ? " trade" : "") }, r.action || ""),
			h("div", { class: "narr clamp" }, r.narrative), more));
		S.thBefore = r.id;
	}
	$("#more").hidden = rows.length < 30;
}

// ---- trades -----------------------------------------------------------------------------------------
function tradeItem(t) {
	return h("div", { class: "item", onclick: () => openTrade(t.id) },
		h("div", { class: "top" }, h("span", { class: "grade" }, t.grade || "·"), h("b", {}, `${t.symbol} · ${t.strategy}`),
			t.structure ? h("span", { class: "chip" }, t.structure) : null, h("span", { class: "grow" }),
			h("b", { class: cls(t.pnl) }, t.status === "open" ? "open" : inr(t.pnl, true))),
		h("div", { class: "small muted" }, `${ist(t.opened_at, true)}${t.closed_at ? " → " + ist(t.closed_at) : ""} · ${t.exit_reason || "open"}` +
			(t.r_multiple != null && t.status !== "open" ? ` · ${t.r_multiple >= 0 ? "+" : ""}${Number(t.r_multiple).toFixed(2)}R` : "")));
}
async function loadTrades() {
	const el = $("#tradelist");
	let rows;
	try { rows = await api("/api/i/trades?n=150"); } catch (e) { el.textContent = e.message; return; }
	el.textContent = "";
	if (!rows.length) el.appendChild(h("div", { class: "empty" }, "No trades yet."));
	rows.forEach((t) => el.appendChild(tradeItem(t)));
}
async function openTrade(id) {
	let t;
	try { t = await api("/api/i/trade?id=" + encodeURIComponent(id)); } catch (e) { return toast(e.message, true); }
	const b = $("#sheetbody");
	b.textContent = "";
	const para = (label, text) => (text ? h("div", { style: "margin:10px 0" }, h("div", { class: "small muted" }, label), h("div", {}, text)) : null);
	const [why, ...rest] = String(t.rationale || "").split(" Market read: ");
	b.append(
		h("div", { class: "row" }, h("span", { class: "grade" }, t.grade || "·"), h("b", { class: "grow" }, `${t.symbol} · ${t.strategy}`),
			h("button", { class: "small", onclick: closeSheet, "aria-label": "Close" }, "✕")),
		h("div", { class: "kv" }, h("div", {}, h("span", {}, "P&L"), h("b", { class: cls(t.pnl) }, inr(t.pnl, true))),
			h("div", {}, h("span", {}, "R"), h("b", {}, t.r_multiple != null ? Number(t.r_multiple).toFixed(2) : "—")),
			h("div", {}, h("span", {}, "Lots"), h("b", {}, t.units)), h("div", {}, h("span", {}, "Costs"), h("b", {}, inr(t.fees)))),
		para("Why it was taken", why), para("What the market looked like", rest.join(" Market read: ")),
		para("Sizing", (t.sizing || []).join(" · ")), para("Exit", t.exit_reason ? `${t.exit_reason} — ${t.exit_note || ""}` : "still open"),
		para("Review", t.review), para("Lessons", (t.lessons || []).join(" ")),
		t.fills && t.fills.length ? h("div", { class: "scroll" }, h("table", {}, h("tr", {}, h("th", {}, "Fill"), h("th", {}, "Qty"), h("th", {}, "Price"), h("th", {}, "Fees")),
			t.fills.map((f) => h("tr", {}, h("td", {}, `${ist(f.ts)} ${f.symbol}`), h("td", {}, f.qty), h("td", {}, num(f.price)), h("td", {}, num(f.fees)))))) : null);
	$("#sheet").classList.add("open");
}
function closeSheet() { $("#sheet").classList.remove("open"); }

// ---- stats ------------------------------------------------------------------------------------------
async function loadStats() {
	const el = $("#stats");
	let s;
	try { s = await api("/api/i/stats"); } catch (e) { el.textContent = e.message; return; }
	el.textContent = "";
	if (!s.trades) { el.appendChild(h("div", { class: "card empty" }, "No closed trades yet.")); return; }
	const tile = (l, v, c) => h("div", { class: "tile" }, h("span", {}, l), h("b", { class: c || "" }, v));
	el.appendChild(h("div", { class: "tiles", style: "margin-bottom:12px" },
		tile("Net P&L", inr(s.net, true), cls(s.net)), tile("Return", pct(s.net / s.capital)), tile("Win rate", Math.round(s.win_rate * 100) + "%"),
		tile("Profit factor", s.profit_factor ? s.profit_factor.toFixed(2) : "—"), tile("Avg trade", (s.avg_r >= 0 ? "+" : "") + s.avg_r.toFixed(2) + "R"),
		tile("Trades / sessions", `${s.trades} / ${s.sessions}`), tile("Green days", Math.round(s.green_days * 100) + "%"),
		tile("Max drawdown", pct(s.max_dd), "neg")));
	const eqCard = h("div", { class: "card" }, h("h2", {}, "Equity by session"), h("div", { class: "chart", style: "height:220px" }));
	el.appendChild(eqCard);
	lineChart(eqCard.querySelector(".chart"), s.equity.map((r) => r.day), s.equity.map((r) => r.equity));
	const setupCard = h("div", { class: "card" }, h("h2", {}, "Net P&L by setup"), h("div", {}));
	el.appendChild(setupCard);
	hbars(setupCard.lastChild, s.by_setup);
	for (const [title, key] of [["By day type", "by_day_type"], ["By structure", "by_structure"], ["By exit", "by_exit"], ["By hour", "by_hour"], ["By underlying", "by_symbol"]])
		el.appendChild(h("div", { class: "card" }, h("h2", {}, title), h("div", { class: "scroll" }, h("table", {},
			h("tr", {}, h("th", {}, ""), h("th", {}, "Trades"), h("th", {}, "Win"), h("th", {}, "Avg R"), h("th", {}, "Net")),
			s[key].map((r) => h("tr", {}, h("td", {}, r.key), h("td", {}, r.trades), h("td", {}, Math.round(r.win * 100) + "%"),
				h("td", {}, (r.avg_r >= 0 ? "+" : "") + r.avg_r.toFixed(2)), h("td", { class: cls(r.pnl) }, inr(r.pnl, true))))))));
}
function lineChart(el, xs, ys) {
	const W = Math.max(300, el.clientWidth), H = el.clientHeight || 220, L = 6, R = 64, T = 10, B = 22;
	const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.08 || 1;
	const X = (i) => L + (xs.length === 1 ? 0.5 : i / (xs.length - 1)) * (W - L - R), Y = (v) => T + (hi + pad - v) / (hi - lo + 2 * pad) * (H - T - B);
	const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Equity by session" }, el);
	niceTicks(lo - pad, hi + pad, 4).forEach((v) => {
		svg("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }, g);
		svg("text", { x: W - R + 4, y: Y(v) + 4 }, g).textContent = inr(v);
	});
	let d = "";
	ys.forEach((v, i) => (d += (d ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)));
	svg("path", { d, fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round" }, g);
	svg("circle", { cx: X(ys.length - 1), cy: Y(ys[ys.length - 1]), r: 4, fill: "var(--s1)", stroke: "var(--surface)", "stroke-width": 2 }, g);
	[0, xs.length - 1].forEach((i) => svg("text", { x: X(i), y: H - 5, "text-anchor": i ? "end" : "start" }, g).textContent = xs[i].slice(5));
	const hit = svg("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" }, g);
	const mv = (e) => { const r = g.getBoundingClientRect(); const i = Math.max(0, Math.min(xs.length - 1, Math.round(((e.clientX - r.left) / r.width * W - L) / ((W - L - R) / Math.max(1, xs.length - 1))))); showTT(e, [xs[i], inr(ys[i])]); };
	hit.addEventListener("pointermove", mv); hit.addEventListener("pointerdown", mv); hit.addEventListener("pointerleave", hideTT);
}
function hbars(el, rows) {
	rows = [...rows].sort((a, b) => b.pnl - a.pnl);
	const max = Math.max(...rows.map((r) => Math.abs(r.pnl)), 1);
	for (const r of rows) {
		const w = Math.abs(r.pnl) / max * 50;
		el.appendChild(h("div", { style: "display:grid;grid-template-columns:110px 1fr 90px;gap:8px;align-items:center;margin:6px 0;font-size:13px" },
			h("span", {}, r.key), h("div", { class: "dbar", style: "height:14px" }, h("i", { style: `${r.pnl >= 0 ? "left:50%" : "right:50%"};width:${w}%;background:var(--s1)` })),
			h("b", { class: cls(r.pnl), style: "text-align:right" }, inr(r.pnl, true))));
	}
}

// ---- reviews (safe markdown → DOM) -----------------------------------------------------------------------
function inline(text) {
	const out = [];
	String(text).split(/(\*\*[^*]+\*\*)/).forEach((p) => out.push(p.startsWith("**") && p.endsWith("**") ? h("b", {}, p.slice(2, -2)) : p));
	return out;
}
function markdown(md) {
	const root = h("div", { class: "md" });
	const lines = md.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (/^#{1,3} /.test(l)) root.appendChild(h(l.startsWith("## ") ? "h2" : "h1", {}, inline(l.replace(/^#+ /, ""))));
		else if (l.startsWith("|")) {
			const rows = [];
			while (i < lines.length && lines[i].startsWith("|")) { if (!/^\|[-:| ]+\|$/.test(lines[i])) rows.push(lines[i]); i++; }
			i--;
			const cells = (r) => r.slice(1, -1).split("|").map((c) => c.trim());
			root.appendChild(h("div", { class: "scroll" }, h("table", {}, rows.map((r, k) => h("tr", {}, cells(r).map((c) => h(k ? "td" : "th", {}, inline(c))))))));
		} else if (l.startsWith("- ")) root.appendChild(h("li", {}, inline(l.slice(2))));
		else if (l.trim()) root.appendChild(h("p", {}, inline(l)));
	}
	return root;
}
async function loadReviews() {
	const el = $("#reviewlist");
	let dates;
	try { dates = await api("/api/i/reviews"); } catch (e) { el.textContent = e.message; return; }
	el.textContent = "";
	if (!dates.length) el.appendChild(h("div", { class: "empty" }, "No session reviews yet."));
	for (const d of dates) el.appendChild(h("div", { class: "item", onclick: async () => {
		const r = await api("/api/i/review?date=" + d);
		const b = $("#sheetbody");
		b.textContent = "";
		b.append(h("div", { class: "row" }, h("b", { class: "grow" }, "Session " + d), h("button", { class: "small", onclick: closeSheet }, "✕")), markdown(r.markdown));
		$("#sheet").classList.add("open");
	} }, h("div", { class: "top" }, h("b", {}, d), h("span", { class: "grow" }), h("span", { class: "small muted" }, "Read →"))));
}

// ---- refresh loop ------------------------------------------------------------------------------------
let tick = 0;
async function refresh(full) {
	if (document.hidden) return;
	if (S.tab === "live") await loadLive(full || tick % 3 === 0);
	else if (S.tab === "thinking" && full) await loadThoughts(true);
	else if (S.tab === "trades" && full) await loadTrades();
	else if (S.tab === "stats" && full) await loadStats();
	else if (S.tab === "reviews" && full) await loadReviews();
}

async function boot() {
	const th = store("qd.theme");
	if (th) setTheme(th);
	$("#theme").addEventListener("click", () => setTheme((document.documentElement.getAttribute("data-theme") ||
		(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark" ? "light" : "dark"));
	S.tab = store("qd.tab") || "live";
	buildTabs();
	seg($("#ivseg"), [["1m", "1m"], ["5m", "5m"], ["15m", "15m"]], S.interval, (v) => { S.interval = v; loadChart(); });
	$("#btn-pause").addEventListener("click", () => command(S.state && S.state.paused ? "resume" : "pause"));
	$("#btn-flatten").addEventListener("click", () => command("flatten", null, "Close every open position and pause new entries?"));
	$("#btn-pro").addEventListener("click", togglePro);
	if (window.QD_DEMO) $("#btn-pro").hidden = true;
	$("#more").addEventListener("click", () => loadThoughts(false));
	$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
	document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
	let accts = [];
	try { accts = await api("/api/i/accounts"); } catch (e) { /* none yet */ }
	const sel = $("#account");
	if (!accts.length) accts = [{ id: "live", label: "Live paper" }];
	accts.forEach((a) => sel.appendChild(h("option", { value: a.id }, a.label)));
	const saved = store("qd.account");
	S.account = accts.some((a) => a.id === saved) ? saved : accts[0].id;
	sel.value = S.account;
	sel.addEventListener("change", () => { S.account = sel.value; store("qd.account", S.account); refresh(true); });
	document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
	document.querySelectorAll("main > section").forEach((s) => (s.hidden = s.dataset.view !== S.tab));
	await refresh(true);
	setInterval(() => { tick++; refresh(false); }, 10000);
	document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(true); });
	let rt;
	addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (S.tab === "live" && !S.pro) drawCandles(); }, 200); });
}
boot().catch((e) => toast("failed to start: " + e.message, true));

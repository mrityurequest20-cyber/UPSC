/* UPSC Intel dashboard: vanilla JS, no build step. Works against the live API or a static export. */
(() => {
  "use strict";

  const STATIC = !!window.UPSC_STATIC;
  const POLL_MS = STATIC ? 300000 : 60000;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ─────────────────────────── helpers ───────────────────────────
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const safeUrl = (u) => {
    if (!u) return "#";
    if (u.startsWith("/files/")) return STATIC ? "#" : u.slice(1);
    return /^https?:\/\//i.test(u) ? u : "#";
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const IST_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const todayIST = () => IST_FMT.format(new Date());
  const D = (s) => new Date(s + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function periodRange(view, anchor) {
    if (view === "day") return [anchor, anchor];
    if (view === "week") {
      const d = D(anchor); const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      const from = addDays(anchor, -dow); return [from, addDays(from, 6)];
    }
    const d = D(anchor);
    const from = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
    const to = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    return [from, to];
  }
  function stepAnchor(view, anchor, dir) {
    if (view === "day") return addDays(anchor, dir);
    if (view === "week") return addDays(anchor, 7 * dir);
    const d = D(anchor); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1)));
  }
  function isoWeek(s) {
    const d = D(s); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
    const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  }
  function periodLabel(view, anchor) {
    const [a, b] = periodRange(view, anchor); const da = D(a), db = D(b);
    if (view === "day") return `${WD[da.getUTCDay()]}, ${da.getUTCDate()} ${MONTHS[da.getUTCMonth()]} ${da.getUTCFullYear()}`;
    if (view === "week") {
      const left = da.getUTCMonth() === db.getUTCMonth() ? `${da.getUTCDate()}` : `${da.getUTCDate()} ${MONTHS[da.getUTCMonth()]}`;
      return `${left}–${db.getUTCDate()} ${MONTHS[db.getUTCMonth()]} ${db.getUTCFullYear()} · W${isoWeek(a)}`;
    }
    return `${MONTHS_LONG[da.getUTCMonth()]} ${da.getUTCFullYear()}`;
  }
  function ago(isoStr) {
    if (!isoStr) return "never";
    const s = Math.max(0, (Date.now() - new Date(isoStr).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  function until(isoStr) {
    if (!isoStr) return "";
    const s = (new Date(isoStr).getTime() - Date.now()) / 1000;
    if (s <= 30) return "any moment";
    return s < 3600 ? `in ${Math.round(s / 60)} min` : `in ${Math.round(s / 3600)} h`;
  }
  const shortTime = (isoStr) => {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const ICON = {
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 12 5 5 9-10"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/></svg>',
  };

  const TIER_GROUPS = [
    ["official", "Official (PIB, RBI, SEBI…)", ["official"]],
    ["examprep", "Exam-prep desks", ["examprep"]],
    ["news", "Newspapers", ["quality", "general"]],
    ["intl", "International", ["intl"]],
    ["watch", "Google News watchlist", ["watch"]],
    ["premium", "Premium & private", ["premium", "library"]],
  ];
  const tierGroup = (t) => (TIER_GROUPS.find((g) => g[2].includes(t)) || ["news"])[0];
  const GRADES = ["NOTE", "SKIM", "READ"];
  const GRADE_HELP = { NOTE: "High yield: make notes", SKIM: "Worth knowing", READ: "Background only", LOW: "Probably not examinable" };

  // ─────────────────────────── state ───────────────────────────
  const S = {
    meta: null,
    view: "day",
    anchor: todayIST(),
    tab: "briefing",
    stories: [],
    loadedKey: "",
    loadedAt: null,
    lastRunSeen: null,
    marks: {},
    library: null,
    sources: null,
    search: null,
    pending: [],
    freshIds: new Set(),
    expanded: new Set(),
    openCards: new Set(),
    noteOpen: new Set(),
    groupBy: store.get("upsc-groupby", "subject"),
    sort: store.get("upsc-sort", "score"),
    f: { gs: new Set(), subjects: new Set(), grades: new Set(GRADES), low: false, tiers: new Set(), starred: false, unread: false, watch: null, q: "" },
  };

  // ─────────────────────────── data provider ───────────────────────────
  const monthCache = new Map();
  const api = {
    async json(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    },
    meta() { return STATIC ? this.json(`data/meta.json?t=${Date.now()}`) : this.json("api/meta"); },
    async stories(from, to, low, since) {
      if (!STATIC) {
        const q = new URLSearchParams({ from, to, include_low: low ? "true" : "false" });
        if (since) q.set("since", since);
        const res = await this.json(`api/stories?${q}`);
        S.serverStamp = res.generated_at;
        return res.stories;
      }
      const months = new Set();
      for (let d = from; d <= to; d = addDays(d, 1)) months.add(d.slice(0, 7));
      const all = new Map();
      for (const m of months) {
        if (!(S.meta.months || []).includes(m)) continue;
        if (!monthCache.has(m) || since) monthCache.set(m, await this.json(`data/stories-${m}.json?v=${encodeURIComponent(S.meta.built_at || "")}`));
        for (const s of monthCache.get(m).stories) all.set(s.id, s);
      }
      return [...all.values()].filter((s) => s.dates.some((d) => d >= from && d <= to));
    },
    async sources() { return STATIC ? (S.meta.sources || []) : (await this.json("api/sources")).sources; },
    async library() { return STATIC ? [] : (await this.json("api/library")).stories; },
    async search(q) {
      if (!STATIC) return (await this.json(`api/search?q=${encodeURIComponent(q)}`)).stories;
      const needle = q.toLowerCase(); const hits = [];
      for (const m of S.meta.months || []) {
        if (!monthCache.has(m)) monthCache.set(m, await this.json(`data/stories-${m}.json`));
        for (const s of monthCache.get(m).stories) if (matchQ(s, needle)) hits.push(s);
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, 300);
    },
    async marks() { return STATIC ? store.get("upsc-marks", {}) : this.json("api/marks"); },
    async setMark(id, patch) {
      const cur = { starred: false, read: false, note: "", ...(S.marks[id] || {}), ...patch };
      S.marks[id] = cur;
      if (STATIC) { store.set("upsc-marks", S.marks); return cur; }
      return this.json("api/marks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ story_id: id, ...patch }) });
    },
    refresh() { return this.json("api/refresh", { method: "POST" }); },
  };

  // ─────────────────────────── filtering ───────────────────────────
  const mark = (s) => S.marks[s.id] || { starred: false, read: false, note: "" };
  function matchQ(s, needle) {
    if (!needle) return true;
    const hay = `${s.title} ${s.summary} ${(s.sources || []).map((x) => x.p + " " + (x.t || "")).join(" ")} ${s.tags.join(" ")}`.toLowerCase();
    return needle.split(/\s+/).every((w) => hay.includes(w));
  }
  function passes(s, skip = "") {
    const f = S.f;
    if (s.grade === "LOW" ? !f.low : !f.grades.has(s.grade)) return false;
    if (skip !== "gs" && f.gs.size && !s.gs.some((g) => f.gs.has(g))) return false;
    if (skip !== "subjects" && f.subjects.size && !s.subjects.some((x) => f.subjects.has(x))) return false;
    if (skip !== "tiers" && f.tiers.size && !f.tiers.has(tierGroup(s.tier))) return false;
    if (skip !== "watch" && f.watch && !s.watch.includes(f.watch)) return false;
    if (f.starred && !mark(s).starred) return false;
    if (f.unread && mark(s).read) return false;
    if (f.q && !matchQ(s, f.q.toLowerCase())) return false;
    return true;
  }
  const briefingPool = () => S.stories.filter((s) => !s.editorial);
  const editorialPool = () => S.stories.filter((s) => s.editorial);
  const activeFilterCount = () => S.f.gs.size + S.f.subjects.size + S.f.tiers.size + (S.f.watch ? 1 : 0) +
    (S.f.starred ? 1 : 0) + (S.f.unread ? 1 : 0) + (S.f.low ? 1 : 0) + (GRADES.length - S.f.grades.size);

  function sortStories(list) {
    const by = S.sort === "latest"
      ? (a, b) => (b.last_seen || "").localeCompare(a.last_seen || "") || b.score - a.score
      : (a, b) => b.score - a.score || b.n_pub - a.n_pub;
    return list.sort(by);
  }

  // ─────────────────────────── rendering: header & KPIs ───────────────────────────
  function renderLive() {
    const m = S.meta; const el = $("#live"); if (!m) return;
    const dot = el.querySelector(".live-dot"); const txt = el.querySelector(".txt");
    const last = m.last_run && m.last_run.finished_at;
    if (STATIC) {
      dot.className = "live-dot";
      txt.textContent = `Auto-updates hourly · built ${ago(m.built_at)}`;
    } else if (m.running) {
      dot.className = "live-dot busy"; txt.textContent = "Fetching all sources…";
    } else {
      dot.className = last ? "live-dot" : "live-dot idle";
      txt.textContent = last ? `Live · updated ${ago(last)}${m.next_run_at ? " · next " + until(m.next_run_at) : ""}` : "Waiting for first fetch…";
    }
  }

  function renderPeriod() {
    $$(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === S.view)));
    $("#periodLabel").textContent = periodLabel(S.view, S.anchor);
    const [, to] = periodRange(S.view, S.anchor);
    $("#next").disabled = to >= todayIST();
    $("#todayBtn").disabled = S.anchor === todayIST() && S.view === "day";
  }

  function coverage() {
    const labels = S.meta.labels.subjects;
    const pool = briefingPool().filter((s) => passes(s, "subjects"));
    const counts = Object.fromEntries(Object.keys(labels).map((k) => [k, 0]));
    for (const s of pool) for (const x of s.subjects) if (x in counts) counts[x] += 1;
    return { pool, counts };
  }

  function renderKpis() {
    const pool = briefingPool().filter((s) => s.grade !== "LOW");
    const note = pool.filter((s) => s.grade === "NOTE").length;
    const outlets = new Set(); for (const s of S.stories) for (const x of s.sources || []) outlets.add(x.p);
    const { counts } = coverage();
    const blind = Object.values(counts).filter((n) => n === 0).length;
    const eds = editorialPool().filter((s) => s.grade !== "LOW").length;
    $("#kpis").innerHTML = [
      [pool.length, "stories in this " + S.view],
      [note, "NOTE-grade (make notes)"],
      [outlets.size, "outlets & feeds reporting"],
      [eds, "editorials & op-eds"],
      [blind, blind ? "syllabus blind spots" : "no blind spots", blind ? "alert" : ""],
    ].map(([v, l, cls]) => `<div class="kpi ${cls || ""}"><div class="v">${v.toLocaleString("en-IN")}</div><div class="l">${esc(l)}</div></div>`).join("");
  }

  // ─────────────────────────── filters sidebar ───────────────────────────
  function renderSide() {
    const m = S.meta; const labels = m.labels.subjects; const gsOf = m.labels.subject_gs;
    const pool = S.tab === "editorials" ? editorialPool() : briefingPool();
    const subjCounts = {}; for (const s of pool.filter((x) => passes(x, "subjects"))) for (const k of s.subjects) subjCounts[k] = (subjCounts[k] || 0) + 1;
    const gsCounts = {}; for (const s of pool.filter((x) => passes(x, "gs"))) for (const g of s.gs) gsCounts[g] = (gsCounts[g] || 0) + 1;
    const tierCounts = {}; for (const s of pool.filter((x) => passes(x, "tiers"))) { const t = tierGroup(s.tier); tierCounts[t] = (tierCounts[t] || 0) + 1; }
    const gsChip = (g) => `<button class="chip" data-f="gs" data-v="${g}" aria-pressed="${S.f.gs.has(g)}" title="${esc(m.gs_papers[g] || "Prelims facts")}">${g} <span class="n">${gsCounts[g] || 0}</span></button>`;
    $("#side").innerHTML = `
      <div class="fgroup">
        <h3>Paper</h3>
        <div class="chips">${["GS1", "GS2", "GS3", "GS4", "Prelims"].map(gsChip).join("")}</div>
      </div>
      <div class="fgroup">
        <h3>Revision grade</h3>
        <div class="chips">${GRADES.map((g) => `<button class="chip" data-f="grade" data-v="${g}" aria-pressed="${S.f.grades.has(g)}" title="${GRADE_HELP[g]}">${g}</button>`).join("")}</div>
        <label class="toggle" title="${GRADE_HELP.LOW}. Nothing is ever deleted: switch this on to see everything."><input type="checkbox" data-f="low" ${S.f.low ? "checked" : ""}> Show LOW too (everything)</label>
      </div>
      <div class="fgroup">
        <h3>Subject</h3>
        <ul class="flist">${Object.entries(labels).map(([k, l]) => `<li><button data-f="subject" data-v="${k}" aria-pressed="${S.f.subjects.has(k)}"><span>${esc(l)}<span class="gs">${esc(gsOf[k] || "")}</span></span><span class="n">${subjCounts[k] || 0}</span></button></li>`).join("")}</ul>
      </div>
      <div class="fgroup">
        <h3>Source type</h3>
        <ul class="flist">${TIER_GROUPS.map(([k, l]) => `<li><button data-f="tier" data-v="${k}" aria-pressed="${S.f.tiers.has(k)}"><span>${esc(l)}</span><span class="n">${tierCounts[k] || 0}</span></button></li>`).join("")}</ul>
      </div>
      <div class="fgroup">
        <h3>My list</h3>
        <label class="toggle"><input type="checkbox" data-f="starred" ${S.f.starred ? "checked" : ""}> Starred only</label>
        <label class="toggle"><input type="checkbox" data-f="unread" ${S.f.unread ? "checked" : ""}> Unread only</label>
      </div>
      ${activeFilterCount() ? `<button class="linkbtn" data-f="clear">Clear all filters (${activeFilterCount()})</button>` : ""}`;
  }

  // ─────────────────────────── right rail ───────────────────────────
  function renderRail() {
    const m = S.meta; const labels = m.labels.subjects;
    const { counts } = coverage();
    const max = Math.max(1, ...Object.values(counts));
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `
      <button class="cov-row ${n === 0 ? "zero" : ""}" data-f="subject" data-v="${k}" data-tip="${esc(labels[k])}: ${n} ${n === 1 ? "story" : "stories"}${n === 0 ? " (blind spot: check PIB & the watchlist)" : ""}">
        <span class="cov-name">${n === 0 ? "⚠ " : ""}${esc(labels[k])}</span>
        <span class="cov-track"><span class="cov-fill" style="width:${n ? Math.max(2, (100 * n) / max) : 0}%"></span></span>
        <span class="cov-val">${n}</span>
      </button>`).join("");
    const watchCounts = {}; for (const s of briefingPool().filter((x) => passes(x, "watch"))) for (const w of s.watch) watchCounts[w] = (watchCounts[w] || 0) + 1;
    const watch = Object.entries(m.labels.watch).map(([k, l]) => {
      const n = watchCounts[k] || 0;
      return `<div class="status ${n ? "ok" : "miss"}"><span class="ic" aria-hidden="true">${n ? "✓" : "!"}</span>
        <button class="lbl" data-f="watch" data-v="${k}" aria-pressed="${S.f.watch === k}">${esc(l)}<small>${n ? `${n} ${n === 1 ? "story" : "stories"}${S.f.watch === k ? " · filtering" : ""}` : "Nothing found: worth a manual check"}</small></button></div>`;
    }).join("");
    const top = briefingPool().filter((s) => passes(s) && s.n_pub > 1).sort((a, b) => b.n_pub - a.n_pub || b.score - a.score).slice(0, 6);
    $("#rail").innerHTML = `
      <section class="panel"><h3>Syllabus coverage <span class="sub">· stories per subject</span></h3><div class="cov-list">${rows}</div></section>
      <section class="panel"><h3>Easy-miss watch</h3>${watch}</section>
      <section class="panel top-covered"><h3>Most covered</h3>${top.length ? `<ol class="toplist">${top.map((s) => `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" data-open="${s.id}">${esc(s.title)}</a> <span class="n">${s.n_pub} outlets</span></li>`).join("")}</ol>` : `<p class="legend-note">Stories carried by several outlets show up here.</p>`}</section>`;
  }

  // ─────────────────────────── tabs ───────────────────────────
  function renderTabs() {
    const n = (arr) => arr.filter((s) => passes(s)).length;
    const tabs = [
      ["briefing", "Briefing", n(briefingPool())],
      ["editorials", "Editorials", n(editorialPool())],
      ["starred", "Starred", Object.values(S.marks).filter((x) => x.starred).length],
      ...(STATIC ? [] : [["library", "Library", S.meta.counts.library || 0]]),
      ["sources", "Sources", ""],
    ];
    $("#tabs").innerHTML = tabs.map(([k, l, c]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}${c !== "" ? `<span class="count">${c}</span>` : ""}</button>`).join("");
  }

  // ─────────────────────────── cards ───────────────────────────
  function card(s) {
    const mk = mark(s); const labels = S.meta.labels.subjects;
    const open = S.openCards.has(s.id);
    const srcs = s.sources || [];
    const shown = open ? srcs : srcs.slice(0, 3);
    const extra = (s.n_src || srcs.length) - shown.length;
    const ai = s.ai && s.ai.summary ? `
      <div class="ai"><b>AI notes</b> · ${esc(s.ai.summary)}
        ${s.ai.prelims && s.ai.prelims.length ? `<ul>${s.ai.prelims.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
        ${s.ai.mains ? `<div><b>Mains angle:</b> ${esc(s.ai.mains)}</div>` : ""}
      </div>` : "";
    const when = s.last_seen ? shortTime(srcs[0] && srcs[0].at ? srcs[0].at : s.last_seen) : "";
    const multiDay = s.dates.length > 1 ? ` · first reported ${esc(s.dates[0])}` : "";
    return `<article class="card ${mk.read ? "read" : ""} ${open ? "open" : ""}" data-id="${s.id}">
      <div class="card-top">
        <div class="pills">
          ${S.freshIds.has(s.id) ? '<span class="pill new">NEW</span>' : ""}
          <span class="pill g-${s.grade}" title="${GRADE_HELP[s.grade] || ""}">${s.grade}</span>
          ${s.gs.map((g) => `<span class="pill gs">${g}</span>`).join("")}
          ${s.subjects.slice(0, 2).map((x) => `<span class="pill subj">${esc(labels[x] || x)}</span>`).join("")}
          ${s.tags.slice(0, 2).map((t) => `<span class="pill tag">${esc(t)}</span>`).join("")}
          ${s.editorial ? '<span class="pill ed">Editorial</span>' : ""}
        </div>
        <div class="actions">
          <button data-act="star" aria-pressed="${mk.starred}" aria-label="${mk.starred ? "Unstar" : "Star for revision"}" title="Star for revision">${mk.starred ? ICON.starOn : ICON.star}</button>
          <button data-act="read" aria-pressed="${mk.read}" aria-label="${mk.read ? "Mark unread" : "Mark read"}" title="${mk.read ? "Mark unread" : "Mark read"}">${ICON.check}</button>
          <button data-act="note" aria-pressed="${!!mk.note}" aria-label="Note" title="Add a note">${ICON.note}</button>
        </div>
      </div>
      <a class="title" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" data-open="${s.id}">${esc(s.title)}</a>
      ${s.summary ? `<p class="summary">${esc(s.summary)}</p>` : ""}
      ${ai}
      <div class="srcline">
        ${s.n_pub > 1 ? `<span class="cov">${s.n_pub} outlets</span>` : ""}
        ${shown.map((x) => `<a href="${esc(safeUrl(x.u))}" target="_blank" rel="noopener" data-open="${s.id}" title="${esc(x.t || "")}">${esc(x.p || "Source")}${x.s ? ` · ${esc(x.s)}` : ""}</a>`).join("")}
        ${extra > 0 || (s.summary && s.summary.length > 160) ? `<button class="more" data-act="expand">${open ? "less" : extra > 0 ? `+${extra} more` : "more"}</button>` : ""}
        <span>${esc(when)}${multiDay}</span>
      </div>
      ${S.noteOpen.has(s.id) || mk.note ? `<div class="note"><textarea data-act="notetext" placeholder="Your notes for revision…" aria-label="Note">${esc(mk.note)}</textarea></div>` : ""}
    </article>`;
  }

  function groupOrder() {
    if (S.groupBy === "paper") return ["GS1", "GS2", "GS3", "GS4", "Prelims", "_other"];
    if (S.groupBy === "subject") return [...Object.keys(S.meta.labels.subjects), "_other"];
    return ["_all"];
  }
  function groupLabel(k) {
    if (k === "_other") return "Other / unclassified";
    if (k === "_all") return "All stories";
    if (k === "_top") return "Top stories";
    if (S.groupBy === "paper") return `${k}${S.meta.gs_papers[k] ? ` · ${S.meta.gs_papers[k]}` : ""}`;
    return S.meta.labels.subjects[k] || k;
  }

  function renderList(list, opts = {}) {
    if (!list.length) {
      return `<div class="empty">${opts.empty || "Nothing matches these filters for this period."}${activeFilterCount() ? ' <br><button class="linkbtn" data-f="clear">Clear filters</button>' : ""}</div>`;
    }
    sortStories(list);
    const perGroup = S.view === "day" ? 6 : 8;
    let html = "";
    let rest = list;
    if (S.groupBy !== "none" && !opts.flat && list.length > 12) {
      const top = list.filter((s) => s.grade === "NOTE" || s.n_pub >= 3).slice(0, S.view === "day" ? 6 : 10);
      if (top.length >= 3) {
        const ids = new Set(top.map((s) => s.id));
        html += `<section class="group"><div class="group-h"><h2>Top stories</h2><span class="meta">highest yield · most covered</span></div><div class="cards">${top.map(card).join("")}</div></section>`;
        rest = list.filter((s) => !ids.has(s.id));
      }
    }
    if (S.groupBy === "none" || opts.flat) {
      const key = "_all"; const lim = S.expanded.has(key) ? rest.length : 60;
      return html + `<div class="cards">${rest.slice(0, lim).map(card).join("")}</div>${rest.length > lim ? `<button class="btn showmore" data-expand="${key}">Show all ${rest.length}</button>` : ""}`;
    }
    const groups = new Map(groupOrder().map((k) => [k, []]));
    for (const s of rest) {
      const k = S.groupBy === "paper" ? (s.gs[0] || "_other") : (s.subjects[0] || "_other");
      (groups.get(k) || groups.get("_other")).push(s);
    }
    for (const [k, arr] of groups) {
      if (!arr.length) continue;
      const lim = S.expanded.has(k) ? arr.length : perGroup;
      const notes = arr.filter((s) => s.grade === "NOTE").length;
      html += `<section class="group"><div class="group-h"><h2>${esc(groupLabel(k))}</h2><span class="meta">${arr.length} ${arr.length === 1 ? "story" : "stories"}${notes ? ` · ${notes} NOTE` : ""}</span></div>
        <div class="cards">${arr.slice(0, lim).map(card).join("")}</div>
        ${arr.length > lim ? `<button class="btn showmore" data-expand="${esc(k)}">Show all ${arr.length} in ${esc(groupLabel(k))}</button>` : ""}</section>`;
    }
    return html;
  }

  function toolbar(count, extra = "") {
    return `<div class="toolbar"><div class="left">${count.toLocaleString("en-IN")} ${count === 1 ? "story" : "stories"}${extra}</div>
      <div class="right">
        <label>Group <select data-ctl="group"><option value="subject" ${S.groupBy === "subject" ? "selected" : ""}>by subject</option><option value="paper" ${S.groupBy === "paper" ? "selected" : ""}>by GS paper</option><option value="none" ${S.groupBy === "none" ? "selected" : ""}>no grouping</option></select></label>
        <label>Sort <select data-ctl="sort"><option value="score" ${S.sort === "score" ? "selected" : ""}>importance</option><option value="latest" ${S.sort === "latest" ? "selected" : ""}>latest</option></select></label>
      </div></div>`;
  }

  // ─────────────────────────── volume chart (week / month) ───────────────────────────
  function volumeChart() {
    if (S.view === "day") return "";
    const [from, to] = periodRange(S.view, S.anchor); const today = todayIST();
    const counts = {};
    for (const s of briefingPool()) if (passes(s)) for (const d of s.dates) if (d >= from && d <= to) counts[d] = (counts[d] || 0) + 1;
    const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const W = 1000, H = 104, top = 16, base = H - 18;
    const max = Math.max(1, ...Object.values(counts));
    const slot = W / days.length; const bw = Math.max(4, Math.min(56, slot - 2));
    const peak = days.reduce((p, d) => ((counts[d] || 0) > (counts[p] || 0) ? d : p), days[0]);
    const bars = days.map((d, i) => {
      const n = counts[d] || 0; const x = i * slot + (slot - bw) / 2;
      const h = d > today ? 0 : n ? Math.max(3, ((base - top) * n) / max) : 2;
      const y = base - h; const r = Math.min(4, bw / 2, h);
      const path = `M${x},${base} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${base} Z`;
      const dd = D(d); const label = `${WD[dd.getUTCDay()]} ${dd.getUTCDate()} ${MONTHS[dd.getUTCMonth()]}`;
      const every = days.length > 10 ? 5 : 1;
      const tick = (i % every === 0 || i === days.length - 1) ? `<text class="tick" x="${x + bw / 2}" y="${H - 3}" text-anchor="middle">${days.length > 10 ? dd.getUTCDate() : WD[dd.getUTCDay()] + " " + dd.getUTCDate()}</text>` : "";
      const peakLbl = d === peak && n ? `<text class="tick" x="${x + bw / 2}" y="${y - 4}" text-anchor="middle">${n}</text>` : "";
      return `<g>${d <= today ? `<rect class="hit" x="${i * slot}" y="0" width="${slot}" height="${base}" data-day="${d}" data-tip="${label}: ${n} ${n === 1 ? "story" : "stories"} · click to open"/>` : ""}<path class="bar ${n ? "" : "low"}" d="${path}"/>${peakLbl}${tick}</g>`;
    }).join("");
    return `<section class="panel volume"><h3>Stories per day <span class="sub">· with current filters · click a day to open it</span></h3>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Stories per day">${bars}<line class="axis" x1="0" x2="${W}" y1="${base}" y2="${base}"/></svg></section>`;
  }

  // ─────────────────────────── main content ───────────────────────────
  async function renderContent() {
    const el = $("#content");
    if (S.search) {
      const list = S.search.stories.filter((s) => passes(s, "none"));
      el.innerHTML = `<div class="searchnote"><span>All-time results for “${esc(S.search.q)}”: ${list.length}</span><button class="linkbtn" data-act="clearsearch">Clear search</button></div>` + renderList(list, { flat: true, empty: "No matches in the archive." });
      return;
    }
    if (S.tab === "sources") return renderSources(el);
    if (S.tab === "library") return renderLibrary(el);
    if (S.tab === "starred") return renderStarred(el);
    const pool = S.tab === "editorials" ? editorialPool() : briefingPool();
    const list = pool.filter((s) => passes(s));
    el.innerHTML = (S.tab === "briefing" ? volumeChart() : "") + toolbar(list.length) + renderList(list, {
      flat: S.tab === "editorials",
      empty: S.stories.length ? undefined : (S.meta.last_run ? "No stories stored for this period yet." : "The first fetch is running: stories will appear in a minute or two."),
    });
  }

  async function renderStarred(el) {
    const ids = Object.entries(S.marks).filter(([, v]) => v.starred).map(([k]) => k);
    const known = new Map(S.stories.map((s) => [s.id, s]));
    let list = ids.map((i) => known.get(i)).filter(Boolean);
    if (!STATIC && list.length < ids.length) {
      try {
        const got = await api.json("api/stories/by_ids", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
        list = got.stories;
      } catch (e) { /* keep what we have */ }
    }
    el.innerHTML = toolbar(list.length, " starred for revision · all dates") + renderList(list, { flat: true, empty: "Star (☆) any story to build your revision list. It lives here across days." });
  }

  async function renderLibrary(el) {
    if (!S.library) { el.innerHTML = '<div class="loading">Loading your library…</div>'; S.library = await api.library(); }
    const list = S.library.filter((s) => (!S.f.subjects.size || s.subjects.some((x) => S.f.subjects.has(x))) && (!S.f.q || matchQ(s, S.f.q.toLowerCase())));
    if (!S.library.length) {
      el.innerHTML = `<div class="empty"><b>Your library is empty.</b><br>Drop PDFs (Vision IAS / Drishti / ForumIAS monthly magazines, e-paper PDFs, class notes) into the <code>inbox/</code> folder. Every page gets indexed, GS-tagged and searchable here within one fetch cycle.</div>`;
      return;
    }
    const byDoc = new Map();
    for (const s of list) { const k = (s.sources[0] && s.sources[0].p) || "Document"; if (!byDoc.has(k)) byDoc.set(k, []); byDoc.get(k).push(s); }
    el.innerHTML = `<div class="toolbar"><div class="left">${list.length} sections from ${byDoc.size} documents</div></div>` +
      [...byDoc].map(([doc, arr]) => {
        const k = "lib:" + doc; const lim = S.expanded.has(k) ? arr.length : 8;
        return `<section class="group"><div class="group-h"><h2>${esc(doc)}</h2><span class="meta">${arr.length} sections</span></div><div class="cards">${arr.slice(0, lim).map(card).join("")}</div>${arr.length > lim ? `<button class="btn showmore" data-expand="${esc(k)}">Show all ${arr.length}</button>` : ""}</section>`;
      }).join("");
  }

  async function renderSources(el) {
    if (!S.sources) { el.innerHTML = '<div class="loading">Loading source health…</div>'; S.sources = await api.sources(); }
    const rows = S.sources.map((s) => {
      const down = !s.last_ok_at || (s.fail_streak > 0 && s.last_error && s.last_count === 0 && !s.last_ok_at);
      const fallback = s.active_step > 0 || (s.using && s.chain[0] !== s.using);
      const state = !s.last_ok_at ? "down" : fallback ? "fallback" : "ok";
      return { ...s, state, down };
    }).sort((a, b) => ({ down: 0, fallback: 1, ok: 2 }[a.state] - { down: 0, fallback: 1, ok: 2 }[b.state]) || (a.watchlist - b.watchlist) || a.name.localeCompare(b.name));
    const n = { ok: 0, fallback: 0, down: 0 }; rows.forEach((r) => n[r.state]++);
    el.innerHTML = `<p class="legend-note"><b>${rows.length} sources</b> · <span class="badge">${n.ok} healthy</span> · <span class="badge fallback">${n.fallback} running on a fallback</span> · <span class="badge down">${n.down} not fetched yet / down</span><br>
      Every source has a fallback chain (direct feed → alternate URL → Google News <code>site:</code> → headless browser). When a step breaks, the next one takes over automatically and the primary is re-tried every few hours.</p>
      <div class="panel tablewrap"><table class="srctable"><thead><tr><th>Source</th><th>Status</th><th>Chain</th><th class="num">Last</th><th class="num">Total</th><th>Last OK</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.section ? ` · ${esc(r.section)}` : ""}${r.private ? " 🔒" : ""}<br><small style="color:var(--muted)">${esc(r.tier)} · every ${r.interval} min</small></td>
        <td><span class="badge ${r.state === "ok" ? "" : r.state}">${r.state === "ok" ? "OK" : r.state === "fallback" ? `Fallback: ${esc(r.using)}` : "Down"}</span>${r.last_error ? `<div class="err">${esc(r.last_error).slice(0, 120)}</div>` : ""}</td>
        <td><small>${r.chain.map((c, i) => (i === r.active_step ? `<b>${esc(c)}</b>` : esc(c))).join(" → ")}</small></td>
        <td class="num">${r.last_count}</td><td class="num">${r.total_items}</td><td>${esc(ago(r.last_ok_at))}</td></tr>`).join("")}
      </tbody></table></div>`;
  }

  function renderAll() {
    renderPeriod(); renderLive(); renderKpis(); renderSide(); renderRail(); renderTabs(); renderContent();
  }

  // ─────────────────────────── loading & live updates ───────────────────────────
  function syncHash() {
    const h = `#${S.view}/${S.anchor}${S.tab !== "briefing" ? "/" + S.tab : ""}`;
    if (location.hash !== h) history.replaceState(null, "", h);
  }
  function readHash() {
    const m = location.hash.match(/^#(day|week|month)\/(\d{4}-\d{2}-\d{2})(?:\/(\w+))?/);
    if (m) { S.view = m[1]; S.anchor = m[2]; if (m[3]) S.tab = m[3]; }
  }

  async function loadPeriod(force = false) {
    const [from, to] = periodRange(S.view, S.anchor);
    const key = `${from}|${to}|${S.f.low}`;
    if (!force && key === S.loadedKey) return;
    $("#content").innerHTML = '<div class="loading">Loading…</div>';
    S.stories = await api.stories(from, to, S.f.low);
    S.loadedKey = key; S.loadedAt = S.serverStamp || new Date().toISOString(); S.pending = [];
    $("#newbanner").hidden = true;
  }

  async function go(patch = {}) {
    Object.assign(S, patch);
    S.expanded.clear(); S.search = null;
    syncHash(); renderPeriod();
    try { await loadPeriod(); } catch (e) { $("#content").innerHTML = `<div class="empty">Could not load stories (${esc(e.message)}).</div>`; return; }
    renderAll();
  }

  async function poll() {
    try {
      const prevRun = S.meta && S.meta.last_run && S.meta.last_run.finished_at;
      S.meta = await api.meta(); renderLive();
      const run = S.meta.last_run && S.meta.last_run.finished_at;
      const stamp = STATIC ? S.meta.built_at : run;
      if (!S.lastRunSeen) { S.lastRunSeen = stamp; return; }
      if (stamp && stamp !== S.lastRunSeen) {
        S.lastRunSeen = stamp;
        const [from, to] = periodRange(S.view, S.anchor);
        if (to < addDays(todayIST(), -1)) return; // viewing the past: nothing new will land
        const fresh = await api.stories(from, to, S.f.low, STATIC ? "static" : S.loadedAt);
        const have = new Map(S.stories.map((s) => [s.id, s]));
        const added = [];
        for (const s of fresh) { if (have.has(s.id)) Object.assign(have.get(s.id), s); else added.push(s); }
        S.loadedAt = S.serverStamp || new Date().toISOString();
        S.pending.push(...added.filter((s) => !S.pending.some((p) => p.id === s.id)));
        const visible = S.pending.filter((s) => s.grade !== "LOW");
        if (visible.length) {
          const b = $("#newbanner"); b.innerHTML = `<span class="dot"></span>${visible.length} new ${visible.length === 1 ? "story" : "stories"}: show`; b.hidden = false;
        }
        if (!prevRun || prevRun !== run) S.sources = null;
      }
    } catch (e) { /* offline: try again next tick */ }
  }

  function mergePending() {
    for (const s of S.pending) { S.stories.push(s); S.freshIds.add(s.id); }
    S.pending = []; $("#newbanner").hidden = true; renderAll(); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ─────────────────────────── export ───────────────────────────
  function exportMarkdown() {
    const labels = S.meta.labels.subjects;
    const pool = S.tab === "starred" ? S.stories.filter((s) => mark(s).starred) : (S.tab === "editorials" ? editorialPool() : briefingPool());
    const list = sortStories(pool.filter((s) => passes(s)));
    const groups = new Map();
    for (const s of list) { const k = labels[s.subjects[0]] || "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    let md = `# UPSC Intel · ${periodLabel(S.view, S.anchor)}${S.tab === "editorials" ? " · Editorials" : ""}\n\n_${list.length} stories · exported ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST_\n`;
    for (const [k, arr] of groups) {
      md += `\n## ${k}\n\n`;
      for (const s of arr) {
        const src = (s.sources || []).filter((x) => /^https?:/.test(x.u || "")).slice(0, 3).map((x) => `[${x.p}](${x.u})`).join(" · ");
        md += `- **${s.title}** \`${s.grade}\` ${s.gs.join(" ")}${s.tags.length ? " · " + s.tags.join(", ") : ""}\n`;
        if (s.summary) md += `  - ${s.summary.replace(/\s+/g, " ").slice(0, 400)}\n`;
        if (s.ai && s.ai.prelims && s.ai.prelims.length) md += s.ai.prelims.map((p) => `  - Prelims: ${p}\n`).join("");
        if (s.ai && s.ai.mains) md += `  - Mains: ${s.ai.mains}\n`;
        if (mark(s).note) md += `  - My note: ${mark(s).note.replace(/\n/g, " ")}\n`;
        if (src) md += `  - ${src}\n`;
      }
    }
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `upsc-${S.view}-${periodRange(S.view, S.anchor)[0]}${S.tab !== "briefing" ? "-" + S.tab : ""}.md`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ─────────────────────────── events ───────────────────────────
  function toggleSet(set, v) { set.has(v) ? set.delete(v) : set.add(v); }
  function closeDrawer() { $("#side").classList.remove("open"); $("#scrim").hidden = true; }

  function onFilterClick(t) {
    const f = t.dataset.f; const v = t.dataset.v;
    if (f === "gs") toggleSet(S.f.gs, v);
    else if (f === "grade") { toggleSet(S.f.grades, v); if (!S.f.grades.size) S.f.grades.add(v); }
    else if (f === "subject") toggleSet(S.f.subjects, v);
    else if (f === "tier") toggleSet(S.f.tiers, v);
    else if (f === "watch") S.f.watch = S.f.watch === v ? null : v;
    else if (f === "clear") { S.f.gs.clear(); S.f.subjects.clear(); S.f.tiers.clear(); S.f.grades = new Set(GRADES); S.f.watch = null; S.f.starred = false; S.f.unread = false; if (S.f.low) { S.f.low = false; return go(); } }
    else return;
    S.expanded.clear(); renderAll();
  }

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a, rect.hit");
    if (!t) return;
    if (t.matches("[data-view]")) return go({ view: t.dataset.view });
    if (t.id === "prev") return go({ anchor: stepAnchor(S.view, S.anchor, -1) });
    if (t.id === "next") return go({ anchor: stepAnchor(S.view, S.anchor, 1) });
    if (t.id === "todayBtn") return go({ view: "day", anchor: todayIST() });
    if (t.id === "themeBtn") {
      const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
      const next = dark ? "light" : "dark"; document.documentElement.setAttribute("data-theme", next); store.set("upsc-theme", next);
      try { localStorage.setItem("upsc-theme", next); } catch (err) { /* ignore */ }
      return;
    }
    if (t.id === "exportBtn") return exportMarkdown();
    if (t.id === "newbanner") return mergePending();
    if (t.id === "filtersBtn") { $("#side").classList.add("open"); $("#scrim").hidden = false; return; }
    if (t.id === "refreshBtn") {
      if (STATIC) { await poll(); return go(); }
      t.disabled = true;
      try { await api.refresh(); S.meta.running = true; renderLive(); } catch (err) { /* ignore */ }
      const wait = setInterval(async () => {
        await poll();
        if (!S.meta.running) { clearInterval(wait); t.disabled = false; if (S.pending.length) mergePending(); else renderAll(); }
      }, 5000);
      return;
    }
    if (t.matches("rect.hit[data-day]")) return go({ view: "day", anchor: t.dataset.day });
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.search = null; S.expanded.clear(); syncHash(); return renderAll(); }
    if (t.dataset.f) { onFilterClick(t); return; }
    if (t.dataset.expand) { S.expanded.add(t.dataset.expand); return renderContent(); }
    if (t.dataset.act === "clearsearch") { S.search = null; $("#q").value = ""; S.f.q = ""; return renderAll(); }
    if (t.dataset.open) {
      const id = t.dataset.open;
      if (!mark({ id }).read) { api.setMark(id, { read: true }); const c = t.closest(".card"); if (c) c.classList.add("read"); }
      return; // let the link open
    }
    const cardEl = t.closest(".card"); if (!cardEl) return;
    const id = cardEl.dataset.id;
    if (t.dataset.act === "star") { await api.setMark(id, { starred: !mark({ id }).starred }); renderTabs(); cardEl.outerHTML = card(findStory(id)); }
    else if (t.dataset.act === "read") { await api.setMark(id, { read: !mark({ id }).read }); cardEl.outerHTML = card(findStory(id)); }
    else if (t.dataset.act === "note") { toggleSet(S.noteOpen, id); cardEl.outerHTML = card(findStory(id)); const ta = $(`.card[data-id="${id}"] textarea`); if (ta) ta.focus(); }
    else if (t.dataset.act === "expand") { toggleSet(S.openCards, id); cardEl.outerHTML = card(findStory(id)); }
  });
  const findStory = (id) => S.stories.find((s) => s.id === id) || (S.search && S.search.stories.find((s) => s.id === id)) || (S.library || []).find((s) => s.id === id);

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.f === "low") { S.f.low = t.checked; return go(); }
    if (t.dataset.f === "starred") { S.f.starred = t.checked; return renderAll(); }
    if (t.dataset.f === "unread") { S.f.unread = t.checked; return renderAll(); }
    if (t.dataset.ctl === "group") { S.groupBy = t.value; store.set("upsc-groupby", S.groupBy); S.expanded.clear(); return renderContent(); }
    if (t.dataset.ctl === "sort") { S.sort = t.value; store.set("upsc-sort", S.sort); return renderContent(); }
  });
  document.addEventListener("input", debounce((e) => {
    const t = e.target;
    if (t.id === "q") { S.f.q = t.value.trim(); if (!S.f.q) S.search = null; renderKpis(); renderTabs(); renderContent(); renderRail(); }
    if (t.dataset.act === "notetext") { const id = t.closest(".card").dataset.id; api.setMark(id, { note: t.value }); }
  }, 250));
  $("#q").addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && e.target.value.trim().length >= 2) {
      const q = e.target.value.trim();
      $("#content").innerHTML = '<div class="loading">Searching the whole archive…</div>';
      try { S.search = { q, stories: await api.search(q) }; } catch (err) { S.search = { q, stories: [] }; }
      S.f.q = ""; renderContent();
    }
    if (e.key === "Escape") { e.target.value = ""; S.f.q = ""; S.search = null; renderAll(); e.target.blur(); }
  });
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
    else if (e.key === "t") go({ view: "day", anchor: todayIST() });
    else if (e.key === "[" || e.key === "ArrowLeft") go({ anchor: stepAnchor(S.view, S.anchor, -1) });
    else if ((e.key === "]" || e.key === "ArrowRight") && !$("#next").disabled) go({ anchor: stepAnchor(S.view, S.anchor, 1) });
    else if (e.key === "d" || e.key === "w" || e.key === "m") go({ view: { d: "day", w: "week", m: "month" }[e.key] });
  });

  // tooltips for chart bars & coverage rows
  const tip = $("#tooltip");
  document.addEventListener("mousemove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip; tip.hidden = false;
    const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`;
  });
  window.addEventListener("hashchange", () => { readHash(); go(); });

  // ─────────────────────────── boot ───────────────────────────
  async function boot() {
    readHash();
    if (STATIC) { $("#refreshBtn").title = "Reload the latest hourly build"; }
    try {
      [S.meta, S.marks] = await Promise.all([api.meta(), api.marks()]);
    } catch (e) {
      $("#content").innerHTML = `<div class="empty">Could not reach the data (${esc(e.message)}). Is the server running?</div>`;
      return;
    }
    S.lastRunSeen = STATIC ? S.meta.built_at : S.meta.last_run && S.meta.last_run.finished_at;
    if (!S.meta.last_run && !STATIC) S.lastRunSeen = "none";
    await go();
    setInterval(poll, POLL_MS);
    setInterval(renderLive, 30000);
  }
  boot();
})();

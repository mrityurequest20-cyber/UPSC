/* UPSC Intel dashboard: vanilla JS, no build step. Works against the live API or a static export.
   Tabs: Brief (curated, explained) · Editorials · Explained · Videos · Everything (firehose) · Starred · Library · Sources */
(() => {
  "use strict";

  const STATIC = !!window.UPSC_STATIC;
  const CORE = window.UPSCCore;  // the Ask bot's engine and the shared summaries (static/intel-core.js)
  const SNAPSHOT = !!window.UPSC_SNAPSHOT; // frozen export: no polling, no downloads
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
  const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function periodRange(view, anchor) {
    if (view === "day") return [anchor, anchor];
    if (view === "week") {
      const d = D(anchor); const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      const from = addDays(anchor, -dow); return [from, addDays(from, 6)];
    }
    const d = D(anchor);
    return [iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))), iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))];
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
  const dayShort = (s) => { const d = D(s); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
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
  const clockIST = (isoStr) => isoStr ? new Date(isoStr).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }) : "";
  const shortTime = (isoStr) => isoStr ? new Date(isoStr).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const plural = (n, one, many) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : (many || one + "s")}`;

  const ICON = {
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 12 5 5 9-10"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg>',
    ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/><path d="M9 10h6M9 14h4"/></svg>',
    dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M12 11v7m0 0-3-3m3 3 3-3"/></svg>',
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
  const GRADE_HELP = { NOTE: "High yield: make notes on it", SKIM: "Know the key facts: a quick read is enough", READ: "Background only", LOW: "Probably not examinable" };
  // how deep to study it (the grader's NOTE / SKIM / READ, in words): Must-know cards are all NOTE, Prelims facts a quick read
  const GRADE_LABEL = { NOTE: "Make notes", SKIM: "Quick read", READ: "Background", LOW: "Low" };
  const gradeName = (g) => GRADE_LABEL[g] || g;
  // the pill's tooltip: what the grade means, and Gemini's reason when Intel AI graded the story
  const gradeTip = (s) => `${GRADE_HELP[s.grade] || ""}${s.ai_why != null ? ` · ✦ Graded by Intel AI${s.ai_why ? `: ${s.ai_why}` : ""}` : ""}`;
  const GRADE_RANK = { NOTE: 0, SKIM: 1, READ: 2, LOW: 3 };
  const PAPERS = ["GS1", "GS2", "GS3", "GS4", "Prelims"];
  const BRIEF_TABS = new Set(["brief", "editorials", "explained", "videos"]);
  // how each kind of piece is labelled on its card
  const kindOf = (s) => (s.editorial ? "editorial" : s.explained ? "explained" : "news");
  const WHY_LABEL = { news: "Why in news:", editorial: "Argument:", explained: "In short:" };
  const WHAT_LABEL = { news: "What happened", editorial: "Core argument", explained: "In brief" };
  const SIG_LABEL = { news: "Why it matters", editorial: "Key points", explained: "Why it matters" };
  const KIND_PILL = { editorial: '<span class="pill ed">Editorial</span>', explained: '<span class="pill ex">Explained</span>', news: "" };

  // ─────────────────────────── state ───────────────────────────
  const S = {
    meta: null,
    view: "day",
    anchor: todayIST(),
    tab: "brief", trk: "dossiers",
    stories: [], loadedKey: "", loadedAt: null,
    brief: null, briefKey: "", briefById: new Map(), pendingBrief: null,
    lastRunSeen: null,
    marks: {},
    library: null, sources: null, search: null,
    pending: [], freshIds: new Set(),
    expanded: new Set(), openCards: new Set(), noteOpen: new Set(), autoOpened: new Set(),
    groupBy: store.get("upsc-groupby", "subject"),
    sort: store.get("upsc-sort", "score"),
    f: { gs: new Set(), subjects: new Set(), grades: new Set(GRADES), low: false, tiers: new Set(), starred: false, unread: false, watch: null, q: "" },
  };

  // ─────────────────────────── data provider ───────────────────────────
  const monthCache = new Map();
  const monthsIn = (from, to) => { const m = new Set(); for (let d = from; d <= to; d = addDays(d, 1)) m.add(d.slice(0, 7)); return [...m]; };
  const api = {
    async json(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    },
    meta() { return STATIC ? this.json(`data/meta.json?t=${Date.now()}`, { cache: "no-store" }) : this.json("api/meta", { cache: "no-store" }); },
    async month(kind, m, fresh) {
      const key = `${kind}-${m}`;
      if (!(S.meta.months || []).includes(m)) return null;
      if (!monthCache.has(key) || fresh) monthCache.set(key, await this.json(`data/${kind}-${m}.json?v=${encodeURIComponent(S.meta.built_at || "")}`));
      return monthCache.get(key);
    },
    async stories(from, to, low, since) {
      if (!STATIC) {
        const q = new URLSearchParams({ from, to, include_low: low ? "true" : "false" });
        if (since) q.set("since", since);
        const res = await this.json(`api/stories?${q}`);
        S.serverStamp = res.generated_at;
        return res.stories;
      }
      const all = new Map();
      for (const m of monthsIn(from, to)) {
        const data = await this.month("stories", m, !!since);
        if (data) for (const s of data.stories) all.set(s.id, s);
      }
      return [...all.values()].filter((s) => s.dates.some((d) => d >= from && d <= to));
    },
    async brief(from, to, fresh) {
      if (!STATIC) return this.json(`api/brief?${new URLSearchParams({ from, to })}`);
      if (from === to && (S.meta.day_files || []).includes(from)) {  // one day: its whole brief
        const key = `day-${from}`;
        if (!monthCache.has(key) || fresh) monthCache.set(key, await this.json(`data/day/${from}.json?v=${encodeURIComponent(S.meta.built_at || "")}`));
        const d = monthCache.get(key);
        return { from, to, days: d.days || {}, stories: d.stories || [], videos: d.videos || {} };
      }
      const out = { from, to, days: {}, stories: [], videos: {} };
      const seen = new Set();
      for (const m of monthsIn(from, to)) {
        const data = await this.month("brief", m, fresh);
        if (!data) continue;
        for (const [d, v] of Object.entries(data.days || {})) if (d >= from && d <= to) out.days[d] = v;
        for (const [d, v] of Object.entries(data.videos || {})) if (d >= from && d <= to) out.videos[d] = v;
        for (const s of data.stories || []) if (!seen.has(s.id)) { seen.add(s.id); out.stories.push(s); }
      }
      return out;
    },
    async sources() { return STATIC ? (S.meta.sources || []) : (await this.json("api/sources")).sources; },
    async library() { return STATIC ? [] : (await this.json("api/library")).stories; },
    async search(q) {
      if (!STATIC) return (await this.json(`api/search?q=${encodeURIComponent(q)}`)).stories;
      const needle = q.toLowerCase(); const hits = [];
      for (const m of S.meta.months || []) {
        const data = await this.month("stories", m);
        if (data) for (const s of data.stories) if (matchQ(s, needle)) hits.push(s);
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

  // ─────────────────────────── filtering (Everything tab) ───────────────────────────
  const mark = (s) => S.marks[s.id] || { starred: false, read: false, note: "" };
  function matchQ(s, needle) {
    if (!needle) return true;
    const ex = s.explain || {};
    const hay = `${s.title} ${s.summary} ${ex.what || ""} ${ex.why_in_news || ""} ${(s.sources || []).map((x) => x.p + " " + (x.t || "")).join(" ")} ${s.tags.join(" ")}`.toLowerCase();
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
  const briefPasses = (s) => (!S.f.gs.size || s.gs.some((g) => S.f.gs.has(g))) && (!S.f.q || matchQ(s, S.f.q.toLowerCase()));
  const briefingPool = () => S.stories.filter((s) => !s.editorial);
  const editorialPool = () => S.stories.filter((s) => s.editorial);
  const activeFilterCount = () => S.f.gs.size + S.f.subjects.size + S.f.tiers.size + (S.f.watch ? 1 : 0) +
    (S.f.starred ? 1 : 0) + (S.f.unread ? 1 : 0) + (S.f.low ? 1 : 0) + (GRADES.length - S.f.grades.size);
  function sortStories(list) {
    const by = S.sort === "latest"
      ? (a, b) => (b.last_seen || "").localeCompare(a.last_seen || "") || b.score - a.score
      : (a, b) => (GRADE_RANK[a.grade] ?? 3) - (GRADE_RANK[b.grade] ?? 3) || b.score - a.score || b.n_pub - a.n_pub;  // Intel AI's grade leads
    return list.sort(by);
  }

  // ─────────────────────────── brief data ───────────────────────────
  const briefDays = () => (S.brief ? Object.keys(S.brief.days).sort() : []);
  function briefList(kind) {
    // Day: rank order. Week/month: every day's picks, best first.
    const out = [];
    for (const d of briefDays()) for (const id of (S.brief.days[d][kind] || [])) { // news · editorials · explained
      const s = S.briefById.get(id); if (s) out.push({ ...s, _day: d });
    }
    if (S.view !== "day") out.sort((a, b) => (b.score + 0.4 * b.n_pub) - (a.score + 0.4 * a.n_pub));
    return out;
  }
  // other outlets' reports of the same event, listed on the lead story's card
  function foldedOf(id) {
    if (!S.brief) return [];
    for (const d of briefDays()) {
      const ids = ((S.brief.days[d] || {}).folded || {})[id];
      if (ids) return ids.map((x) => S.briefById.get(x)).filter(Boolean);
    }
    return [];
  }
  const nMore = () => briefDays().reduce((n, d) => n + ((S.brief.days[d].more || []).length || S.brief.days[d].n_more || 0), 0);
  function briefVideos() {
    if (!S.brief) return [];
    return Object.keys(S.brief.videos || {}).sort().reverse().flatMap((d) => (S.brief.videos[d] || []).map((v) => ({ ...v, _day: d })));
  }

  // ─────────────────────────── header ───────────────────────────
  function renderLive() {
    const m = S.meta; const el = $("#live"); if (!m) return;
    const dot = el.querySelector(".live-dot"); const txt = el.querySelector(".txt");
    const last = m.last_run && m.last_run.finished_at;
    if (SNAPSHOT) { dot.className = "live-dot idle"; txt.textContent = `Snapshot · data from ${shortTime(m.built_at)} IST`; }
    else if (STATIC) {
      dot.className = "live-dot" + (buildLate() ? " stale" : "");
      txt.textContent = `Updates every ${m.refresh_min || 60} min · last ${clockIST(m.built_at)} IST, ${ago(m.built_at)}${buildLate() ? " (running late)" : ""}`;
    }
    else if (m.running) { dot.className = "live-dot busy"; txt.textContent = "Fetching all sources…"; }
    else {
      dot.className = last ? "live-dot" : "live-dot idle";
      txt.textContent = last ? `Live · updated ${ago(last)}${m.next_run_at ? " · next " + until(m.next_run_at) : ""}` : "Waiting for first fetch…";
    }
  }
  function renderPeriod() {
    $$(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === S.view)));
    $("#periodLabel").innerHTML = `${ICON.cal}<span>${esc(periodLabel(S.view, S.anchor))}</span>`;
    const [, to] = periodRange(S.view, S.anchor);
    $("#next").disabled = to >= todayIST();
    $("#todayBtn").disabled = S.anchor === todayIST() && S.view === "day";
  }
  function renderTabs() {
    const has = !!S.brief;
    const nNews = has ? briefList("news").length + briefList("prelims").length + (S.view === "day" ? briefList("more").length : 0) : "";
    const nEd = has ? briefList("editorials").length : "";
    const nEx = has ? briefList("explained").length : "";
    const nVid = has ? briefVideos().length + briefList("news").concat(briefList("prelims"), briefList("explained"), briefList("editorials")).filter((s) => storyVideos(s).length).length : "";
    const tabs = [
      ["brief", S.view === "day" ? "Daily Brief" : S.view === "week" ? "Week in review" : "Month in review", nNews],
      ["editorials", "Editorials", nEd],
      ["explained", "Explained", nEx],
      ["videos", "Videos", nVid],
      ["practice", "Practice", ""],
      ["trackers", "Trackers", ""],
      ["everything", "Everything", S.tab === "everything" ? briefingPool().filter((s) => passes(s)).length : ""],
      ["starred", "Starred", Object.values(S.marks).filter((x) => x.starred).length],
      ...(STATIC ? [] : [["library", "Library", S.meta.counts.library || 0]]),
      ["sources", "Sources", ""],
    ];
    $("#tabs").innerHTML = tabs.map(([k, l, c]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${esc(l)}${c !== "" ? `<span class="count">${c}</span>` : ""}</button>`).join("");
  }
  function setLayout() {
    const brief = BRIEF_TABS.has(S.tab) && !S.search;
    const everything = S.tab === "everything" && !S.search;
    $("#layout").className = `layout ${brief ? "mode-brief" : everything ? "mode-all" : "mode-plain"}`;
    $("#kpis").hidden = !everything;
    $("#rail").hidden = !everything;
    $("#side").hidden = !(brief || everything);
    $("#filtersBtn").hidden = !everything;
  }

  // ─────────────────────────── brief rendering ───────────────────────────
  function progress(list) {
    const done = list.filter((s) => mark(s).read).length;
    const pct = list.length ? Math.round((100 * done) / list.length) : 0;
    return `<div class="progress" title="Tick “Mark done” on a story when you've read it"><div class="bar"><span style="width:${pct}%"></span></div><span>${done} of ${list.length} done</span></div>`;
  }
  function gsChips() {
    return `<div class="chips gs-chips" role="group" aria-label="Filter by paper">${PAPERS.map((g) => `<button class="chip" data-f="gs" data-v="${g}" aria-pressed="${S.f.gs.has(g)}" title="${esc(S.meta.gs_papers[g] || "Prelims facts")}">${g}</button>`).join("")}</div>`;
  }
  // one English and one Hindi video per story when a confident match exists
  const storyVideos = (s) => [[s.video, "English"], [s.video_hi, "हिंदी"]].filter(([v]) => v && v.id);
  function videoChip(s) {
    const vids = storyVideos(s);
    if (vids.length) return vids.map(([v, lang]) => `<a class="vchip" href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc(v.title)} · ${esc(v.channel)}">${ICON.play}<span>${lang} · ${esc(v.channel || "video")}</span></a>`).join("");
    const v = s.video;
    const kw = s.explain && s.explain.keywords && s.explain.keywords.length ? s.explain.keywords.slice(0, 5).join(" ") : null;
    const q = v && v.query ? v.query : (kw || s.title);
    const url = v && v.search_url ? v.search_url : `https://www.youtube.com/results?search_query=${encodeURIComponent(q + " UPSC")}`;
    const urlHi = `https://www.youtube.com/results?search_query=${encodeURIComponent(q + " UPSC hindi")}`;
    return `<span class="vchip ghost vpair" title="No confident match yet: a YouTube search">${ICON.search}<a href="${esc(url)}" target="_blank" rel="noopener">Find video</a><span aria-hidden="true">·</span><a href="${esc(urlHi)}" target="_blank" rel="noopener" lang="hi">हिंदी</a></span>`;
  }
  function videoBlock(s) {
    return storyVideos(s).map(([v, lang]) => `<a class="vblock" href="${esc(v.url)}" target="_blank" rel="noopener">
      <span class="thumb"><img src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="" loading="lazy" onerror="this.remove()"><span class="playbadge">${ICON.play}</span></span>
      <span class="vmeta"><b>${esc(v.title)}</b><small>${lang} · ${esc(v.channel || "")}${v.published ? " · " + esc(shortTime(v.published)) : ""}</small></span></a>`).join("");
  }
  // Summary box: Claude's note, the full article read from a free copy (fetched when the card opens, or in the
  // background for cards on screen), or until then the key lines of the outlets' reports.
  const SUMSTEP = new Map();
  function summaryBox(s, seen = new Set()) {
    const P = CORE.summaryNow(s); const step = SUMSTEP.get(s.id);
    const src = P.from === "web" ? CORE.sourceHtml(P.src)
      : P.from === "note" ? "Claude's study note."
      : step || P.busy ? `<span class="sumstep">${esc(step || "Reading the full article…")}</span>`
      : P.miss ? `No free copy of the full article could be read${(P.src && P.src.closed || []).length ? ` (the original on ${esc(P.src.closed.join(", "))} is subscriber-only)` : ""}: these are the key lines from the outlets' reports.`
      : "Key lines from the outlets' reports.";
    const st = CORE.staticFor(s);  // the summary's static part: Intel AI's, else the glossary's
    return `<section class="sumbox" data-sum="${esc(s.id)}"><div class="sumh"><span class="adot"></span>Summary · ${plural(P.points.length + (st ? st.points.length : 0), "point")}</div>
      ${st && P.points.length ? '<div class="sumsub">What\'s happening</div>' : ""}
      ${P.points.length ? `<ul class="pts">${P.points.map((x) => `<li><span>${CORE.gloss.html(x, seen)}</span></li>`).join("")}</ul>` : '<p class="pts-none">The outlets carried only the headline.</p>'}
      <p class="sumsrc">${src}</p>${CORE.staticHtml(st, seen)}</section>`;
  }
  function patchSummary(id) {
    const s = findStory(id); if (!s) return;
    const sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
    $$(`.sumbox[data-sum="${sel}"]`).forEach((el) => { el.outerHTML = summaryBox(s); });
  }
  function startSummary(s) {  // an opened card reads its article now, ahead of the background queue
    const P = CORE.summaryNow(s);
    if (P.from !== "brief" || P.miss) return;
    SUMSTEP.set(s.id, "Finding the full article…"); patchSummary(s.id);
    CORE.summaryFor(s, { onStep: (m) => { SUMSTEP.set(s.id, m); patchSummary(s.id); } })
      .catch((e) => toast(esc(e.message || "Couldn't reach the web just now.")))
      .finally(() => { SUMSTEP.delete(s.id); patchSummary(s.id); });
  }
  CORE.onSummary((id) => patchSummary(id));
  let cardWatch = null;
  function watchCards() {  // cards on screen get their summaries in the background, nearest first
    if (cardWatch) cardWatch.disconnect();
    if (!("IntersectionObserver" in window)) return;
    cardWatch = new IntersectionObserver((entries) => {
      const seen = entries.filter((x) => x.isIntersecting).map((x) => findStory(x.target.dataset.id)).filter(Boolean);
      if (seen.length) CORE.prefetch(seen);
    }, { rootMargin: "400px 0px" });
    $$("#content .bcard[data-id]").forEach((el) => cardWatch.observe(el));
  }
  const QUICK = ["60-word summary", "Static background", "Make 2 Prelims MCQs", "Mains answer outline", "हिंदी में समझाएं", "Link to syllabus"];
  function explainBody(s) {
    const e = s.explain || {};
    const labels = S.meta.labels.subjects;
    const seen = new Set(); const G = (x) => CORE.gloss.html(x, seen);  // each glossary term marked once per story
    const sum = summaryBox(s, seen);
    const li = (arr) => `<ul>${arr.map((x) => `<li>${G(x)}</li>`).join("")}</ul>`;
    const study = []; const details = [];
    const what = CORE.cleanText(e.what);
    if (what && !e.auto) study.push([WHAT_LABEL[kindOf(s)], `<p>${G(what)}</p>`]); else if (what) details.push([WHAT_LABEL[kindOf(s)], `<p>${esc(what)}</p>`]);
    if (e.when) details.push(["When", `<p>${esc(e.when)}</p>`]);
    if (e.where) details.push(["Where", `<p>${esc(e.where)}</p>`]);
    if (e.who) details.push(["Who", `<p>${esc(e.who)}</p>`]);
    if (e.background && !(e.static || []).length) (e.auto ? details : study).push(["Background", `<p>${G(e.background)}</p>`]);  // (else it's in the summary)
    if (e.significance && e.significance.length) (e.auto ? details : study).push([SIG_LABEL[kindOf(s)], li(e.significance)]);
    if (e.prelims && e.prelims.length) study.push(["Prelims facts", li(e.prelims)]);
    if (e.mains) study.push(["Mains question", `<p class="mq">${G(e.mains)}</p>`]);
    if (e.keywords && e.keywords.length) study.push(["Keywords", `<p class="kw">${e.keywords.map((k) => `<span>${esc(k)}</span>`).join("")}</p>`]);
    const srcs = (s.sources || []).slice(0, 6).map((x) => `<a href="${esc(safeUrl(x.u))}" target="_blank" rel="noopener" data-open="${s.id}">${esc(x.p || "Source")}${x.s ? ` · ${esc(x.s)}` : ""}</a>`).join("");
    const subj = s.subjects.map((x) => labels[x] || x).join(" · ");
    const dl = (rows) => `<dl class="explain">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
    return `<div class="bbody">
      ${sum}
      <div class="qchips">${QUICK.map((q) => `<button class="chip qchip" data-act="askq" data-q="${esc(q)}">${esc(q)}</button>`).join("")}<button class="chip qchip claude" data-act="askclaude" title="Opens Claude with this story, on your own Claude account">Ask Claude ↗</button></div>
      ${study.length ? dl(study) : ""}
      ${videoBlock(s)}
      <p class="srcs-line"><b>Read the original:</b> <span class="srcs">${srcs}${s.n_src > 6 ? `<span>+${s.n_src - 6} more</span>` : ""}</span></p>
      ${details.length || subj ? `<details class="details5w"><summary>Details: when, where, who and the syllabus</summary>${details.length ? dl(details) : ""}
        <p class="meta-line">${esc(subj)}${s.n_pub > 1 ? ` · reported by ${s.n_pub} outlets` : ""}${s.dates.length > 1 ? ` · in the news since ${esc(dayShort(s.dates[0]))}` : ""}</p></details>` : ""}
      ${S.noteOpen.has(s.id) || mark(s).note ? `<div class="note"><textarea data-act="notetext" placeholder="Your notes for revision…" aria-label="Note">${esc(mark(s).note)}</textarea></div>` : ""}
    </div>`;
  }
  function bcard(s, opts = {}) {
    const mk = mark(s); const e = s.explain || {};
    const open = S.openCards.has(s.id);
    const headline = e.headline || s.title;
    const why = CORE.cleanText(e.why_in_news) || CORE.cleanText(e.what) || CORE.cleanText(s.summary) || "";
    const labels = S.meta.labels.subjects;
    const firstSrc = (s.sources[0] && s.sources[0].p) || "Source";
    return `<article class="bcard ${open ? "open" : ""} ${mk.read ? "read" : ""} ${opts.compact ? "compact" : ""}" data-id="${s.id}"${opts.rank ? ` data-rank="${opts.rank}"` : ""}${opts.inGrade ? ' data-ing="1"' : ""}${opts.day ? ` data-day="${opts.day}"` : ""}${opts.showSubject ? " data-subj=\"1\"" : ""}>
      <button class="btoggle" data-act="toggle" aria-expanded="${open}">
        <span class="pills">
          ${opts.rank ? `<span class="rank">${opts.rank}</span>` : ""}
          ${S.freshIds.has(s.id) ? '<span class="pill new">NEW</span>' : ""}
          ${opts.day ? `<span class="pill daychip">${esc(dayShort(opts.day))}</span>` : ""}
          ${opts.inGrade ? "" : `<span class="pill g-${s.grade}" title="${esc(gradeTip(s))}">${gradeName(s.grade)}</span>`}
          ${s.gs.map((g) => `<span class="pill gs">${g}</span>`).join("")}
          ${opts.showSubject && s.subjects[0] ? `<span class="pill subj">${esc(labels[s.subjects[0]] || s.subjects[0])}</span>` : ""}
          ${KIND_PILL[kindOf(s)]}
        </span>
        <span class="btitle">${esc(headline)}</span>
        ${why ? `<span class="why"><b>${WHY_LABEL[kindOf(s)]}</b> ${esc(why)}</span>` : ""}
        <span class="chev" aria-hidden="true">${ICON.chev}</span>
      </button>
      <div class="bactions">
        ${videoChip(s)}
        <a class="vchip ghost" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" data-open="${s.id}">${ICON.ext}<span>${esc(firstSrc)}${s.n_pub > 1 ? ` +${s.n_pub - 1}` : ""}</span></a>
        <button class="vchip ask" data-act="ask" title="Ask Intel: a summary, MCQs, a Mains outline, Hindi, background…"><span class="adot"></span><span>Ask Intel</span></button>
        <span class="spacer"></span>
        <button class="icon" data-act="star" aria-pressed="${mk.starred}" title="Star for revision" aria-label="Star">${mk.starred ? ICON.starOn : ICON.star}</button>
        <button class="icon" data-act="note" aria-pressed="${!!mk.note}" title="Add a note" aria-label="Note">${ICON.note}</button>
        <button class="done ${mk.read ? "on" : ""}" data-act="read" aria-pressed="${mk.read}">${ICON.check}<span>${mk.read ? "Done" : "Mark done"}</span></button>
      </div>
      ${alsoReported(s)}
      ${CORE.dossierChips(s.topics)}
      ${open ? explainBody(s) : ""}
    </article>`;
  }
  function mrow(s) {
    const mk = mark(s); const open = S.openCards.has(s.id);
    const pub = (s.sources[0] && s.sources[0].p) || "";
    return `<li class="mrow ${open ? "open" : ""} ${mk.read ? "read" : ""}" data-id="${s.id}">
      <button class="mhead" data-act="toggle" aria-expanded="${open}"><span class="pill g-${s.grade}" title="${esc(gradeTip(s))}">${gradeName(s.grade)}</span><span class="mtitle">${esc(s.title)}</span><span class="msrc">${esc(pub)}${s.n_pub > 1 ? ` +${s.n_pub - 1}` : ""}</span></button>
      ${open ? `<div class="mbody">${summaryBox(s)}
        <p class="srcs">${(s.sources || []).map((x) => `<a href="${esc(safeUrl(x.u))}" target="_blank" rel="noopener" data-open="${s.id}">${esc(x.p || "Source")}</a>`).join("")}</p>
        <div class="bactions">${videoChip(s)}<button class="vchip ask" data-act="ask" title="Ask Intel"><span class="adot"></span><span>Ask Intel</span></button><span class="spacer"></span>
          <button class="icon" data-act="star" aria-pressed="${mk.starred}" title="Star for revision" aria-label="Star">${mk.starred ? ICON.starOn : ICON.star}</button>
          <button class="done ${mk.read ? "on" : ""}" data-act="read" aria-pressed="${mk.read}">${ICON.check}<span>${mk.read ? "Done" : "Mark done"}</span></button></div></div>` : ""}
    </li>`;
  }
  function alsoReported(s) {
    const own = (s.sources[0] && s.sources[0].p) || "";
    const f = foldedOf(s.id).filter((x) => ((x.sources[0] && x.sources[0].p) || "") !== own); if (!f.length) return "";
    return `<p class="alsorep"><b>Also reported:</b> ${f.slice(0, 4).map((x) => `<a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener" data-open="${x.id}" title="${esc(x.title)}">${esc((x.sources[0] && x.sources[0].p) || "another outlet")}</a>`).join(" · ")}${f.length > 4 ? ` · +${f.length - 4} more` : ""}</p>`;
  }
  function contentsNav(sections, title) {
    return `<nav class="contents" aria-label="Contents"><h3>${esc(title)}</h3><ol>${sections.map((x) => `<li><button data-jump="${x.id}"><span>${esc(x.label)}</span><span class="n">${x.n}</span></button></li>`).join("")}</ol></nav>`;
  }
  const section = (id, title, sub, body) =>
    `<section class="bsection" id="${id}"><div class="bsec-h"><h2>${esc(title)}</h2>${sub ? `<span class="meta">${esc(sub)}</span>` : ""}</div>${body}</section>`;
  function coverageChips(list) {
    const labels = S.meta.labels.subjects; const counts = {};
    for (const s of list) counts[s.subjects[0]] = (counts[s.subjects[0]] || 0) + 1;
    const all = Object.keys(labels);
    const missing = all.filter((k) => !counts[k]);
    return `<div class="covchips"><span class="covlabel">What we covered</span>${all.filter((k) => counts[k]).map((k) => `<button class="cchip" data-jump="sec-${k}">${esc(labels[k])} <b>${counts[k]}</b></button>`).join("")}
      ${missing.length ? `<span class="cmiss" title="No brief story in these areas for this period">⚠ Nothing in: ${esc(missing.map((k) => labels[k]).join(", "))}</span>` : ""}</div>`;
  }
  function briefHero(news, eds, exps, totalReported, lines = { note: [], quick: [], bg: [] }, facts = []) {
    const nQuick = facts.length + lines.quick.length;
    const all = news.concat(facts, eds, exps);
    const areas = new Set(news.concat(facts).map((s) => s.subjects[0])).size;
    const minutes = Math.max(5, Math.round(news.length * 1.5 + facts.length * 0.75 + (eds.length + exps.length) * 2));
    const [from, to] = periodRange(S.view, S.anchor);
    const d = D(from);
    const eyebrow = S.view === "day" ? `Daily Brief · ${WD_LONG[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`
      : S.view === "week" ? `Week ${isoWeek(from)} in review · ${periodLabel("week", S.anchor).split(" · ")[0]}` : `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()} in review`;
    const title = S.view === "day" ? `${plural(news.length, "must-know story", "must-know stories")}${lines.note.length ? ` + ${lines.note.length} to note` : ""}`
      : `${plural(news.length, "must-know story", "must-know stories")}${facts.length ? ` + ${plural(facts.length, "Prelims fact")}` : ""} · ${plural(eds.length, "editorial")} · ${plural(exps.length, "explainer")}`;
    const sub = S.view === "day"
      ? [nQuick && `${nQuick} quick read`, eds.length && plural(eds.length, "editorial"), exps.length && plural(exps.length, "explainer"), `about ${minutes} min`, `from ${plural(totalReported, "story", "stories")} reported`].filter(Boolean).join(" · ")
      : `Across ${areas} syllabus areas · from ${plural(briefDays().length, "daily brief")}${to > todayIST() ? " so far" : ""} · picked from ${plural(totalReported, "story", "stories")} reported${nMore() ? ` · ${nMore()} more are listed in the daily briefs` : ""}`;
    return `<header class="bhero"><div class="bhero-text"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
      <div class="bhero-side">${progress(all)}${gsChips()}${S.view === "day" && CORE.listen.supported && news.length ? '<button class="chip lsn-go" data-listen="start" title="Read the must-know stories and Prelims facts aloud">🎧 Listen to the brief</button>' : ""}</div></header>`;
  }
  function briefVolume() {
    const [from, to] = periodRange(S.view, S.anchor); const today = todayIST();
    const counts = {}; for (const d of briefDays()) counts[d] = (S.brief.days[d].news || []).length + (S.brief.days[d].prelims || []).length;
    const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const W = 1000, H = 90, top = 14, base = H - 18;
    const max = Math.max(1, ...Object.values(counts));
    const slot = W / days.length; const bw = Math.max(4, Math.min(48, slot - 2));
    const bars = days.map((d, i) => {
      const n = counts[d] || 0; const x = i * slot + (slot - bw) / 2;
      const h = d > today ? 0 : n ? Math.max(3, ((base - top) * n) / max) : 2;
      const y = base - h; const r = Math.min(4, bw / 2, h);
      const path = `M${x},${base} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${base} Z`;
      const dd = D(d); const every = days.length > 10 ? 5 : 1;
      const tick = (i % every === 0 || i === days.length - 1) ? `<text class="tick" x="${x + bw / 2}" y="${H - 3}" text-anchor="middle">${days.length > 10 ? dd.getUTCDate() : WD[dd.getUTCDay()] + " " + dd.getUTCDate()}</text>` : "";
      return `<g>${d <= today ? `<rect class="hit" x="${i * slot}" y="0" width="${slot}" height="${base}" data-day="${d}" data-tip="${dayShort(d)}: ${n} brief ${n === 1 ? "story" : "stories"} · click to open"/>` : ""}<path class="bar ${n ? "" : "low"}" d="${path}"/>${tick}</g>`;
    }).join("");
    return `<section class="panel volume"><h3>Brief stories per day <span class="sub">· click a day to open its brief</span></h3>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Brief stories per day">${bars}<line class="axis" x1="0" x2="${W}" y1="${base}" y2="${base}"/></svg></section>`;
  }
  function videoTile(v) {
    return `<a class="vtile" href="${esc(v.url)}" target="_blank" rel="noopener">
      <span class="thumb"><img src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="" loading="lazy" onerror="this.remove()"><span class="playbadge">${ICON.play}</span></span>
      <span class="vmeta"><b>${esc(v.title)}</b><small>${esc(v.channel || "")}${v._day && S.view !== "day" ? " · " + esc(dayShort(v._day)) : ""}</small></span></a>`;
  }
  const reportedTotal = () => briefDays().reduce((n, d) => n + (S.meta.date_counts[d] || 0), 0);

  function renderBrief() {
    const el = $("#content");
    if (!S.brief) { el.innerHTML = '<div class="loading">Loading the brief…</div>'; return; }
    const labels = S.meta.labels.subjects;
    const news = briefList("news").filter(briefPasses);
    const facts = briefList("prelims").filter(briefPasses);
    const more = S.view === "day" ? briefList("more").filter(briefPasses) : [];
    const low = S.view === "day" ? briefList("low").filter(briefPasses) : [];  // what Intel AI took out
    // the day is laid out by grade: Must-know (make notes) → Quick read → Background → Low; the list under the
    // cards joins the block of its own grade
    const lines = { note: more.filter((s) => s.grade === "NOTE"), quick: more.filter((s) => s.grade === "SKIM"),
      bg: more.filter((s) => s.grade !== "NOTE" && s.grade !== "SKIM") };
    const eds = briefList("editorials").filter(briefPasses);
    const exps = briefList("explained").filter(briefPasses);
    const vids = briefVideos();
    if (!news.length && !facts.length && !more.length && !eds.length && !exps.length) {
      const fresh = S.view === "day" && S.anchor === todayIST();
      el.innerHTML = briefHero(news, eds, exps, reportedTotal()) + `<div class="empty">${S.f.gs.size || S.f.q ? "Nothing in this brief matches the filter."
        : fresh ? `The day has just started (IST): this brief fills up as the news comes in. <br><button class="linkbtn" data-yesterday>Read yesterday's brief →</button>`
        : S.meta.last_run || STATIC ? "No brief for this period yet." : "The first fetch is running: the brief appears in a minute or two."}</div>`;
      $("#side").innerHTML = "";
      return;
    }
    const topN = S.view === "day" ? 5 : S.view === "week" ? 10 : 15;
    const top = news.slice(0, topN);
    if (!S.autoOpened.has(S.briefKey)) { S.autoOpened.add(S.briefKey); if (S.view === "day") top.slice(0, 3).forEach((s) => S.openCards.add(s.id)); }
    const rest = S.view === "day" ? news.slice(topN) : news;
    const bySubject = new Map(Object.keys(labels).map((k) => [k, []]));
    for (const s of rest) { const k = s.subjects[0]; if (bySubject.has(k)) bySubject.get(k).push(s); }
    const compact = S.view !== "day";
    const sections = [];
    let html = briefHero(news, eds, exps, reportedTotal(), lines, facts) + (compact ? coverageChips(news.concat(facts)) + briefVolume() : "");
    if (top.length) {
      html += section("sec-top", S.view === "day" ? (S.anchor === todayIST() ? "Must-know · make notes: the top " + top.length : `Must-know of ${dayShort(S.anchor)} · make notes: the top ${top.length}`) : S.view === "week" ? "Must-know: top 10 of the week" : "Must-know: top 15 of the month",
        news.length > top.length ? `the other ${news.length - top.length} follow by subject` : "", `<div class="bcards">${top.map((s, i) => bcard(s, { rank: i + 1, day: compact ? s._day : null, showSubject: true, inGrade: true })).join("")}</div>`);
      sections.push({ id: "sec-top", label: "Must-know: top " + top.length, n: top.length });
    }
    for (const [k, arr] of bySubject) {
      if (!arr.length) continue;
      const key = "b:" + k; const lim = S.expanded.has(key) || S.view === "day" ? arr.length : 6;
      html += section(`sec-${k}`, labels[k], `${S.meta.labels.subject_gs[k] || ""} · ${plural(arr.length, "story", "stories")}`,
        `<div class="bcards">${arr.slice(0, lim).map((s) => bcard(s, { compact, day: compact ? s._day : null, inGrade: true })).join("")}</div>${arr.length > lim ? `<button class="btn showmore" data-expand="${key}">Show all ${arr.length}</button>` : ""}`);
      sections.push({ id: `sec-${k}`, label: labels[k], n: arr.length });
    }
    const lineList = (arr) => {  // one line per story, grouped by subject
      const bySubj = new Map(Object.keys(labels).map((k) => [k, []]));
      for (const s of arr) { const k = s.subjects[0]; (bySubj.get(k) || (bySubj.set(k, []), bySubj.get(k))).push(s); }
      return `<div class="mlist">${[...bySubj].filter(([, a]) => a.length).map(([k, a]) =>
        `<div class="mgroup"><h4>${esc(labels[k] || k || "Other")}</h4><ul>${a.map(mrow).join("")}</ul></div>`).join("")}</div>`;
    };
    if (lines.note.length) {
      html += section("sec-note", "More to make notes on", "high-yield stories listed as lines (analysis, or beyond the day's cards) · tap a line for its summary", lineList(lines.note));
      sections.push({ id: "sec-note", label: "More to make notes on", n: lines.note.length });
    }
    if (facts.length) {
      const key = "b:facts"; const lim = S.expanded.has(key) || S.view === "day" ? facts.length : 12;
      html += section("sec-prelims", "Quick read · Prelims facts", "know the key fact of each: exercises, pacts signed, Acts and approvals, schemes, species, verdicts",
        `<div class="bcards">${facts.slice(0, lim).map((s) => bcard(s, { compact: true, day: compact ? s._day : null, showSubject: true, inGrade: true })).join("")}</div>${facts.length > lim ? `<button class="btn showmore" data-expand="${key}">Show all ${facts.length}</button>` : ""}`);
      sections.push({ id: "sec-prelims", label: "Quick read · Prelims facts", n: facts.length });
    }
    if (lines.quick.length) {
      html += section("sec-quick", "More quick reads", "worth knowing the gist · tap a line for its summary", lineList(lines.quick));
      sections.push({ id: "sec-quick", label: "More quick reads", n: lines.quick.length });
    }
    if (lines.bg.length) {
      html += section("sec-more", "Background", "context, reactions, previews and smaller stories · tap a line for its summary", lineList(lines.bg));
      sections.push({ id: "sec-more", label: "Background", n: lines.bg.length });
    }
    if (eds.length) {
      const key = "b:eds"; const lim = S.expanded.has(key) || S.view === "day" ? eds.length : 10;
      html += section("sec-editorials", S.view === "day" ? "Editorials of the day" : "Editorials", "core argument, GS paper and Mains angle",
        `<div class="bcards">${eds.slice(0, lim).map((s) => bcard(s, { compact, day: compact ? s._day : null, showSubject: true })).join("")}</div>${eds.length > lim ? `<button class="btn showmore" data-expand="${key}">Show all ${eds.length}</button>` : ""}`);
      sections.push({ id: "sec-editorials", label: "Editorials", n: eds.length });
    }
    if (exps.length) {
      const key = "b:exps"; const lim = S.expanded.has(key) || S.view === "day" ? exps.length : 10;
      html += section("sec-explained", S.view === "day" ? "Explained: today's deep dives" : "Explained", "the concept behind the news, in exam format",
        `<div class="bcards">${exps.slice(0, lim).map((s) => bcard(s, { compact, day: compact ? s._day : null, showSubject: true })).join("")}</div>${exps.length > lim ? `<button class="btn showmore" data-expand="${key}">Show all ${exps.length}</button>` : ""}`);
      sections.push({ id: "sec-explained", label: "Explained", n: exps.length });
    }
    if (vids.length) {
      const lim = S.view === "day" ? 9 : 12;
      html += section("sec-videos", S.view === "day" ? "Watch: today's analysis" : "Analysis videos", "Sansad TV, PIB, DD News, Indian Express, Drishti, StudyIQ and more",
        `<div class="vgrid">${vids.slice(0, lim).map(videoTile).join("")}</div>${vids.length > lim ? `<button class="btn showmore" data-tab-go="videos">All ${vids.length} videos</button>` : ""}`);
      sections.push({ id: "sec-videos", label: "Videos", n: vids.length });
    }
    if (low.length) {
      html += section("sec-low", "Low · not UPSC material", "taken out of the brief by Intel AI: the old rules would have listed these",
        `<details class="lowbox"><summary>Show the ${plural(low.length, "story", "stories")} Intel AI took out, with its reason</summary><ul class="lowlist">${low.map((s) =>
          `<li><span class="pill g-LOW">Low</span><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" data-open="${s.id}">${esc(s.title)}</a><span class="msrc">${esc((s.sources[0] && s.sources[0].p) || "")}</span>${s.ai_why ? `<small>✦ ${esc(s.ai_why)}</small>` : ""}</li>`).join("")}</ul></details>`);
      sections.push({ id: "sec-low", label: "Low", n: low.length });
    }
    el.innerHTML = html;
    $("#side").innerHTML = contentsNav(sections, S.view === "day" ? (S.anchor === todayIST() ? "In today's brief" : `In the ${dayShort(S.anchor)} brief`) : "In this " + S.view) +
      `<div class="side-note">Picked from ${plural(reportedTotal(), "story", "stories")} reported. The full list is under <button class="linkbtn" data-tab-go="everything">Everything</button>.</div>`;
  }

  const KIND_TAB = {
    editorials: { noun: "editorial", eyebrow: "Editorials", srcKey: "editorial_sources", head: (n) => `${plural(n, "editorial")} worth your time`,
      note: "ranked by syllabus relevance, with no single paper taking more than a third of the day" },
    explained: { noun: "explainer", eyebrow: "Explained", srcKey: "explained_sources", head: (n) => `${plural(n, "explainer")} to build your concepts`,
      note: "the \u201cwhat is it, why now, why it matters\u201d pieces behind the news, ranked by syllabus relevance" },
  };
  function renderKindTab(key) {
    const cfg = KIND_TAB[key]; const el = $("#content");
    if (!S.brief) { el.innerHTML = '<div class="loading">Loading…</div>'; return; }
    const list = briefList(key).filter(briefPasses);
    const byPub = {}; for (const s of list) { const p = (s.sources[0] && s.sources[0].p) || "Other"; byPub[p] = (byPub[p] || 0) + 1; }
    const papers = ["GS1", "GS2", "GS3", "GS4", "Other"];
    const groups = new Map(papers.map((g) => [g, []]));
    for (const s of list) (groups.get(S.meta.labels.subject_gs[s.subjects[0]]) || groups.get("Other")).push(s);
    const compact = S.view !== "day";
    const sections = [];
    let html = `<header class="bhero"><div class="bhero-text"><div class="eyebrow">${cfg.eyebrow} · ${esc(periodLabel(S.view, S.anchor))}</div>
        <h1>${cfg.head(list.length)}</h1><p>${esc(Object.entries(byPub).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(" · "))}</p></div>
        <div class="bhero-side">${progress(list)}${gsChips()}</div></header>`;
    for (const [g, arr] of groups) {
      if (!arr.length) continue;
      const id = `sec-${key}-${g}`; const k = `${key}:${g}`;
      const lim = S.expanded.has(k) || !compact ? arr.length : 8;
      html += section(id, g === "Other" ? "Other" : `${g} · ${S.meta.gs_papers[g] || ""}`, plural(arr.length, cfg.noun),
        `<div class="bcards">${arr.slice(0, lim).map((s) => bcard(s, { day: compact ? s._day : null, showSubject: true, compact })).join("")}</div>${arr.length > lim ? `<button class="btn showmore" data-expand="${esc(k)}">Show all ${arr.length}</button>` : ""}`);
      sections.push({ id, label: g, n: arr.length });
    }
    el.innerHTML = html + (list.length ? "" : `<div class="empty">No ${cfg.noun}s picked for this period yet.</div>`);
    const names = (S.meta[cfg.srcKey] || []).join(", ");
    $("#side").innerHTML = (sections.length ? contentsNav(sections, "By GS paper") : "") +
      `<div class="side-note">Picked from ${esc(names || "the opinion pages")}: ${cfg.note}. Everything else is under <button class="linkbtn" data-tab-go="everything">Everything</button>.</div>`;
  }

  function renderVideosTab() {
    const el = $("#content");
    if (!S.brief) { el.innerHTML = '<div class="loading">Loading…</div>'; return; }
    const vids = briefVideos();
    const matched = briefList("news").concat(briefList("prelims"), briefList("explained"), briefList("editorials")).filter((s) => storyVideos(s).length);
    el.innerHTML = `<header class="bhero"><div class="bhero-text"><div class="eyebrow">Videos · ${esc(periodLabel(S.view, S.anchor))}</div>
        <h1>${plural(matched.length, "story explainer")} · ${plural(vids.length, "analysis video")}</h1>
        <p>Up to two per story, one in English and one in हिंदी, attached only when the topic, key terms and date line up. Otherwise the card offers a YouTube search instead of a wrong video.</p></div></header>` +
      (matched.length ? section("sec-matched", "Explainers for brief stories", "matched by topic and date", `<div class="vlist">${matched.map((s) => `<div class="vrow">${videoBlock(s)}<div class="vfor">For: <button class="linkbtn" data-open-card="${s.id}">${esc((s.explain && s.explain.headline) || s.title)}</button></div></div>`).join("")}</div>`) : "") +
      (vids.length ? section("sec-daily", "Daily analysis videos", "news analysis, PIB summaries, Sansad TV programmes", `<div class="vgrid">${vids.map(videoTile).join("")}</div>`) : "") +
      (!matched.length && !vids.length ? '<div class="empty">No videos for this period yet. They are collected every hour from the channels\' feeds.</div>' : "");
    $("#side").innerHTML = `<div class="side-note"><b>Hindi and English only.</b> Channels watched: English: Sansad TV, PIB, DD India, The Hindu, Indian Express, WION, Drishti IAS English, StudyIQ English, Vajiram & Ravi, NEXT IAS, PW OnlyIAS, Vision IAS, Sleepy Classes, ClearIAS, Prep together. Hindi: DD News, Drishti IAS, StudyIQ IAS, NEXT IAS Hindi, UPSC Wallah, Sanskriti IAS, Dhyeya TV, Khan Global Studies. A video is attached only when its topic, key terms and date match the story; other channels must match more strongly. Add your own in <code>config/sources.local.yaml</code>.</div>`;
  }

  // ─────────────────────────── Everything tab (firehose) ───────────────────────────
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
      [pool.length, "stories in this " + S.view], [note, "NOTE-grade (make notes)"], [outlets.size, "outlets & feeds reporting"],
      [eds, "editorials & op-eds"], [blind, blind ? "syllabus blind spots" : "no blind spots", blind ? "alert" : ""],
    ].map(([v, l, cls]) => `<div class="kpi ${cls || ""}"><div class="v">${v.toLocaleString("en-IN")}</div><div class="l">${esc(l)}</div></div>`).join("");
  }
  function renderSide() {
    const m = S.meta; const labels = m.labels.subjects; const gsOf = m.labels.subject_gs;
    const pool = briefingPool();
    const subjCounts = {}; for (const s of pool.filter((x) => passes(x, "subjects"))) for (const k of s.subjects) subjCounts[k] = (subjCounts[k] || 0) + 1;
    const gsCounts = {}; for (const s of pool.filter((x) => passes(x, "gs"))) for (const g of s.gs) gsCounts[g] = (gsCounts[g] || 0) + 1;
    const tierCounts = {}; for (const s of pool.filter((x) => passes(x, "tiers"))) { const t = tierGroup(s.tier); tierCounts[t] = (tierCounts[t] || 0) + 1; }
    $("#side").innerHTML = `
      <div class="fgroup"><h3>Paper</h3><div class="chips">${PAPERS.map((g) => `<button class="chip" data-f="gs" data-v="${g}" aria-pressed="${S.f.gs.has(g)}" title="${esc(m.gs_papers[g] || "Prelims facts")}">${g} <span class="n">${gsCounts[g] || 0}</span></button>`).join("")}</div></div>
      <div class="fgroup"><h3>Revision grade</h3>
        <div class="chips">${GRADES.map((g) => `<button class="chip" data-f="grade" data-v="${g}" aria-pressed="${S.f.grades.has(g)}" title="${GRADE_HELP[g]}">${gradeName(g)}</button>`).join("")}</div>
        <label class="toggle" title="${GRADE_HELP.LOW}. Nothing is ever deleted: switch this on to see everything."><input type="checkbox" data-f="low" ${S.f.low ? "checked" : ""}> Show LOW too (everything)</label></div>
      <div class="fgroup"><h3>Subject</h3><ul class="flist">${Object.entries(labels).map(([k, l]) => `<li><button data-f="subject" data-v="${k}" aria-pressed="${S.f.subjects.has(k)}"><span>${esc(l)}<span class="gs">${esc(gsOf[k] || "")}</span></span><span class="n">${subjCounts[k] || 0}</span></button></li>`).join("")}</ul></div>
      <div class="fgroup"><h3>Source type</h3><ul class="flist">${TIER_GROUPS.map(([k, l]) => `<li><button data-f="tier" data-v="${k}" aria-pressed="${S.f.tiers.has(k)}"><span>${esc(l)}</span><span class="n">${tierCounts[k] || 0}</span></button></li>`).join("")}</ul></div>
      <div class="fgroup"><h3>My list</h3>
        <label class="toggle"><input type="checkbox" data-f="starred" ${S.f.starred ? "checked" : ""}> Starred only</label>
        <label class="toggle"><input type="checkbox" data-f="unread" ${S.f.unread ? "checked" : ""}> Unread only</label></div>
      ${activeFilterCount() ? `<button class="linkbtn" data-f="clear">Clear all filters (${activeFilterCount()})</button>` : ""}`;
  }
  function renderRail() {
    const m = S.meta; const labels = m.labels.subjects;
    const { counts } = coverage();
    const max = Math.max(1, ...Object.values(counts));
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `
      <button class="cov-row ${n === 0 ? "zero" : ""}" data-f="subject" data-v="${k}" data-tip="${esc(labels[k])}: ${n} ${n === 1 ? "story" : "stories"}${n === 0 ? " (blind spot)" : ""}">
        <span class="cov-name">${n === 0 ? "⚠ " : ""}${esc(labels[k])}</span>
        <span class="cov-track"><span class="cov-fill" style="width:${n ? Math.max(2, (100 * n) / max) : 0}%"></span></span>
        <span class="cov-val">${n}</span></button>`).join("");
    const watchCounts = {}; for (const s of briefingPool().filter((x) => passes(x, "watch"))) for (const w of s.watch) watchCounts[w] = (watchCounts[w] || 0) + 1;
    const watch = Object.entries(m.labels.watch).map(([k, l]) => {
      const n = watchCounts[k] || 0;
      return `<div class="status ${n ? "ok" : "miss"}"><span class="ic" aria-hidden="true">${n ? "✓" : "!"}</span>
        <button class="lbl" data-f="watch" data-v="${k}" aria-pressed="${S.f.watch === k}">${esc(l)}<small>${n ? `${n} ${n === 1 ? "story" : "stories"}${S.f.watch === k ? " · filtering" : ""}` : "Nothing found: worth a manual check"}</small></button></div>`;
    }).join("");
    $("#rail").innerHTML = `<section class="panel"><h3>Syllabus coverage <span class="sub">· stories per subject</span></h3><div class="cov-list">${rows}</div></section>
      <section class="panel"><h3>Easy-miss watch</h3>${watch}</section>`;
  }
  // Why a story is (or isn't) in the Daily Brief: one rule set, stated on every card.
  const BRIEF_RULE = "Daily Brief = every story that clears the bar, however many: its grade, lifted when the headline reports an examinable development (a law passed, a Cabinet decision, a pact signed, an exercise, a species found…) and lowered for reactions and commentary. The day is laid out by grade: Must-know = the high-yield (make-notes) stories; Quick read = Prelims facts and other stories worth knowing the key fact of; Background = context, reactions, previews and smaller stories; with Intel AI on, Low lists what it took out as not UPSC material. Reports of the same event share one card, every syllabus area gets its best story, and a quiet day is topped up.";
  function briefChip(s) {
    const b = s.in_brief;
    if (b) {
      const where = b.k === "editorial" ? "Editorials" : b.k === "explained" ? "Explained"
        : b.l ? "brief, on the same event's card" : b.t === "more" ? `brief · ${s.grade === "NOTE" ? "More to make notes on" : s.grade === "SKIM" ? "More quick reads" : "Background"}`
        : b.t === "prelims" ? "brief · Quick read" : "brief · Must-know";
      return `<span class="bchip in" title="${esc(BRIEF_RULE)}">✓ In ${esc(dayShort(b.d))} ${where}</span>`;
    }
    if (s.grade === "LOW") return "";
    const why = !s.subjects.length ? "no syllabus match" : `below ${esc(dayShort(s.date))}'s bar`;
    return `<span class="bchip out" title="${esc(BRIEF_RULE)}">Not in brief · ${why}</span>`;
  }
  function card(s) {
    const mk = mark(s); const labels = S.meta.labels.subjects;
    const open = S.openCards.has(s.id);
    const srcs = s.sources || [];
    const shown = open ? srcs : srcs.slice(0, 3);
    const extra = (s.n_src || srcs.length) - shown.length;
    return `<article class="card ${mk.read ? "read" : ""} ${open ? "open" : ""}" data-id="${s.id}">
      <div class="card-top">
        <div class="pills">
          ${S.freshIds.has(s.id) ? '<span class="pill new">NEW</span>' : ""}
          <span class="pill g-${s.grade}" title="${esc(gradeTip(s))}">${gradeName(s.grade)}</span>
          ${s.gs.map((g) => `<span class="pill gs">${g}</span>`).join("")}
          ${s.subjects.slice(0, 2).map((x) => `<span class="pill subj">${esc(labels[x] || x)}</span>`).join("")}
          ${s.tags.slice(0, 2).map((t) => `<span class="pill tag">${esc(t)}</span>`).join("")}
          ${KIND_PILL[kindOf(s)]}
        </div>
        <div class="actions">
          <button data-act="star" aria-pressed="${mk.starred}" aria-label="Star" title="Star for revision">${mk.starred ? ICON.starOn : ICON.star}</button>
          <button data-act="read" aria-pressed="${mk.read}" aria-label="Mark read" title="${mk.read ? "Mark unread" : "Mark read"}">${ICON.check}</button>
          <button data-act="note" aria-pressed="${!!mk.note}" aria-label="Note" title="Add a note">${ICON.note}</button>
        </div>
      </div>
      <a class="title" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" data-open="${s.id}">${esc(s.title)}</a>
      ${briefChip(s)}
      ${s.summary ? `<p class="summary">${esc(s.summary)}</p>` : ""}
      <div class="srcline">
        ${s.n_pub > 1 ? `<span class="cov">${s.n_pub} outlets</span>` : ""}
        ${shown.map((x) => `<a href="${esc(safeUrl(x.u))}" target="_blank" rel="noopener" data-open="${s.id}" title="${esc(x.t || "")}">${esc(x.p || "Source")}${x.s ? ` · ${esc(x.s)}` : ""}</a>`).join("")}
        ${extra > 0 || (s.summary && s.summary.length > 160) ? `<button class="more" data-act="expand">${open ? "less" : extra > 0 ? `+${extra} more` : "more"}</button>` : ""}
        <span>${esc(shortTime(srcs[0] && srcs[0].at ? srcs[0].at : s.last_seen))}</span>
      </div>
      ${S.noteOpen.has(s.id) || mk.note ? `<div class="note"><textarea data-act="notetext" placeholder="Your notes for revision…" aria-label="Note">${esc(mk.note)}</textarea></div>` : ""}
    </article>`;
  }
  function renderList(list, opts = {}) {
    if (!list.length) return `<div class="empty">${opts.empty || "Nothing matches these filters for this period."}${activeFilterCount() ? ' <br><button class="linkbtn" data-f="clear">Clear filters</button>' : ""}</div>`;
    sortStories(list);
    const perGroup = S.view === "day" ? 6 : 8;
    if (S.groupBy === "none" || opts.flat) {
      const key = "_all"; const lim = S.expanded.has(key) ? list.length : 60;
      return `<div class="cards">${list.slice(0, lim).map(card).join("")}</div>${list.length > lim ? `<button class="btn showmore" data-expand="${key}">Show all ${list.length}</button>` : ""}`;
    }
    const order = S.groupBy === "paper" ? [...PAPERS, "_other"] : [...Object.keys(S.meta.labels.subjects), "_other"];
    const groups = new Map(order.map((k) => [k, []]));
    for (const s of list) { const k = S.groupBy === "paper" ? (s.gs[0] || "_other") : (s.subjects[0] || "_other"); (groups.get(k) || groups.get("_other")).push(s); }
    let html = "";
    for (const [k, arr] of groups) {
      if (!arr.length) continue;
      const lim = S.expanded.has(k) ? arr.length : perGroup;
      const label = k === "_other" ? "Other / unclassified" : S.groupBy === "paper" ? `${k}${S.meta.gs_papers[k] ? " · " + S.meta.gs_papers[k] : ""}` : S.meta.labels.subjects[k] || k;
      html += `<section class="group"><div class="group-h"><h2>${esc(label)}</h2><span class="meta">${plural(arr.length, "story", "stories")}</span></div>
        <div class="cards">${arr.slice(0, lim).map(card).join("")}</div>${arr.length > lim ? `<button class="btn showmore" data-expand="${esc(k)}">Show all ${arr.length}</button>` : ""}</section>`;
    }
    return html;
  }
  function toolbar(count) {
    return `<div class="toolbar"><div class="left">${plural(count, "story", "stories")}</div>
      <div class="right">
        <label>Group <select data-ctl="group"><option value="subject" ${S.groupBy === "subject" ? "selected" : ""}>by subject</option><option value="paper" ${S.groupBy === "paper" ? "selected" : ""}>by GS paper</option><option value="none" ${S.groupBy === "none" ? "selected" : ""}>no grouping</option></select></label>
        <label>Sort <select data-ctl="sort"><option value="score" ${S.sort === "score" ? "selected" : ""}>importance</option><option value="latest" ${S.sort === "latest" ? "selected" : ""}>latest</option></select></label>
      </div></div>`;
  }
  function renderEverything() {
    renderKpis(); renderSide(); renderRail();
    const list = briefingPool().filter((s) => passes(s));
    const eds = editorialPool().filter((s) => passes(s)).length;
    $("#content").innerHTML = `<p class="legend-note">Everything reported in this period, graded and grouped (${plural(eds, "opinion piece")} included under their subjects' filters). A story shows on every day it's in the news, but joins the brief once, on the day it was first reported. <b>How the <button class="linkbtn" data-tab-go="brief">Brief</button> is picked:</b> ${esc(BRIEF_RULE)} Each card says whether it made the brief, and if not, why.</p>` +
      toolbar(list.length) + renderList(list, { empty: S.stories.length ? undefined : "No stories stored for this period yet." });
  }

  // ─────────────────────────── other tabs ───────────────────────────
  async function renderStarred() {
    const el = $("#content");
    const ids = Object.entries(S.marks).filter(([, v]) => v.starred).map(([k]) => k);
    const known = new Map(S.stories.concat(S.brief ? S.brief.stories : []).map((s) => [s.id, s]));
    let list = ids.map((i) => known.get(i)).filter(Boolean);
    if (!STATIC && list.length < ids.length) {
      try { list = (await api.json("api/stories/by_ids", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })).stories; } catch (e) { /* keep */ }
    }
    el.innerHTML = `<p class="legend-note">${plural(list.length, "starred story", "starred stories")} across all dates: your revision list.</p>` +
      (list.length ? `<div class="cards">${sortStories(list).map(card).join("")}</div>` : '<div class="empty">Star (☆) any story to build your revision list. It lives here across days.</div>') +
      CORE.backup.html();
  }
  async function renderLibrary() {
    const el = $("#content");
    if (!S.library) { el.innerHTML = '<div class="loading">Loading your library…</div>'; S.library = await api.library(); }
    if (!S.library.length) {
      el.innerHTML = `<div class="empty"><b>Your library is empty.</b><br>Drop PDFs (Vision IAS / Drishti / ForumIAS monthly magazines, e-paper PDFs, class notes) into the <code>inbox/</code> folder. Every page gets indexed, GS-tagged and searchable here within one fetch cycle.</div>`;
      return;
    }
    const list = S.library.filter((s) => !S.f.q || matchQ(s, S.f.q.toLowerCase()));
    const byDoc = new Map();
    for (const s of list) { const k = (s.sources[0] && s.sources[0].p) || "Document"; if (!byDoc.has(k)) byDoc.set(k, []); byDoc.get(k).push(s); }
    el.innerHTML = `<p class="legend-note">${list.length} sections from ${byDoc.size} documents</p>` + [...byDoc].map(([doc, arr]) => {
      const k = "lib:" + doc; const lim = S.expanded.has(k) ? arr.length : 8;
      return `<section class="group"><div class="group-h"><h2>${esc(doc)}</h2><span class="meta">${arr.length} sections</span></div><div class="cards">${arr.slice(0, lim).map(card).join("")}</div>${arr.length > lim ? `<button class="btn showmore" data-expand="${esc(k)}">Show all ${arr.length}</button>` : ""}</section>`;
    }).join("");
  }
  async function renderSources() {
    const el = $("#content");
    if (!S.sources) { el.innerHTML = '<div class="loading">Loading source health…</div>'; S.sources = await api.sources(); }
    const rank = { down: 0, fallback: 1, ok: 2 };
    const rows = S.sources.map((s) => {
      const fallback = s.active_step > 0 || (s.using && s.chain[0] !== s.using);
      return { ...s, state: !s.last_ok_at ? "down" : fallback ? "fallback" : "ok" };
    }).sort((a, b) => rank[a.state] - rank[b.state] || (a.watchlist - b.watchlist) || a.name.localeCompare(b.name));
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
  function renderSearch() {
    const list = S.search.stories;
    $("#content").innerHTML = `<div class="searchnote"><span>All-time results for “${esc(S.search.q)}”: ${list.length}</span><button class="linkbtn" data-act="clearsearch">Clear search</button></div>` +
      (list.length ? `<div class="cards">${list.map(card).join("")}</div>` : '<div class="empty">No matches in the archive.</div>');
  }

  function renderAll() {
    renderScreen();
    watchCards();
  }
  function renderScreen() {
    renderPeriod(); renderLive(); renderTabs(); setLayout();
    if (S.search) return renderSearch();
    if (S.tab === "brief") return renderBrief();
    if (S.tab === "editorials") return renderKindTab("editorials");
    if (S.tab === "explained") return renderKindTab("explained");
    if (S.tab === "videos") return renderVideosTab();
    if (S.tab === "practice") return renderPractice();
    if (S.tab === "trackers") return renderTrackers();
    if (S.tab === "everything") return renderEverything();
    if (S.tab === "starred") return renderStarred();
    if (S.tab === "library") return renderLibrary();
    if (S.tab === "sources") return renderSources();
  }

  // ─────────────────────────── loading & live updates ───────────────────────────
  function syncHash() {
    const h = `#${S.view}/${S.anchor}${S.tab !== "brief" ? "/" + S.tab : ""}`;
    try { if (location.hash !== h) history.replaceState(null, "", h); } catch (e) { /* sandboxed frame */ }
  }
  function readHash() {
    const m = location.hash.match(/^#(day|week|month)\/(\d{4}-\d{2}-\d{2})(?:\/(\w+))?/);
    if (m) { S.view = m[1]; S.anchor = m[2]; if (m[3]) S.tab = m[3]; }
    if (["dossiers", "map", "ranks"].includes(S.tab)) { S.trk = S.tab; S.tab = "trackers"; }  // the old tabs' links still land
  }
  async function loadBrief(force = false) {
    const [from, to] = periodRange(S.view, S.anchor);
    const key = `${from}|${to}`;
    if (!force && key === S.briefKey && S.brief) return;
    S.brief = await api.brief(from, to, force);
    S.briefKey = key;
    S.briefById = new Map(S.brief.stories.map((s) => [s.id, s]));
    setGlossary();
  }
  // the day's glossary (days[d].glossary): its terms are marked in a card's text, a tap shows the meaning
  const setGlossary = () => CORE.gloss.set(Object.assign({}, ...Object.values((S.brief && S.brief.days) || {}).map((v) => v.glossary || {})));
  async function loadStories(force = false) {
    const [from, to] = periodRange(S.view, S.anchor);
    const key = `${from}|${to}|${S.f.low}`;
    if (!force && key === S.loadedKey) return;
    S.stories = await api.stories(from, to, S.f.low);
    S.loadedKey = key; S.loadedAt = S.serverStamp || new Date().toISOString(); S.pending = [];
  }
  async function go(patch = {}) {
    Object.assign(S, patch);
    S.expanded.clear(); S.search = null;
    syncHash(); renderPeriod();
    if (!S.brief || S.briefKey !== periodRange(S.view, S.anchor).join("|")) $("#content").innerHTML = '<div class="loading">Loading…</div>';
    try {
      await loadBrief();
      if (S.tab === "everything") await loadStories();
    } catch (e) { $("#content").innerHTML = `<div class="empty">Could not load (${esc(e.message)}).</div>`; return; }
    renderAll();
    window.scrollTo({ top: 0 });
  }

  // Checks for a new build/run. Returns how many new stories arrived (0 when nothing changed), or null
  // when the data couldn't be reached. apply=true shows them at once instead of offering the banner.
  async function poll(opts = {}) {
    try {
      S.meta = await api.meta(); renderLive();
      const stamp = STATIC ? S.meta.built_at : S.meta.last_run && S.meta.last_run.finished_at;
      if (!stamp || stamp === S.lastRunSeen) return 0;
      S.lastRunSeen = stamp; S.sources = null;
      const [from, to] = periodRange(S.view, S.anchor);
      if (to < addDays(todayIST(), -1)) return 0; // viewing the past: nothing new will land
      const before = new Set(S.brief ? S.brief.stories.map((s) => s.id) : []);
      const fresh = await api.brief(from, to, true);
      const added = fresh.stories.filter((s) => !before.has(s.id));
      S.pendingBrief = fresh;
      if (S.tab === "everything") {
        const more = await api.stories(from, to, S.f.low, STATIC ? "static" : S.loadedAt);
        const have = new Map(S.stories.map((s) => [s.id, s]));
        for (const s of more) { if (have.has(s.id)) Object.assign(have.get(s.id), s); else if (!S.pending.some((p) => p.id === s.id)) S.pending.push(s); }
        S.loadedAt = S.serverStamp || S.loadedAt;
      }
      const n = added.length + S.pending.filter((s) => s.grade !== "LOW").length;
      if (n && !opts.apply) { const b = $("#newbanner"); b.innerHTML = `<span class="dot"></span>${plural(n, "new story", "new stories")}: show`; b.hidden = false; }
      else applyPending(false);
      return n;
    } catch (e) { return null; } // offline: try again next tick
  }

  // ─────────────────────────── refresh button ───────────────────────────
  let toastTimer;
  function toast(html, kind = "") {
    const el = $("#toast");
    el.className = `toast ${kind}`; el.innerHTML = html; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 9000);
  }
  function setBusy(btn, busy, label) {
    btn.disabled = busy; btn.classList.toggle("busy", busy);
    btn.querySelector(".txt").textContent = busy ? label : "Refresh";
  }
  // GitHub runs scheduled workflows on a best-effort basis: they can start late or be skipped.
  // Past the interval plus a grace period, say so instead of promising the next build.
  const LATE_GRACE_MIN = 15;
  function buildLate() {
    const every = S.meta.refresh_min || 60;
    const built = new Date(S.meta.built_at).getTime();
    return !!built && Date.now() - built > (every + LATE_GRACE_MIN) * 60000;
  }
  function nextBuild() {
    const every = S.meta.refresh_min || 60;
    const next = new Date(new Date(S.meta.built_at).getTime() + every * 60000).toISOString();
    return until(next) === "any moment" ? "the next one is due any minute" : `next one ${until(next)}`;
  }
  // Static site: the data is rebuilt on a schedule by GitHub Actions, so Refresh checks for a newer
  // build and loads it. Server: Refresh fetches every source right now.
  async function refreshNow(btn) {
    if (STATIC) {
      setBusy(btn, true, "Checking…");
      const before = S.lastRunSeen;
      const n = await poll({ apply: true });
      setBusy(btn, false);
      if (n === null) return toast("<b>Couldn't reach the site.</b> Check your connection and try again.", "warn");
      if (S.lastRunSeen !== before) return toast(`<b>Updated.</b> ${n ? plural(n, "new story", "new stories") + " added to this view" : "Latest data loaded"} · built ${ago(S.meta.built_at)}.`, "ok");
      if (buildLate()) return toast(`<b>No newer data yet.</b> Last update ${ago(S.meta.built_at)}. The rebuild due every ${S.meta.refresh_min || 60} min is running late (GitHub starts scheduled runs on a best-effort basis); try again in a few minutes.`, "warn");
      return toast(`<b>You're up to date.</b> Last update ${ago(S.meta.built_at)}; the site rebuilds about every ${S.meta.refresh_min || 60} min (${nextBuild()}).`);
    }
    setBusy(btn, true, "Fetching…");
    try { await api.refresh(); S.meta.running = true; renderLive(); } catch (err) {
      setBusy(btn, false); return toast("<b>Couldn't reach the server.</b> Is it still running?", "warn");
    }
    toast("<b>Fetching every source now.</b> This takes 1–3 minutes; keep reading, new stories appear when it's done.");
    const wait = setInterval(async () => {
      await poll();
      if (S.meta.running) return;
      clearInterval(wait); setBusy(btn, false); applyPending(false);
      const r = S.meta.last_run || {};
      toast(`<b>Done.</b> ${r.n_ok ?? "?"} of ${r.n_sources ?? "?"} sources fetched · ${plural(r.n_new_stories || 0, "new story", "new stories")}.`, "ok");
    }, 4000);
  }
  function applyPending(scroll = true) {
    if (S.pendingBrief) {
      const before = new Set(S.brief ? S.brief.stories.map((s) => s.id) : []);
      S.brief = S.pendingBrief; S.pendingBrief = null;
      S.briefById = new Map(S.brief.stories.map((s) => [s.id, s]));
      setGlossary();
      if (before.size) for (const s of S.brief.stories) if (!before.has(s.id)) S.freshIds.add(s.id);
    }
    for (const s of S.pending) { S.stories.push(s); S.freshIds.add(s.id); }
    S.pending = []; $("#newbanner").hidden = true; renderAll();
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ─────────────────────────── practice (the shared widget in intel-core.js) ───────────────────────────
  const PX = { el: null, w: null };
  const practiceDays = () => (STATIC ? (S.meta.practice_days || []) : (S.meta.day_files || briefDays())).slice().sort().reverse();
  function practiceDay() {  // the open day, or the newest day with questions before it
    const want = S.view === "day" ? S.anchor : periodRange(S.view, S.anchor)[1];
    const have = practiceDays();
    return !STATIC || have.includes(want) ? want : (have.find((d) => d <= want) || have[0] || want);
  }
  const pxHost = {
    day: practiceDay,
    days: practiceDays,
    load: (d) => api.json(STATIC ? `data/practice/${d}.json?v=${encodeURIComponent(S.meta.built_at || "")}` : `api/practice/${d}`),
    label: (d) => `${dayShort(d)}${d === todayIST() ? " (today)" : ""}`,
    subject: (k) => (S.meta.labels.subjects || {})[k] || k,
    claude: (prompt) => CORE.openClaude(prompt),
    cardDays: () => (STATIC ? (S.meta.cards_days || []) : practiceDays()).slice().sort().reverse(),
    loadCards: (d) => api.json(STATIC ? `data/cards/${d}.json?v=${encodeURIComponent(S.meta.built_at || "")}` : `api/cards/${d}`),
    loadDay: (d) => api.json(STATIC ? `data/day/${d}.json?v=${encodeURIComponent(S.meta.built_at || "")}` : `api/brief?${new URLSearchParams({ from: d, to: d })}`),
  };
  function renderPractice() {
    const el = $("#content");
    if (PX.el && el.contains(PX.el)) { PX.w.setDay(practiceDay()); return; }  // keep a set in progress across refreshes
    el.innerHTML = '<div id="pxRoot"></div>';
    PX.el = $("#pxRoot"); PX.w = CORE.mountPractice(PX.el, pxHost);
  }

  // India's Ranks (data/rankings.json): India in global indices, kept as the news reports each new edition
  const RK = { el: null, data: null };
  // Trackers: running stories, the places map and India's ranks, one tab with three views
  const TRK = [["dossiers", "Dossiers"], ["map", "Map"], ["ranks", "India's Ranks"]];
  function renderTrackers() {
    const el = $("#content"); let body = $("#trkBody");
    if (!body || !el.contains(body) || body.dataset.trk !== S.trk) {
      el.innerHTML = `<div class="trk-seg" role="tablist" aria-label="Trackers">${TRK.map(([k, l]) => `<button type="button" role="tab" data-trk="${k}" aria-selected="${S.trk === k}">${l}</button>`).join("")}</div><div id="trkBody" data-trk="${S.trk}"></div>`;
      body = $("#trkBody");
    }
    return S.trk === "map" ? renderMap(body) : S.trk === "ranks" ? renderRanks(body) : renderDossiers(body);
  }
  function renderRanks(el) {
    if (RK.el && el.contains(RK.el)) return;
    el.innerHTML = '<div id="rkRoot" class="rk-root"></div>';
    RK.el = $("#rkRoot");
    CORE.mountRanks(RK.el, { ask: askIntel, load: () => RK.data || (RK.data = api.json(STATIC ? `data/rankings.json?v=${encodeURIComponent(S.meta.built_at || "")}` : "api/rankings").catch((e) => { RK.data = null; throw e; })) });
  }

  // Dossiers (data/dossiers.json): running stories with their timeline and story so far; Map (data/places.json):
  // the places of the last month's cards. A report opens in its day's brief.
  const dataUrl = (file, route) => (STATIC ? `data/${file}?v=${encodeURIComponent(S.meta.built_at || "")}` : route);
  async function openInBrief(id, day) {
    S.openCards.add(id);
    await go({ view: "day", anchor: day || S.anchor, tab: "brief" });
    const c = $(`.bcard[data-id="${id}"]`); if (c) c.scrollIntoView({ block: "center" });
  }
  const DS = { el: null, w: null, data: null, key: null };
  function renderDossiers(el) {
    if (DS.el && el.contains(DS.el)) { if (DS.key !== DS.w.key) DS.w.show(DS.key); return; }
    el.innerHTML = '<div id="dsRoot" class="ds-root"></div>';
    DS.el = $("#dsRoot");
    DS.w = CORE.mountDossiers(DS.el, { key: DS.key, open: openInBrief, ask: askIntel, onShow: (k) => { DS.key = k; },
      load: () => DS.data || (DS.data = api.json(dataUrl("dossiers.json", "api/dossiers")).catch((e) => { DS.data = null; throw e; })) });
  }
  const MP = { el: null, data: null };
  function renderMap(el) {
    if (MP.el && el.contains(MP.el)) return;
    el.innerHTML = '<div id="mpRoot" class="mp-root"></div>';
    MP.el = $("#mpRoot");
    CORE.mountMap(MP.el, { base: "static/", open: openInBrief,
      load: () => MP.data || (MP.data = api.json(dataUrl("places.json", "api/places")).catch((e) => { MP.data = null; throw e; })) });
  }

  // ─────────────────────────── export ───────────────────────────
  // The Daily Brief PDF is built with the site (export_pdf.py): the menu links the day's file (a week or month
  // lists its days'); "My notes" is the Markdown export, the one that carries your notes and stars.
  const pdfHref = (d) => (STATIC ? `data/pdf/brief-${d}.pdf?v=${encodeURIComponent(S.meta.built_at || "")}` : `api/pdf/${d}`);
  const hasPdf = (d) => !STATIC || (S.meta.pdf_days || []).includes(d);
  function toggleExportMenu(btn) {
    const m = $("#exportMenu");
    if (!m.hidden) { m.hidden = true; return; }
    const [from, to] = periodRange(S.view, S.anchor);
    const days = []; for (let d = to; d >= from; d = addDays(d, -1)) if (d <= todayIST()) days.push(d);
    const pdfs = days.filter(hasPdf);
    const item = (d) => `<a class="exm-item" href="${esc(pdfHref(d))}" download="upsc-daily-brief-${d}.pdf" data-exp="pdf">${ICON.dl}<span><b>Daily Brief PDF</b><small>${esc(dayShort(d))}${d === todayIST() ? " · today, so far" : ""} · must-know notes, Prelims facts, editorials' arguments, source links</small></span></a>`;
    m.innerHTML = `${S.view === "day" ? (pdfs.length ? item(pdfs[0]) : `<div class="exm-none">No PDF for ${esc(dayShort(S.anchor))} yet: it is built with the day's brief.</div>`)
      : pdfs.length ? `<div class="exm-h">PDF of each day in this ${S.view}</div><div class="exm-days">${pdfs.map((d) => `<a href="${esc(pdfHref(d))}" download="upsc-daily-brief-${d}.pdf" data-exp="pdf">${esc(dayShort(d))}</a>`).join("")}</div>`
      : `<div class="exm-none">No PDFs for this ${S.view} yet.</div>`}
      <button class="exm-item exm-md" data-exp="md"><span><b>My notes (.md)</b><small>this view as Markdown, with your notes and stars</small></span></button>`;
    const r = btn.getBoundingClientRect();
    m.style.top = `${Math.round(r.bottom + 6)}px`;
    m.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    m.hidden = false;
  }
  function exportMarkdown() {
    const labels = S.meta.labels.subjects;
    let md = `# UPSC Intel · ${periodLabel(S.view, S.anchor)}\n\n_exported ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST_\n`;
    const block = (s) => {
      const e = s.explain || {};
      let out = `\n### ${e.headline || s.title}\n\`${gradeName(s.grade)}\` ${s.gs.join(" ")}${s.tags.length ? " · " + s.tags.join(", ") : ""}${S.view !== "day" && s._day ? " · " + s._day : ""}\n\n`;
      if (e.why_in_news) out += `- **Why in news:** ${e.why_in_news}\n`;
      if (e.what) out += `- **What happened:** ${e.what}\n`;
      if (e.when) out += `- **When:** ${e.when}\n`;
      if (e.where) out += `- **Where:** ${e.where}\n`;
      if (e.who) out += `- **Who:** ${e.who}\n`;
      if (e.background) out += `- **Background:** ${e.background}\n`;
      (e.significance || []).forEach((x) => { out += `- **Why it matters:** ${x}\n`; });
      (e.prelims || []).forEach((x) => { out += `- **Prelims:** ${x}\n`; });
      if (e.mains) out += `- **Mains:** ${e.mains}\n`;
      if (mark(s).note) out += `- **My note:** ${mark(s).note.replace(/\n/g, " ")}\n`;
      if (s.video && s.video.id) out += `- **Video:** [${s.video.title}](${s.video.url})\n`;
      const src = (s.sources || []).filter((x) => /^https?:/.test(x.u || "")).slice(0, 3).map((x) => `[${x.p}](${x.u})`).join(" · ");
      if (src) out += `- ${src}\n`;
      return out;
    };
    if (BRIEF_TABS.has(S.tab) && S.brief) {
      const news = briefList("news").filter(briefPasses);
      const groups = new Map();
      for (const s of news) { const k = labels[s.subjects[0]] || "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
      for (const [k, arr] of groups) md += `\n## ${k}\n` + arr.map(block).join("");
      const facts = briefList("prelims").filter(briefPasses);
      if (facts.length) md += `\n## Quick read · Prelims facts\n` + facts.map(block).join("");
      const eds = briefList("editorials").filter(briefPasses);
      if (eds.length) md += `\n## Editorials\n` + eds.map(block).join("");
      const exps = briefList("explained").filter(briefPasses);
      if (exps.length) md += `\n## Explained\n` + exps.map(block).join("");
    } else {
      for (const s of sortStories(briefingPool().filter((x) => passes(x)))) md += `\n- **${s.title}** \`${gradeName(s.grade)}\` ${s.gs.join(" ")} · [${(s.sources[0] || {}).p || "source"}](${s.url})`;
    }
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `upsc-${S.view}-${periodRange(S.view, S.anchor)[0]}-${S.tab}.md`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ─────────────────────────── events ───────────────────────────
  function toggleSet(set, v) { set.has(v) ? set.delete(v) : set.add(v); }
  function closeDrawer() { $("#side").classList.remove("open"); $("#scrim").hidden = true; }
  const VIRTUAL = new Map();  // a dossier or an index, as a story the Ask Intel bot reads (CORE.dossierStory, rankStory)
  const askIntel = (s) => { VIRTUAL.set(s.id, s); botOpen(s.id); };
  const findStory = (id) => VIRTUAL.get(id) || S.briefById.get(id) || S.stories.find((s) => s.id === id) || (S.search && S.search.stories.find((s) => s.id === id)) || (S.library || []).find((s) => s.id === id);
  function refreshProgress() {
    const prog = $(".bhero .progress"); if (!prog) return;
    const list = (KIND_TAB[S.tab] ? briefList(S.tab) : briefList("news").concat(briefList("prelims"), briefList("editorials"), briefList("explained"))).filter(briefPasses);
    prog.outerHTML = progress(list);
  }
  function rerenderCard(el) {
    const s = findStory(el.dataset.id); if (!s) return;
    if (el.classList.contains("bcard")) {
      el.outerHTML = bcard(s, { compact: el.classList.contains("compact"), rank: el.dataset.rank ? Number(el.dataset.rank) : null, day: el.dataset.day || null, showSubject: !!el.dataset.subj, inGrade: !!el.dataset.ing });
      refreshProgress();
    } else if (el.classList.contains("mrow")) el.outerHTML = mrow(s);
    else el.outerHTML = card(s);
  }
  function onFilterClick(t) {
    const f = t.dataset.f; const v = t.dataset.v;
    if (f === "gs") toggleSet(S.f.gs, v);
    else if (f === "grade") { toggleSet(S.f.grades, v); if (!S.f.grades.size) S.f.grades.add(v); }
    else if (f === "subject") toggleSet(S.f.subjects, v);
    else if (f === "tier") toggleSet(S.f.tiers, v);
    else if (f === "watch") S.f.watch = S.f.watch === v ? null : v;
    else if (f === "clear") { S.f.gs.clear(); S.f.subjects.clear(); S.f.tiers.clear(); S.f.grades = new Set(GRADES); S.f.watch = null; S.f.starred = false; S.f.unread = false; if (S.f.low) { S.f.low = false; S.loadedKey = ""; return go(); } }
    else return;
    S.expanded.clear(); renderAll();
  }
  async function switchTab(tab) {
    S.tab = tab; S.search = null; S.expanded.clear(); syncHash();
    if (tab === "everything") { $("#content").innerHTML = '<div class="loading">Loading everything…</div>'; await loadStories(); }
    renderAll(); window.scrollTo({ top: 0 });
  }

  // ─────────────────────────── calendar (date picker) ───────────────────────────
  // Days with news get a dot. Month and year menus jump anywhere in the archive at once.
  const cal = { month: null };
  const pad2 = (n) => String(n).padStart(2, "0");
  const hasNews = (d) => (S.meta.date_counts[d] || 0) > 0 || !!(S.meta.brief_days && S.meta.brief_days[d]);
  function calBounds() {
    const known = Object.keys(S.meta.date_counts || {}).concat(Object.keys(S.meta.brief_days || {}), (S.meta.months || []).map((m) => m + "-01"));
    const first = known.length ? known.reduce((a, b) => (a < b ? a : b)) : todayIST();
    return [first.slice(0, 7), todayIST().slice(0, 7)];
  }
  function calShift(ym, n) { const d = D(ym + "-01"); d.setUTCMonth(d.getUTCMonth() + n); return iso(d).slice(0, 7); }
  function renderCalendar() {
    const el = $("#calendar");
    const [minM, maxM] = calBounds();
    cal.month = cal.month < minM ? minM : cal.month > maxM ? maxM : cal.month;
    const [y, m] = cal.month.split("-").map(Number);
    const first = D(`${cal.month}-01`);
    const lead = (first.getUTCDay() + 6) % 7;  // weeks start on Monday
    const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const today = todayIST();
    const [from, to] = periodRange(S.view, S.anchor);
    const years = [];
    for (let yy = +minM.slice(0, 4); yy <= +maxM.slice(0, 4); yy++) years.push(yy);
    let days = "";
    for (let i = 1; i <= nDays; i++) {
      const d = `${cal.month}-${pad2(i)}`;
      const cls = [hasNews(d) ? "has" : "", d === today ? "today" : "", d >= from && d <= to ? (S.view === "day" ? "sel" : "inrange") : ""].join(" ").trim();
      const dd = D(d);
      days += `<button type="button" data-day="${d}" class="${cls}" ${d > today ? "disabled" : ""} aria-label="${WD_LONG[dd.getUTCDay()]} ${i} ${MONTHS_LONG[m - 1]} ${y}${hasNews(d) ? ", has news" : ""}"${d >= from && d <= to ? ' aria-current="date"' : ""}>${i}</button>`;
    }
    el.innerHTML = `<div class="cal-head">
        <button type="button" class="iconbtn" data-cal="prev" aria-label="Previous month" ${cal.month <= minM ? "disabled" : ""}>‹</button>
        <select data-cal="month" aria-label="Month">${MONTHS_LONG.map((n, i) => { const v = `${y}-${pad2(i + 1)}`; return `<option value="${i + 1}" ${i + 1 === m ? "selected" : ""} ${v > maxM || v < minM ? "disabled" : ""}>${n}</option>`; }).join("")}</select>
        <select data-cal="year" aria-label="Year">${years.map((yy) => `<option value="${yy}" ${yy === y ? "selected" : ""}>${yy}</option>`).join("")}</select>
        <button type="button" class="iconbtn" data-cal="next" aria-label="Next month" ${cal.month >= maxM ? "disabled" : ""}>›</button>
      </div>
      <div class="cal-grid">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((w) => `<span class="wd" aria-hidden="true">${w}</span>`).join("")}${"<span></span>".repeat(lead)}${days}</div>
      <div class="cal-foot"><span><i></i>has news</span><button type="button" class="linkbtn" data-cal="today">Today</button></div>`;
  }
  function placeCalendar() {
    const el = $("#calendar");
    el.style.transform = "translateX(-50%)";
    const r = el.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    const shift = r.left < 16 ? 16 - r.left : r.right > vw - 16 ? vw - 16 - r.right : 0;
    if (shift) el.style.transform = `translateX(calc(-50% + ${Math.round(shift)}px))`;
  }
  function openCalendar() {
    cal.month = S.anchor.slice(0, 7);
    renderCalendar();
    $("#calendar").hidden = false; $("#periodLabel").setAttribute("aria-expanded", "true");
    placeCalendar();
    const focus = $("#calendar [aria-current]") || $("#calendar .today") || $("#calendar [data-day]:not([disabled])");
    if (focus) focus.focus();
  }
  function closeCalendar(refocus = false) {
    if ($("#calendar").hidden) return;
    $("#calendar").hidden = true; $("#periodLabel").setAttribute("aria-expanded", "false");
    if (refocus) $("#periodLabel").focus();
  }
  function calFocusDay(d) {
    const today = todayIST();
    if (d > today) return;
    if (d.slice(0, 7) !== cal.month) {
      const [minM] = calBounds();
      if (d.slice(0, 7) < minM) return;
      cal.month = d.slice(0, 7); renderCalendar();
    }
    const b = $(`#calendar [data-day="${d}"]`);
    if (b) b.focus();
  }
  document.addEventListener("click", (e) => {  // a click anywhere else closes the calendar and the export menu
    if (!$("#calendar").hidden && !e.target.closest(".datepick")) closeCalendar();
    if (!$("#exportMenu").hidden && !e.target.closest("#exportMenu, #exportBtn")) $("#exportMenu").hidden = true;
  }, true);
  document.addEventListener("change", (e) => {
    const sel = e.target.closest && e.target.closest("#calendar select");
    if (!sel) return;
    const [y, m] = cal.month.split("-");
    cal.month = sel.dataset.cal === "year" ? `${sel.value}-${m}` : `${y}-${pad2(+sel.value)}`;
    renderCalendar();
  });

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a, rect.hit");
    if (!t) return;
    if (t.matches("[data-view]")) return go({ view: t.dataset.view });
    if (t.id === "prev") return go({ anchor: stepAnchor(S.view, S.anchor, -1) });
    if (t.id === "next") return go({ anchor: stepAnchor(S.view, S.anchor, 1) });
    if (t.id === "todayBtn") return go({ view: "day", anchor: todayIST() });
    if (t.id === "periodLabel") return $("#calendar").hidden ? openCalendar() : closeCalendar();
    if (t.dataset.cal === "prev" || t.dataset.cal === "next") { cal.month = calShift(cal.month, t.dataset.cal === "prev" ? -1 : 1); renderCalendar(); return; }
    if (t.dataset.cal === "today") { closeCalendar(); return go({ view: "day", anchor: todayIST() }); }
    if (t.dataset.day) { closeCalendar(); return go({ anchor: t.dataset.day }); }
    if (t.matches("[data-yesterday]")) return go({ view: "day", anchor: addDays(todayIST(), -1) });
    if (t.id === "themeBtn") {
      const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
      const next = dark ? "light" : "dark"; document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("upsc-theme", next); } catch (err) { /* ignore */ }
      return;
    }
    if (t.id === "exportBtn") return toggleExportMenu(t);
    if (t.dataset.exp) { $("#exportMenu").hidden = true; if (t.dataset.exp === "md") exportMarkdown(); return; }
    if (t.id === "newbanner") return applyPending();
    if (t.id === "filtersBtn") { $("#side").classList.add("open"); $("#scrim").hidden = false; return; }
    if (t.id === "refreshBtn") return refreshNow(t);
    if (t.matches("rect.hit[data-day]")) return go({ view: "day", anchor: t.dataset.day });
    if (t.dataset.tab) return switchTab(t.dataset.tab);
    if (t.dataset.tabGo) return switchTab(t.dataset.tabGo);
    if (t.dataset.jump) { const target = document.getElementById(t.dataset.jump); if (target) target.scrollIntoView({ behavior: "smooth", block: "start" }); closeDrawer(); return; }
    if (t.dataset.dsOpen) { DS.key = t.dataset.dsOpen; S.trk = "dossiers"; return switchTab("trackers"); }  // a card's running story
    if (t.dataset.trk) { S.trk = t.dataset.trk; return renderTrackers(); }
    if (t.dataset.openCard) {
      S.openCards.add(t.dataset.openCard); await switchTab("brief");
      const c = $(`.bcard[data-id="${t.dataset.openCard}"]`); if (c) c.scrollIntoView({ block: "center" });
      return;
    }
    if (t.dataset.bot) { onBotClick(t); return; }
    if (t.dataset.f) { onFilterClick(t); return; }
    if (t.dataset.expand) { S.expanded.add(t.dataset.expand); return renderAll(); }
    if (t.dataset.act === "clearsearch") { S.search = null; $("#q").value = ""; S.f.q = ""; return renderAll(); }
    if (t.dataset.open) {
      const id = t.dataset.open;
      if (!mark({ id }).read && !t.closest(".bcard")) { api.setMark(id, { read: true }); const c = t.closest(".card"); if (c) c.classList.add("read"); }
      return; // let the link open
    }
    const cardEl = t.closest(".card, .bcard, .mrow"); if (!cardEl) return;
    const id = cardEl.dataset.id;
    if (t.dataset.act === "toggle" || t.dataset.act === "expand") {
      toggleSet(S.openCards, id); rerenderCard(cardEl);
      if (S.openCards.has(id)) { const s = findStory(id); if (s) startSummary(s); }
    }
    else if (t.dataset.act === "star") { await api.setMark(id, { starred: !mark({ id }).starred }); renderTabs(); rerenderCard(cardEl); }
    else if (t.dataset.act === "read") { await api.setMark(id, { read: !mark({ id }).read }); rerenderCard(cardEl); }
    else if (t.dataset.act === "ask") botOpen(id);
    else if (t.dataset.act === "askq") botOpen(id, t.dataset.q);
    else if (t.dataset.act === "askclaude") { botOpen(id); askClaude(""); }
    else if (t.dataset.act === "note") {
      toggleSet(S.noteOpen, id); S.openCards.add(id); rerenderCard(cardEl);
      const ta = $(`[data-id="${id}"] textarea`); if (ta) ta.focus();
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.f === "low") { S.f.low = t.checked; S.loadedKey = ""; return go(); }
    if (t.dataset.f === "starred") { S.f.starred = t.checked; return renderAll(); }
    if (t.dataset.f === "unread") { S.f.unread = t.checked; return renderAll(); }
    if (t.dataset.ctl === "group") { S.groupBy = t.value; store.set("upsc-groupby", S.groupBy); S.expanded.clear(); return renderAll(); }
    if (t.dataset.ctl === "sort") { S.sort = t.value; store.set("upsc-sort", S.sort); return renderAll(); }
  });
  document.addEventListener("input", debounce((e) => {
    const t = e.target;
    if (t.id === "q") { S.f.q = t.value.trim(); if (!S.f.q) S.search = null; renderAll(); }
    if (t.dataset.act === "notetext") { const id = t.closest("[data-id]").dataset.id; api.setMark(id, { note: t.value }); }
  }, 250));
  $("#q").addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && e.target.value.trim().length >= 2) {
      const q = e.target.value.trim();
      $("#content").innerHTML = '<div class="loading">Searching the whole archive…</div>';
      try { S.search = { q, stories: await api.search(q) }; } catch (err) { S.search = { q, stories: [] }; }
      S.f.q = ""; renderAll();
    }
    if (e.key === "Escape") { e.target.value = ""; S.f.q = ""; S.search = null; renderAll(); e.target.blur(); }
  });
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#bot") && !$("#bot").hidden) { e.preventDefault(); botClose(); return; }
    if (!$("#calendar").hidden) {
      if (e.key === "Escape") { e.preventDefault(); closeCalendar(true); return; }
      const day = e.target.dataset && e.target.dataset.day;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (day && step) { e.preventDefault(); calFocusDay(addDays(day, step)); }
      if (e.target.closest && e.target.closest("#calendar")) return;
    }
    if (e.key === "Escape") closeDrawer();
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
    else if (e.key === "t") go({ view: "day", anchor: todayIST() });
    else if (e.key === "[" || e.key === "ArrowLeft") go({ anchor: stepAnchor(S.view, S.anchor, -1) });
    else if ((e.key === "]" || e.key === "ArrowRight") && !$("#next").disabled) go({ anchor: stepAnchor(S.view, S.anchor, 1) });
    else if (e.key === "d" || e.key === "w" || e.key === "m") go({ view: { d: "day", w: "week", m: "month" }[e.key] });
  });
  const tip = $("#tooltip");
  document.addEventListener("mousemove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip; tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8)}px`; tip.style.top = `${e.clientY + 14}px`;
  });
  window.addEventListener("hashchange", () => { readHash(); go(); });

  // ─────────────────────────── Ask bot ───────────────────────────
  // The bot's brain is shared with the app (static/intel-core.js). It answers from what the brief holds,
  // reads the full article from a free-to-read site (finding one through a news search when the original is
  // paywalled), and looks up background on Wikipedia. No key and no server. "Ask Claude" opens Claude with
  // the story and the question on the viewer's own Claude plan.
  const LOGO = '<svg class="bot-logo" viewBox="0 0 48 48" width="28" height="28" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#1c5cab"/><path d="M15 17v9a9 9 0 0 0 18 0v-9" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="33" cy="8.5" r="3.6" fill="#fab219"/></svg>';
  const BOT = { id: null, log: [], busy: false, step: "", last: "", partial: "" };
  CORE.listen.provider(() => CORE.listenItems(briefList("news"), briefList("prelims")));  // 🎧 Listen: the open day's cards
  const bot = CORE.makeBot({
    labels: () => S.meta && S.meta.labels,
    folded: (id) => foldedOf(id),
    pool: () => (S.brief ? S.brief.stories : []).concat(S.stories || []),
    day: () => (S.brief ? { label: periodLabel(S.view, S.anchor), cards: briefList("news"), prelims: briefList("prelims"), more: briefList("more"), editorials: briefList("editorials"), explained: briefList("explained") } : null),
    videos: (s) => storyVideos(s),
    dayShort: (d) => dayShort(d),
  });
  function botEnsure() {
    if ($("#bot")) return;
    document.body.insertAdjacentHTML("beforeend", `
      <button id="botFab" class="bot-fab" data-bot="open" aria-label="Ask Intel" title="Ask about a story or the day"><span class="adot"></span><span>Ask Intel</span></button>
      <section id="bot" class="bot" hidden role="dialog" aria-labelledby="botTitle">
        <header class="bot-h">${LOGO}<div class="bot-t"><b id="botTitle">Ask Intel</b><small id="botCtx"></small></div>
          <button class="bot-x" data-bot="day" title="Ask about the whole day instead">Whole day</button>
          <button class="bot-x" data-bot="close" aria-label="Close">✕</button></header>
        <div id="botLog" class="bot-log" aria-live="polite"></div>
        <div id="botChips" class="bot-chips"></div>
        <form id="botForm" class="bot-in"><input id="botQ" autocomplete="off" aria-label="Your question"><button type="submit">Ask</button></form>
        <p class="bot-foot">Answers quote the reports, the free full article (read via Jina Reader; paywalled sites are never opened) and Wikipedia. Switch on <b>✦ Intel AI</b> (a free Google key, kept only in this browser) and Intel answers in its own words from the article; check key facts before quoting.</p>
      </section>`);
    $("#botForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#botQ").value.trim(); if (q) { $("#botQ").value = ""; botAsk(q); } });
    CORE.gemini.bind((r) => {  // switched on or off: the confirmation takes the key form's place (an error goes under it)
      const i = BOT.log.map((m) => /gem-box/.test(m.html)).lastIndexOf(true);
      if (r.ok && i >= 0) BOT.log[i] = { who: "from-bot", html: r.html }; else BOT.log.push({ who: "from-bot", html: r.html });
      botRender();
    });
  }
  function botRender() {
    const s = BOT.id ? findStory(BOT.id) : null;
    $("#botCtx").textContent = s ? s.title : `The ${S.view === "day" ? "day's" : S.view + "'s"} brief · ${periodLabel(S.view, S.anchor)}`;
    $("#botQ").placeholder = s ? "Ask about this story…" : "Ask about the day, e.g. “GS2” or “RBI”…";
    $("#bot").querySelector('[data-bot="day"]').hidden = !s;
    $("#botChips").innerHTML = bot.chips(s).map((c) => `<button class="chip${/claude/i.test(c) ? " chip-claude" : /intel ai/i.test(c) ? ` chip-gem${CORE.gemini.on() ? " on" : ""}` : ""}" data-bot="chip" data-q="${esc(c)}">${esc(c)}</button>`).join("");
    $("#botLog").innerHTML = BOT.log.map((m) => `<div class="bot-msg ${m.who}">${m.html}</div>`).join("")
      + (BOT.busy ? (BOT.partial ? `<div class="bot-msg from-bot">${BOT.partial}</div>`
        : `<div class="bot-msg from-bot typing" aria-label="Working">${BOT.step ? `<span class="bot-step">${esc(BOT.step)}</span>` : "…"}</div>`) : "");
    $("#botLog").scrollTop = $("#botLog").scrollHeight;
  }
  async function botOpen(id, first) {  // a story: its summary comes first, without asking
    botEnsure();
    const s = id ? findStory(id) : null;
    const next = s ? s.id : null;
    const fresh = next !== BOT.id || !BOT.log.length;
    if (fresh) { BOT.id = next; BOT.log = []; if (!s) BOT.log.push({ who: "from-bot", html: bot.welcome(null) }); }
    $("#bot").hidden = false; $("#botFab").hidden = true;
    botRender(); $("#botQ").focus();
    if (fresh && s) await botAsk("Summary", { auto: true });
    if (first) botAsk(first);
  }
  function botClose() { $("#bot").hidden = true; $("#botFab").hidden = false; $("#botFab").focus(); }
  function askClaude(q) {  // must run inside the click: a new tab opened after an await is blocked as a pop-up
    const s = BOT.id ? findStory(BOT.id) : null;
    const opened = CORE.openClaude(bot.claudeFor(s, q || BOT.last));
    BOT.log.push({ who: "from-bot", html: `<p>${opened ? `Opened Claude in a new tab with this ${s ? "story" : "day's brief"} and your question.` : "Your browser blocked the new tab: open <a href=\"https://claude.ai/new\" target=\"_blank\" rel=\"noopener\">claude.ai</a>."} The prompt is also copied: if Claude opens empty, paste it.</p><p class="bot-src">Claude answers on your own Claude account (the free plan works); nothing is sent from this site.</p>` });
    botRender();
  }
  async function botAsk(q, opts = {}) {
    if (!opts.url && bot.intentOf(q) === "claude") { BOT.log.push({ who: "from-me", html: `<p>${esc(q)}</p>` }); return askClaude(""); }
    const s = BOT.id ? findStory(BOT.id) : null;
    if (!opts.auto) BOT.log.push({ who: "from-me", html: `<p>${esc(opts.label || q)}</p>` });
    BOT.busy = true; BOT.step = ""; BOT.partial = ""; botRender();
    if (!opts.url) BOT.last = q;
    const onStep = (m) => { BOT.step = m; botRender(); };
    const onPartial = (h) => { BOT.partial = h; botRender(); };  // Intel AI's answer as it types
    let html;
    try { html = opts.url ? await bot.read(opts.url, onStep) : await bot.answer(s, q, { onStep, onPartial, deep: opts.deep }); }
    catch (e) { html = `<p>Something went wrong: ${esc(e.message)}</p>`; }
    BOT.busy = false; BOT.step = ""; BOT.partial = ""; BOT.log.push({ who: "from-bot", html }); BOT.log = BOT.log.slice(-40); botRender();
  }
  function onBotClick(t) {
    const a = t.dataset.bot;
    if (a === "open") botOpen(BOT.id);
    else if (a === "close") botClose();
    else if (a === "day") botOpen(null);
    else if (a === "chip") botAsk(t.dataset.q);
    else if (a === "story") botOpen(t.dataset.id);
    else if (a === "wiki") botAsk(`What is ${t.dataset.term}?`);
    else if (a === "deeper") botAsk(t.dataset.q, { deep: true, label: "Look in the full article" });
    else if (a === "read") botAsk("", { url: t.dataset.url, label: `Summarise ${CORE.web.domainOf(t.dataset.url)}` });
    else if (a === "claude") { BOT.log.push({ who: "from-me", html: "<p>Ask Claude ↗</p>" }); askClaude(t.dataset.q); }
  }

  // ─────────────────────────── boot ───────────────────────────
  async function boot() {
    readHash();
    S.view = "day"; S.anchor = todayIST();  // opening the site always lands on today (IST); the tab is kept
    if (STATIC) $("#refreshBtn").title = "Check for the latest update";
    if (SNAPSHOT) { $("#refreshBtn").hidden = true; $("#exportBtn").hidden = true; }
    botEnsure();
    try { [S.meta, S.marks] = await Promise.all([api.meta(), api.marks()]); }
    catch (e) { $("#content").innerHTML = `<div class="empty">Could not reach the data (${esc(e.message)}). Is the server running?</div>`; return; }
    S.lastRunSeen = STATIC ? S.meta.built_at : (S.meta.last_run && S.meta.last_run.finished_at) || "none";
    await go();
    if (!SNAPSHOT) setInterval(poll, POLL_MS);
    setInterval(renderLive, 30000);
  }
  boot();
})();

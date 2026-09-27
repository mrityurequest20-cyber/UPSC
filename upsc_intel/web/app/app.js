/* UPSC Intel app: the Claude Design "UPSC Intel App", built on the site's live data. Vanilla JS, no build step.
   Tabs: Brief · Read (editorials, explainers) · Insights · Review · Saved; a story view; sheets for the calendar,
   PDF export, search and Ask Intel (the shared bot in ../static/intel-core.js).
   Works from the static site (../data/*.json) or the local server (../api/*). Marks (done, starred, notes) are
   the dashboard's: the same localStorage key on the site, the same /api/marks on the server. */
(() => {
  "use strict";

  const STATIC = !!window.UPSC_STATIC;
  const CORE = window.UPSCCore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = CORE.esc;
  const safeUrl = CORE.safeUrl;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode or full */ } },
  };

  // ─────────────────────────── dates (IST) ───────────────────────────
  const IST_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const todayIST = () => IST_FMT.format(new Date());
  const D = (s) => new Date(s + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WDS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WDL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const WD1 = ["M", "T", "W", "T", "F", "S", "S"];
  const dow = (s) => (D(s).getUTCDay() + 6) % 7;  // Monday = 0
  const weekStart = (s) => addDays(s, -dow(s));
  const dayLabel = (s) => { const d = D(s); return `${WDL[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const dayShort = (s) => { if (!s) return ""; const d = D(s); return `${WDS[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const dayFull = (s) => { const d = D(s); return `${WDL[d.getUTCDay()]}, ${d.getUTCDate()} ${MONL[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const monthLabel = (s) => { const d = D(s.length === 7 ? s + "-01" : s); return `${MONL[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const clockIST = (x) => (x ? new Date(x).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }) : "");
  const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000);
  function ago(x) {
    if (!x) return "never";
    const s = Math.max(0, (Date.now() - new Date(x).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  const fmtMins = (m) => (m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim());
  const monthsIn = (from, to) => { const out = []; for (let d = from.slice(0, 7) + "-01"; d <= to; d = iso(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)))) out.push(d.slice(0, 7)); return out; };
  const plural = (n, one, many) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : (many || one + "s")}`;

  // ─────────────────────────── icons (from the design) ───────────────────────────
  const LOGO = (size = 32) => `<svg class="logo" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#1c5cab"/><path d="M15 17v9a9 9 0 0 0 18 0v-9" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="33" cy="8.5" r="3.6" fill="#fab219"/></svg>`;
  const I = {
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m15 6-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
    dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6m0 0-2.5-2.5M12 17l2.5-2.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/></svg>',
  };
  const TABS = [
    { key: "brief", label: "Brief", title: "UPSC Intel", d: "M6 3h9l4 4v14H6zM9 10h7M9 14h7M9 18h4" },
    { key: "read", label: "Read", title: "Read", d: "M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3zM21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z" },
    { key: "insights", label: "Insights", title: "Insights", d: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" },
    { key: "practice", label: "Practice", title: "Practice", d: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
    { key: "review", label: "Review", title: "Review", d: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
    { key: "saved", label: "Saved", title: "Saved", d: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" },
  ];
  const QUICK = ["60-word summary", "Static background", "Make 2 Prelims MCQs", "Mains answer outline", "हिंदी में समझाएं", "Link to syllabus"];
  const PAPERS = ["GS1", "GS2", "GS3", "GS4", "Prelims"];

  // ─────────────────────────── state ───────────────────────────
  const A = {
    meta: null,
    day: todayIST(), tab: "brief", gs: "All", readSeg: "ed", period: "week", moreOpen: new Set(), lowOpen: false,
    brief: null, briefDay: null, byId: new Map(),
    months: new Map(), cache: new Map(),  // month brief data; every story seen, by id
    open: null, sheet: null, calMonth: null,
    exp: { scope: "brief", story: null, busy: false, opts: store.get("upsc-app-pdf", { sum: true, vid: true, links: true, mains: true, notes: true, eds: true }) },
    bot: { ctx: null, log: [], busy: false, step: "", last: "", partial: "" },
    sumStep: new Map(),
    marks: {}, saved: store.get("upsc-app-saved", {}), log: store.get("upsc-app-log", {}),
    search: { q: "", results: [], busy: false, wide: false },
  };

  // ─────────────────────────── data ───────────────────────────
  const api = {
    async json(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    },
    meta() { return STATIC ? this.json(`../data/meta.json?t=${Date.now()}`, { cache: "no-store" }) : this.json("../api/meta", { cache: "no-store" }); },
    stamp() { return encodeURIComponent((A.meta && A.meta.built_at) || ""); },
    async day(d) {  // one day's whole brief: cards, "Also in the news", folded reports, editorials, explainers
      if (!STATIC) return this.json(`../api/brief?from=${d}&to=${d}`);
      if ((A.meta.day_files || []).includes(d)) {
        const x = await this.json(`../data/day/${d}.json?v=${this.stamp()}`);
        return { days: x.days || {}, stories: x.stories || [], videos: x.videos || {} };
      }
      const m = await this.month(d.slice(0, 7));  // older days: the month's cards
      return m && m.days[d] ? { days: { [d]: m.days[d] }, stories: m.stories || [], videos: { [d]: (m.videos || {})[d] || [] } } : { days: {}, stories: [], videos: {} };
    },
    month(m) {  // a month's brief cards (Insights, Review, Saved, older days)
      if (!A.months.has(m)) {
        let p;
        if (STATIC) p = (A.meta.months || []).includes(m) ? this.json(`../data/brief-${m}.json?v=${this.stamp()}`) : Promise.resolve(null);
        else {
          const last = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
          p = this.json(`../api/brief?from=${m}-01&to=${m}-${String(last).padStart(2, "0")}`);
        }
        p = p.then((x) => { if (x) for (const s of x.stories || []) if (!A.cache.has(s.id)) A.cache.set(s.id, s); return x; });
        A.months.set(m, p);
        p.catch(() => A.months.delete(m));
      }
      return A.months.get(m);
    },
    async range(from, to) {  // {days, byId} for a date range, from the month files
      const out = { days: {}, byId: new Map() };
      for (const m of monthsIn(from, to)) {
        let x = null;
        try { x = await this.month(m); } catch (e) { /* offline: what's cached */ }
        if (!x) continue;
        for (const [d, v] of Object.entries(x.days || {})) if (d >= from && d <= to) out.days[d] = v;
        for (const s of x.stories || []) out.byId.set(s.id, s);
      }
      if (A.brief && A.briefDay >= from && A.briefDay <= to) {  // the open day's file is the fullest copy
        const v = A.brief.days[A.briefDay]; if (v) out.days[A.briefDay] = v;
        for (const s of A.brief.stories) out.byId.set(s.id, s);
      }
      return out;
    },
    marks() { return STATIC ? Promise.resolve(store.get("upsc-marks", {})) : this.json("../api/marks"); },
    async setMark(id, patch) {
      const cur = { starred: false, read: false, note: "", ...(A.marks[id] || {}), ...patch };
      A.marks[id] = cur;
      if (STATIC) { store.set("upsc-marks", A.marks); return cur; }
      return this.json("../api/marks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ story_id: id, ...patch }) });
    },
    async search(q, wide) {
      if (!STATIC) return (await this.json(`../api/search?q=${encodeURIComponent(q)}`)).stories;
      const pool = new Map(A.cache);
      if (wide) {
        for (const m of (A.meta.months || []).slice(-2)) {
          try { const x = await this.json(`../data/stories-${m}.json?v=${this.stamp()}`); for (const s of x.stories || []) pool.set(s.id, s); } catch (e) { /* offline */ }
        }
      }
      return [...pool.values()].filter((s) => matches(s, q)).sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.score - a.score).slice(0, 60);
    },
  };
  function matches(s, q) {
    const hay = `${s.title} ${s.summary || ""} ${((s.explain || {}).why_in_news) || ""} ${(s.tags || []).join(" ")} ${(s.sources || []).map((x) => x.p).join(" ")}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  const dayOf = () => (A.brief && A.brief.days[A.briefDay]) || {};
  const pick = (ids) => (ids || []).map((id) => A.byId.get(id)).filter(Boolean);
  // news: the Must-know cards · prelims: the Prelims facts cards (absent in briefs built before they existed) · more: one-liners
  // · low: what Intel AI took out (with its verdicts on)
  const lists = () => { const v = dayOf(); return { news: pick(v.news), prelims: pick(v.prelims), more: pick(v.more), editorials: pick(v.editorials), explained: pick(v.explained), low: pick(v.low) }; };
  const cardIds = (v) => (v.news || []).concat(v.prelims || []);
  const findStory = (id) => A.byId.get(id) || A.cache.get(id) || A.saved[id] || null;
  function foldedOf(id) {
    const f = (dayOf().folded || {})[id];
    return f ? f.map((x) => findStory(x)).filter(Boolean) : [];
  }
  const gsOk = (s) => A.gs === "All" || (s.gs || []).includes(A.gs);

  // ─────────────────────────── story helpers ───────────────────────────
  const labels = () => (A.meta && A.meta.labels) || { subjects: {}, subject_gs: {}, watch: {} };
  const subjName = (k) => labels().subjects[k] || k;
  const subjOf = (s) => ((s.subjects || []).length ? subjName(s.subjects[0]) : s.editorial ? "Editorial" : s.explained ? "Explained" : "General");
  const tagOf = (s) => (s.tags || [])[0] || "";
  const srcName = (s) => (s.sources && s.sources[0] && s.sources[0].p) || "Source";
  const cleanText = CORE.cleanText;  // a report minus the pipeline's placeholders and feed furniture
  function whyOf(s, max = 260) {  // the card's one-liner: the write-up's "why in news", else the report itself
    const e = s.explain || {};
    for (const t of [e.why_in_news, e.what, s.summary, ...(s.texts || []).map((x) => x.x)]) {
      const x = cleanText(t);
      if (x.length >= 30) return x.length > max ? x.slice(0, max - 3).replace(/\s+\S*$/, "") + "…" : x;
    }
    return "";
  }
  const minutesOf = (s) => (s.editorial ? 6 : s.explained ? 5 : 3) + (s.grade === "NOTE" ? 1 : 0) + ((s.n_pub || 0) >= 5 ? 1 : 0);
  const storyVideos = (s) => [[s.video, "English"], [s.video_hi, "हिंदी"]].filter(([v]) => v && v.id);
  const ytThumb = (v) => `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`;
  const ytSearch = (s) => (s.video && s.video.search_url) || `https://www.youtube.com/results?search_query=${encodeURIComponent(s.title + " UPSC")}`;
  const noteOf = (s) => (s.ai && s.ai.source === "claude-notes" ? s.ai : null);
  const mark = (id) => A.marks[id] || { starred: false, read: false, note: "" };
  const isDone = (s) => !!mark(s.id).read;
  const isStar = (s) => !!mark(s.id).starred;
  function mainsOf(s) {
    const e = s.explain || {};
    if (e.mains) return e.mains;
    const subj = (s.subjects || []).map(subjName).join(" / ");
    return `With reference to “${s.title}”, discuss its significance for ${subj || "India"}. `;
  }
  const paperOf = (s) => (s.gs || []).find((g) => /^GS[1-4]$/.test(g)) || ((s.gs || []).includes("Prelims") ? "Prelims" : "Other");

  // Summary points (shared with the website, kept on the device): Claude's note when the notes routine wrote one,
  // else the full article read from a free copy (as soon as the story opens, or in the background for cards on
  // screen), else until then the key lines of what the outlets published.
  function pointsFor(s) {
    const P = CORE.summaryNow(s);
    const line = P.from === "note" ? "Claude's study note."
      : P.from === "web" ? CORE.sourceHtml(P.src)
        : P.miss ? `No free copy of the full article could be read${(P.src && P.src.closed || []).length ? ` (the original on ${esc(P.src.closed.join(", "))} is subscriber-only)` : ""}: these are the key lines from the outlets' reports.`
          : "Key lines from the outlets' reports.";
    return { ...P, line };
  }
  function startSummary(s) {  // the open story reads its article now, ahead of the background queue
    const P = CORE.summaryNow(s);
    if (P.from !== "brief" || P.miss) return;
    A.sumStep.set(s.id, "Finding the full article…"); paintSum(s);
    CORE.summaryFor(s, { onStep: (m) => { A.sumStep.set(s.id, m); paintSum(s); } })
      .catch((e) => toast(e.message || "Couldn't reach the web just now."))
      .finally(() => { A.sumStep.delete(s.id); paintSum(s); });
  }
  function sumBoxInner(s) {
    const P = pointsFor(s); const step = A.sumStep.get(s.id) || (P.from === "brief" && P.busy ? "Reading the full article…" : "");
    return `<div class="sumh"><span class="adot"></span>Summary · ${plural(P.points.length, "point")}</div>
      ${P.points.length ? `<ul class="pts">${P.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : `<p class="rt" style="margin:0;font-size:14px">The outlets carried only the headline.</p>`}
      <div class="sumsrc">${step ? `<span class="sumstep">${esc(step)}</span>` : P.line}</div>`;
  }
  function paintSum(s) { const box = $("#sumbody"); if (box && A.open === s.id) box.innerHTML = sumBoxInner(s); }
  CORE.onSummary((id) => { const s = findStory(id); if (s) paintSum(s); });
  let cardWatch = null;
  function watchCards() {  // cards on screen get their summaries in the background, nearest first
    if (cardWatch) cardWatch.disconnect();
    if (!("IntersectionObserver" in window)) return;
    cardWatch = new IntersectionObserver((entries) => {
      const seen = entries.filter((x) => x.isIntersecting).map((x) => findStory(x.target.dataset.open)).filter(Boolean);
      if (seen.length) CORE.prefetch(seen);
    }, { rootMargin: "400px 0px" });
    document.querySelectorAll("#screen .card[data-open], #screen .pcard[data-open]").forEach((el) => cardWatch.observe(el));
  }

  // marks, the per-device activity log (streaks, time read) and saved copies (the Saved tab works offline)
  async function setMark(s, patch) {
    await api.setMark(s.id, patch).catch(() => toast("Couldn't save that: check your connection."));
    if ("read" in patch) {
      for (const d of Object.keys(A.log)) if (A.log[d][s.id] != null) { delete A.log[d][s.id]; if (!Object.keys(A.log[d]).length) delete A.log[d]; }
      if (patch.read) { const t = todayIST(); A.log[t] = A.log[t] || {}; A.log[t][s.id] = minutesOf(s); }
      const keep = addDays(todayIST(), -400); for (const d of Object.keys(A.log)) if (d < keep) delete A.log[d];
      store.set("upsc-app-log", A.log);
    }
    if ("starred" in patch || "note" in patch) {
      if (mark(s.id).starred) A.saved[s.id] = compact(s); else delete A.saved[s.id];
      store.set("upsc-app-saved", A.saved);
    }
  }
  const compact = (s) => ({
    id: s.id, title: s.title, date: s.date, dates: s.dates, grade: s.grade, gs: s.gs, subjects: s.subjects, tags: s.tags, watch: s.watch,
    n_pub: s.n_pub, editorial: s.editorial, explained: s.explained, score: s.score, first_seen: s.first_seen, sources: (s.sources || []).slice(0, 4),
    summary: String(s.summary || "").slice(0, 600), explain: s.explain ? { why_in_news: whyOf(s, 600), where: s.explain.where, who: s.explain.who, when: s.explain.when, significance: s.explain.significance, prelims: s.explain.prelims, keywords: s.explain.keywords, mains: s.explain.mains } : undefined,
    video: s.video, video_hi: s.video_hi,
  });

  // ─────────────────────────── pieces ───────────────────────────
  function vpill(s) {
    const v = storyVideos(s);
    if (!v.length) return `<a class="vpill find" href="${esc(ytSearch(s))}" target="_blank" rel="noopener">${I.play}Find video</a>`;
    const langs = v.map(([, l]) => (l === "English" ? "EN" : l)).join(" · ");
    return `<a class="vpill" href="${esc(safeUrl(v[0][0].url))}" target="_blank" rel="noopener" aria-label="Watch the video">${I.play}${esc(langs)}</a>`;
  }
  // how deep to study it (the grader's NOTE / SKIM / READ, in words): every brief card is must-know, this says how much
  const GRADE_LABEL = { NOTE: "Make notes", SKIM: "Quick read", READ: "Background", LOW: "Low" };
  const GRADE_HELP = { NOTE: "High yield: make notes on it", SKIM: "Know the key facts: a quick read is enough", READ: "Background only", LOW: "Probably not examinable" };
  const gradeName = (g) => GRADE_LABEL[g] || g;
  const gradePill = (s) => `<span class="grade g-${esc(s.grade)}" title="${esc(`${GRADE_HELP[s.grade] || ""}${s.ai_why != null ? ` · ✦ Graded by Intel AI${s.ai_why ? `: ${s.ai_why}` : ""}` : ""}`)}">${esc(gradeName(s.grade))}</span>`;
  const gsPills = (s) => (s.gs || []).map((g) => `<span class="gsp">${esc(g)}</span>`).join("");
  function card(s, rank) {
    const done = isDone(s); const star = isStar(s); const tag = tagOf(s); const why = whyOf(s);
    return `<article class="card${done ? " done" : ""}" data-open="${esc(s.id)}">
      <div class="card-meta">${rank ? `<span class="rank">${rank}</span>` : ""}${gradePill(s)}${gsPills(s)}<span class="sp"></span><span class="min">${minutesOf(s)} min</span></div>
      <div class="card-tags"><span class="subj">${esc(subjOf(s))}</span>${tag ? `<span class="tag">${esc(tag)}</span>` : ""}</div>
      <h3 class="card-title">${esc(s.title)}</h3>
      ${why ? `<p class="card-why"><b>Why in news:</b> ${esc(why)}</p>` : ""}
      <div class="card-foot">${vpill(s)}<span class="src">${esc(srcName(s))} · ${plural(s.n_pub || 1, "outlet")}</span>
        <button class="star${star ? " on" : ""}" data-act="star" data-id="${esc(s.id)}" aria-label="${star ? "Unstar" : "Star"}" aria-pressed="${star}">${star ? I.starOn : I.star}</button>
        <button class="done-btn${done ? " on" : ""}" data-act="done" data-id="${esc(s.id)}" aria-label="${done ? "Mark not done" : "Mark done"}" aria-pressed="${done}">${I.check}</button></div>
    </article>`;
  }
  const mrow = (s) => `<div class="mrow${isDone(s) ? " done" : ""}" data-open="${esc(s.id)}">${gradePill(s)}<div class="mrow-t">${esc(s.title)}<small>${esc(srcName(s))} · ${esc(subjOf(s))}${s.date && s.date !== A.day ? ` · ${esc(dayShort(s.date))}` : ""}</small></div>
    <button class="star${isStar(s) ? " on" : ""}" data-act="star" data-id="${esc(s.id)}" aria-label="Star">${isStar(s) ? I.starOn : I.star}</button></div>`;
  function pcard(s) {
    const x = s.explained && !s.editorial; const sec = s.sources && s.sources[0] && s.sources[0].s;
    const v = storyVideos(s)[0];
    const band = x ? `<div class="xband"><span class="term">${esc(subjOf(s))}</span>${v ? `<img src="${esc(ytThumb(v[0]))}" alt="" loading="lazy" onerror="this.nextElementSibling.remove();this.remove()"><span class="play">${I.play}</span>` : ""}</div>` : "";
    return `<article class="pcard${x ? " xcard" : ""}${isDone(s) ? " done" : ""}" data-open="${esc(s.id)}">${band}<div class="${x ? "pbody" : ""}">
      <div class="pcard-top"><span class="kind${x ? " ex" : ""}">${x ? "EXPLAINED" : "EDITORIAL"}</span><span class="pcard-src">${esc(srcName(s))}${sec ? ` · ${esc(sec)}` : ""}</span><span class="min">${minutesOf(s)} min</span></div>
      <h3 class="pcard-t">${esc(s.title)}</h3>
      ${whyOf(s) ? `<p class="pcard-w"><b>${x ? "In short:" : "Argument:"}</b> ${esc(whyOf(s))}</p>` : ""}</div></article>`;
  }

  // ─────────────────────────── screens ───────────────────────────
  function renderBrief() {
    const d = A.day; const today = todayIST(); const has = (A.meta && A.meta.brief_days) || {};
    const ws = weekStart(d);
    const strip = WD1.map((l, i) => {
      const x = addDays(ws, i); const ok = (has[x] || x === d) && x <= today;
      return `<button class="wd${has[x] ? " has" : ""}${x === d ? " sel" : ""}${x === today ? " today" : ""}" data-day="${x}"${ok ? "" : " disabled"} aria-label="${esc(dayFull(x))}"><span class="l">${l}</span><span class="n">${D(x).getUTCDate()}</span><span class="d"></span></button>`;
    }).join("");
    const head = `<div class="monthrow"><button class="monthbtn" data-act="cal">${I.cal}${esc(monthLabel(d))}${I.chev}</button>${d !== today ? '<button class="btn-s" data-act="today">Today</button>' : ""}</div><div class="week">${strip}</div>`;
    if (A.briefDay !== d) return head + '<div class="loading">Loading the brief…</div>';
    const L = lists();
    if (!L.news.length && !L.prelims.length && !L.more.length && !L.editorials.length) {
      const early = d === today;
      return `${head}<div class="empty">${early ? "Today's brief fills up through the day: the first stories land after 6 am IST." : `No brief for ${esc(dayLabel(d))}.`}<br><button class="btn-s" data-day="${addDays(d, -1)}">Open ${esc(dayShort(addDays(d, -1)))}</button></div>`;
    }
    const all = L.news.concat(L.prelims, L.editorials, L.explained);
    const done = all.filter(isDone).length;
    const mins = all.reduce((n, s) => n + minutesOf(s), 0);
    const reported = ((A.meta && A.meta.date_counts) || {})[d];
    const pct = all.length ? Math.round(done * 100 / all.length) : 0;
    // the day by grade: Must-know (make notes) → Quick read → Background → Low; the one-liners join their grade's block
    const byGrade = (arr) => ({ note: arr.filter((s) => s.grade === "NOTE"), quick: arr.filter((s) => s.grade === "SKIM"), bg: arr.filter((s) => s.grade !== "NOTE" && s.grade !== "SKIM") });
    const G0 = byGrade(L.more); const nQuick = L.prelims.length + G0.quick.length; const nBg = G0.bg.length;
    const hero = `<section class="hero">
      <div class="eyebrow">Daily Brief · ${esc(dayLabel(d))}</div>
      <div class="hero-n">${plural(L.news.length, "must-know story", "must-know stories")}</div>
      <div class="hero-sub">${L.news.length ? "make notes on each" : "none yet"}${nQuick ? ` · ${nQuick} quick read` : ""}${nBg ? ` · ${nBg} background` : ""} · ${plural(L.editorials.length, "editorial")} · ${plural(L.explained.length, "explainer")} · about ${fmtMins(mins)}<br>${reported ? `picked from ${reported.toLocaleString("en-IN")} reported` : "the day's pick"}</div>
      <div class="hero-prog"><div class="track"><div style="width:${pct}%"></div></div><span>${done} of ${all.length} done</span></div>
      <div class="hero-btns"><button class="hbtn" data-act="export">${I.pdf}Export as PDF</button><button class="hbtn ghost" data-act="askday"><span class="adot"></span>Ask Intel</button>${CORE.listen.supported && L.news.length ? '<button class="hbtn ghost" data-listen="start" title="Read the must-know stories and Prelims facts aloud">🎧 Listen</button>' : ""}</div>
    </section>`;
    const count = (g) => L.news.concat(L.prelims, L.more).filter((s) => g === "All" || (s.gs || []).includes(g)).length;
    const chips = `<div class="chips nosb">${["All", ...PAPERS].map((g) => `<button class="chip${A.gs === g ? " on" : ""}" data-gs="${g}">${g}${g !== "All" ? `<span class="c">${count(g)}</span>` : ""}</button>`).join("")}</div>`;
    const cards = L.news.map((s, i) => [s, i + 1]).filter(([s]) => gsOk(s));
    const facts = L.prelims.filter(gsOk);
    const G = byGrade(L.more.filter(gsOk)); const low = L.low.filter(gsOk);
    const lines = (arr, k) => {  // one-liners, the first 12 until "Show all"
      const shown = A.moreOpen.has(k) ? arr : arr.slice(0, 12);
      return `<div class="more">${shown.map(mrow).join("")}${arr.length > shown.length ? `<button class="showmore" data-act="moreall" data-k="${k}">Show all ${arr.length}</button>` : ""}</div>`;
    };
    const lowRow = (s) => `<div class="mrow low" data-open="${esc(s.id)}">${gradePill(s)}<div class="mrow-t">${esc(s.title)}<small>${esc(srcName(s))}${s.ai_why ? ` · ✦ ${esc(s.ai_why)}` : ""}</small></div></div>`;
    return `${head}${hero}${chips}
      <div class="sechead"><h2>Must-know</h2><span>${cards.length} · make notes</span></div>
      <div class="list">${cards.map(([s, r]) => card(s, r)).join("") || `<div class="empty">No ${esc(A.gs)} must-know story ${L.news.length ? "among today's cards" : "yet"}.</div>`}</div>
      ${G.note.length ? `<div class="sechead"><h2>More to make notes on</h2><span>${G.note.length} · as one-liners</span></div>${lines(G.note, "note")}` : ""}
      ${facts.length || G.quick.length ? `<div class="sechead"><h2>Quick read</h2><span>${facts.length ? `${plural(facts.length, "Prelims fact")}` : ""}${facts.length && G.quick.length ? " + " : ""}${G.quick.length ? `${G.quick.length} more` : ""} · know the key fact</span></div>
        ${facts.length ? `<div class="list">${facts.map((s) => card(s, null)).join("")}</div>` : ""}${G.quick.length ? lines(G.quick, "quick") : ""}` : ""}
      ${G.bg.length ? `<div class="sechead"><h2>Background</h2><span>${G.bg.length} · context and smaller stories</span></div>${lines(G.bg, "bg")}` : ""}
      ${low.length ? `<div class="sechead"><h2>Low</h2><span>${low.length} · not UPSC material, taken out by Intel AI</span></div>
        <div class="more lowbox"><button class="showmore" data-act="lowopen" aria-expanded="${A.lowOpen}">${A.lowOpen ? "Hide them" : `Show what Intel AI took out, with its reason`}</button>${A.lowOpen ? low.map(lowRow).join("") : ""}</div>` : ""}
      <p class="fine" style="padding:0 16px 8px">Everything reported today, with filters: <a href="../#everything">the full dashboard ↗</a></p>`;
  }

  function renderRead() {
    if (A.briefDay !== A.day) return '<div class="loading">Loading…</div>';
    const L = lists();
    const seg = `<div style="padding:2px 16px 12px"><div class="seg">${[["ed", `Editorials · ${L.editorials.length}`], ["ex", `Explained · ${L.explained.length}`]].map(([k, l]) => `<button class="${A.readSeg === k ? "on" : ""}" data-seg="${k}">${l}</button>`).join("")}</div></div>`;
    if (A.readSeg === "ed") {
      const papers = (A.meta && A.meta.gs_papers) || {};
      const groups = ["GS1", "GS2", "GS3", "GS4", "Prelims", "Other"].map((p) => ({ p, items: L.editorials.filter((s) => paperOf(s) === p) })).filter((g) => g.items.length);
      return `${seg}<div class="intro"><div class="eyebrow">Opinion pages · ${esc(dayLabel(A.day))}</div><div class="intro-t">${plural(L.editorials.length, "editorial")}, by GS paper</div><div class="intro-s">Spread across publishers: none takes more than a third of the day.</div></div>
        ${groups.map((g) => `<div class="grouphead"><h2>${g.p}</h2><span>${esc((papers[g.p] || (g.p === "Prelims" ? "Facts for Prelims" : "Beyond the GS papers")).split(", ").join(" · "))}</span></div><div class="list tight">${g.items.map(pcard).join("")}</div>`).join("")
          || '<div class="empty">No editorials for this day.</div>'}`;
    }
    return `${seg}<div class="intro"><div class="eyebrow green">Explainer desks · ${esc(dayLabel(A.day))}</div><div class="intro-t">${plural(L.explained.length, "deep dive")}</div><div class="intro-s">Kept separate from news, so both show up.</div></div>
      <div class="list">${L.explained.map(pcard).join("") || '<div class="empty">No explainers for this day.</div>'}</div>`;
  }

  // Insights: your last 30 days, from your done marks (this device's log for streaks) and the brief archive
  const R30 = { key: "", data: null, busy: false };
  function range30() {
    const t = todayIST(); const key = `${t}|${(A.meta && A.meta.built_at) || ""}`;
    if (R30.key !== key && !R30.busy) {
      R30.busy = true;
      api.range(addDays(t, -29), t).then((r) => { R30.data = r; R30.key = key; }).catch(() => {}).finally(() => { R30.busy = false; if (A.tab === "insights" || A.tab === "review" || A.tab === "saved") renderScreen(); });
    }
    return R30.data;
  }
  function ensure30() {  // the same, as a promise (search, the catch-up plan)
    range30();
    return new Promise((resolve) => { const t0 = Date.now(); (function wait() { if (R30.data || Date.now() - t0 > 20000) resolve(R30.data); else setTimeout(wait, 150); })(); });
  }
  function insightsModel(R) {
    const t = todayIST(); const cards = [];
    for (const [d, v] of Object.entries(R.days)) for (const id of cardIds(v)) { const s = R.byId.get(id); if (s) cards.push({ s, d }); }
    const loggedDays = Object.keys(A.log).filter((d) => Object.keys(A.log[d]).length).sort();
    const logged = new Set(loggedDays);
    let streak = 0; for (let d = logged.has(t) ? t : addDays(t, -1); logged.has(d); d = addDays(d, -1)) streak += 1;
    let best = 0; let run = 0; let prev = null;
    for (const d of loggedDays) { run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; }
    const ws = weekStart(t);
    const week = WD1.map((l, i) => { const d = addDays(ws, i); return { l, cls: logged.has(d) ? "ok" : d === t ? "now" : "", mark: logged.has(d) ? "✓" : d === t ? "•" : "" }; });
    const weekMins = Object.entries(A.log).filter(([d]) => d >= ws).reduce((n, [, v]) => n + Object.values(v).reduce((a, b) => a + b, 0), 0);
    const doneAll = Object.values(A.marks).filter((m) => m.read).length;
    const notes = Object.values(A.marks).filter((m) => (m.note || "").trim()).length;
    const done = (s) => !!mark(s.id).read;
    const mastery = PAPERS.map((p) => { const xs = cards.filter((c) => (c.s.gs || []).includes(p)); const n = xs.filter((c) => done(c.s)).length; return { p, n, total: xs.length, pct: xs.length ? Math.round(n * 100 / xs.length) : 0 }; });
    const lastDone = {};  // subject → the latest day you finished one of its stories
    for (const d of loggedDays) for (const id of Object.keys(A.log[d])) { const s = R.byId.get(id) || findStory(id); if (s) for (const k of s.subjects || []) lastDone[k] = d; }
    const subjects = Object.keys(labels().subjects).map((k) => {
      const xs = cards.filter((c) => (c.s.subjects || []).includes(k)); const n = xs.filter((c) => done(c.s)).length;
      const week7 = xs.filter((c) => c.d >= addDays(t, -6)); const skipped = week7.filter((c) => !done(c.s)).length;
      return { k, name: subjName(k), total: xs.length, n, share: xs.length ? n / xs.length : 0, skipped, last: lastDone[k] || null };
    });
    const blind = subjects.filter((x) => x.total >= 3 && x.share <= 0.25).sort((a, b) => a.share - b.share || b.total - a.total).slice(0, 3);
    const strong = subjects.filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 2);
    const skip = subjects.filter((x) => x.skipped >= 2).sort((a, b) => b.skipped - a.skipped)[0];
    const stale = subjects.filter((x) => x.total >= 3 && (!x.last || daysBetween(x.last, t) >= 7)).sort((a, b) => (a.last || "").localeCompare(b.last || "") || b.total - a.total)[0];
    let read;
    if (!doneAll) read = "Nothing marked done yet. Tick ✓ on the stories you finish, and this page maps your strong papers and your blind spots.";
    else {
      const bits = [];
      if (strong.length) bits.push(`Strong on ${strong.map((x) => x.name).join(" and ")}.`);
      if (skip) bits.push(`You've skipped ${plural(skip.skipped, `${skip.name} story`, `${skip.name} stories`)} this week`);
      if (stale && (!skip || stale.k !== skip.k)) bits.push(`${skip ? "and" : "You"} haven't finished ${stale.name} ${stale.last ? `in ${daysBetween(stale.last, t)} days` : "this month"}.`);
      else if (skip) bits[bits.length - 1] += ".";
      read = bits.join(" ") || "Balanced across papers so far. Keep going.";
    }
    const last7 = Array.from({ length: 7 }, (_, i) => addDays(t, i - 6));
    const inBrief = (id, d) => { const v = R.days[d]; return !!v && (cardIds(v).includes(id) || (v.more || []).includes(id)); };
    const threads = [...R.byId.values()].map((s) => ({ s, on: last7.map((d) => ((s.dates || []).includes(d) || inBrief(s.id, d))) }))
      .map((x) => ({ ...x, n: x.on.filter(Boolean).length })).filter((x) => x.n >= 3 && !x.s.editorial)
      .sort((a, b) => b.n - a.n || b.s.score - a.s.score).slice(0, 3);
    const L = A.briefDay ? lists() : { news: [] };
    const radar = L.news.concat(L.prelims || []).filter((s) => (s.tags || []).length || (s.watch || []).length).sort((a, b) => b.score - a.score).slice(0, 4);
    return { streak, best, week, weekMins, doneAll, notes, read, mastery, blind, threads, radar, cards };
  }
  function practicePanel() {  // your practice sets (Practice tab): accuracy, weakest areas
    const P = CORE.practiceStats();
    if (!P.attempts.length) return `<section class="panel"><div class="ph">Practice</div><div class="ps" style="margin:0">Take a daily set of UPSC-style MCQs in the Practice tab: your scores and weak areas show up here. <button class="btn-o" data-tab="practice">Practice now</button></div></section>`;
    const subj = Object.entries(P.subj).filter(([, [, t]]) => t >= 2).map(([k, [r, t]]) => ({ k, pct: Math.round((r * 100) / t), t })).sort((a, b) => a.pct - b.pct);
    const last = P.attempts[P.attempts.length - 1];
    return `<section class="panel"><div class="ph">Practice <span>· ${P.attempts.length} set${P.attempts.length === 1 ? "" : "s"}, ${P.accuracy}% accuracy</span></div>
      <div class="ps">Last set: ${last.score} / ${last.max} (${last.right} right, ${last.wrong} wrong) · ${esc(dayShort(last.day))}</div>
      <div class="mastery">${subj.slice(0, 6).map((m) => `<div class="mrowg"><b>${esc(subjName(m.k))}</b><div class="bar${m.pct < 50 ? " low" : ""}"><div style="width:${m.pct}%"></div></div><span class="${m.pct < 50 ? "low" : ""}">${m.pct}%</span></div>`).join("")}</div>
      <button class="btn-o" data-tab="practice" style="margin-top:8px">New practice set</button></section>`;
  }
  function renderInsights() {
    const R = range30();
    if (!R) return '<div class="loading">Reading your last 30 days…</div>';
    const M = insightsModel(R);
    const W = labels().watch || {};
    return `<div class="intro"><div class="eyebrow">Your preparation · last 30 days</div><div class="intro-t">Insights</div></div>
      <section class="streak"><div class="streak-top"><span class="streak-n">${M.streak}</span><span class="streak-l">day streak</span><span class="sp"></span><span class="streak-best">Best: ${Math.max(M.best, M.streak)}</span></div>
        <div class="streak-days">${M.week.map((w) => `<div><div class="b ${w.cls}">${w.mark}</div><span>${w.l}</span></div>`).join("")}</div>
        <div class="streak-kpis"><div><b>${fmtMins(M.weekMins)}</b><span>read this week</span></div><div><b>${M.doneAll}</b><span>stories done</span></div><div><b>${M.notes}</b><span>notes written</span></div></div></section>
      <section class="intel">${LOGO(30)}<div style="flex:1;min-width:0"><div class="intel-h">Intel's read on your week</div><div class="intel-t">${esc(M.read)}</div>
        <button class="btn-p" data-act="plan">Build a 30-min catch-up plan</button></div></section>
      ${practicePanel()}
      <section class="panel"><div class="ph">Paper mastery</div><div class="ps">Share of the brief's stories (last 30 days) you've finished</div>
        <div class="mastery">${M.mastery.map((m) => { const low = M.doneAll && m.total && m.pct < 40; return `<div class="mrowg"><b>${m.p}</b><div class="bar${low ? " low" : ""}"><div style="width:${m.pct}%"></div></div><span class="${low ? "low" : ""}">${m.total ? `${m.pct}%` : "–"}</span></div>`; }).join("")}</div></section>
      <section class="panel"><div class="ph">Blind spots</div>${M.blind.map((b) => `<div class="blind"><span class="bang">!</span><div class="blind-t"><b>${esc(b.name)}</b><span>${b.n} of ${b.total} stories read · ${b.last ? `last one ${daysBetween(b.last, todayIST())} days ago` : "none in 30 days"}</span></div><button class="btn-o" data-act="plan" data-subj="${esc(b.k)}">Catch up</button></div>`).join("")
        || `<div class="ps" style="margin:0">${M.doneAll ? "No blind spot: every subject with 3+ stories has a quarter or more done." : "Your blind spots show up once you start marking stories done."}</div>`}</section>
      <section class="panel"><div class="ph">Running stories <span>· in the news for days</span></div>${M.threads.map((x) => `<div class="thread" data-open="${esc(x.s.id)}"><div class="thread-t"><b>${esc(x.s.title)}</b><span>${x.n} of last 7 days · ${esc((x.s.gs || []).join(" · ") || subjOf(x.s))}</span></div>
        <div class="spark" aria-hidden="true">${x.on.map((on, i) => `<i class="${i === 6 ? "last" : ""}" style="height:${on ? 8 + i * 2.6 : 3}px"></i>`).join("")}</div></div>`).join("") || '<div class="ps" style="margin:0">No story has run 3+ days this week.</div>'}</section>
      <section class="panel"><div class="ph">Exam radar</div><div class="ps">Today's stories that touch recurring UPSC themes</div>${M.radar.map((s) => { const k = tagOf(s) || String(W[(s.watch || [])[0]] || "").split(/[ (]/)[0]; return `<div class="radar" data-open="${esc(s.id)}"><span class="k">${esc(k)}</span><div class="radar-t"><b>${esc(s.title)}</b><span>${esc(subjOf(s))} · recurring ${esc((s.gs || [])[0] || "GS")} theme</span></div>${I.right}</div>`; }).join("") || '<div class="ps" style="margin:0">Nothing flagged for this day.</div>'}</section>`;
  }

  function reviewRange() {
    if (A.period === "week") { const a = weekStart(A.day); return [a, addDays(a, 6)]; }
    const m = A.day.slice(0, 7); const last = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
    return [`${m}-01`, `${m}-${String(last).padStart(2, "0")}`];
  }
  const REV = { key: "", data: null, busy: false };
  function renderReview() {
    const [from, to] = reviewRange(); const t = todayIST(); const key = `${from}|${to}|${(A.meta && A.meta.built_at) || ""}`;
    const seg = `<div class="seg inline" style="margin-bottom:12px">${["week", "month"].map((p) => `<button class="${A.period === p ? "on" : ""}" data-period="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join("")}</div>`;
    if (REV.key !== key) {
      if (!REV.busy) { REV.busy = true; api.range(from, to).then((r) => { REV.data = r; REV.key = key; }).catch(() => {}).finally(() => { REV.busy = false; if (A.tab === "review") renderScreen(); }); }
      return `<div class="intro">${seg}</div><div class="loading">Adding up the ${A.period}…</div>`;
    }
    const R = REV.data; const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const news = []; const seen = new Set(); let eds = 0;
    for (const d of days) { const v = R.days[d]; if (!v) continue; eds += (v.editorials || []).length; for (const id of cardIds(v)) { const s = R.byId.get(id); if (s && !seen.has(id)) { seen.add(id); news.push(s); } } }
    const subj = Object.keys(labels().subjects).map((k) => ({ k, name: subjName(k), n: news.filter((s) => (s.subjects || []).includes(k)).length })).sort((a, b) => b.n - a.n);
    const hit = subj.filter((x) => x.n).length; const gaps = subj.length - hit; const max = Math.max(1, ...subj.map((x) => x.n));
    const perDay = (d) => cardIds(R.days[d] || {}).length;
    let bars;
    if (A.period === "week") bars = days.map((d, i) => ({ v: d > t ? "" : perDay(d), l: WD1[i], part: d >= t }));
    else {
      const weeks = []; for (const d of days) { const w = Math.floor((D(d).getUTCDate() - 1 + dow(`${from}`)) / 7); weeks[w] = weeks[w] || { v: 0, l: `W${w + 1}`, part: false, any: false }; if (d <= t) { weeks[w].v += perDay(d); weeks[w].any = true; } if (d >= t) weeks[w].part = true; }
      bars = weeks.filter(Boolean).map((w) => ({ ...w, v: w.any ? w.v : "" }));
    }
    const bmax = Math.max(1, ...bars.map((b) => +b.v || 0));
    const cols = `grid-template-columns:repeat(${bars.length},minmax(0,1fr))`;
    const top = news.slice().sort((a, b) => (b.score + 0.4 * (b.n_pub || 0)) - (a.score + 0.4 * (a.n_pub || 0))).slice(0, 5);
    const range = A.period === "week" ? `${D(from).getUTCDate()}${from.slice(5, 7) !== to.slice(5, 7) ? ` ${MON[D(from).getUTCMonth()]}` : ""}–${D(to).getUTCDate()} ${MON[D(to).getUTCMonth()]} ${to.slice(0, 4)}` : monthLabel(from);
    return `<div class="intro">${seg}<div class="eyebrow">${A.period === "week" ? "Week" : "Month"} in review · ${esc(range)}</div>
        <div class="hero-n" style="margin:4px 0 12px;font-size:26px">${plural(news.length, "story", "stories")} covered</div>
        <div class="kpis"><div class="kpi"><b>${hit}/${subj.length}</b><span>Subjects hit</span></div><div class="kpi"><b>${eds}</b><span>Editorials</span></div><div class="kpi"><b class="${gaps ? "bad" : ""}">${gaps}</b><span>${gaps === 1 ? "Gap flagged" : "Gaps flagged"}</span></div></div></div>
      <section class="panel"><div class="ph">Brief per ${A.period === "week" ? "day" : "week"}</div>
        <div class="bars" style="${cols}">${bars.map((b) => `<div><span>${b.v}</span><i class="${b.part ? "part" : ""}" style="height:${b.v === "" ? 0 : Math.round((+b.v || 0) / bmax * 84)}px"></i></div>`).join("")}</div>
        <div class="barlabels" style="${cols};display:grid">${bars.map((b) => `<span>${b.l}</span>`).join("")}</div></section>
      <section class="panel"><div class="ph">What we covered <span>· by subject</span></div><div class="cov">${subj.map((x) => `<div><span class="nm${x.n ? "" : " gap"}">${esc(x.name)}${x.n ? "" : " · gap"}</span><div class="bx"><i style="width:${x.n / max * 100}%"></i></div><span class="v${x.n ? "" : " gap"}">${x.n}</span></div>`).join("")}</div></section>
      <section class="panel"><div class="ph">Top 5 of the ${A.period}</div><div class="top5">${top.map((s, i) => `<div data-open="${esc(s.id)}"><span class="r">${i + 1}</span><div><b>${esc(s.title)}</b><small>${esc(subjOf(s))} · ${plural(s.n_pub || 1, "outlet")}</small></div></div>`).join("") || '<div class="ps" style="margin:0">No brief in this period yet.</div>'}</div></section>`;
  }

  function renderSaved() {
    const ids = Object.keys(A.marks).filter((id) => A.marks[id].starred);
    const items = ids.map(findStory).filter(Boolean).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    if (items.length < ids.length) range30();  // stars from the dashboard: find them in the brief archive
    const missing = ids.length - items.length;
    return `<div class="savedhead"><div><div class="eyebrow">Revision list</div><div class="intro-t">${ids.length} starred</div><div class="intro-s">Starred stories and your notes.</div></div>
        <button class="btn-pdf" data-act="export" data-scope="saved">${I.dl}PDF</button></div>
      ${items.length ? `<div class="list tight">${items.map((s) => { const n = mark(s.id).note; return `<article class="scard" data-open="${esc(s.id)}"><div class="scard-top"><span class="subj">${esc(subjOf(s))}</span><span class="sp"></span>
          <button class="star on" data-act="star" data-id="${esc(s.id)}" aria-label="Unstar">${I.starOn}</button></div><h3 class="scard-t">${esc(s.title)}</h3><div class="scard-m">${esc(dayShort(s.date))} · ${esc(srcName(s))}</div>${n ? `<div class="note">${esc(n)}</div>` : ""}</article>`; }).join("")}</div>` : ""}
      ${missing ? `<p class="fine">${missing} starred ${missing === 1 ? "story is" : "stories are"} older than the archive this app loads.</p>` : ""}
      ${!ids.length ? '<div class="empty">Nothing starred yet. Tap the star on any card to build your revision list.</div>' : ""}`;
  }

  // ─────────────────────────── the story view ───────────────────────────
  function renderStory(s) {
    const e = s.explain || {}; const m = mark(s.id); const P = pointsFor(s);
    const vids = storyVideos(s); const folded = foldedOf(s.id);
    const rows = [
      ["What happened", e.what && e.what !== e.why_in_news ? cleanText(e.what) : ""],
      ["Why in news", cleanText(e.why_in_news) && !P.points.some((p) => cleanText(e.why_in_news).startsWith(p.slice(0, 40))) ? cleanText(e.why_in_news) : ""],
      ["When · Where · Who", [e.when, e.where, e.who].filter(Boolean).join(" · ")],
      ["Background", !e.auto || noteOf(s) ? e.background : ""],
      ["Why it matters", (e.significance || []).join(" · ")],
      ["Link to syllabus", noteOf(s) ? noteOf(s).syllabus : ""],
    ].filter(([, v]) => v);
    const facts = e.prelims || [];
    const vcard = vids.length ? `<a class="vcard" href="${esc(safeUrl(vids[0][0].url))}" target="_blank" rel="noopener"><div class="vthumb"><img src="${esc(ytThumb(vids[0][0]))}" alt="" loading="lazy"><span class="play">${I.play}</span></div><div style="min-width:0"><b>${esc(vids[0][0].title)}</b><small>${esc(vids.map(([, l]) => l).join(" · "))} · ${esc(vids[0][0].channel || "YouTube")}</small></div></a>`
      : `<a class="vcard" href="${esc(ytSearch(s))}" target="_blank" rel="noopener"><div class="vthumb"><span class="play">${I.play}</span></div><div style="min-width:0"><b>Search YouTube: ${esc((s.video && s.video.query) || s.title)}</b><small>No confident video match yet</small></div></a>`;
    const pw = (u) => CORE.web.paywalled(CORE.web.domainOf(u));
    return `<div class="story fixed-col" role="dialog" aria-label="${esc(s.title)}">
      <div class="story-bar"><button class="back" data-act="close">${I.back}${esc((TABS.find((x) => x.key === A.tab) || TABS[0]).title)}</button><span class="sp"></span>
        <button class="ib${m.starred ? " on" : ""}" data-act="star" data-id="${esc(s.id)}" aria-label="${m.starred ? "Unstar" : "Star"}">${m.starred ? I.starOn : I.star}</button>
        <button class="ib" data-act="export" data-scope="story" aria-label="Export as PDF" style="color:var(--accent-strong)">${I.dl}</button></div>
      <div class="story-body" id="storyBody">
        <div class="card-meta">${gradePill(s)}${gsPills(s)}<span class="subj">${esc(subjOf(s))}</span>${tagOf(s) ? `<span class="tag">${esc(tagOf(s))}</span>` : ""}</div>
        <h1>${esc(s.title)}</h1>
        <div class="story-meta">${esc(srcName(s))}${(s.n_pub || 1) > 1 ? ` and ${plural(s.n_pub - 1, "more outlet")}` : ""}${s.first_seen ? ` · first seen ${esc(clockIST(s.first_seen))} IST${s.date && s.date !== todayIST() ? `, ${esc(dayShort(s.date))}` : ""}` : ""} · ${minutesOf(s)} min read</div>
        <section class="sumbox" id="sumbox"><div id="sumbody">${sumBoxInner(s)}</div>
          <div class="qchips nosb">${QUICK.map((q) => `<button class="qchip" data-ask="${esc(q)}">${esc(q)}</button>`).join("")}<button class="qchip claude" data-act="claude">Ask Claude ↗</button></div></section>
        ${vcard}
        <div class="rows">
          ${rows.map(([l, v]) => `<div><div class="rl">${esc(l)}</div><div class="rt">${esc(v)}</div></div>`).join("")}
          ${facts.length ? `<div><div class="rl">Prelims facts</div><ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
          <div class="mains"><div class="rl">Mains question · ${esc(paperOf(s) === "Other" ? "GS" : paperOf(s))}</div><p>${esc(mainsOf(s))}</p><small>250 words · 15 marks${e.mains ? "" : " · practice question from the syllabus mapping"}</small></div>
          ${(e.keywords || []).length ? `<div><div class="rl">Keywords</div><div class="kws">${e.keywords.map((k) => `<span>${esc(k)}</span>`).join("")}</div></div>` : ""}
          <div><div class="rl">Read the original</div><div class="links">${(s.sources || []).map((x) => `<a href="${esc(safeUrl(x.u))}" target="_blank" rel="noopener"><span>${esc(x.p || "Source")}${x.s ? ` <small>· ${esc(x.s)}</small>` : ""}</span>${pw(x.u) ? '<span class="pw">subscriber</span>' : ""}${I.ext}</a>`).join("")}
            ${folded.map((f) => `<a href="${esc(safeUrl(f.url || (f.sources && f.sources[0] && f.sources[0].u)))}" target="_blank" rel="noopener"><span>${esc(srcName(f))} <small>· ${esc(f.title)}</small></span>${I.ext}</a>`).join("")}</div></div>
          <div><div class="rl">My note</div><textarea class="notebox" data-note="${esc(s.id)}" placeholder="Add a revision note…">${esc(m.note || "")}</textarea></div>
        </div>
      </div>
      <div class="story-foot"><button class="askbtn" data-act="askstory"><span class="adot"></span>Ask Intel</button>
        <button class="bigdone${m.read ? " on" : ""}" data-act="done" data-id="${esc(s.id)}">${I.check}${m.read ? "Done · tap to undo" : "Mark done"}</button></div>
    </div>`;
  }
  // ─────────────────────────── sheets ───────────────────────────
  function renderCal() {
    const t = todayIST(); const has = (A.meta && A.meta.brief_days) || {}; const months = (A.meta && A.meta.months) || [t.slice(0, 7)];
    const m = A.calMonth || A.day.slice(0, 7); const first = `${m}-01`; const len = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
    const cells = [...Array(dow(first)).fill(null), ...Array.from({ length: len }, (_, i) => `${m}-${String(i + 1).padStart(2, "0")}`)];
    const i = months.indexOf(m); const prev = i > 0 ? months[i - 1] : null; const next = i >= 0 && i < months.length - 1 ? months[i + 1] : null;
    return `<div class="scrim" data-act="close"></div><div class="sheet fixed-col" role="dialog" aria-label="Pick a date"><div class="grab"></div>
      <div class="calhead"><button class="ib" data-calm="${prev || ""}"${prev ? "" : " disabled"} aria-label="Previous month">${I.left}</button><div>${esc(monthLabel(m))}</div><button class="ib" data-calm="${next || ""}"${next ? "" : " disabled"} aria-label="Next month">${I.right}</button></div>
      <div class="calgrid">${WD1.map((w) => `<div class="w">${w}</div>`).join("")}${cells.map((d) => (d ? `<button class="cd${has[d] ? " has" : ""}${d === A.day ? " sel" : ""}${d === t ? " today" : ""}" data-day="${d}"${has[d] || d === t ? "" : " disabled"} aria-label="${esc(dayFull(d))}">${+d.slice(8)}<i></i></button>` : "<span></span>")).join("")}</div>
      <div class="calfoot"><span><i></i>Day has a brief · archive back to ${esc(monthLabel(months[0]))}</span><button class="linkb" data-act="today">Jump to today</button></div></div>`;
  }

  function expData() {
    const X = A.exp; const L = A.briefDay ? lists() : { news: [], prelims: [], editorials: [], explained: [] };
    if (X.scope === "story") { const s = findStory(X.story || A.open); return { items: s ? [s] : [], extra: [], title: s ? s.title : "Story note", sub: `Story note · ${s ? subjOf(s) : ""}` }; }
    if (X.scope === "saved") { const items = Object.keys(A.marks).filter((id) => A.marks[id].starred).map(findStory).filter(Boolean); return { items, extra: [], title: "My revision list", sub: `${items.length} starred · ${dayFull(todayIST())}` }; }
    return { items: L.news.concat(L.prelims), extra: L.editorials.concat(L.explained), title: "Daily Brief", sub: dayFull(A.day) };
  }
  // The Daily Brief PDF built with the site (export_pdf.py): the same file as the website's Export
  const pdfHref = (d) => (STATIC ? `../data/pdf/brief-${d}.pdf?v=${api.stamp()}` : `../api/pdf/${d}`);
  function fullPdf(d) {
    const ok = !STATIC || ((A.meta && A.meta.pdf_days) || []).includes(d);
    return ok ? `<a class="pdfdl" href="${esc(pdfHref(d))}" download="upsc-daily-brief-${d}.pdf" target="_blank" rel="noopener">${I.pdf}<span><b>Full Daily Brief · PDF</b><small>${esc(dayShort(d))}: a 10-12 line note on each must-know story, Prelims facts, editorials' arguments, source links</small></span></a>
      <div class="fine" style="margin:6px 0 10px">Or make your own below: pick what to include, then save it from the print dialog.</div>`
      : `<div class="fine" style="margin:4px 0 10px">The full PDF for ${esc(dayShort(d))} is built with the day's brief and isn't ready yet. You can make your own below.</div>`;
  }
  function renderExport() {
    const X = A.exp; const Dx = expData(); const o = X.opts;
    const scopes = [["brief", "Daily Brief"], ["saved", "Starred"], ["story", "This story"]].filter(([k]) => k !== "story" || X.story || A.open);
    const optDefs = [["sum", "8-point summaries"], ["vid", "YouTube video links"], ["links", "Article source links"], ["mains", "Mains questions"], ["notes", "My notes"], ["eds", "Editorials & explainers"]];
    const extra = X.scope === "brief" && o.eds ? Dx.extra.length : 0;
    return `<div class="scrim" data-act="close"></div><div class="sheet fixed-col" role="dialog" aria-label="Export as PDF"><div class="grab"></div>
      <div class="sheet-h"><div><div class="sheet-title">Export as PDF</div><div class="sheet-sub">${esc(Dx.sub)}</div></div><button class="x" data-act="close" aria-label="Close">${I.x}</button></div>
      ${X.scope === "brief" ? fullPdf(A.day) : ""}
      <div class="scopes">${scopes.map(([k, l]) => `<button class="${X.scope === k ? "on" : ""}" data-scope-pick="${k}">${l}</button>`).join("")}</div>
      <div class="expbody"><div class="a4" aria-hidden="true"><div class="a4-h">${LOGO(11)}<span>UPSC Intel</span><small>${esc(dayShort(X.scope === "brief" ? A.day : todayIST()))}</small></div><div class="a4-rule"></div>
        <div class="a4-t">${esc(X.scope === "story" ? "Story note" : Dx.title)}</div>${Dx.items.slice(0, 3).map((s) => `<div class="a4-i"><div class="m"><b>${esc(s.grade)}</b>${esc(subjOf(s))}</div><div class="tt">${esc(s.title.slice(0, 90))}</div><i></i><i style="width:92%"></i><i style="width:80%"></i>${o.vid && storyVideos(s).length ? `<div class="v">▶ ${esc(storyVideos(s)[0][0].channel || "YouTube")}</div>` : ""}</div>`).join("")}</div>
        <div class="toggles"><div class="ph">Include</div>${optDefs.map(([k, l]) => `<button class="tg${o[k] ? " on" : ""}" data-opt="${k}" aria-pressed="${!!o[k]}"><span>${l}</span><i class="sw"></i></button>`).join("")}</div></div>
      <div class="expmeta">${plural(Dx.items.length, "story", "stories")}${extra ? ` + ${extra} editorials & explainers` : ""} · A4 · about ${plural(Math.max(1, Math.ceil(Dx.items.length * 0.6) + (extra ? Math.ceil(extra / 6) : 0)), "page")} · every video and article is a tappable link</div>
      <button class="bigbtn" data-act="runexport"${X.busy ? " disabled" : ""}>${I.pdf}${X.busy ? "Building your PDF…" : "Generate PDF"}</button>
      <div class="fine">Opens your print dialog. Choose “Save as PDF”.</div></div>`;
  }
  function buildPdf(items, extra, title, sub) {
    const o = A.exp.opts; const E = esc;
    const story = (s, i) => {
      const e = s.explain || {}; const pts = pointsFor(s).points; const v = storyVideos(s)[0]; const note = mark(s.id).note;
      return `<article><div class="meta"><span class="n">${i + 1}</span><span class="g g-${E(s.grade)}">${E(s.grade)}</span>${(s.gs || []).map((g) => `<span class="gs">${E(g)}</span>`).join("")}<span class="subj">${E(subjOf(s))}</span></div>
<h2>${E(s.title)}</h2>${whyOf(s) ? `<p class="why"><b>Why in news:</b> ${E(whyOf(s, 400))}</p>` : ""}
${o.sum && pts.length ? `<div class="box"><div class="lbl">Summary</div><ol>${pts.map((l) => `<li>${E(l)}</li>`).join("")}</ol></div>` : ""}
${(e.prelims || []).length ? `<div class="lbl">Prelims facts</div><ul>${e.prelims.map((l) => `<li>${E(l)}</li>`).join("")}</ul>` : ""}
${o.mains ? `<div class="mq"><span class="lbl">Mains · ${E(paperOf(s))}</span> ${E(mainsOf(s))}</div>` : ""}
${o.notes && note ? `<div class="note"><span class="lbl">My note</span> ${E(note)}</div>` : ""}
<div class="links">${o.vid ? (v ? `<a class="yt" href="${E(safeUrl(v[0].url))}">▶ ${E(v[0].title)} <span>· ${E(v[0].channel || "")} · YouTube</span></a>` : `<a class="yt" href="${E(ytSearch(s))}">▶ Find a video <span>· YouTube search</span></a>`) : ""}
${o.links ? `<div class="src"><span class="lbl">Read the original</span> ${(s.sources || []).map((x) => `<a href="${E(safeUrl(x.u))}">${E(x.p || "Source")} ↗</a>`).join(" · ")}</div>` : ""}</div></article>`;
    };
    const small = (s) => `<div class="mini"><span class="kind">${s.editorial ? "EDITORIAL" : "EXPLAINED"}</span> <b>${E(s.title)}</b> <span class="src2">${E(srcName(s))}</span><div>${E(whyOf(s, 300))}</div>${o.links && s.sources && s.sources[0] ? `<a href="${E(safeUrl(s.sources[0].u))}">Read on ${E(srcName(s))} ↗</a>` : ""}</div>`;
    const logo = '<svg viewBox="0 0 48 48" width="30" height="30"><rect width="48" height="48" rx="12" fill="#1c5cab"/><path d="M15 17v9a9 9 0 0 0 18 0v-9" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="33" cy="8.5" r="3.6" fill="#fab219"/></svg>';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${E(title)}</title><style>
@page{size:A4;margin:16mm 15mm 18mm}*{box-sizing:border-box}body{margin:0;padding:16px;font:10.5pt/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0b0b0b;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media print{body{padding:0}}
header{display:flex;align-items:center;gap:10px;border-bottom:2px solid #0b0b0b;padding-bottom:10px}header .b{font-weight:800;font-size:13pt;letter-spacing:-.01em}header .d{margin-left:auto;font-size:9pt;color:#52514e;text-align:right}
.cover{padding:18px 0 14px;border-bottom:1px solid #e1e0d9;margin-bottom:6px}.eyebrow{font-size:8.5pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#184f95}h1{font-family:Georgia,"Iowan Old Style",serif;font-size:26pt;line-height:1.1;margin:6px 0;letter-spacing:-.01em}.cover p{margin:0;color:#52514e}
.toc{columns:2;column-gap:20px;font-size:9pt;margin:10px 0 0;padding:0;list-style:none}.toc li{break-inside:avoid;padding:2px 0;border-bottom:1px dotted #c3c2b7}
article{padding:14px 0;border-bottom:1px solid #e1e0d9;break-inside:avoid-page}.meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:8pt;font-weight:700}.n{background:#0b0b0b;color:#fff;border-radius:4px;min-width:18px;height:18px;padding:0 3px;display:inline-grid;place-items:center}.g{padding:1px 5px;border-radius:3px}.g-NOTE{background:#1c5cab;color:#fff}.g-SKIM{background:#b7d3f6;color:#0d366b}.g-READ{background:#eceae4;color:#52514e}.gs{border:1px solid #c3c2b7;padding:0 5px;border-radius:3px;color:#52514e}.subj{color:#52514e;font-weight:600}
h2{font-family:Georgia,"Iowan Old Style",serif;font-size:15pt;line-height:1.25;margin:6px 0 4px}.why{margin:0 0 8px;color:#52514e}.why b{color:#0b0b0b}
.box{background:#f5f8fd;border:1px solid #d6e5f9;border-radius:8px;padding:8px 12px 6px;margin:6px 0 8px}.box ol{margin:4px 0 2px;padding-left:18px}.box li{margin:1px 0}.lbl{font-size:7.5pt;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#184f95}ul{margin:3px 0 8px;padding-left:18px}
.mq{background:#0b0b0b;color:#fff;border-radius:8px;padding:8px 12px;font-style:italic;margin:6px 0}.mq .lbl{color:#9ec5f4;font-style:normal;margin-right:6px}.note{border-left:3px solid #2a78d6;padding:4px 10px;margin:6px 0;background:#f2f1ed;white-space:pre-wrap}
.links{display:grid;gap:4px;margin-top:6px;font-size:9.5pt}a{color:#1c5cab;text-decoration:none}.yt{color:#b42525;font-weight:650}.yt span{color:#7a7873;font-weight:400}.src a{font-weight:600}
section.more{break-before:page}section.more h3{font-family:Georgia,serif;font-size:16pt;margin:0 0 8px;border-bottom:2px solid #0b0b0b;padding-bottom:6px}.mini{padding:8px 0;border-bottom:1px solid #e1e0d9;break-inside:avoid}.kind{font-size:7.5pt;font-weight:800;background:#f2f1ed;padding:1px 5px;border-radius:3px}.src2{color:#7a7873;font-size:9pt}.mini div{color:#52514e;margin:2px 0}
footer{margin-top:18px;font-size:8.5pt;color:#7a7873;display:flex;justify-content:space-between;gap:12px}
</style></head><body><header>${logo}<span class="b">UPSC Intel</span><span class="d">${E(sub)}<br>Generated ${E(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }))} IST</span></header>
<div class="cover"><div class="eyebrow">${E(sub)}</div><h1>${E(title)}</h1><p>${plural(items.length, "story", "stories")}${o.sum ? " · summaries" : ""}${o.vid ? " · video links" : ""}${o.links ? " · source links" : ""}</p>${items.length > 1 ? `<ol class="toc">${items.map((s, i) => `<li>${i + 1}. ${E(s.title)}</li>`).join("")}</ol>` : ""}</div>
${items.map(story).join("")}
${extra && extra.length && o.eds ? `<section class="more"><h3>Editorials &amp; explainers</h3>${extra.map(small).join("")}</section>` : ""}
<footer><span>UPSC Intel · summaries quote what the covering outlets published</span><span>mrityurequest20-cyber.github.io/UPSC</span></footer></body></html>`;
  }
  function runExport() {  // runs inside the click: a phone opens the printable page in a new tab (pop-ups need the click)
    const X = A.exp; const Dx = expData();
    if (!Dx.items.length) { toast("Nothing to export yet. Star a few stories first."); return; }
    const html = buildPdf(Dx.items, X.scope === "brief" ? Dx.extra : [], Dx.title, Dx.sub);
    const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    const w = touch ? window.open("", "_blank") : null;
    if (w) {
      w.document.open(); w.document.write(html); w.document.close();
      setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* the page stays open to print or share */ } }, 600);
    } else {
      const f = document.createElement("iframe");
      f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
      document.body.appendChild(f);
      const doc = f.contentDocument; doc.open(); doc.write(html); doc.close();
      setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { /* print blocked */ } setTimeout(() => f.remove(), 60000); }, 450);
    }
    closeTop();
    toast(`PDF ready: ${plural(Dx.items.length, "story", "stories")}. Choose “Save as PDF” in the print dialog.`);
  }

  function renderSearch() {
    const S2 = A.search;
    return `<div class="scrim" data-act="close"></div><div class="sheet fixed-col" role="dialog" aria-label="Search"><div class="grab"></div>
      <div class="sheet-h"><div><div class="sheet-title">Search</div><div class="sheet-sub">${STATIC ? "The brief archive; tap “Search everything” for every story" : "Every story on this server"}</div></div><button class="x" data-act="close" aria-label="Close">${I.x}</button></div>
      <form class="searchin" id="searchForm"><input id="searchQ" type="search" placeholder="e.g. repo rate, Western Ghats, Article 356" value="${esc(S2.q)}" autocomplete="off" enterkeyhint="search"><button class="send" type="submit" aria-label="Search">${I.right}</button></form>
      <div id="searchOut">${searchResults()}</div></div>`;
  }
  function searchResults() {
    const S2 = A.search;
    if (S2.busy) return '<div class="loading" style="padding:20px">Searching…</div>';
    if (!S2.q) return "";
    return `<div class="results">${S2.results.map(mrow).join("")}</div>${!S2.results.length ? `<p class="fine">Nothing matches “${esc(S2.q)}”.</p>` : ""}
      ${STATIC && !S2.wide ? '<button class="btn-s" style="margin-top:10px" data-act="searchwide">Search everything (downloads ~2 MB a month)</button>' : ""}`;
  }
  async function doSearch(q, wide) {
    A.search.q = q; A.search.busy = true; A.search.wide = !!wide; const out = $("#searchOut"); if (out) out.innerHTML = searchResults();
    try { if (STATIC) await ensure30(); A.search.results = await api.search(q, wide); } catch (e) { A.search.results = []; }
    A.search.busy = false; const o2 = $("#searchOut"); if (o2) o2.innerHTML = searchResults();
  }

  // ─────────────────────────── Ask Intel ───────────────────────────
  const bot = CORE.makeBot({
    labels: () => A.meta && A.meta.labels,
    folded: (id) => foldedOf(id),
    pool: () => [...A.byId.values()],
    day: () => (A.briefDay ? { label: dayLabel(A.briefDay), cards: lists().news, prelims: lists().prelims, more: lists().more, editorials: lists().editorials, explained: lists().explained } : null),
    videos: storyVideos,
    dayShort,
  });
  const STORY_CHIPS = [...QUICK, "Summary", "Search the web", "5W", "Other outlets", "✦ Intel AI", "Ask Claude ↗"];
  const INSIGHT_CHIPS = ["30-min catch-up plan", "My blind spots", "Ask Claude ↗"];
  function botCtxStory() { const c = A.bot.ctx; return c && c.kind === "story" ? findStory(c.id) : null; }
  function openBot(ctx, first) {
    const same = A.bot.ctx && ctx && A.bot.ctx.kind === ctx.kind && A.bot.ctx.id === ctx.id && A.bot.ctx.subj === ctx.subj;
    if (!same) {
      A.bot.ctx = ctx; A.bot.log = [];
      const s = ctx.kind === "story" ? findStory(ctx.id) : null;
      const hello = s ? ""
        : ctx.kind === "insights" ? "<p>I can see your last 30 days: what you've finished, by paper and subject. Want a catch-up plan for your blind spots?</p>"
          : `<p>I have the full brief for ${esc(dayLabel(A.briefDay || A.day))}. Ask what to read first, one GS paper, or a topic like “RBI”.</p>`;
      if (hello) A.bot.log.push({ me: false, html: hello });
    }
    openSheet("bot");
    const s = ctx.kind === "story" && !same ? findStory(ctx.id) : null;
    setTimeout(async () => {
      if (s) await botAsk("Summary", { auto: true });  // a story's summary comes first, without asking
      if (first) botAsk(first);
    }, 60);
  }
  function renderBot() {
    const B = A.bot; const s = botCtxStory();
    const ctx = s ? `About: ${s.title}` : B.ctx && B.ctx.kind === "insights" ? "About: your preparation insights" : `About: the Daily Brief · ${dayLabel(A.briefDay || A.day)}`;
    const chips = s ? STORY_CHIPS : B.ctx && B.ctx.kind === "insights" ? INSIGHT_CHIPS : bot.chips(null);
    return `<div class="scrim" data-act="close"></div><div class="bot fixed-col" role="dialog" aria-label="Ask Intel"><div class="grab"></div>
      <div class="bot-h">${LOGO(32)}<div><b>Ask Intel</b><small>${esc(ctx)}</small></div><button class="x" data-act="close" aria-label="Close">${I.x}</button></div>
      <div class="bot-log" id="botLog" aria-live="polite">${botLogHtml()}</div>
      <div class="bot-chips nosb">${chips.map((c) => `<button class="${/claude/i.test(c) ? "claude" : /intel ai/i.test(c) ? `gem${CORE.gemini.on() ? " on" : ""}` : ""}" data-ask="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <form class="bot-in" id="botForm"><input id="botQ" placeholder="${s ? "Ask about this article…" : "Ask about the brief…"}" autocomplete="off" enterkeyhint="send" aria-label="Your question"><button class="send" type="submit" aria-label="Send">${I.send}</button></form>
      <div class="bot-foot">Answers quote the reports, the free full article (paywalled sites are never opened) and Wikipedia. Switch on ✦ Intel AI (a free Google key, kept only on this phone) and Intel answers in its own words from the article. “Ask Claude” opens Claude on your own account.</div></div>`;
  }
  function botLogHtml() {  // the conversation, and while busy: Intel AI's answer as it types, or what the bot is doing
    const B = A.bot;
    return B.log.map((m) => `<div class="msg${m.me ? " me" : ""}">${m.html}</div>`).join("")
      + (B.busy ? (B.partial ? `<div class="msg">${B.partial}</div>` : `<div class="busy"><i></i>${esc(B.step || "Intel is reading the coverage…")}</div>`) : "");
  }
  function paintBot() {  // refresh the log only: the input keeps focus and what you're typing
    const log = $("#botLog"); if (!log) return;
    log.innerHTML = botLogHtml();
    log.scrollTop = log.scrollHeight;
  }
  CORE.listen.provider(() => { const L = lists(); return CORE.listenItems(L.news, L.prelims); });  // 🎧 Listen: the open day's cards
  CORE.gemini.bind((r) => {  // switched on or off: the confirmation takes the key form's place (an error goes under it)
    const L = A.bot.log; const i = L.map((m) => /gem-box/.test(m.html)).lastIndexOf(true);
    if (r.ok && i >= 0) L[i] = { me: false, html: r.html }; else L.push({ me: false, html: r.html });
    if (A.sheet === "bot") renderLayer(true);
  });
  function askClaude(q) {  // inside the click: a tab opened after an await is blocked as a pop-up
    const s = botCtxStory(); const B = A.bot;
    let prompt;
    if (B.ctx && B.ctx.kind === "insights") {
      const R = range30(); const M = R ? insightsModel(R) : null;
      prompt = CORE.claudePrompt(null, q || "Build me a 30-minute UPSC catch-up plan for my blind spots from these stories.", M ? `MY LAST 30 DAYS: ${M.read}\nPaper mastery: ${M.mastery.map((m) => `${m.p} ${m.total ? m.pct + "%" : "n/a"}`).join(", ")}\nBlind spots: ${M.blind.map((b) => `${b.name} (${b.n}/${b.total})`).join(", ") || "none"}\nUNFINISHED STORIES THIS WEEK:\n${planItems(null).map((x) => `- ${x.title}`).join("\n")}` : "");
    } else prompt = bot.claudeFor(s, q || B.last);
    const opened = CORE.openClaude(prompt);
    B.log.push({ me: true, html: "<p>Ask Claude ↗</p>" });
    B.log.push({ me: false, html: `<p>${opened ? "Opened Claude in a new tab with this context and your question." : 'Your browser blocked the new tab: open <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a>.'} The prompt is also copied: if Claude opens empty, paste it.</p><p class="bot-src">Claude answers on your own Claude account (the free plan works); nothing is sent from this app.</p>` });
    paintBot();
  }
  function planItems(subj) {  // unfinished brief cards from the last 7 days, blind-spot subjects first, NOTE first
    const R = R30.data; if (!R) return [];
    const t = todayIST(); const M = insightsModel(R); const weak = new Set(subj ? [subj] : M.blind.map((b) => b.k));
    const seen = new Set(); const pool = [];
    for (let d = t; d >= addDays(t, -6); d = addDays(d, -1)) for (const id of cardIds(R.days[d] || {})) { const s = R.byId.get(id); if (s && !seen.has(id) && !isDone(s)) { seen.add(id); pool.push(s); } }
    const rankOf = (s) => ((s.subjects || []).some((k) => weak.has(k)) ? 0 : 1) * 10 + ({ NOTE: 0, SKIM: 1, READ: 2 }[s.grade] ?? 3);
    const pickd = []; let mins = 0;
    for (const s of pool.filter((x) => !subj || (x.subjects || []).includes(subj)).sort((a, b) => rankOf(a) - rankOf(b) || b.score - a.score)) {
      if (mins + minutesOf(s) > 32) continue;
      pickd.push(s); mins += minutesOf(s);
      if (mins >= 27) break;
    }
    return pickd;
  }
  async function insightAnswer(q) {
    const R = await ensure30(); if (!R) return "<p>Couldn't load your last 30 days: check the connection.</p>";
    const M = insightsModel(R); const subj = A.bot.ctx && A.bot.ctx.subj;
    if (/blind/i.test(q)) return M.blind.length ? `<p class="bot-sub">Blind spots · last 30 days</p><ul>${M.blind.map((b) => `<li><b>${esc(b.name)}</b>: ${b.n} of ${b.total} read <button class="linkbtn" data-plan="${esc(b.k)}">Plan for this</button></li>`).join("")}</ul>` : "<p>No blind spot right now: every subject with 3+ stories has a quarter or more done.</p>";
    const items = planItems(subj);
    if (!items.length) return `<p>Nothing unfinished${subj ? ` in ${esc(subjName(subj))}` : ""} from the last 7 days. Nice.</p>`;
    const total = items.reduce((n, s) => n + minutesOf(s), 0);
    return `<p class="bot-sub">Your ${total}-minute catch-up${subj ? ` · ${esc(subjName(subj))}` : ""}</p><ol class="plan">${items.map((s) => `<li><span class="pill g-${esc(s.grade)}">${esc(s.grade)}</span> ${esc(s.title)} <span class="bot-src">${esc(subjOf(s))} · ${minutesOf(s)} min · ${esc(dayShort(s.date))}</span> <button class="linkbtn" data-open-story="${esc(s.id)}">Open</button></li>`).join("")}</ol>
      <p class="bot-src">Unfinished stories from the last 7 days${subj ? "" : ", your blind-spot subjects first"}, NOTE grade first. Tick ✓ on each as you finish.</p>`;
  }
  async function botAsk(q, opts = {}) {
    const B = A.bot; if (B.busy) return;
    const s = botCtxStory();
    if (!opts.url && bot.intentOf(q) === "claude") { askClaude(""); return; }
    if (!opts.auto) B.log.push({ me: true, html: `<p>${esc(opts.label || q)}</p>` });
    B.busy = true; B.step = ""; B.partial = "";
    if (!opts.url) B.last = q;
    paintBot();
    const onStep = (m) => { B.step = m; paintBot(); };
    const onPartial = (h) => { B.partial = h; paintBot(); };  // Intel AI's answer as it types
    let html;
    try {
      if (opts.url) html = await bot.read(opts.url, onStep);
      else if (B.ctx && B.ctx.kind === "insights") html = await insightAnswer(q);
      else html = await bot.answer(s, q, { onStep, onPartial, deep: opts.deep });
    } catch (e) { html = `<p>Something went wrong: ${esc(e.message)}</p>`; }
    B.busy = false; B.step = ""; B.partial = ""; B.log.push({ me: false, html }); B.log = B.log.slice(-40); paintBot();
  }

  // ─────────────────────────── layers: story view and sheets (the back button closes them) ───────────────────────────
  function openStory(id) {  // from a sheet (search, a plan), the story takes the sheet's place in the history
    const s = findStory(id); if (!s) { toast("That story isn't loaded."); return; }
    const fromSheet = !!A.sheet;
    A.sheet = null; A.open = id;
    if (fromSheet && history.state && history.state.layer) history.replaceState({ layer: "story" }, ""); else history.pushState({ layer: "story" }, "");
    renderLayer();
    startSummary(s);  // the article's summary, without asking
  }
  function openSheet(kind) { A.sheet = kind; history.pushState({ layer: kind }, ""); renderLayer(); }
  function closeTop() { if (history.state && history.state.layer) history.back(); else { if (A.sheet) A.sheet = null; else A.open = null; renderLayer(); } }
  window.addEventListener("popstate", () => { if (A.sheet) A.sheet = null; else if (A.open) A.open = null; renderLayer(); renderScreen(); });
  function renderLayer(keepScroll) {
    const layer = $("#layer"); const body = $("#storyBody"); const y = keepScroll && body ? body.scrollTop : 0;
    const s = A.open ? findStory(A.open) : null;
    const sheet = A.sheet === "cal" ? renderCal() : A.sheet === "export" ? renderExport() : A.sheet === "bot" ? renderBot() : A.sheet === "search" ? renderSearch() : "";
    layer.innerHTML = (s ? renderStory(s) : "") + sheet;
    document.documentElement.style.overflow = s || A.sheet ? "hidden" : "";
    if (keepScroll && $("#storyBody")) $("#storyBody").scrollTop = y;
    if (A.sheet === "bot") { paintBot(); const f = $("#botForm"); f.addEventListener("submit", (e) => { e.preventDefault(); const q = $("#botQ").value.trim(); if (q) { $("#botQ").value = ""; botAsk(q); } }); }
    if (A.sheet === "search") {
      const f = $("#searchForm"); const input = $("#searchQ");
      f.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value.trim(); if (q.length >= 2) { input.blur(); doSearch(q); } });
      setTimeout(() => input.focus(), 250);
    }
  }

  // ─────────────────────────── header, tabs, screen ───────────────────────────
  function renderLive() {
    const el = $("#live"); if (!el || !A.meta) return;
    const off = navigator.onLine === false;
    el.innerHTML = `<span class="live-dot${off ? " off" : ""}"></span><span>${off ? `Offline · data from ${esc(ago(A.meta.built_at))}` : `Live · updated ${esc(ago(A.meta.built_at))}`}</span>`;
  }
  function renderTabs() {
    const n = Object.values(A.marks).filter((m) => m.starred).length;
    $("#tabbar").innerHTML = TABS.map((t) => `<button class="${A.tab === t.key ? "on" : ""}" data-tab="${t.key}" aria-current="${A.tab === t.key ? "page" : "false"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${A.tab === t.key ? 2.3 : 1.8}" stroke-linecap="round" stroke-linejoin="round"><path d="${t.d}"/></svg><span>${t.label}</span>${t.key === "saved" && n ? `<span class="badge">${n}</span>` : ""}</button>`).join("");
    $("#title").textContent = (TABS.find((x) => x.key === A.tab) || TABS[0]).title;
  }
  // Practice: the shared widget (intel-core.js), mounted once and kept while you answer a set
  const PX = { el: null, w: null };
  const practiceDays = () => (STATIC ? ((A.meta && A.meta.practice_days) || []) : ((A.meta && A.meta.day_files) || [])).slice().sort().reverse();
  function practiceDay() {
    const have = practiceDays();
    return !STATIC || have.includes(A.day) ? A.day : (have.find((d) => d <= A.day) || have[0] || A.day);
  }
  const pxHost = {
    day: practiceDay,
    days: practiceDays,
    load: (d) => api.json(STATIC ? `../data/practice/${d}.json?v=${api.stamp()}` : `../api/practice/${d}`),
    label: (d) => `${dayShort(d)}${d === todayIST() ? " (today)" : ""}`,
    subject: (k) => subjName(k),
    claude: (prompt) => CORE.openClaude(prompt),
    cardDays: () => (STATIC ? ((A.meta && A.meta.cards_days) || []) : practiceDays()).slice().sort().reverse(),
    loadCards: (d) => api.json(STATIC ? `../data/cards/${d}.json?v=${api.stamp()}` : `../api/cards/${d}`),
    loadDay: (d) => api.json(STATIC ? `../data/day/${d}.json?v=${api.stamp()}` : `../api/brief?from=${d}&to=${d}`),
  };
  function renderPractice() {
    const scr = $("#screen");
    if (PX.el && scr.contains(PX.el)) { PX.w.setDay(practiceDay()); return; }
    scr.innerHTML = '<div class="pxwrap"><div id="pxRoot"></div></div>';
    PX.el = $("#pxRoot"); PX.w = CORE.mountPractice(PX.el, pxHost);
  }
  function renderScreen() {
    if (A.tab === "practice") { renderPractice(); renderTabs(); return; }
    const html = A.tab === "read" ? renderRead() : A.tab === "insights" ? renderInsights() : A.tab === "review" ? renderReview() : A.tab === "saved" ? renderSaved() : renderBrief();
    $("#screen").innerHTML = html;
    renderTabs();
    watchCards();
  }
  function rerenderCard(id) {  // a star or tick on a list: repaint in place, keep the scroll
    renderScreen();
    if (A.open === id) renderLayer(true);
  }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.innerHTML = `<div>${esc(msg)}</div>`; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  async function loadDay(d, fresh) {
    if (!fresh && A.briefDay === d && A.brief) return;
    try {
      const x = await api.day(d);
      A.brief = x; A.briefDay = d; A.byId = new Map(x.stories.map((s) => [s.id, s]));
      for (const s of x.stories) A.cache.set(s.id, s);
    } catch (e) {
      A.brief = { days: {}, stories: [], videos: {} }; A.briefDay = d; A.byId = new Map();
      toast(navigator.onLine === false ? "You're offline and this day isn't saved on the phone yet." : `Couldn't load the brief (${e.message}).`);
    }
  }
  async function goDay(d) {
    A.day = d; A.moreOpen = new Set(); A.lowOpen = false; A.gs = "All";
    if (A.tab !== "brief" && A.tab !== "read") A.tab = "brief";
    renderScreen(); window.scrollTo(0, 0);
    await loadDay(d); if (A.day === d) renderScreen();
  }

  // ─────────────────────────── events ───────────────────────────
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("button, a, [data-open], [data-open-story]");
    if (!t) return;
    if (t.tagName === "A" && !t.dataset.act) return;  // links open normally
    const act = t.dataset.act;
    if (t.dataset.tab) { if (A.tab !== t.dataset.tab) { A.tab = t.dataset.tab; renderScreen(); window.scrollTo(0, 0); } return; }
    if (t.dataset.day) { if (A.sheet === "cal") closeTop(); goDay(t.dataset.day); return; }
    if (t.dataset.gs) { A.gs = t.dataset.gs; renderScreen(); return; }
    if (t.dataset.seg) { A.readSeg = t.dataset.seg; renderScreen(); return; }
    if (t.dataset.period) { A.period = t.dataset.period; renderScreen(); return; }
    if (t.dataset.calm !== undefined) { if (t.dataset.calm) { A.calMonth = t.dataset.calm; renderLayer(); } return; }
    if (t.dataset.scopePick) { A.exp.scope = t.dataset.scopePick; renderLayer(true); return; }
    if (t.dataset.opt) { A.exp.opts[t.dataset.opt] = !A.exp.opts[t.dataset.opt]; store.set("upsc-app-pdf", A.exp.opts); renderLayer(true); return; }
    if (t.dataset.ask) {
      const q = t.dataset.ask;
      if (!A.sheet) { if (/claude/i.test(q)) { A.bot.ctx = null; openBot({ kind: "story", id: A.open }); askClaude(""); return; } openBot({ kind: "story", id: A.open }, q); return; }
      if (/claude/i.test(q)) { askClaude(""); return; }
      if (/catch-up plan/i.test(q)) { botAsk(q); return; }
      botAsk(q); return;
    }
    if (t.dataset.openStory) { openStory(t.dataset.openStory); return; }
    if (t.dataset.plan) { A.bot.ctx.subj = t.dataset.plan; botAsk(`Catch-up plan: ${subjName(t.dataset.plan)}`); return; }
    if (t.dataset.bot) {  // buttons inside the bot's answers
      const b = t.dataset.bot;
      if (b === "chip") botAsk(t.dataset.q);
      else if (b === "wiki") botAsk(`What is ${t.dataset.term}?`);
      else if (b === "deeper") botAsk(t.dataset.q, { deep: true, label: "Look in the full article" });
      else if (b === "read") botAsk("", { url: t.dataset.url, label: `Summarise ${CORE.web.domainOf(t.dataset.url)}` });
      else if (b === "claude") askClaude(t.dataset.q);
      else if (b === "story") { A.bot.ctx = null; openBot({ kind: "story", id: t.dataset.id }); renderLayer(); }
      return;
    }
    if (act === "star" || act === "done") {
      ev.stopPropagation();
      const s = findStory(t.dataset.id); if (!s) return;
      const on = act === "star" ? !isStar(s) : !isDone(s);
      setMark(s, act === "star" ? { starred: on } : { read: on }).then(() => rerenderCard(s.id));
      if (act === "done" && on && A.open === s.id) toast("Marked done. Nice.");
      return;
    }
    if (t.dataset.open && !act) { openStory(t.dataset.open); return; }
    switch (act) {
      case "close": closeTop(); break;
      case "cal": A.calMonth = A.day.slice(0, 7); openSheet("cal"); break;
      case "today": if (A.sheet) closeTop(); goDay(todayIST()); break;
      case "export": A.exp.scope = t.dataset.scope || (A.open ? "story" : A.tab === "saved" ? "saved" : "brief"); A.exp.story = A.open; openSheet("export"); break;
      case "runexport": runExport(); break;
      case "search": openSheet("search"); break;
      case "searchwide": doSearch(A.search.q, true); break;
      case "askday": openBot({ kind: "brief" }); break;
      case "askstory": openBot({ kind: "story", id: A.open }); break;
      case "claude": A.bot.ctx = null; openBot({ kind: "story", id: A.open }); askClaude(""); break;
      case "plan": A.bot.ctx = null; openBot({ kind: "insights", subj: t.dataset.subj || null }, t.dataset.subj ? `Catch-up plan: ${subjName(t.dataset.subj)}` : "30-min catch-up plan"); break;
      case "moreall": A.moreOpen.add(t.dataset.k || ""); renderScreen(); break;
      case "lowopen": A.lowOpen = !A.lowOpen; renderScreen(); break;
      default: break;
    }
  });
  let noteTimer;
  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.note) {
      const id = t.dataset.note; const v = t.value;
      clearTimeout(noteTimer); noteTimer = setTimeout(() => { const s = findStory(id); if (s) setMark(s, { note: v }); }, 400);
    }
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && (A.sheet || A.open)) closeTop(); });
  window.addEventListener("scroll", () => { $("#top").classList.toggle("scrolled", window.scrollY > 4); }, { passive: true });
  window.addEventListener("online", renderLive);
  window.addEventListener("offline", renderLive);

  // ─────────────────────────── boot ───────────────────────────
  async function poll() {  // a new build every ~20 minutes: pick it up without a reload
    try {
      const m = await api.meta();
      if (m.built_at !== A.meta.built_at) {
        const size = () => { const L = lists(); return L.news.length + L.prelims.length + L.more.length; };
        const before = A.briefDay === todayIST() ? size() : null;
        A.meta = m; A.months.clear();
        if (A.day === todayIST()) {
          await loadDay(A.day, true);
          const after = size();
          if (before != null && after > before) toast(`Updated: ${plural(after - before, "new story", "new stories")} in today's brief.`);
        }
        if (!A.open && !A.sheet) renderScreen();
      }
    } catch (e) { /* offline: try again next time */ }
    renderLive();
  }
  async function boot() {
    try { [A.meta, A.marks] = await Promise.all([api.meta(), api.marks()]); }
    catch (e) { $("#screen").innerHTML = `<div class="empty">Couldn't reach the data (${esc(e.message)}).<br>Check your connection and reopen the app.</div>`; return; }
    const q = new URLSearchParams(location.search);
    if (q.get("tab") && TABS.some((x) => x.key === q.get("tab"))) A.tab = q.get("tab");
    renderLive(); renderTabs();
    await goDay(todayIST());
    setInterval(poll, STATIC ? 300000 : 60000);
    setInterval(renderLive, 30000);
    if (STATIC && "serviceWorker" in navigator) {
      // A new build's app takes over as soon as it has downloaded: right after opening, reload into it (so an update
      // needs one open, not two); later, say so instead of reloading under your fingers.
      const had = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!had) return;  // the first install: this page is already the latest
        if (performance.now() < 20000) location.reload(); else toast("A new version of the app is ready: close and reopen it to use it.");
      });
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }
  boot();
})();

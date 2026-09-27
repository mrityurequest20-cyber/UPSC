/* UPSC Intel core: the Ask bot's engine, shared by the dashboard and the app. Vanilla JS, no keys.
   - text:   words, sentences, ranking, extractive summaries (a summary quotes the article; nothing is made up)
   - web:    reads the free, public version of a story through Jina Reader (keyless, allows calls from
             any page) and searches the news (Bing News RSS, through the same reader) to find the same
             story on other sites. Only domains on OPEN_DOMAINS are read: subscriber-only and metered
             sites are never fetched, so no paywall is bypassed; a story whose own outlets are paywalled
             is read from a free site that carries it.
   - wiki:   background from Wikipedia's REST API (keyless, allows calls from any page)
   - claude: hands a question to Claude (claude.ai, on the viewer's own plan) with the story as context */
(function (root) {
  "use strict";

  // ─────────────────────────── text ───────────────────────────
  const STOPW = new Set(("a an the of in on at to for and or is are was were be been by with from as that this it its into about what " +
    "which who whom whose when where why how do does did can could should would will shall may might me my we our you your tell give " +
    "show explain please more some any all story news article say says said there their them they he she his her has have had not").split(" "));
  const stem = (w) => (w.length > 5 ? w.slice(0, 5) : w);
  const words = (t) => [...new Set((String(t || "").toLowerCase().match(/[a-z0-9ऀ-ॿ]+/g) || [])
    .filter((w) => w.length > 1 && !STOPW.has(w)).map(stem))];
  // A sentence ends at . ! or ? followed by a space, so "886.7 sq km" and "5.5%" stay whole; so do "Dr." and
  // initials ("V. D. Satheesan", "U.S."), whose dot is swapped for a look-alike while splitting (no regex
  // lookbehind: older iPhones can't parse it).
  const ABBR = /\b(Mr|Mrs|Ms|Dr|St|No|Nos|Rs|Sr|Jr|vs|Prof|Gen|Lt|Col|Capt|Govt|Dept|Hon|Rev|Sh|Smt|Art|Sec|Ch|Vol|approx|[A-Z])\.(?= )/g;
  const sentencesOf = (t) => (String(t || "").replace(/\s+/g, " ").replace(ABBR, "$1\u2024").match(/(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+(?=\s|$)|$)/g) || [])
    .map((x) => x.replace(/\u2024/g, ".").trim()).filter((x) => x.length > 30);
  // feed and page furniture that isn't reporting: "Source: The post … has been created based on …", "UPSC Syllabus: GS-3 …"
  const FURNITURE = /^(source\s*:|upsc syllabus|syllabus\s*:|the post\b.*\b(appeared first|has been created)|read more|also read|click here|subscribe)|has been created based on|appeared first on/i;
  const overlap = (a, b) => { const A = new Set(a); const n = b.filter((w) => A.has(w)).length; return n / (Math.min(A.size, b.length) || 1); };

  // corpus: [{text, src, head?}] → matches, best first: sc (score), hits (query words found), cover (hits / query
  // words) and share (the part of the weight of the query words the corpus has that the line covers; a rare word
  // like "villages" weighs more than "minister")
  function rank(corpus, q) {
    const qw = words(q); if (!qw.length) return [];
    const df = {}; for (const o of corpus) for (const w of words(o.text)) df[w] = (df[w] || 0) + 1;
    const n = corpus.length || 1;
    const idf = (w) => Math.log(1 + n / df[w]);
    const total = qw.filter((w) => df[w]).reduce((a, w) => a + idf(w), 0) || 1;
    return corpus.map((o, i) => {
      const ws = new Set(words(o.text)); let sc = 0; let hits = 0;
      for (const w of qw) if (ws.has(w)) { sc += idf(w); hits += 1; }
      return { ...o, i, sc: sc * (o.head ? 0.7 : 1), hits, share: sc / total, cover: hits / qw.length };
    }).filter((o) => o.hits > 0).sort((a, b) => b.sc - a.sc);
  }

  // Extractive summary: the sentences that carry the article's most repeated, most specific words, with a
  // lift for the lead (news puts the facts first); near-duplicates are dropped and document order is kept.
  function summarize(sents, n = 8) {
    const docs = sents.map((s) => words(s.text));
    const df = {}; for (const ws of docs) for (const w of ws) df[w] = (df[w] || 0) + 1;
    const N = sents.length || 1;
    const scored = sents.map((s, i) => {
      const ws = docs[i]; if (ws.length < 4) return { i, sc: 0 };
      let sc = 0; for (const w of ws) sc += Math.log(1 + N / df[w]) * (df[w] > 1 ? 1.4 : 1);
      return { i, sc: (sc / Math.sqrt(ws.length)) * (i < 2 ? 1.5 : i < 6 ? 1.15 : 1) };
    }).sort((a, b) => b.sc - a.sc);
    const picked = [];
    for (const x of scored) {
      if (picked.length >= n || !x.sc) break;
      if (picked.some((p) => overlap(docs[p], docs[x.i]) > 0.6)) continue;
      picked.push(x.i);
    }
    return picked.sort((a, b) => a - b).map((i) => sents[i]);
  }
  function brief(sents, maxWords = 60) {  // a ~60-word summary: the best sentences, in order, until the budget is spent
    const out = []; let count = 0;
    for (const s of summarize(sents, 5)) {
      const n = s.text.split(/\s+/).length;
      if (count && count + n > maxWords + 12) continue;
      out.push(s.text); count += n;
      if (count >= maxWords) break;
    }
    return out.join(" ");
  }

  // the story's key term, for background: an acronym or a named thing in the headline
  function termOf(s) {
    const e = s.explain || {};
    if (e.keywords && e.keywords.length) return e.keywords[0];
    const skip = new Set(["UPSC", "PM", "CM", "SC", "HC", "US", "UK", "EU", "UN", "LIVE", "IST", "GS", "NEW", "MP", "MLA", "CJI"]);
    const acr = (s.title.match(/\b[A-Z][A-Z0-9&-]{2,}\b/g) || []).find((x) => !skip.has(x) && !/^\d/.test(x));
    if (acr) return acr;
    const quoted = s.title.match(/[‘'"“]([^’'"”]{4,60})[’'"”]/); if (quoted) return quoted[1];
    const runs = s.title.replace(/^[^:|]{0,40}[:|]\s*/, "").match(/\b[A-Z][\w-]*(?:\s+(?:of|and|for|the|de|on)?\s*[A-Z][\w-]*){1,4}/g) || [];
    if (runs.length) return runs.sort((a, b) => b.length - a.length)[0];
    return searchQuery(s.title, 6);  // no named thing: the headline's content words
  }
  function termFrom(q) {  // "What is X?" → X
    const m = q.match(/(?:what(?:'s| is| are| was| were| does)|who(?:'s| is| was| are)|explain|meaning of|define|tell me about|background (?:of|on|to)|history of)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s*(?:mean)?[?.!]*$/i);
    const t = m ? m[1].replace(/\b(in|from) (this|the) (story|news|article)\b/i, "").trim() : "";
    return /^(it|this|that|the (background|context|history|story|issue|matter)|background|context|history)$/i.test(t) ? "" : t;
  }
  function searchQuery(title, n = 8) {  // a headline's content words, for a news search
    return (String(title).match(/[\p{L}\d][\p{L}\d'’-]*/gu) || [])
      .filter((w) => !STOPW.has(w.toLowerCase()) && !/^(says?|said|amid|over|after|new|its|his|her)$/i.test(w))
      .slice(0, n).join(" ");
  }

  // ─────────────────────────── web: read free pages, search the news ───────────────────────────
  const READER = "https://r.jina.ai/";
  // Free-to-read sites only. Metered and subscriber sites (The Hindu, Indian Express, Mint, ET, Business
  // Standard, BusinessLine, Frontline, FT, WSJ, NYT, Bloomberg, The Economist, Reuters…) are not listed,
  // so they are never fetched.
  const OPEN_DOMAINS = [
    // government, parliament, regulators, multilaterals, reference
    "gov.in", "nic.in", "sansad.in", "prsindia.org", "rbi.org.in", "sebi.gov.in", "un.org", "who.int", "worldbank.org",
    "imf.org", "wto.org", "unep.org", "undp.org", "unesco.org", "ipcc.ch", "wikipedia.org", "orfonline.org", "idsa.in",
    "manoharparrikaridsa.in", "scobserver.in", "barandbench.com",
    // Indian news that is free to read
    "ndtv.com", "indiatoday.in", "businesstoday.in", "news18.com", "firstpost.com", "wionews.com", "theprint.in", "thewire.in",
    "scroll.in", "downtoearth.org.in", "mongabay.com", "deccanherald.com", "deccanchronicle.com", "tribuneindia.com",
    "newindianexpress.com", "telegraphindia.com", "thestatesman.com", "timesofindia.indiatimes.com", "hindustantimes.com",
    "aninews.in", "ptinews.com", "uniindia.com", "ianslive.in", "financialexpress.com", "cnbctv18.com", "thequint.com",
    "outlookindia.com", "theweek.in", "freepressjournal.in", "dnaindia.com", "zeenews.india.com", "zeebiz.com", "abplive.com",
    "republicworld.com", "newsx.com", "lokmattimes.com", "thesouthfirst.com", "thefederal.com", "thenewsminute.com",
    "indiatvnews.com", "telanganatoday.com", "thehansindia.com", "siasat.com", "onmanorama.com", "mathrubhumi.com",
    "keralakaumudi.com", "jagran.com", "morungexpress.com", "nagalandpost.com", "sentinelassam.com", "greaterkashmir.com",
    "millenniumpost.in", "dailypioneer.com", "sundayguardianlive.com", "nationalheraldindia.com", "newsbytesapp.com",
    "psuwatch.com", "psuconnect.in", "indianmasterminds.com", "devdiscourse.com", "webindia123.com", "eurasiantimes.com",
    "aajtak.in", "amarujala.com", "livehindustan.com", "bhaskar.com",
    // world news that is free to read
    "aljazeera.com", "bbc.com", "bbc.co.uk", "apnews.com", "theguardian.com", "dw.com", "france24.com", "abc.net.au",
    "cnn.com", "dawn.com", "thedailystar.net", "jagonews24.com", "kathmandupost.com", "thehimalayantimes.com",
    "arabnews.com", "gulfnews.com", "khaleejtimes.com", "aa.com.tr", "tass.com",
    // UPSC prep sites
    "forumias.com", "insightsonindia.com", "vajiramandravi.com", "drishtiias.com", "nextias.com", "civilsdaily.com",
    "gktoday.in", "iasexpress.net", "clearias.com", "pwonlyias.com", "studyiq.com", "iasgyan.in", "jagranjosh.com",
    "visionias.in", "byjus.com", "testbook.com", "adda247.com",
  ];
  const PREMIUM_PATH = /\/(premium|prime|toi-plus|ht-premium|htpremium|subscriber|epaper|e-paper)(\/|$)/i;
  const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; } };
  function isOpen(u) {
    const d = domainOf(u);
    return !!d && !PREMIUM_PATH.test(u) && !/(^|\.)news\.google\./.test(d) && OPEN_DOMAINS.some((x) => d === x || d.endsWith("." + x));
  }
  const fail = (code, message) => Object.assign(new Error(message), { code });
  // The free reader allows about 20 pages a minute per device: every call waits for a slot in one shared budget,
  // so background summaries never starve what you asked for (they only run while the budget has room).
  const RATE = { max: 18, win: 60000, stamps: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readerLoad = () => { const now = Date.now(); RATE.stamps = RATE.stamps.filter((t) => now - t < RATE.win); return RATE.stamps.length; };
  async function slot() {
    while (readerLoad() >= RATE.max) await sleep(RATE.win - (Date.now() - RATE.stamps[0]) + 50);
    RATE.stamps.push(Date.now());
  }
  async function viaReader(url, signal) {
    await slot();
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    if (signal) signal.addEventListener("abort", () => ctl.abort());
    try {
      const r = await fetch(READER + url, { headers: { Accept: "application/json", "X-Retain-Images": "none" }, signal: ctl.signal });
      if (r.status === 429) {  // over the limit anyway: pause every caller for a minute
        const now = Date.now(); RATE.stamps = Array(RATE.max).fill(now);
        throw fail("rate", "The free reader is busy: try again in a minute.");
      }
      if (!r.ok) throw fail("http", `The page couldn't be read (${r.status}).`);
      return ((await r.json()).data || {});
    } catch (e) {
      if (e.code) throw e;
      throw fail("net", ctl.signal.aborted ? "Reading the page took too long." : "Couldn't reach the free reader.");
    } finally { clearTimeout(t); }
  }

  // A page's main text: prose lines (few links, sentence-shaped), minus furniture, taken from the densest
  // run of such lines. Menus, "related stories" and footers fall away.
  const BOILER = /^(advertisement|also read|read more|read also|follow us|subscribe|sign in|log ?in|download|click here|share|trending|related|©|copyright|all rights reserved|terms|privacy|visitor counter|release id|posted on|reported by|last updated|published on|read time|how may i help|show full article|track latest news)/i;
  // a "trending" teaser: a headline run into another story's dateline ("… says Mamata KOLKATA: Mamata Banerjee
  // alleged …"), or a quoted headline cut off with an ellipsis. An article's own dateline only opens a paragraph.
  const TEASER = (t) => /\S\s+[A-Z]{4,}(?:[ -][A-Z]{2,})*:\s/.test(t.slice(1)) || (/^[‘'"“]/.test(t) && /(\.\.\.|…)$/.test(t));
  function mainText(md) {
    const kept = [];
    String(md || "").split("\n").forEach((raw, i) => {
      const links = (raw.match(/\]\(/g) || []).length;
      const listed = /^\s*(\d+\.|[-*+])\s/.test(raw);
      const t = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\s*(\d+\.|[-*+])(\s+(\d+\.|[-*+]))*\s+/, "").replace(/[*_`#>|]+/g, " ").replace(/\s+/g, " ").trim();
      if (!t || FURNITURE.test(t) || BOILER.test(t) || TEASER(t)) return;
      const n = t.split(" ").length;
      if (links >= 2 && links * 12 > n) return;  // a list of links: navigation, "related stories"
      const sentence = /[.!?"”’)]$/.test(t);
      if ((n >= 14 && (sentence || n >= 28)) || (listed && n >= 8 && sentence)) kept.push({ i, t, n });
    });
    const runs = []; let cur = [];
    for (const k of kept) { if (cur.length && k.i - cur[cur.length - 1].i > 4) { runs.push(cur); cur = []; } cur.push(k); }
    if (cur.length) runs.push(cur);
    const size = (r) => r.reduce((s, x) => s + x.n, 0);
    const best = runs.sort((a, b) => size(b) - size(a))[0] || [];
    return best.map((x) => x.t).slice(0, 60);
  }

  const readCache = new Map();
  function read(url, signal) {  // → {url, domain, title, paragraphs, words}
    if (!isOpen(url)) return Promise.reject(fail("closed", "That site is subscriber-only or not on the free-to-read list."));
    if (!readCache.has(url)) {
      const p = viaReader(url, signal).then((d) => {
        const paragraphs = mainText(d.content);
        if (!paragraphs.length) throw fail("empty", "No article text on that page.");
        return { url, domain: domainOf(url), title: d.title || "", paragraphs, words: paragraphs.join(" ").split(/\s+/).length };
      });
      readCache.set(url, p); p.catch(() => readCache.delete(url));
    }
    return readCache.get(url);
  }

  const searchCache = new Map();
  function search(q, signal) {  // the news, through Bing News RSS → [{title, url, domain, snippet, date, open}]
    const key = q.toLowerCase();
    if (!searchCache.has(key)) {
      const feed = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=en-IN&cc=IN`;
      const p = viaReader(feed, signal).then((d) => {
        const out = [];
        for (const b of String(d.content || "").split(/\n(?=### \[)/)) {
          const m = b.match(/^### \[([^\]]+)\]\(([^)\s]+)\)/); if (!m) continue;
          let url = m[2]; const um = url.match(/[?&]url=([^&]+)/); if (um) { try { url = decodeURIComponent(um[1]); } catch (e) { continue; } }
          const rest = b.slice(m[0].length).split("\n").map((x) => x.trim()).filter(Boolean);
          const isDate = (x) => /^(mon|tue|wed|thu|fri|sat|sun), \d/i.test(x);
          const snippet = (rest.find((x) => !x.startsWith("[") && !isDate(x)) || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
          const date = rest.find(isDate) || "";
          out.push({ title: m[1].replace(/\\([[\]])/g, "$1"), url, domain: domainOf(url), snippet, date, open: isOpen(url) });
        }
        return out;
      });
      searchCache.set(key, p); p.catch(() => searchCache.delete(key));
    }
    return searchCache.get(key);
  }

  // A second search when the headline finds nothing free: the story's names, acronyms and numbers, which
  // other outlets repeat even when they word the headline differently.
  const GENERIC = new Set(("minister ministry government govt union centre center state states india indian national new " +
    "says said opinion editorial analysis explained explainer express tribune hindu mint civilsdaily forumias upsc prelims " +
    "mains however also while after before amid why how what don can will day today year years week month monday tuesday " +
    "wednesday thursday friday saturday sunday january february march april may june july august september october " +
    "november december jan feb mar apr jun jul aug sep sept oct nov dec").split(" "));
  function keyQuery(story) {  // the headline's names, acronyms and figures, the place, then its longest words: 3-5 terms
    const e = story.explain || {};
    const pubs = new Set((story.sources || []).flatMap((x) => words(x.p || "")));
    const terms = []; const has = (w) => terms.some((t) => t.toLowerCase() === w.toLowerCase());
    const ok = (w) => { const k = w.toLowerCase(); return k.length > 1 && !STOPW.has(k) && !GENERIC.has(k) && !pubs.has(stem(k)) && !has(w); };
    const tokens = story.title.split(/\s+/).map((raw) => raw.replace(/^[^\w]+|[^\w%]+$/g, "").replace(/['’]s$/, "")).filter(Boolean);
    const titleCase = tokens.filter((w) => /^[A-Z]/.test(w)).length > tokens.length * 0.6;
    tokens.forEach((w, i) => {
      const acronym = /^[A-Z][A-Z0-9-]{1,}$/.test(w);
      const name = !titleCase && i > 0 && /^[A-Z][a-z]/.test(w);
      const figure = /^\d[\d.,]*%?$/.test(w) && (w.length >= 3 || w.endsWith("%"));
      if ((acronym || name || figure) && ok(w) && terms.length < 5) terms.push(w);
    });
    const where = String(e.where || "").split(/[,;(]/)[0].trim();
    if (where && where.length < 30 && !/^(india|reported|unknown)/i.test(where) && !has(where)) terms.push(where);
    tokens.filter((w) => /^[\p{L}-]{4,}$/u.test(w) && ok(w)).sort((x, y) => y.length - x.length)
      .forEach((w) => { if (terms.length < 3) terms.push(w); });
    return terms.slice(0, 5).join(" ");
  }
  // How well a search hit matches the story: the share of the headline's words found in the hit's title and snippet.
  function matchOf(hit, tw) {
    const hw = new Set(words(`${hit.title} ${hit.snippet}`));
    const shared = tw.filter((w) => hw.has(w)).length;
    return shared >= 2 ? shared / (tw.length || 1) : 0;
  }
  const sameStory = (page, tw) => { const pw = new Set(words(page.paragraphs.join(" "))); return tw.filter((w) => pw.has(w)).length / (tw.length || 1) >= 0.5; };
  const COMMON = new Set(["gover", "state", "minis", "centr", "india", "offic", "peopl", "year", "years", "month", "today", "new"]);
  // A widget above an article ("trending") shares next to nothing with the story; an article's lead shares its
  // names and subject with the headline. (Its closing lines may not, so only the top is trimmed.)
  function trimEdges(page, story) {
    const e = story.explain || {};
    const sw = new Set(words(`${story.title} ${e.why_in_news || ""} ${e.what || ""} ${story.summary || ""}`).filter((w) => !COMMON.has(w)));
    const fit = (p) => words(p).filter((w) => sw.has(w)).length;
    const paras = page.paragraphs.slice();
    while (paras.length > 2 && fit(paras[0]) < 2) paras.shift();
    return paras.length === page.paragraphs.length ? page : { ...page, paragraphs: paras, words: paras.join(" ").split(/\s+/).length };
  }

  // Full text for a story: its own free sources first; if all of them are paywalled (or unreadable), the
  // same story found on free-to-read sites through a news search (headline first, then key terms).
  // → {read: [pages], hits: [search results, best match first], closed: [paywalled domains not opened]}
  async function gather(story, { extra = [], onStep, signal } = {}) {
    const step = (m) => { if (onStep) onStep(m); };
    const urls = [...new Set([...(story.sources || []).map((x) => x.u), ...extra].filter(Boolean))];
    const closed = [...new Set(urls.filter((u) => !isOpen(u) && !/news\.google\./.test(u)).map(domainOf))];
    const out = { read: [], hits: [], closed };
    const tw = words(story.title);
    const tried = new Set();
    for (const u of urls.filter(isOpen).slice(0, 3)) {
      step(`Reading ${domainOf(u)}…`); tried.add(u);
      try { out.read.push(trimEdges(await read(u, signal), story)); return out; } catch (e) { if (e.code === "rate") throw e; }
    }
    const queries = [searchQuery(story.title), keyQuery(story)].filter((q, i, a) => q && a.indexOf(q) === i);
    for (const q of queries) {
      step("Searching the news for a free version…");
      for (const h of await search(q, signal)) {
        if (!out.hits.some((x) => x.url === h.url)) out.hits.push({ ...h, match: matchOf(h, tw) });
      }
      out.hits.sort((a, b) => b.match - a.match);
      for (const h of out.hits.filter((x) => x.open && x.match >= 0.4 && !tried.has(x.url)).slice(0, 2)) {
        if (tried.size >= 4) break;  // the free reader allows ~20 pages a minute: a few tries per question
        step(`Reading ${h.domain}…`); tried.add(h.url);
        try {
          const page = await read(h.url, signal);
          if (sameStory(page, tw)) { out.read.push({ ...trimEdges(page, story), via: "search" }); return out; }
        } catch (e) { if (e.code === "rate") throw e; }
      }
    }
    return out;
  }
  const sentencesFrom = (page) => page.paragraphs.flatMap((p) => sentencesOf(p).map((text) => ({ text, src: page.domain, url: page.url })));

  // ─────────────────────────── summaries: one per story, shared by every screen, kept on the device ───────────────────────────
  // the pipeline's placeholder lines: "Reported on 26 Sep by …", "Explainer by …, 26 Sep. Open it for the full piece."
  const WEAK = /^(reported (on|by) |(opinion piece|explainer)\b.*open it for the full (argument|piece)\.?$)/i;
  function cleanText(t) {  // a report minus feed furniture ("Source: The post … has been created based on …")
    const x = String(t || "").replace(/\s+/g, " ").trim();
    if (!x || WEAK.test(x)) return "";
    if (!FURNITURE.test(x)) return x;
    return sentencesOf(x).filter((y) => !FURNITURE.test(y) && !/^upsc syllabus/i.test(y)).join(" ");
  }
  function localPoints(story, n = 8) {  // the key lines of what the brief holds (write-up, each outlet's text)
    const e = story.explain || {}; const seen = new Set(); const sents = [];
    for (const p0 of [e.why_in_news, e.what, ...(story.texts || []).map((t) => t.x), story.summary]) {
      const p = cleanText(p0); if (!p) continue;
      for (const t of sentencesOf(p)) {
        if (FURNITURE.test(t)) continue;
        const k = t.slice(0, 60).toLowerCase(); if (seen.has(k)) continue; seen.add(k); sents.push({ text: t });
      }
    }
    return summarize(sents, n).map((x) => x.text);
  }
  const SUM_KEY = "upsc-sum"; const SUM_MAX = 250; const MISS_RETRY = 6 * 3600 * 1000;
  const sumStore = {
    get() { try { return JSON.parse(localStorage.getItem(SUM_KEY) || localStorage.getItem("upsc-app-sum") || "{}") || {}; } catch (e) { return {}; } },
    set(v) { try { localStorage.setItem(SUM_KEY, JSON.stringify(v)); } catch (e) { /* private mode or full */ } },
  };
  let SUMS = null;
  const sums = () => (SUMS = SUMS || sumStore.get());
  const inflight = new Map(); const listeners = [];
  const noteOf = (s) => (s && s.ai && s.ai.source === "claude-notes" ? s.ai : null);
  // What a screen shows right now: Claude's note, the full article's summary (once read), or the brief's key lines.
  function summaryNow(story) {
    const n = noteOf(story);
    if (n && n.points && n.points.length) return { from: "note", points: n.points };
    const w = sums()[story.id];
    if (w && w.points && w.points.length) return { from: "web", points: w.points, src: w };
    return { from: "brief", points: localPoints(story), miss: !!(w && w.miss && Date.now() - w.at < MISS_RETRY), busy: inflight.has(story.id), src: w };
  }
  // The full article's 8-point summary, read from a free copy (once per story, kept on the device).
  // → {points, src} or {miss, hits, closed}
  function summaryFor(story, { onStep } = {}) {
    const w = sums()[story.id];
    if (w && w.points && w.points.length) return Promise.resolve({ points: w.points, src: w });
    if (!inflight.has(story.id)) {
      const p = gather(story, { onStep }).then((g) => {
        const all = sums();
        if (g.read.length) {
          const page = g.read[0];
          all[story.id] = { points: summarize(sentencesFrom(page), 8).map((x) => x.text), url: page.url, domain: page.domain, via: page.via || "", closed: g.closed.filter(paywalled), at: Date.now() };
        } else all[story.id] = { miss: true, closed: g.closed.filter(paywalled), at: Date.now() };
        const keys = Object.keys(all);
        if (keys.length > SUM_MAX) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - SUM_MAX).forEach((k) => delete all[k]);
        sumStore.set(all);
        const out = g.read.length ? { points: all[story.id].points, src: all[story.id] } : { miss: true, hits: g.hits, closed: all[story.id].closed };
        listeners.forEach((fn) => { try { fn(story.id, out); } catch (e) { /* one screen's handler */ } });
        return out;
      });
      inflight.set(story.id, p);
      p.catch(() => {}).finally(() => inflight.delete(story.id));
    }
    return inflight.get(story.id);
  }
  // Where a summary came from, as HTML for a source line.
  function sourceHtml(src) {
    if (!src || !src.domain) return "";
    const a = `<a href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener">${esc(src.domain)}</a>`;
    const closed = (src.closed || []).length ? ` The original on ${esc(src.closed.join(", "))} is subscriber-only, so it wasn't opened.` : "";
    return src.via === "search" ? `Summarised from ${a}, a free report of the same story.${closed}` : `Summarised from the full article on ${a}.`;
  }
  // Background summaries for the cards on screen: one story at a time, and only while the reader budget has room.
  const PF = { queue: [], running: false, pause: 0 };
  function prefetch(stories) {
    const want = stories.filter((x) => x && x.id && !noteOf(x) && summaryNow(x).from === "brief" && !summaryNow(x).miss);
    PF.queue = want.concat(PF.queue.filter((x) => !want.some((y) => y.id === x.id))).slice(0, 40);
    if (!PF.running) runPrefetch();
  }
  async function runPrefetch() {  // up to two stories at a time, leaving ~6 pages a minute for what you tap
    PF.running = true;
    while (PF.queue.length) {
      if (readerLoad() > 12 || inflight.size >= 2 || PF.pause > Date.now()) { await sleep(2000); continue; }
      const x = PF.queue.shift();
      if (summaryNow(x).from !== "brief") continue;
      summaryFor(x).catch((e) => { if (e.code === "rate") PF.pause = Date.now() + 30000; });
      await sleep(800);
    }
    PF.running = false;
  }
  const onSummary = (fn) => { listeners.push(fn); };

  // ─────────────────────────── Wikipedia ───────────────────────────
  const wikiCache = new Map();
  // → {title, desc, extract, url, others, fit} or null. With context (the story's words), the hit that shares
  // the most words with the story wins, so "ESA" in a Kerala forest story isn't the European Space Agency;
  // fit 0 means no hit looked related.
  function wiki(term, context) {
    const own = new Set(words(term));
    const ctx = new Set([...(context || [])].filter((w) => !own.has(w)));
    const key = `${term.toLowerCase()}|${[...ctx].sort().join(" ").slice(0, 400)}`;
    if (!wikiCache.has(key)) {
      wikiCache.set(key, (async () => {
        const r = await fetch(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(term)}&limit=5`);
        if (!r.ok) throw new Error(`Wikipedia search: ${r.status}`);
        const hits = ((await r.json()).pages || []).map((h, i) => {
          const hw = words(`${h.title} ${h.description || ""} ${String(h.excerpt || "").replace(/<[^>]+>/g, "")}`);
          return { h, i, fit: hw.filter((w) => ctx.has(w)).length };
        });
        const order = ctx.size ? hits.slice().sort((x, y) => (y.fit - x.fit) || (x.i - y.i)) : hits;
        for (const { h, fit } of order.slice(0, 3)) {
          const r2 = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.key)}`);
          if (!r2.ok) continue;
          const j = await r2.json();
          if (j.type === "disambiguation" || !j.extract) continue;
          return {
            title: j.title, desc: j.description || "", extract: j.extract, fit,
            url: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || `https://en.wikipedia.org/wiki/${h.key}`,
            others: hits.filter((x) => x.h.key !== h.key && (!ctx.size || x.fit > 0)).slice(0, 3).map((x) => x.h.title),
          };
        }
        return null;
      })().catch((e) => { wikiCache.delete(key); throw e; }));
    }
    return wikiCache.get(key);
  }
  // "ESA" → "Ecologically Sensitive Area": the run of capitalised words, in the story's own text, whose initials
  // spell the acronym (small joining words allowed); the most frequent run wins.
  function expandAcronym(acr, text) {
    const L = String(acr).replace(/[^A-Za-z]/g, "").toUpperCase();
    if (L.length < 2 || L.length > 8 || !/^[A-Z][A-Z0-9&-]+$/.test(acr)) return "";
    const toks = String(text || "").split(/[^\p{L}\d'-]+/u).filter(Boolean);
    const seen = new Map();
    for (let i = 0; i < toks.length; i += 1) {
      const run = []; let k = 0; let j = i;
      while (j < toks.length && k < L.length) {
        const w = toks[j];
        if (k > 0 && /^(of|and|for|the|on|in|to|&)$/i.test(w)) { run.push(w); j += 1; continue; }
        if (/^[A-Z][a-z]/.test(w) && w[0] === L[k]) { run.push(w); k += 1; j += 1; } else break;
      }
      if (k === L.length) { const x = run.join(" "); seen.set(x, (seen.get(x) || 0) + 1); }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }

  // ─────────────────────────── Claude (on the viewer's own plan) ───────────────────────────
  function claudePrompt(story, question, extra) {
    const e = (story && story.explain) || {};
    const lines = [
      "You are my UPSC Civil Services tutor. Answer from the news story below, and search the web if you need more. Be concise and exam-oriented: short bullets, GS paper links, key facts for Prelims.",
      "",
    ];
    if (story) {
      lines.push(`STORY: ${story.title}`);
      if (story.date) lines.push(`Date: ${story.date}`);
      if (e.why_in_news) lines.push(`Why in news: ${e.why_in_news}`);
      if (e.what && e.what !== e.why_in_news) lines.push(`What happened: ${e.what}`);
      if (story.summary && !e.what) lines.push(`Summary: ${story.summary}`);
      const links = (story.sources || []).map((x) => x.u).filter((u) => u && !/news\.google\./.test(u)).slice(0, 4);
      if (links.length) lines.push(`Sources: ${links.join(" , ")}`);
    }
    if (extra) lines.push(extra);
    lines.push("", `MY QUESTION: ${question}`);
    return lines.join("\n");
  }
  function openClaude(prompt) {  // opens a new Claude chat with the prompt filled in, and copies it too (pasting always works)
    try { if (navigator.clipboard) navigator.clipboard.writeText(prompt).catch(() => {}); } catch (e) { /* no clipboard */ }
    const w = root.open("https://claude.ai/new?q=" + encodeURIComponent(prompt.slice(0, 6000)), "_blank");
    if (w) { try { w.opener = null; } catch (e) { /* cross-origin already */ } }
    return !!w;  // (the "noopener" feature would make this null even when the tab opens)
  }

  // ─────────────────────────── the Ask bot (shared by the dashboard and the app) ───────────────────────────
  // makeBot(host).answer(story|null, question, {onStep, deep}) → HTML. Answers come from, in order: the story's
  // Claude study note (when the notes routine wrote one), what the brief holds (write-up, every outlet's text,
  // same-event reports), the full free article read from the web, Wikipedia. Every line says where it's from.
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "#");
  const MONTH_RX = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow|20\d\d)\b/i;
  const PAYWALLED = ["thehindu.com", "thehindubusinessline.com", "indianexpress.com", "livemint.com", "economictimes.indiatimes.com",
    "business-standard.com", "ft.com", "wsj.com", "nytimes.com", "bloomberg.com", "economist.com", "washingtonpost.com", "thediplomat.com",
    "livelaw.in", "scmp.com", "straitstimes.com", "japantimes.co.jp"];
  const paywalled = (d) => PAYWALLED.some((x) => d === x || d.endsWith("." + x));
  const para = (t) => (t ? `<p>${esc(t)}</p>` : "");
  const list = (items, tag = "ul") => (items.length ? `<${tag}>${items.map((x) => `<li>${x}</li>`).join("")}</${tag}>` : "");
  const link = (u, text) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const btn = (act, label, data = {}) => `<button class="linkbtn" data-bot="${act}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("")}>${esc(label)}</button>`;
  const cite = (o) => `<li>${esc(o.text)} <span class="bot-src">— ${esc(o.src)}</span></li>`;
  const sub = (t, note) => `<p class="bot-sub">${esc(t)}${note ? ` <span class="bot-src">${esc(note)}</span>` : ""}</p>`;
  const NOTE_TAG = "Claude's study note";
  const STORY_CHIPS = ["60-word summary", "Static background", "Make 2 Prelims MCQs", "Mains answer outline", "हिंदी में समझाएं",
    "Link to syllabus", "Summary", "Search the web", "5W", "Prelims facts", "Other outlets", "Related stories", "Videos", "Ask Claude ↗"];
  const DAY_CHIPS = ["Top stories", "GS1", "GS2", "GS3", "GS4", "Prelims", "Ask Claude ↗"];
  function intentOf(q) {
    const t = String(q || "").toLowerCase().trim();
    if (/claude/.test(t)) return "claude";
    if (/^summari[sz]e the full article/.test(t)) return "websummary";
    if (/\bhindi\b|हिंदी|हिन्दी/.test(t)) return "hindi";
    if (/\bmcqs?\b|quiz|test me/.test(t)) return "mcq";
    if (/outline|mains answer|answer writing|structure (an|the|my) answer/.test(t)) return "outline";
    if (/mains( question)?$|practice question/.test(t)) return "mainsq";
    if (/\b60\b|sixty|in short|quick summary|short summary/.test(t)) return "s60";
    if (/^(summary|summari[sz]e( it| this)?|tl;?dr|gist|overview|full summary|read the (full|whole) article|full article)\b/.test(t)) return "summary";
    if (/^why (is it |is this )?in (the )?news/.test(t)) return "win";
    if (/^5 ?w|five w/.test(t)) return "5w";
    if (/^(who|what|when|where|why)(?: (?:happened|is it|was it|did it|is involved|matters?|did this happen))?\s*\??$/.test(t)) return "w";
    if (/syllabus|which (gs )?paper/.test(t)) return "syllabus";
    if (/^(static )?background$|^(context|history)$|static background/.test(t)) return "background";
    if (/prelims|facts?\b|key points|remember/.test(t)) return "prelims";
    if (/why (it|does it|this) matters?|significan|importan|relevan/.test(t)) return "matters";
    if (/search (the )?(web|news|internet)|other sites|free version|on the internet|online/.test(t)) return "web";
    if (/other (outlets|papers|sources|reports)|coverage|who reported|outlets/.test(t)) return "outlets";
    if (/related|similar|previous|earlier|timeline|follow[- ]?up|more on/.test(t)) return "related";
    if (/video|watch|youtube/.test(t)) return "videos";
    return "ask";
  }

  // Fill-in-the-blank MCQs from the article's own figures: the right answer is what the report says; the
  // other options are nearby numbers. Practice for fact recall, not exam-style questions.
  const NUM_RX = /(₹\s?)?\b(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d,]*[a-z])(\s?(?:%|per ?cent|crore|lakh|million|billion|trillion|sq\.? ?km|square kilomet(?:re|er)s|km|kilomet(?:re|er)s?|MW|GW|tonnes?|hectares?|acres?)(?![a-z]))?/gi;
  function hashOf(t) { let h = 7; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
  function clozes(sents, n = 2) {
    const out = []; const used = new Set();
    for (const x of sents) {
      if (out.length >= n) break;
      if (x.text.length > 320 || x.text.length < 60) continue;
      const found = [...x.text.matchAll(NUM_RX)].find((m) => {
        const around = x.text.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12);
        const v = parseFloat(m[2].replace(/,/g, ""));
        const dateLike = MONTH_RX.test(around) && v <= 31 && !m[3];
        return !dateLike && (v >= 10 || m[3]) && !/^0\d/.test(m[2]) && !used.has(m[2]);
      });
      if (!found) continue;
      used.add(found[2]);
      const raw = found[2]; const v = parseFloat(raw.replace(/,/g, "")); const dec = (raw.split(".")[1] || "").length;
      const year = !found[3] && !found[1] && /^(19|20)\d\d$/.test(raw);
      const fmt = (y) => (raw.includes(",") ? y.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : y.toFixed(dec));
      const alts = year ? [-3, -1, 2, 4].map((d) => String(v + d)) : [0.5, 0.75, 1.3, 1.6].map((k) => fmt(v * k));
      const opts = [...new Set([raw, ...alts])].filter((o) => o === raw || parseFloat(o.replace(/,/g, "")) !== v).slice(0, 4);
      if (opts.length < 4) continue;
      const shift = hashOf(x.text) % 4;
      const options = opts.map((o, i) => opts[(i + shift) % 4]).map((o) => `${found[1] || ""}${o}${found[3] || ""}`);
      const answer = options.indexOf(`${found[1] || ""}${raw}${found[3] || ""}`);
      out.push({ q: x.text.slice(0, found.index) + "_____" + x.text.slice(found.index + found[0].length), options, answer, why: `${x.text}`, src: x.src });
    }
    return out;
  }
  const mcqHtml = (m, i, tag) => `<div class="mcq"><p class="mcq-q"><b>Q${i + 1}.</b> ${esc(m.q)}</p>
    <ol class="mcq-o" type="a">${m.options.map((o) => `<li>${esc(o)}</li>`).join("")}</ol>
    <details><summary>Show answer</summary><p><b>(${"abcd"[m.answer]}) ${esc(m.options[m.answer])}</b>${m.why ? ` — ${esc(m.why)}` : ""}${m.src || tag ? ` <span class="bot-src">${esc(m.src || tag)}</span>` : ""}</p></details></div>`;

  // Hindi: a free machine translation (MyMemory, no key, ~5,000 characters a day per device), else a link to Google Translate
  const trCache = new Map();
  function toHindi(text) {
    const key = text.slice(0, 480);
    if (!trCache.has(key)) {
      const p = fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(key)}&langpair=en|hi`).then((r) => r.json()).then((j) => {
        const t = j && j.responseData && j.responseData.translatedText;
        if (Number(j.responseStatus) !== 200 || !t || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t)) throw fail("quota", "The free translator is out of quota for today.");
        return t;
      });
      trCache.set(key, p); p.catch(() => trCache.delete(key));
    }
    return trCache.get(key);
  }
  const gtLink = (text) => `https://translate.google.com/?sl=en&tl=hi&op=translate&text=${encodeURIComponent(text.slice(0, 1800))}`;

  function makeBot(host) {
    const H = { labels: () => null, folded: () => [], pool: () => [], day: () => null, videos: () => [], dayShort: (d) => d, ...host };
    const L = () => H.labels() || { subjects: {}, subject_gs: {} };  // read when answering: the site's labels load after the bot is made
    const noteOf = (s) => (s && s.ai && s.ai.source === "claude-notes" ? s.ai : null);
    const srcName = (s) => (s.sources && s.sources[0] && s.sources[0].p) || "the outlet";
    const labelOf = (x) => L().subjects[x] || x;

    function corpusOf(s) {  // every sentence the brief holds about the story, with where it came from
      const e = s.explain || {}; const out = []; const seen = new Set();
      const add = (text, src, head = false) => {
        if (!head && WEAK.test(String(text || "").trim())) return;  // a placeholder, not a report
        for (const x of head ? [String(text || "").trim()].filter(Boolean) : sentencesOf(text)) {
          if (FURNITURE.test(x) || WEAK.test(x)) continue;
          const k = x.slice(0, 70).toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push({ text: x, src, head });
        }
      };
      add(e.why_in_news, "Why in news"); add(e.what, "What happened"); add(e.background, "Background");
      for (const t of s.texts || []) add(t.x, t.p || "An outlet");
      add(s.summary, srcName(s));
      for (const f of H.folded(s.id)) add(f.summary, srcName(f));
      for (const x of s.sources || []) if (x.t) add(x.t, `${x.p || "An outlet"} (headline)`, true);
      return out;
    }

    const gathered = new Map();
    async function fromWeb(s, onStep) {  // → {g, err}: the story's free full text, or why there is none
      if (!gathered.has(s.id)) { const p = gather(s, { onStep }); gathered.set(s.id, p); p.catch(() => gathered.delete(s.id)); }
      try { return { g: await gathered.get(s.id) }; } catch (e) { return { err: e }; }
    }
    function sourceLine(g) {
      const page = g.read[0];
      const closed = g.closed.filter(paywalled);
      return page.via === "search"
        ? `Read from ${link(page.url, page.domain)}, a free report of the same story${closed.length ? `: the original on ${esc(closed.join(", "))} is subscriber-only, so it wasn't opened` : ""}. Summary lines are quoted from it.`
        : `From the full article on ${link(page.url, page.domain)}. Summary lines are quoted from it.`;
    }
    function othersSay(g) {
      const hits = (g ? g.hits : []).filter((h) => h.match > 0).slice(0, 5);
      if (!hits.length) return "";
      return `${sub("How other outlets report it")}<ul class="bot-hits">${hits.map((h) => `<li>${link(h.url, h.domain)}${h.date ? ` <span class="bot-src">${esc(h.date.slice(5, 16))}</span>` : ""}: ${esc(h.snippet || h.title)}
        ${h.open ? btn("read", "Summarise", { url: h.url }) : `<span class="bot-src">${paywalled(h.domain) ? "subscriber-only" : "not on the free-to-read list"}</span>`}</li>`).join("")}</ul>`;
    }
    const webFail = (r) => (r.err ? `<p class="bot-src">${esc(r.err.message)}</p>` : (r.g && !r.g.read.length ? `<p class="bot-src">No free copy of this story could be read${r.g.closed.filter(paywalled).length ? ` (the original on ${esc(r.g.closed.filter(paywalled).join(", "))} is subscriber-only)` : ""}.</p>` : ""));
    const claudeBtn = (q) => `<p class="bot-src">Want a deeper answer? ${btn("claude", "Ask Claude ↗", { q })} opens Claude with this story and your question.</p>`;

    function quickSummary(s) {
      const e = s.explain || {}; const corpus = corpusOf(s);
      const lead = [...new Set([e.why_in_news, e.what].filter((x) => x && !WEAK.test(x)))];
      const facts = [e.when && `<b>When:</b> ${esc(e.when)}`, e.where && `<b>Where:</b> ${esc(e.where)}`, e.who && `<b>Who:</b> ${esc(e.who)}`].filter(Boolean);
      const extra = corpus.filter((o) => !o.head && !lead.some((l) => l.includes(o.text.slice(0, 40)))).slice(0, lead.length ? 2 : 4);
      return `${lead.map(para).join("")}${list(facts)}${extra.length ? `${sub("What the reports say")}<ul>${extra.map(cite).join("")}</ul>` : ""}`;
    }
    // Background from Wikipedia, in the story's sense of the term: an acronym is expanded from the story's own
    // text (and the full article when it has been read), and the hit sharing the most words with the story wins.
    async function wikiHtml(term, s, extraText) {
      const search = `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(term)}`;
      const text = s ? `${corpusOf(s).map((o) => o.text).join(" ")} ${extraText || ""}` : "";
      const long = s ? expandAcronym(term, text) : "";
      const e = (s && s.explain) || {};
      const ctx = s ? words([s.title, e.where, e.who, ...namesIn(text.slice(0, 20000))].join(" ")) : [];
      try {
        let w = null;
        for (const t of [...new Set([long, term].filter(Boolean))]) {
          const hit = await wiki(t, ctx);
          if (hit && (!w || hit.fit > w.fit)) w = hit;
          if (w && (w.fit > 0 || !s)) break;
        }
        if (!w) return `<p>Wikipedia has no page that matches <b>${esc(long || term)}</b>. ${link(search, "Search Wikipedia yourself")}.</p>`;
        return `<p class="bot-lead">Background: <b>${esc(w.title)}</b>${w.desc ? ` <span class="bot-src">(${esc(w.desc)})</span>` : ""}</p>
          ${s && !w.fit ? `<p class="bot-src">Wikipedia's closest page for “${esc(long || term)}”: it may not be what this story means.</p>` : ""}${para(w.extract)}
          <p class="bot-src">From Wikipedia, which may not cover the latest development. ${link(w.url, "Read the full article")}${w.others.length ? ` · also: ${w.others.map((o) => btn("wiki", o, { term: o })).join(", ")}` : ""}</p>`;
      } catch (e) {
        return `<p>Couldn't reach Wikipedia just now${/429/.test(e.message) ? " (too many lookups: try again in a minute)" : ""}. ${link(search, "Open the search on Wikipedia")}.</p>`;
      }
    }
    // the full article's text when it has been read (or can be, for an acronym the brief doesn't spell out)
    async function webText(s, onStep, need) {
      if (!need && !gathered.has(s.id)) return "";
      const r = await fromWeb(s, onStep);
      return r.g && r.g.read.length ? r.g.read[0].paragraphs.join(" ") : "";
    }
    const isAcronym = (t) => /^[A-Z][A-Z0-9&-]{1,7}$/.test(t);
    function namesIn(text) {  // capitalised words that don't start a sentence: the story's people, places and bodies
      const out = [];
      for (const sent of sentencesOf(text)) {
        for (const w of sent.split(" ").slice(1)) {
          const t = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
          if (/^[A-Z][a-z][\w-]{2,}$/.test(t)) out.push(t);
        }
      }
      return out;
    }
    function related(s, n = 5) {
      const pool = new Map(); for (const x of H.pool()) if (x.id !== s.id) pool.set(x.id, x);
      const folded = new Set(H.folded(s.id).map((x) => x.id));
      const mine = new Set(words(s.title + " " + ((s.explain || {}).keywords || []).join(" ")));
      const df = {}; for (const x of pool.values()) for (const w of words(x.title)) df[w] = (df[w] || 0) + 1;
      const N = pool.size || 1; const rare = Math.max(3, N * 0.02);
      return [...pool.values()].filter((x) => !folded.has(x.id)).map((x) => {  // share two words, one of them rare
        let sc = 0; let shared = 0; let specific = false;
        for (const w of words(x.title)) if (mine.has(w)) { sc += Math.log(1 + N / df[w]); shared += 1; specific = specific || df[w] <= rare; }
        return { x, sc: shared >= 2 && specific ? sc : 0 };
      }).filter((r) => r.sc > 5).sort((a, b) => b.sc - a.sc).slice(0, n).map((r) => r.x);
    }
    const storyLine = (x) => `<li><span class="pill g-${esc(x.grade)}">${esc(x.grade)}</span> ${esc(x.title)} <span class="bot-src">${esc(H.dayShort(x.date))} · ${esc(srcName(x))}</span>
      ${btn("story", "Ask about this", { id: x.id })}</li>`;

    async function storyAnswer(s, q, { onStep, deep } = {}) {
      const e = s.explain || {}; const n = noteOf(s); const intent = deep ? "deep" : intentOf(q);
      const corpus = corpusOf(s);
      if (intent === "summary" || intent === "websummary") {  // the shared summary: instant when a card already read it
        if (intent === "summary" && n && n.points && n.points.length) return `${sub(`Summary · ${n.points.length} points`, NOTE_TAG)}${list(n.points.map(esc), "ol")}<p class="bot-src">${btn("chip", "Summarise the full article from the web", { q: "Summarise the full article from the web" })}</p>`;
        let r;
        try { r = await summaryFor(s, { onStep }); } catch (err) { r = { miss: true, err }; }
        if (r.points) return `${sub(`Summary · ${r.points.length} points`)}${list(r.points.map(esc), "ol")}<p class="bot-src">${sourceHtml(r.src)} Lines are quoted from it.</p>`;
        return `${sub("Summary from the brief")}${quickSummary(s) || "<p>The outlets carried only the headline.</p>"}${othersSay({ hits: r.hits || [] })}
          <p class="bot-src">${r.err ? esc(r.err.message) : `No free copy of this story could be read${(r.closed || []).length ? ` (the original on ${esc(r.closed.join(", "))} is subscriber-only)` : ""}.`}</p>${claudeBtn("Summarise this story for UPSC")}`;
      }
      if (intent === "s60") {
        if (n && n.summary60) return `${sub("In 60 words", NOTE_TAG)}${para(n.summary60)}`;
        const r = await fromWeb(s, onStep);
        if (r.g && r.g.read.length) return `${sub("In 60 words")}${para(brief(sentencesFrom(r.g.read[0]), 60))}<p class="bot-src">${sourceLine(r.g)}</p>`;
        const local = brief(corpus.filter((o) => !o.head), 60);
        return `${sub("In 60 words, from the brief")}${local ? para(local) : "<p>The brief holds only the headline for this story.</p>"}${webFail(r)}`;
      }
      if (intent === "win") return e.why_in_news && !WEAK.test(e.why_in_news) ? para(e.why_in_news) : `<p>No “why in news” line; the reports say:</p><ul>${corpus.slice(0, 2).map(cite).join("")}</ul>`;
      if (intent === "5w" || intent === "w") {
        const rows = [["What", e.what || e.why_in_news], ["Why in news", e.why_in_news !== e.what ? e.why_in_news : ""], ["When", e.when], ["Where", e.where], ["Who", e.who],
          ["Why it matters", (e.significance || []).join("; ")]].filter(([, v]) => v && !WEAK.test(v));
        const want = intent === "w" ? q.toLowerCase().trim().match(/^(who|what|when|where|why)/)[1] : null;
        const pick = want ? rows.filter(([k]) => k.toLowerCase().startsWith(want)) : rows;
        if (pick.length) return `<dl class="bot-dl">${pick.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
        const cue = want === "when" ? corpus.filter((o) => MONTH_RX.test(o.text)) : rank(corpus, s.title);
        return cue.length ? `<p>The write-up has no “${esc(want || "5W")}” line, but the reports say:</p><ul>${cue.slice(0, 3).map(cite).join("")}</ul>`
          : `<p>The reports on this story don't say. ${btn("wiki", `Look up ${termOf(s)} on Wikipedia`, { term: termOf(s) })}</p>`;
      }
      if (intent === "background") {
        const own = n ? n.background : (!e.auto && e.background);
        const term = termOf(s);
        const extra = await webText(s, onStep, isAcronym(term) && !expandAcronym(term, corpus.map((o) => o.text).join(" ")));
        return `${own ? `${sub("Static background", n ? NOTE_TAG : "")}${para(own)}` : ""}${await wikiHtml(term, s, extra)}`;
      }
      if (intent === "mcq") {
        if (n && n.mcqs && n.mcqs.length) return `${sub("Prelims MCQs", NOTE_TAG)}${n.mcqs.slice(0, 2).map((m, i) => mcqHtml(m, i, NOTE_TAG)).join("")}`;
        const r = await fromWeb(s, onStep);
        const all = r.g && r.g.read.length ? sentencesFrom(r.g.read[0]) : corpus.filter((o) => !o.head);
        const top = summarize(all, 10); const sents = top.concat(all.filter((x) => !top.includes(x)));
        const qs = clozes(sents, 2);
        if (!qs.length) return `<p>The ${r.g && r.g.read.length ? "article" : "brief"} has no figures to build fact questions from.</p>${claudeBtn("Make 2 UPSC Prelims-style MCQs on this story, with answers and explanations")}`;
        return `${sub("Fact-recall MCQs", "made from the article's own figures")}${qs.map((m, i) => mcqHtml(m, i)).join("")}
          ${r.g && r.g.read.length ? `<p class="bot-src">${sourceLine(r.g)}</p>` : ""}${claudeBtn("Make 2 UPSC Prelims-style MCQs on this story, with answers and explanations")}`;
      }
      if (intent === "outline") {
        if (n && n.mains_outline) {
          const o = n.mains_outline;
          return `${sub("Mains answer outline", NOTE_TAG)}${n.mains ? `<p class="mq">${esc(n.mains)}</p>` : ""}<dl class="bot-dl">
            <div><dt>Intro</dt><dd>${esc(o.intro)}</dd></div><div><dt>Body</dt><dd>${list(o.body.map(esc))}</dd></div>
            ${o.way_forward.length ? `<div><dt>Way forward</dt><dd>${list(o.way_forward.map(esc))}</dd></div>` : ""}${o.conclusion ? `<div><dt>Conclusion</dt><dd>${esc(o.conclusion)}</dd></div>` : ""}</dl>`;
        }
        const r = await fromWeb(s, onStep);
        const full = r.g && r.g.read.length ? sentencesFrom(r.g.read[0]) : [];
        const pts = summarize(full.length ? full : corpus.filter((o) => !o.head), 5);
        const ahead = full.filter((x) => /\b(should|need(s|ed)? to|must|call(s|ed)? for|recommend\w*|way forward)\b/i.test(x.text)).slice(0, 3);
        const subj = s.subjects.map(labelOf).join(" / ");
        const question = e.mains || `With reference to “${s.title}”, discuss its significance for ${subj || "India"}${s.gs.length ? ` (${s.gs.join(", ")})` : ""}. (250 words)`;
        return `${sub("Mains answer outline", "built from the article's own lines: add your analysis")}<p class="mq">${esc(question)}</p><dl class="bot-dl">
          <div><dt>Intro</dt><dd>${esc((pts[0] || {}).text || e.why_in_news || s.title)}</dd></div>
          <div><dt>Body</dt><dd>${list([...pts.slice(1).map((x) => esc(x.text)), ...(e.significance || []).map((x) => `<i>${esc(x)}</i>`)])}</dd></div>
          ${ahead.length ? `<div><dt>Way forward</dt><dd>${list(ahead.map((x) => esc(x.text)))}</dd></div>` : ""}
          <div><dt>Conclusion</dt><dd><i>Tie it to ${esc(subj || "the syllabus")}: what it means for governance, the economy or citizens, and what to watch next.</i></dd></div></dl>
          ${full.length ? `<p class="bot-src">${sourceLine(r.g)}</p>` : webFail(r)}${claudeBtn("Write a 250-word UPSC Mains answer outline on this story: intro, body, way forward, conclusion")}`;
      }
      if (intent === "hindi") {
        if (n && n.hindi && n.hindi.length) return `${sub("हिंदी में", NOTE_TAG)}${list(n.hindi.map(esc))}`;
        const r = await fromWeb(s, onStep);
        const text = n && n.summary60 ? n.summary60 : r.g && r.g.read.length ? brief(sentencesFrom(r.g.read[0]), 60) : brief(corpus.filter((o) => !o.head), 60) || s.title;
        const vid = s.video_hi && s.video_hi.url ? `<p>हिंदी वीडियो: ${link(s.video_hi.url, s.video_hi.title || "YouTube")}</p>` : "";
        try {
          const hi = await toHindi(text);
          return `${sub("हिंदी में (मशीन अनुवाद)")}${para(hi)}<p class="bot-src">Machine translation (MyMemory) of the 60-word summary. ${link(gtLink(text), "Google Translate")} for the full text.</p>${vid}`;
        } catch (err) {
          return `${sub("In 60 words")}${para(text)}<p>${link(gtLink(text), "हिंदी में पढ़ें (Google Translate) ↗")}</p><p class="bot-src">${esc(err.message)}</p>${vid}`;
        }
      }
      if (intent === "syllabus" || intent === "matters") {
        const sg = L().subject_gs || {};
        const subj = s.subjects.map((x) => `${esc(labelOf(x))}${sg[x] ? ` (${esc(sg[x])})` : ""}`);
        return `${n && n.syllabus ? `${sub("Link to syllabus", NOTE_TAG)}${para(n.syllabus)}` : ""}${sub("Why it matters for UPSC")}${list([...(e.significance || []).map(esc),
          subj.length ? `Syllabus: ${subj.join(", ")}` : "", `Graded <b>${esc(s.grade)}</b>${s.n_pub > 1 ? `, reported by ${s.n_pub} outlets` : ""}${(s.dates || []).length > 1 ? `, in the news since ${esc(H.dayShort(s.dates[0]))}` : ""}`].filter(Boolean))}`;
      }
      if (intent === "prelims") {
        const items = [...(e.prelims || []).map(esc), ...(e.keywords || []).map((k) => `Keyword: <b>${esc(k)}</b>`), ...(s.tags || []).map((t) => `Tag: ${esc(t)}`)];
        const nums = corpus.filter((o) => /\d/.test(o.text) && !o.head).slice(0, 3);
        return `${items.length ? `${sub("Prelims pointers", n ? NOTE_TAG : "")}${list(items)}` : ""}${nums.length ? `${sub("Facts and figures in the reports")}<ul>${nums.map(cite).join("")}</ul>` : ""}
          <p>${btn("chip", "Make 2 Prelims MCQs", { q: "Make 2 Prelims MCQs" })} · Look up on Wikipedia: ${btn("wiki", termOf(s), { term: termOf(s) })}</p>`;
      }
      if (intent === "mainsq") {
        if (e.mains) return `${sub("Mains question")}<p class="mq">${esc(e.mains)}</p><p>${btn("chip", "Mains answer outline", { q: "Mains answer outline" })}</p>`;
        const subj = s.subjects.map(labelOf).join(" / ");
        return `${sub("Practice question", "auto, from the syllabus mapping")}<p class="mq">${esc(`With reference to "${s.title}", discuss its significance for ${subj || "India"}${s.gs.length ? ` (${s.gs.join(", ")})` : ""}. (150 words)`)}</p>
          <p>${btn("chip", "Mains answer outline", { q: "Mains answer outline" })}</p>`;
      }
      if (intent === "web") {
        if (onStep) onStep("Searching the news…");
        const tw = words(s.title); const seen = new Map();
        try {
          for (const query of [searchQuery(s.title), keyQuery(s)].filter((x, i, a) => x && a.indexOf(x) === i)) {
            for (const h of await search(query)) if (!seen.has(h.url)) seen.set(h.url, { ...h, match: matchOf(h, tw) });
          }
        } catch (err) { if (!seen.size) return `<p>${esc(err.message)}</p>`; }
        const hits = [...seen.values()].filter((h) => h.match > 0).sort((a, b) => (b.match - a.match) || (b.open - a.open));
        if (!hits.length) return `<p>The news search found nothing for this headline.</p>${claudeBtn(q)}`;
        return `${sub(`The news on the web · ${hits.length} reports`)}<ul class="bot-hits">${hits.slice(0, 10).map((h) => `<li>${link(h.url, h.title)} <span class="bot-src">${esc(h.domain)}${h.date ? ` · ${esc(h.date.slice(5, 16))}` : ""}</span>
          ${h.open ? `<span class="free">free</span> ${btn("read", "Summarise", { url: h.url })}` : `<span class="bot-src">${paywalled(h.domain) ? "subscriber-only" : "not on the free-to-read list"}</span>`}</li>`).join("")}</ul>
          <p class="bot-src">From Bing News. “Summarise” reads that page and quotes its key lines; subscriber-only sites are never opened.</p>`;
      }
      if (intent === "outlets") {
        const t = (s.texts || []).map((x) => `<li><b>${esc(x.p || "An outlet")}:</b> ${esc(x.x)}</li>`);
        const heads = (s.sources || []).map((x) => `<li>${link(x.u, x.p || "Source")}${x.t ? `: ${esc(x.t)}` : ""}</li>`);
        const fold = H.folded(s.id).map((x) => `<li>${link(x.url, srcName(x))}: ${esc(x.title)}</li>`);
        return `${t.length ? `${sub("What each outlet wrote")}<ul>${t.join("")}</ul>` : ""}${sub("Headlines")}<ul>${heads.concat(fold).join("")}</ul><p>${btn("chip", "Search the web", { q: "Search the web" })}</p>`;
      }
      if (intent === "related") {
        const rel = related(s);
        return rel.length ? `${sub("Related stories")}<ul class="bot-stories">${rel.map(storyLine).join("")}</ul>` : "<p>No related story in the brief or Everything for this period.</p>";
      }
      if (intent === "videos") {
        const v = H.videos(s);
        return v.length ? list(v.map(([x, lang]) => `${link(x.url, x.title)} <span class="bot-src">${esc(lang)} · ${esc(x.channel || "")}</span>`))
          : `<p>No confident video match yet.${s.video && s.video.search_url ? ` ${link(s.video.search_url, "Search YouTube")}` : ""}</p>`;
      }
      // a free question: a definition goes to Wikipedia; otherwise the brief, then the full article on the web
      const term = termFrom(q);
      if (term && intent !== "deep") {
        const inStory = rank(corpus, term).filter((o) => o.hits >= words(term).length).slice(0, 1);
        const extra = await webText(s, onStep, isAcronym(term) && !expandAcronym(term, corpus.map((o) => o.text).join(" ")));
        return `${await wikiHtml(term, s, extra)}${inStory.length ? `${sub("In this story")}<ul>${inStory.map(cite).join("")}</ul>` : ""}`;
      }
      const local = rank(corpus.filter((o) => !o.head), q).filter((o) => o.share >= 0.5).slice(0, 3);
      if (intent !== "deep" && local.length && local[0].cover === 1) {  // every word of the question in one line
        return `<p>From the reports:</p><ul>${local.map(cite).join("")}</ul><p class="bot-src">${btn("deeper", "Look in the full article", { q })}</p>`;
      }
      const r = await fromWeb(s, onStep);
      if (r.g && r.g.read.length) {
        const hits = rank(sentencesFrom(r.g.read[0]), q).filter((o) => o.share >= 0.5).slice(0, 3);
        if (hits.length) return `<p>From the full article:</p><ul>${hits.map(cite).join("")}</ul><p class="bot-src">${sourceLine(r.g)}</p>`;
      }
      if (local.length) return `<p>From the reports:</p><ul>${local.map(cite).join("")}</ul>${webFail(r)}`;
      return `<p>Neither the reports nor the free full text answer that.</p>${webFail(r)}${await wikiHtml(termOf(s), s, r.g && r.g.read.length ? r.g.read[0].paragraphs.join(" ") : "")}${claudeBtn(q)}`;
    }

    function dayAnswer(q) {
      const d = H.day(); const ql = q.toLowerCase();
      if (!d) return "<p>Open the Daily Brief first, then ask about the day.</p>";
      const all = d.cards.concat(d.more, d.editorials, d.explained);
      if (/top|summar|highlight|today|what happened|must.?know|overview/.test(ql)) {
        return `${sub(`${d.label}: the must-know stories`)}<ol class="bot-stories">${d.cards.slice(0, 10).map((x) => `<li>${esc(x.title)} <span class="bot-src">${esc(labelOf(x.subjects[0]) || "")}</span> ${btn("story", "Ask", { id: x.id })}</li>`).join("")}</ol>
          ${d.cards.length > 10 || d.more.length ? `<p class="bot-src">${Math.max(0, d.cards.length - 10)} more cards and ${d.more.length} one-liners in the brief.</p>` : ""}`;
      }
      const paper = ql.match(/\bgs ?([1-4])\b|\bprelims\b/);
      const subj = Object.entries(L().subjects).find(([, v]) => ql.includes(v.toLowerCase().split(/[ &]/)[0]));
      if (paper || subj) {
        const want = paper ? (paper[1] ? `GS${paper[1]}` : "Prelims") : null;
        const hits = all.filter((x) => (want ? (x.gs || []).includes(want) || (want === "Prelims" && (x.tags || []).length) : x.subjects.includes(subj[0])));
        const name = want || labelOf(subj[0]);
        return hits.length ? `${sub(`${name} in this brief: ${hits.length}`)}<ul class="bot-stories">${hits.slice(0, 12).map(storyLine).join("")}</ul>` : `<p>Nothing for ${esc(name)} in this brief.</p>`;
      }
      const corpus = all.map((x) => ({ x, text: `${x.title}. ${(x.explain && (x.explain.why_in_news || x.explain.what)) || x.summary || ""}` }));
      const hits = rank(corpus, q).slice(0, 6);
      return hits.length ? `${sub("In this brief")}<ul class="bot-stories">${hits.map((o) => storyLine(o.x)).join("")}</ul>`
        : `<p>Nothing in this brief matches “${esc(q)}”. Try the search box, which covers Everything.</p>${claudeBtn(q)}`;
    }

    async function readAnswer(url, onStep) {  // "Summarise" on a search result
      if (!isOpen(url)) return `<p>${esc(domainOf(url))} is ${paywalled(domainOf(url)) ? "subscriber-only" : "not on the free-to-read list"}, so it isn't opened. ${link(url, "Open it yourself")}.</p>`;
      if (onStep) onStep(`Reading ${domainOf(url)}…`);
      try {
        const page = await read(url);
        const pts = summarize(sentencesFrom(page), 8);
        return `${sub(page.title || domainOf(url))}${list(pts.map((x) => esc(x.text)), "ol")}<p class="bot-src">Quoted from ${link(url, page.domain)} (${page.words} words).</p>`;
      } catch (err) { return `<p>${esc(err.message)} ${link(url, "Open it yourself")}.</p>`; }
    }

    function welcome(s) {
      return s ? `<p>Ask me about <b>${esc(s.title)}</b>: a summary of the full article (I find a free copy on the web when the original is paywalled), 60 words, the 5 Ws, background, MCQs, a Mains outline, Hindi, or anything in it.</p>`
        : "<p>Ask me about the day: the top stories, one GS paper or subject, or a topic like “RBI” or “Manipur”.</p>";
    }
    function dayPrompt(q) {
      const d = H.day();
      const extra = d ? `TODAY'S MUST-KNOW STORIES (${d.label}):\n${d.cards.slice(0, 25).map((x, i) => `${i + 1}. ${x.title}`).join("\n")}` : "";
      return claudePrompt(null, q || "Give me a UPSC-focused briefing of these stories: what happened, why it matters, GS paper links.", extra);
    }
    return {
      chips: (s) => (s ? STORY_CHIPS : DAY_CHIPS), welcome, intentOf,
      answer: (s, q, opts) => (s ? storyAnswer(s, q, opts) : Promise.resolve(dayAnswer(q))),
      read: readAnswer,
      claudeFor: (s, q) => (s ? claudePrompt(s, q && intentOf(q) !== "claude" ? q : "Explain this story for UPSC: an 8-point summary, the static background, 2 Prelims MCQs with answers, and a Mains answer outline.") : dayPrompt(q && intentOf(q) !== "claude" ? q : "")),
    };
  }

  root.UPSCCore = Object.freeze({
    STOPW, stem, words, sentencesOf, FURNITURE, overlap, rank, summarize, brief, termOf, termFrom, searchQuery, esc, safeUrl,
    makeBot, intentOf, clozes, toHindi, cleanText, localPoints, WEAK,
    summaryNow, summaryFor, sourceHtml, prefetch, onSummary, readerLoad,
    web: Object.freeze({ OPEN_DOMAINS, isOpen, paywalled, domainOf, read, search, gather, sentencesFrom, mainText, keyQuery, matchOf }),
    wiki, expandAcronym, claudePrompt, openClaude,
  });
})(window);

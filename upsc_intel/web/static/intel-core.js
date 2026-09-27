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
  // An editorial opens with a hook (an anecdote, a quote, a scene) and argues later: its summary favours the
  // sentences that argue (should, must, needs to…) and its conclusion. Same rules as pipeline/articles.py.
  const ARGUE = /\b(should|must|need(s|ed)? to|ought to|has to|have to|the case for|it is time|instead|however|therefore|thus|imperative|crucial|way forward|lesson|reform|policy|risks?|challenge|priority|balance)\b/i;
  const ANECDOTE = /\b(I|we|my|our|once upon|years ago|remember|recall(s|ed)?|story goes|was sold|in (18|19)\d\d)\b/;
  function summarize(sents, n = 8, { editorial = false } = {}) {
    const docs = sents.map((s) => words(s.text));
    const df = {}; for (const ws of docs) for (const w of ws) df[w] = (df[w] || 0) + 1;
    const N = sents.length || 1;
    const scored = sents.map((s, i) => {
      const ws = docs[i]; if (ws.length < 4) return { i, sc: 0 };
      let sc = 0; for (const w of ws) sc += Math.log(1 + N / df[w]) * (df[w] > 1 ? 1.4 : 1);
      sc /= Math.sqrt(ws.length);
      if (editorial) {
        const pos = i / N;
        sc *= (ARGUE.test(s.text) ? 1.3 : 1) * (pos < 0.15 ? 0.55 : pos > 0.7 ? 1.2 : 1) * (ANECDOTE.test(s.text) ? 0.6 : 1);
      } else sc *= i < 2 ? 1.5 : i < 6 ? 1.15 : 1;
      return { i, sc };
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

  // Countries as headlines write them → Wikipedia's names, for "India–United States relations" pages.
  const COUNTRY = { us: "United States", usa: "United States", america: "United States", uk: "United Kingdom", britain: "United Kingdom",
    uae: "United Arab Emirates", eu: "European Union", russia: "Russia", china: "China", japan: "Japan", france: "France", germany: "Germany",
    australia: "Australia", canada: "Canada", pakistan: "Pakistan", bangladesh: "Bangladesh", nepal: "Nepal", bhutan: "Bhutan",
    "sri lanka": "Sri Lanka", maldives: "Maldives", myanmar: "Myanmar", afghanistan: "Afghanistan", iran: "Iran", israel: "Israel",
    "saudi arabia": "Saudi Arabia", qatar: "Qatar", oman: "Oman", egypt: "Egypt", ukraine: "Ukraine", brazil: "Brazil", chile: "Chile",
    mexico: "Mexico", argentina: "Argentina", "south africa": "South Africa", nigeria: "Nigeria", kenya: "Kenya", ethiopia: "Ethiopia",
    indonesia: "Indonesia", vietnam: "Vietnam", singapore: "Singapore", malaysia: "Malaysia", thailand: "Thailand", philippines: "Philippines",
    "south korea": "South Korea", korea: "South Korea", mongolia: "Mongolia", kazakhstan: "Kazakhstan", italy: "Italy", spain: "Spain",
    netherlands: "Netherlands", greece: "Greece", poland: "Poland", "new zealand": "New Zealand", turkey: "Turkey", "türkiye": "Turkey",
    armenia: "Armenia", mauritius: "Mauritius", "sri-lanka": "Sri Lanka", gcc: "Gulf Cooperation Council", asean: "ASEAN", africa: "Africa" };
  const COUNTRY_RX = new RegExp(`\\b(${Object.keys(COUNTRY).sort((a, b) => b.length - a.length).join("|")})\\b`, "gi");
  function countryPair(text) {  // "India-US", "India, Australia", "India and the Netherlands" → "India–United States relations"
    const t = String(text || "");
    const m = t.match(new RegExp(`\\bIndia(?:n)?\\s*(?:[-–—/]|,|\\band(?: the)?\\b)\\s*(${Object.keys(COUNTRY).join("|")})\\b`, "i"))
      || t.match(new RegExp(`\\b(${Object.keys(COUNTRY).join("|")})\\s*(?:[-–—/]|\\band\\b)\\s*India\\b`, "i"));
    const c = m && COUNTRY[m[1].toLowerCase()];
    return c ? `India–${c} relations` : "";
  }
  // the story's key term, for background: a keyword, an acronym, India's relations with a country, or a named
  // thing in the headline, never the headline itself (a search for that lands on a page like "India")
  function termOf(s) {
    const e = s.explain || {};
    if (e.keywords && e.keywords.length) return e.keywords[0];
    const skip = new Set(["UPSC", "PM", "CM", "SC", "HC", "US", "UK", "EU", "UN", "LIVE", "IST", "GS", "NEW", "MP", "MLA", "CJI", "EAM", "MEA"]);
    const acr = (s.title.match(/\b[A-Z][A-Z0-9&-]{2,}\b/g) || []).find((x) => !skip.has(x) && !/^\d/.test(x));
    if (acr) return acr;
    const pair = countryPair(s.title); if (pair) return pair;
    const quoted = s.title.match(/[‘'"“]([^’'"”]{4,60})[’'"”]/); if (quoted) return quoted[1];
    const runs = (s.title.replace(/^[^:|]{0,40}[:|]\s*/, "").match(/\b[A-Z][\w-]*(?:\s+(?:of|for|the|de|on)?\s*[A-Z][\w-]*){1,4}/g) || [])
      .filter((r) => !/^(The|A|An|In|On|At|As)\b/.test(r) || r.split(" ").length > 2);
    if (runs.length) return runs.sort((a, b) => b.length - a.length)[0];
    return keyQuery(s) || searchQuery(s.title, 4);
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
  // The free article the build already read for a card (pipeline/articles.py): its link and opening text.
  function builtPage(story) {
    const b = story && story.sum;
    if (!b || !b.text || !b.url) return null;
    const paragraphs = String(b.text).split("\n").map((x) => x.trim()).filter(Boolean);
    return paragraphs.length ? { url: b.url, domain: b.domain || domainOf(b.url), via: b.via || "", title: "", paragraphs, words: paragraphs.join(" ").split(/\s+/).length, built: true } : null;
  }
  async function gather(story, { extra = [], onStep, signal } = {}) {
    const step = (m) => { if (onStep) onStep(m); };
    const urls = [...new Set([...(story.sources || []).map((x) => x.u), ...extra].filter(Boolean))];
    const closed = [...new Set(urls.filter((u) => !isOpen(u) && !/news\.google\./.test(u)).map(domainOf))];
    const out = { read: [], hits: [], closed };
    const built = extra.length ? null : builtPage(story);
    if (built) { out.read.push(built); return out; }
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
    const b = story.sum;
    if (b && b.points && b.points.length) return { from: "web", points: b.points, src: { ...b, closed: [] } };
    const w = sums()[story.id];
    if (w && w.points && w.points.length) return { from: "web", points: w.points, src: w };
    return { from: "brief", points: localPoints(story), miss: !!(w && w.miss && Date.now() - w.at < MISS_RETRY), busy: inflight.has(story.id), src: w };
  }
  // The full article's 8-point summary, read from a free copy (once per story, kept on the device).
  // → {points, src} or {miss, hits, closed}
  function summaryFor(story, { onStep } = {}) {
    const b = story.sum;
    if (b && b.points && b.points.length) return Promise.resolve({ points: b.points, src: { ...b, closed: [] } });
    const w = sums()[story.id];
    if (w && w.points && w.points.length) return Promise.resolve({ points: w.points, src: w });
    if (!inflight.has(story.id)) {
      const p = gather(story, { onStep }).then((g) => {
        const all = sums();
        if (g.read.length) {
          const page = g.read[0];
          all[story.id] = { points: summarize(sentencesFrom(page), 8, { editorial: !!story.editorial }).map((x) => x.text), url: page.url, domain: page.domain, via: page.via || "", closed: g.closed.filter(paywalled), at: Date.now() };
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
  // A country, a continent or a whole field is never "the background" of one story.
  const BROAD = new Set(["india", "united states", "china", "russia", "pakistan", "asia", "europe", "africa", "world", "earth",
    "economy of india", "politics of india", "government of india", "history of india", "united nations", "war", "economy", "politics"]);
  const broadPage = (title, story) => BROAD.has(String(title).toLowerCase()) || (Object.values(COUNTRY).some((c) => c.toLowerCase() === String(title).toLowerCase())
    && !new RegExp(`^${String(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(story ? story.title : ""));
  // strict: take the first hit (best fit first) that shares 2+ of the story's words beyond the term, or whose
  // title is the term itself, and isn't a broad page; null when none does.
  function wiki(term, context, { strict = false, story = null } = {}) {
    const own = new Set(words(term));
    const ctx = new Set([...(context || [])].filter((w) => !own.has(w)));
    const key = `${strict ? "!" : ""}${term.toLowerCase()}|${[...ctx].sort().join(" ").slice(0, 400)}`;
    if (!wikiCache.has(key)) {
      wikiCache.set(key, (async () => {
        const r = await fetch(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(term)}&limit=5`);
        if (!r.ok) throw new Error(`Wikipedia search: ${r.status}`);
        const acr = /^[A-Z][A-Z0-9&-]{1,7}$/.test(term) ? term.replace(/[^A-Z]/g, "") : "";
        const initials = (t) => (String(t).match(/\b[A-Z]/g) || []).join("");
        const hits = ((await r.json()).pages || []).map((h, i) => {
          const hw = words(`${h.title} ${h.description || ""} ${String(h.excerpt || "").replace(/<[^>]+>/g, "")}`);
          const spelt = !!acr && initials(h.title) === acr;  // "CBAM" → "Carbon Border Adjustment Mechanism"
          return { h, i, spelt, fit: hw.filter((w) => ctx.has(w)).length + (spelt ? 3 : 0) };
        });
        const order = ctx.size ? hits.slice().sort((x, y) => (y.fit - x.fit) || (x.i - y.i)) : hits;
        const norm = (t) => String(t).toLowerCase().replace(/[–—-]/g, " ").replace(/\s+/g, " ").trim();
        const exactOf = (x) => x.spelt || norm(x.h.title) === norm(term);
        const fits = (x) => !broadPage(x.h.title, story) && (x.fit >= 2 || exactOf(x));
        for (const x of (strict ? order.filter(fits) : order).slice(0, 3)) {
          const { h, fit } = x;
          const r2 = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.key)}`);
          if (!r2.ok) continue;
          const j = await r2.json();
          if (j.type === "disambiguation" || !j.extract) continue;
          return {
            title: j.title, desc: j.description || "", extract: j.extract, fit, exact: exactOf(x),
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
  // "What is the issue with …", "What is India's stand on …": a question about the story, not a term to define
  const ABOUT_STORY = /\b(issue|problem|impact|effect|reason|stand|stance|position|role|significance|concern|debate|controversy|dispute|row|happen\w*|said|says|say|mean for|means for|latest|update|outcome|result|decision|plan|deal|response|reaction|status|matter|point|argument|view)\b|['’]s\b/i;
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
    const wikiCard = (w, s, term) => `<p class="bot-lead">Background: <b>${esc(w.title)}</b>${w.desc ? ` <span class="bot-src">(${esc(w.desc)})</span>` : ""}</p>
      ${s && !w.fit && !w.exact ? `<p class="bot-src">Wikipedia's closest page for “${esc(term)}”: it may not be what this story means.</p>` : ""}${para(w.extract)}
      <p class="bot-src">From Wikipedia, which may not cover the latest development. ${link(w.url, "Read the full article")}${w.others.length ? ` · also: ${w.others.map((o) => btn("wiki", o, { term: o })).join(", ")}` : ""}</p>`;
    const wikiDown = (e, term) => `<p>Couldn't reach Wikipedia just now${/429/.test(e.message) ? " (too many lookups: try again in a minute)" : ""}. ${link(`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(term)}`, "Open the search on Wikipedia")}.</p>`;
    function storyContext(s, text) {
      const e = (s && s.explain) || {};
      return s ? words([s.title, e.where, e.who, ...namesIn(String(text || "").slice(0, 20000))].join(" ")) : [];
    }
    // A term you asked about ("What is CBAM?"): its page in the story's sense, or the closest one, labelled.
    async function wikiHtml(term, s, extraText) {
      const text = s ? `${corpusOf(s).map((o) => o.text).join(" ")} ${extraText || ""}` : "";
      const long = s ? expandAcronym(term, text) : "";
      const ctx = storyContext(s, text);
      try {
        let w = null;
        for (const t of [...new Set([long, term].filter(Boolean))]) {
          const hit = await wiki(t, ctx, { story: s });
          if (hit && (!w || hit.fit > w.fit)) w = hit;
          if (w && (w.fit > 0 || !s)) break;
        }
        if (!w) return `<p>Wikipedia has no page that matches <b>${esc(long || term)}</b>. ${link(`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(term)}`, "Search Wikipedia yourself")}.</p>`;
        return wikiCard(w, s, long || term);
      } catch (e) {
        return wikiDown(e, term);
      }
    }
    // What to look up for a story's background, most specific first: its keywords, an acronym (spelt out from
    // the story's own text), India's relations with a country in it, names the article repeats, its key terms.
    function bgTerms(s, text) {
      const e = s.explain || {}; const out = [];
      const add = (t) => { const x = String(t || "").replace(/\s+/g, " ").trim(); if (x.length > 2 && !out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x); };
      (e.keywords || []).slice(0, 2).forEach(add);
      const t0 = termOf(s);
      if (isAcronym(t0)) { add(expandAcronym(t0, text)); add(t0); }
      add(countryPair(s.title) || countryPair(String(text).slice(0, 4000)));
      const runs = {};
      for (const r of String(text).match(/\b[A-Z][a-z][\w-]*(?:\s+(?:of|for|the|de|on)?\s*[A-Z][\w-]*){1,4}/g) || []) {
        if (!/^(The|This|That|These|In|On|At|He|She|It|But|And|However|Prime Minister|External Affairs Minister|Union Minister|Chief Minister)\b/.test(r)) runs[r] = (runs[r] || 0) + 1;
      }
      Object.entries(runs).filter(([, k]) => k >= 2).sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length)).slice(0, 2).forEach(([r]) => add(r));
      add(keyQuery(s)); add(t0);
      return out.slice(0, 6);
    }
    // The story's background: the first page, over at most four lookups, that fits this story. None rather
    // than a wrong one (a lookup of a headline used to land on "India").
    async function backgroundHtml(s, extraText) {
      const text = `${corpusOf(s).map((o) => o.text).join(" ")} ${extraText || ""}`;
      const ctx = storyContext(s, text);
      const terms = bgTerms(s, text);
      try {
        for (const t of terms.slice(0, 4)) {
          const w = await wiki(t, ctx, { strict: true, story: s });
          if (w) return wikiCard(w, s, t);
        }
      } catch (e) {
        return wikiDown(e, terms[0] || s.title);
      }
      return `<p>No Wikipedia page clearly fits this story, so none is shown.</p>
        <p class="bot-src">Look up: ${terms.slice(0, 4).map((t) => btn("wiki", t, { term: t })).join(" · ")}</p>${claudeBtn("Give me the static background for this story for UPSC")}`;
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
        const extra = await webText(s, onStep, !!s.sum || (isAcronym(term) && !expandAcronym(term, corpus.map((o) => o.text).join(" "))));
        return `${own ? `${sub("Static background", n ? NOTE_TAG : "")}${para(own)}` : ""}${await backgroundHtml(s, extra)}`;
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
      // A free question is answered from the article: the full text (read by the build, or a free copy read
      // now), then the outlets' reports. Wikipedia only for a short "what is X?" term, alongside what the article
      // says about it. Nothing matching: the closest lines, labelled as such, and Ask Claude.
      const term = termFrom(q);
      const define = !!term && words(term).length <= 4 && !ABOUT_STORY.test(term);
      const local = rank(corpus.filter((o) => !o.head), q).filter((o) => o.share >= 0.5).slice(0, 3);
      if (!define && !s.sum && intent !== "deep" && local.length && local[0].cover === 1) {  // every word of the question in one line
        return `<p>From the reports:</p><ul>${local.map(cite).join("")}</ul><p class="bot-src">${btn("deeper", "Look in the full article", { q })}</p>`;
      }
      const r = await fromWeb(s, onStep);
      const art = r.g && r.g.read.length ? sentencesFrom(r.g.read[0]) : [];
      if (define) {
        const says = rank(art.length ? art : corpus.filter((o) => !o.head), term).filter((o) => o.cover === 1).slice(0, 2);
        return `${says.length ? `${sub("In this story")}<ul>${says.map(cite).join("")}</ul>` : ""}${await wikiHtml(term, s, art.map((x) => x.text).join(" "))}`;
      }
      const hits = rank(art, q).filter((o) => o.share >= 0.5).slice(0, 3);
      if (hits.length) return `<p>From the full article:</p><ul>${hits.map(cite).join("")}</ul><p class="bot-src">${sourceLine(r.g)}</p>`;
      if (local.length) return `<p>From the reports:</p><ul>${local.map(cite).join("")}</ul>${webFail(r)}`;
      const near = rank(art.length ? art : corpus.filter((o) => !o.head), q).slice(0, 3);
      if (near.length) {
        return `<p>Nothing in the ${art.length ? "article" : "reports"} answers that exactly. The closest lines:</p><ul>${near.map(cite).join("")}</ul>
          ${art.length ? `<p class="bot-src">${sourceLine(r.g)}</p>` : webFail(r)}${claudeBtn(q)}`;
      }
      const partial = art.length && art.length < 6 ? ` (only the opening of the article, ${art.length} lines, could be read)` : "";
      return `<p>The ${art.length ? "article doesn't" : "reports don't"} cover that${partial}.</p>${webFail(r)}
        <p class="bot-src">${btn("chip", "See how other outlets report it", { q: "Search the web" })} · ${btn("chip", "Static background", { q: "Static background" })}</p>${claudeBtn(q)}`;
    }

    function dayAnswer(q) {
      const d = H.day(); const ql = q.toLowerCase();
      if (!d) return "<p>Open the Daily Brief first, then ask about the day.</p>";
      const facts = d.prelims || [];
      const all = d.cards.concat(facts, d.more, d.editorials, d.explained);
      const line = (x) => `<li>${esc(x.title)} <span class="bot-src">${esc(labelOf(x.subjects[0]) || "")}</span> ${btn("story", "Ask", { id: x.id })}</li>`;
      if (facts.length && /prelims facts?|\bfacts\b|quick facts/.test(ql)) {
        return `${sub(`${d.label}: ${facts.length} Prelims fact${facts.length === 1 ? "" : "s"}`)}<ol class="bot-stories">${facts.slice(0, 15).map(line).join("")}</ol>`;
      }
      if (/top|summar|highlight|today|what happened|must.?know|overview/.test(ql)) {
        const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
        const rest = [d.cards.length > 10 ? n(d.cards.length - 10, "more must-know card", "more must-know cards") : "",
          facts.length ? n(facts.length, "Prelims fact", "Prelims facts") : "", d.more.length ? n(d.more.length, "one-liner", "one-liners") : ""].filter(Boolean);
        return `${sub(`${d.label}: the must-know stories`)}<ol class="bot-stories">${d.cards.slice(0, 10).map(line).join("")}</ol>
          ${rest.length ? `<p class="bot-src">Also in the brief: ${rest.join(", ")}.</p>` : ""}`;
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
      const facts = d && d.prelims ? d.prelims : [];
      const extra = d ? `TODAY'S MUST-KNOW STORIES (${d.label}):\n${d.cards.slice(0, 25).map((x, i) => `${i + 1}. ${x.title}`).join("\n")}` +
        (facts.length ? `\n\nPRELIMS FACTS:\n${facts.slice(0, 20).map((x, i) => `${i + 1}. ${x.title}`).join("\n")}` : "") : "";
      return claudePrompt(null, q || "Give me a UPSC-focused briefing of these stories: what happened, why it matters, GS paper links.", extra);
    }
    return {
      chips: (s) => (s ? STORY_CHIPS : DAY_CHIPS), welcome, intentOf,
      answer: (s, q, opts) => (s ? storyAnswer(s, q, opts) : Promise.resolve(dayAnswer(q))),
      read: readAnswer,
      claudeFor: (s, q) => (s ? claudePrompt(s, q && intentOf(q) !== "claude" ? q : "Explain this story for UPSC: an 8-point summary, the static background, 2 Prelims MCQs with answers, and a Mains answer outline.") : dayPrompt(q && intentOf(q) !== "claude" ? q : "")),
    };
  }

  // ─────────────────────────── Practice: the day's UPSC-style MCQs (data/practice/<day>.json) ───────────────────────────
  // One widget for the dashboard and the app: pick a day, a set of 10/15/20, practice (answer shown after each) or exam
  // (answers at the end); swap any question for one never seen; a result with UPSC marking and every answer's source.
  // What you've seen and your scores stay on this device (shared by the dashboard and the app).
  const PX_KEY = "upsc-practice";
  const pxStore = {
    get() { try { const v = JSON.parse(localStorage.getItem(PX_KEY) || "{}") || {}; return { seen: v.seen || {}, attempts: v.attempts || [] }; } catch (e) { return { seen: {}, attempts: [] }; } },
    set(v) {
      const seen = Object.entries(v.seen).sort((a, b) => b[1] - a[1]).slice(0, 3000);
      try { localStorage.setItem(PX_KEY, JSON.stringify({ seen: Object.fromEntries(seen), attempts: v.attempts.slice(-80) })); } catch (e) { /* private mode or full */ }
    },
  };
  const PX_TYPE = { statements: "Statements", pairs: "Match the pairs", fact: "Fact", figure: "Figure", claude: "By Claude" };
  const PX_MARK = { right: 2, wrong: -0.66 };
  const PX_QUOTA = { pairs: 0.08, statements: 0.5, fact: 0.25, figure: 0.17, claude: 1 };
  function pxSeed(t) { let h = 2166136261; for (const c of String(t)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
  // A set of n: questions never seen first, one per story before a second, about half statements, one pairs at most.
  function pxPick(pool, n, seen, exclude = new Set()) {
    const avail = pool.filter((q) => !exclude.has(q.id));
    const fresh = avail.filter((q) => !seen[q.id]); const old = avail.filter((q) => seen[q.id]);
    const out = []; const stories = new Map(); const count = {};
    const room = (q) => (count[q.type] || 0) < Math.max(1, Math.round((PX_QUOTA[q.type] || 0.2) * n)) && (q.type !== "pairs" || !count.pairs);
    const take = (q) => { out.push(q); stories.set(q.story_id, (stories.get(q.story_id) || 0) + 1); count[q.type] = (count[q.type] || 0) + 1; };
    for (const list of [fresh, old]) {
      for (const pass of [0, 1, 2]) {
        for (const q of list) {
          if (out.length >= n) break;
          if (out.includes(q) || (q.type === "pairs" && count.pairs)) continue;
          if (pass === 0 && (stories.get(q.story_id) || !room(q))) continue;
          if (pass === 1 && (stories.get(q.story_id) || 0) >= 1 && !room(q)) continue;
          take(q);
        }
      }
    }
    const seed = pxSeed(out.map((q) => q.id).join());  // types interleaved, the same order every time for this set
    return out.map((q, i) => [pxSeed(q.id + seed), q, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }
  function practiceStats() {  // for the app's Insights: accuracy by subject over your attempts
    const st = pxStore.get(); const subj = {};
    for (const a of st.attempts) for (const [k, [r, t]] of Object.entries(a.subj || {})) { subj[k] = subj[k] || [0, 0]; subj[k][0] += r; subj[k][1] += t; }
    const tot = st.attempts.reduce((x, a) => [x[0] + a.right, x[1] + a.n], [0, 0]);
    return { attempts: st.attempts, subj, accuracy: tot[1] ? Math.round((tot[0] * 100) / tot[1]) : null, seen: Object.keys(st.seen).length };
  }

  // host: { day() → "YYYY-MM-DD", days() → recent days, newest first, load(day) → Promise<{questions}>, label(day) → text,
  //         subject(key) → name, claude(prompt) }
  function mountPractice(el, host) {
    const P = { view: "setup", day: host.day(), size: 15, mode: "practice", pool: null, loading: false, err: "", s: null };
    const L = (k) => (host.subject ? host.subject(k) : k) || k;
    async function load(day) {
      P.day = day; P.pool = null; P.loading = true; P.err = ""; render();
      try { const x = await host.load(day); P.pool = (x && x.questions) || []; } catch (e) { P.pool = []; P.err = "No practice questions for this day yet."; }
      P.loading = false; render();
    }
    function start(qs) {
      const st = pxStore.get(); const now = Date.now();
      P.s = { day: P.day, qs, i: 0, ans: {}, checked: {}, mode: P.mode, t0: now, swapped: 0 };
      if (qs[0]) st.seen[qs[0].id] = now;
      pxStore.set(st); P.view = "quiz"; render();
    }
    async function swap() {
      const S = P.s; const cur = S.qs[S.i]; const st = pxStore.get();
      const inSet = new Set(S.qs.map((q) => q.id));
      let next = pxPick(P.pool, 1, st.seen, inSet).find((q) => !st.seen[q.id]);
      if (!next) {  // this day's pool is used up: the days before it
        for (const d of (host.days() || []).filter((x) => x < S.day).slice(0, 7)) {
          try { const x = await host.load(d); next = pxPick((x && x.questions) || [], 1, st.seen, inSet).find((q) => !st.seen[q.id]); } catch (e) { next = null; }
          if (next) break;
        }
      }
      if (!next) { toastIn("No unseen question left for this day or the week before it."); return; }
      st.seen[next.id] = Date.now(); pxStore.set(st);
      S.qs[S.i] = next; delete S.ans[cur.id]; delete S.checked[cur.id]; S.swapped += 1; render();
    }
    function finish() {
      const S = P.s; const st = pxStore.get();
      let right = 0; let wrong = 0; const subj = {};
      for (const q of S.qs) {
        const a = S.ans[q.id]; const k = q.subject || "other"; subj[k] = subj[k] || [0, 0]; subj[k][1] += 1;
        if (a == null) continue;
        if (a === q.answer) { right += 1; subj[k][0] += 1; } else wrong += 1;
      }
      const res = { day: S.day, n: S.qs.length, right, wrong, skipped: S.qs.length - right - wrong,
        score: Math.round((right * PX_MARK.right + wrong * PX_MARK.wrong) * 100) / 100, max: S.qs.length * PX_MARK.right,
        secs: Math.round((Date.now() - S.t0) / 1000), at: Date.now(), subj, mode: S.mode };
      st.attempts.push(res); pxStore.set(st);
      S.result = res; P.view = "result"; render();
    }
    let toastMsg = "";
    function toastIn(m) { toastMsg = m; render(); setTimeout(() => { toastMsg = ""; render(); }, 3500); }
    const optLabel = (i) => "abcd"[i];
    function qHtml(q, S, review = false) {
      const a = S.ans[q.id]; const shown = review || S.checked[q.id];
      const items = q.items && q.items.length ? (q.type === "fact" || q.type === "figure"
        ? `<blockquote class="px-sent">${esc(q.items[0])}</blockquote>`
        : `<ol class="px-items">${q.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`) : "";
      const opts = q.options.map((o, i) => {
        const cls = shown ? (i === q.answer ? " right" : i === a ? " wrong" : "") : i === a ? " sel" : "";
        return `<button class="px-opt${cls}" data-px="pick" data-i="${i}"${shown ? " disabled" : ""}><b>(${optLabel(i)})</b> ${esc(o)}</button>`;
      }).join("");
      const verdict = a == null ? "Not answered" : a === q.answer ? "Correct" : "Incorrect";
      const why = shown ? `<div class="px-why ${a === q.answer ? "ok" : a == null ? "" : "bad"}"><p><b>${verdict}</b> · answer (${optLabel(q.answer)}) ${esc(q.options[q.answer])}</p>
        ${q.why ? `<p>${esc(q.why)}</p>` : ""}<p class="px-src">${q.url ? `<a href="${esc(safeUrl(q.url))}" target="_blank" rel="noopener">Source: ${esc(q.src || domainOf(q.url))} ↗</a> · ` : ""}${esc(q.title)}</p></div>` : "";
      return `<article class="px-q"><div class="px-tags"><span class="px-type">${esc(PX_TYPE[q.type] || q.type)}</span><span>${esc(L(q.subject))}</span>${(q.gs || []).map((g) => `<span>${esc(g)}</span>`).join("")}</div>
        <p class="px-stem">${esc(q.q)}</p>${items}${q.ask ? `<p class="px-ask">${esc(q.ask)}</p>` : ""}<div class="px-opts">${opts}</div>${why}</article>`;
    }
    function setupHtml() {
      const st = pxStore.get(); const pool = P.pool || [];
      const unseen = pool.filter((q) => !st.seen[q.id]).length;
      const days = [...new Set([P.day, ...(host.days() || [])])].sort().reverse().slice(0, 14);
      const stats = practiceStats(); const last = st.attempts.slice(-4).reverse();
      const subj = Object.entries(stats.subj).filter(([, [, t]]) => t >= 3).map(([k, [r, t]]) => [k, Math.round((r * 100) / t), t]).sort((a, b) => a[1] - b[1]).slice(0, 5);
      const n = Math.min(P.size, pool.length);
      return `<section class="px">
        <header class="px-head"><div class="px-eyebrow">Practice · ${esc(host.label(P.day))}</div>
          <h2>${P.loading ? "Loading the questions…" : pool.length ? `${pool.length} questions from this day's brief` : "No practice questions for this day yet"}</h2>
          <p>${pool.length ? `${unseen} you haven't seen yet · statements, match the pairs, facts and figures · UPSC marking: +2 right, −0.66 wrong` : esc(P.err || "They are built with each day's brief: try another day.")}</p></header>
        <div class="px-row"><span class="px-lab">Day</span><select class="px-day" data-px-day aria-label="Day">${days.map((d) => `<option value="${d}"${d === P.day ? " selected" : ""}>${esc(host.label(d))}</option>`).join("")}</select></div>
        <div class="px-row"><span class="px-lab">Questions</span>${[10, 15, 20].map((k) => `<button class="px-chip${P.size === k ? " on" : ""}" data-px="size" data-n="${k}">${k}</button>`).join("")}</div>
        <div class="px-row"><span class="px-lab">Mode</span><button class="px-chip${P.mode === "practice" ? " on" : ""}" data-px="mode" data-m="practice">Practice · answer after each</button><button class="px-chip${P.mode === "exam" ? " on" : ""}" data-px="mode" data-m="exam">Exam · answers at the end</button></div>
        <button class="px-go" data-px="start"${n ? "" : " disabled"}>Start ${n} question${n === 1 ? "" : "s"}</button>
        ${last.length ? `<div class="px-hist"><h3>Your last attempts</h3><ul>${last.map((a) => `<li><b>${a.score} / ${a.max}</b> · ${a.right} right, ${a.wrong} wrong, ${a.skipped} skipped · ${esc(host.label(a.day))}</li>`).join("")}</ul>
          ${subj.length ? `<p class="px-fine">Weakest areas so far: ${subj.map(([k, pc, t]) => `${esc(L(k))} ${pc}% (${t} Qs)`).join(" · ")}</p>` : ""}</div>` : ""}
        <p class="px-fine">Every question comes from the day's reports, and every answer shows its source line. Want more? <button class="px-link" data-px="claude">Make 10 more with Claude ↗</button></p>
        ${toastMsg ? `<p class="px-toast">${esc(toastMsg)}</p>` : ""}</section>`;
    }
    function quizHtml() {
      const S = P.s; const q = S.qs[S.i]; const n = S.qs.length; const last = S.i === n - 1;
      const answered = S.ans[q.id] != null; const done = Object.keys(S.ans).length;
      const nextLabel = S.mode === "exam" ? (last ? "Submit" : "Next") : last ? "Finish" : answered ? "Next" : "Skip";
      return `<section class="px"><div class="px-top"><span>Q ${S.i + 1} of ${n}</span><div class="px-bar"><i style="width:${Math.round((done * 100) / n)}%"></i></div>
          <span class="px-fine">${done} answered</span><button class="px-link" data-px="end">End</button></div>
        ${qHtml(q, S)}
        <div class="px-nav"><button class="px-btn" data-px="swap" title="Replace it with a question you haven't seen"${S.checked[q.id] ? " disabled" : ""}>↻ Swap question</button>
          <span class="px-sp"></span>${S.i > 0 ? `<button class="px-btn" data-px="prev">Back</button>` : ""}<button class="px-btn primary" data-px="next">${nextLabel}</button></div>
        ${toastMsg ? `<p class="px-toast">${esc(toastMsg)}</p>` : ""}</section>`;
    }
    function resultHtml() {
      const S = P.s; const r = S.result; const acc = r.right + r.wrong ? Math.round((r.right * 100) / (r.right + r.wrong)) : 0;
      const bars = Object.entries(r.subj).sort((a, b) => b[1][1] - a[1][1]).map(([k, [rt, t]]) => `<div class="px-sbar"><span>${esc(L(k))}</span><div><i style="width:${Math.round((rt * 100) / t)}%"></i></div><b>${rt}/${t}</b></div>`).join("");
      const wrongN = S.qs.filter((q) => S.ans[q.id] != null && S.ans[q.id] !== q.answer).length;
      return `<section class="px"><header class="px-res"><div class="px-eyebrow">Result · ${esc(host.label(S.day))} · ${S.mode === "exam" ? "exam" : "practice"} mode</div>
          <div class="px-score">${r.score} <small>/ ${r.max}</small></div>
          <p>${r.right} right · ${r.wrong} wrong · ${r.skipped} skipped · ${acc}% accuracy · ${Math.floor(r.secs / 60)} min ${r.secs % 60} s</p></header>
        <div class="px-sbars">${bars}</div>
        <div class="px-nav"><button class="px-btn primary" data-px="again">New set (questions you haven't seen)</button>${wrongN ? `<button class="px-btn" data-px="retry">Retry the ${wrongN} wrong</button>` : ""}<button class="px-btn" data-px="setup">Back</button></div>
        <h3 class="px-rh">Review</h3>${S.qs.map((q, i) => `<div class="px-rev"><p class="px-fine">Q${i + 1}</p>${qHtml(q, S, true)}</div>`).join("")}</section>`;
    }
    function render() {
      el.innerHTML = P.view === "quiz" && P.s ? quizHtml() : P.view === "result" && P.s ? resultHtml() : setupHtml();
      const sel = el.querySelector("[data-px-day]");
      if (sel) sel.onchange = () => load(sel.value);
    }
    el.onclick = async (ev) => {
      const t = ev.target.closest("[data-px]"); if (!t || !el.contains(t)) return;
      const a = t.dataset.px; const S = P.s;
      if (a === "size") { P.size = Number(t.dataset.n); render(); }
      else if (a === "mode") { P.mode = t.dataset.m; render(); }
      else if (a === "start" || a === "again") { const st = pxStore.get(); const qs = pxPick(P.pool || [], P.size, st.seen); if (qs.length) start(qs); }
      else if (a === "retry") { const qs = S.qs.filter((q) => S.ans[q.id] != null && S.ans[q.id] !== q.answer); if (qs.length) start(qs); }
      else if (a === "setup") { P.view = "setup"; render(); }
      else if (a === "pick" && S) {
        const q = S.qs[S.i]; if (S.checked[q.id]) return;
        S.ans[q.id] = Number(t.dataset.i);
        if (S.mode === "practice") S.checked[q.id] = true;
        render();
      } else if (a === "next" && S) {
        if (S.i >= S.qs.length - 1) { finish(); return; }
        S.i += 1; const st = pxStore.get(); st.seen[S.qs[S.i].id] = Date.now(); pxStore.set(st); render();
      } else if (a === "prev" && S) { S.i = Math.max(0, S.i - 1); render(); }
      else if (a === "swap" && S) await swap();
      else if (a === "end" && S) finish();
      else if (a === "claude") {
        const facts = (P.pool || []).filter((q) => q.why).slice(0, 25).map((q, i) => `${i + 1}. ${q.title}: ${q.why.replace(/^The report says: /, "")}`.slice(0, 400));
        host.claude(`Make 10 new UPSC Prelims-style MCQs (statement-based "consider the following statements", "how many pairs are correctly matched", and direct questions), each with four options, the answer and a one-line explanation, from these news facts of ${host.label(P.day)}:\n${facts.join("\n")}`);
      }
    };
    load(P.day);
    return { setDay: (d) => { if (d && d !== P.day && P.view === "setup") load(d); }, render };
  }

  root.UPSCCore = Object.freeze({
    STOPW, stem, words, sentencesOf, FURNITURE, overlap, rank, summarize, brief, termOf, termFrom, searchQuery, esc, safeUrl,
    makeBot, intentOf, clozes, toHindi, cleanText, localPoints, WEAK,
    summaryNow, summaryFor, sourceHtml, prefetch, onSummary, readerLoad,
    web: Object.freeze({ OPEN_DOMAINS, isOpen, paywalled, domainOf, read, search, gather, sentencesFrom, mainText, keyQuery, matchOf }),
    wiki, expandAcronym, claudePrompt, openClaude,
    mountPractice, practiceStats, pxPick,
  });
})(window);

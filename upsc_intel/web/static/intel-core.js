/* UPSC Intel core: the Ask bot's engine, shared by the dashboard and the app. Vanilla JS, no keys.
   - text:   words, sentences, ranking, extractive summaries (a summary quotes the article; nothing is made up)
   - web:    reads the free, public version of a story through Jina Reader (keyless, allows calls from
             any page) and searches the news (Bing News RSS, through the same reader) to find the same
             story on other sites. Only domains on OPEN_DOMAINS are read: subscriber-only and metered
             sites are never fetched, so no paywall is bypassed; a story whose own outlets are paywalled
             is read from a free site that carries it.
   - wiki:   background from Wikipedia's REST API (keyless, allows calls from any page)
   - claude: hands a question to Claude (claude.ai, on the viewer's own plan) with the story as context
   - Intel AI: with the viewer's own free Google AI Studio key (kept only on their device, sent only to Google's
             Gemini API), free questions and the writing chips are answered in Intel's own words from the story's
             article. The bot is always "Intel"; Gemini is the engine underneath. */
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
  // (a paragraph's own "NEW DELHI:" is no teaser: the dateline must follow words of a headline)
  const TEASER = (t) => /[a-z].*?\S\s+[A-Z]{4,}(?:[ -][A-Z]{2,})*:\s/.test(t) || (/^[‘'"“]/.test(t) && /(\.\.\.|…)$/.test(t));
  // the author's bio under an article
  const BIO = /^(?:[A-Z][\w.'’-]+\s){1,3}(?:is|has)\b.{0,80}?\b(?:years of experience|(?:senior |special |principal )?(?:journalist|correspondent|reporter)\b)/;
  // A run of article text survives what sites put between its paragraphs (a tweet, a comment box, ads: short lines)
  // but ends at a block of rejected prose (a "trending" strip, a list of other stories) or a long stretch of page.
  const RUN_GAP = 15; const RUN_NOISE = 60;
  function mainText(md) {
    const kept = []; let gap = 0; let noise = 0;
    String(md || "").split("\n").forEach((raw, i) => {
      if (!raw.trim()) return;
      const links = (raw.match(/\]\(/g) || []).length;
      const linked = (raw.match(/\[[^\]]*\]\(/g) || []).reduce((sum, m) => sum + m.length - 3, 0);
      const listed = /^\s*(\d+\.|[-*+])\s/.test(raw);
      const t = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/(\w?)\[([^\]]*)\]\([^)]*\)(\w?)/g, (m, a, x, b) => `${a}${a ? " " : ""}${x}${b ? " " : ""}${b}`)  // "President[Donald Trump](…)and"
        .replace(/^\s*(\d+\.|[-*+])(\s+(\d+\.|[-*+]))*\s+/, "").replace(/[*_`#>|]+/g, " ").replace(/\s+/g, " ").trim()
        .replace(/([a-z0-9%)][.!?]["”’]?)([A-Z])/g, "$1 $2");  // "of the law.A Gazette" → two sentences
      const n = t ? t.split(" ").length : 0;
      const skip = () => { gap += 1; if (n >= 14) noise += n; };
      if (!t || FURNITURE.test(t) || BOILER.test(t) || TEASER(t) || BIO.test(t)) return skip();
      // a list of links: navigation, "related stories", a "trending" strip of headlines run together
      if (links >= 2 && (links * 12 > n || linked * 2 > t.length || /\]\([^)]*\)\[/.test(raw))) return skip();
      const sentence = /[.!?"”’)]$/.test(t);
      if ((n >= 14 && (sentence || n >= 28)) || (listed && n >= 8 && sentence)) {
        kept.push({ i, t, n, gap, noise }); gap = 0; noise = 0;
      } else skip();
    });
    const runs = []; let cur = [];
    for (const k of kept) { if (cur.length && (k.gap > RUN_GAP || k.noise > RUN_NOISE)) { runs.push(cur); cur = []; } cur.push(k); }
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
  const OWN_FIT = 0.34;  // a story's own page words its headline its own way; a free copy found by search must match more
  const sameStory = (page, tw, bar = 0.5) => { const pw = new Set(words(page.paragraphs.join(" "))); return tw.filter((w) => pw.has(w)).length / (tw.length || 1) >= bar; };
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
      try {
        const page = trimEdges(await read(u, signal), story);
        if (sameStory(page, tw, OWN_FIT)) { out.read.push(page); return out; }  // else the text read was the page's furniture
      } catch (e) { if (e.code === "rate") throw e; }
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
  // v2: summaries kept on a device before the trending-strip fix are dropped
  const SUM_KEY = "upsc-sum-v2"; const SUM_MAX = 250; const MISS_RETRY = 6 * 3600 * 1000;
  const sumStore = {
    get() { try { return JSON.parse(localStorage.getItem(SUM_KEY) || "{}") || {}; } catch (e) { return {}; } },
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
  function sourceHtml(src) {  // (src.by: an AI wrote the points from the article; else they are its own lines)
    if (!src || !src.domain) return "";
    const a = `<a href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener">${esc(src.domain)}</a>`;
    const closed = (src.closed || []).length ? ` The original on ${esc(src.closed.join(", "))} is subscriber-only, so it wasn't opened.` : "";
    const verb = src.by ? "✦ Written by Intel AI from" : "Summarised from";
    const tail = src.by ? " Check key facts against it before quoting." : " Lines are quoted from it.";
    return (src.via === "search" ? `${verb} ${a}, a free report of the same story.${closed}` : `${verb} the full article on ${a}.`) + tail;
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

  // ─────────────────────────── Gemini (the viewer's own free key, kept on this device) ───────────────────────────
  // A Google AI Studio key is free. It is stored only in this browser and sent only to Google's Gemini API (in a
  // header, never in a URL). The reply streams in; a model whose free quota is used up hands over to the next.
  const GEM_API = "https://generativelanguage.googleapis.com/v1beta";
  const GEM_KEY = "upsc-gemini-key"; const GEM_MODELS = "upsc-gemini-models";
  const GEM_FALLBACK = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
  const GEM_TTS = "upsc-gemini-tts"; const TTS_FALLBACK = ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"];
  const gemStore = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
    set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };
  function rankModels(names) {  // the newest stable Flash, the next one, the newest Flash-Lite, then the "latest" aliases
    const ver = (n) => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)-/) || [])[1] || 0);
    const by = (rx) => names.filter((n) => rx.test(n)).sort((a, b) => ver(b) - ver(a));
    const out = [...by(/^gemini-\d+(?:\.\d+)?-flash$/).slice(0, 2), ...by(/^gemini-\d+(?:\.\d+)?-flash-lite$/).slice(0, 1),
      ...["gemini-flash-latest", "gemini-flash-lite-latest"].filter((n) => names.includes(n))];
    return out.length ? out : GEM_FALLBACK.slice();
  }
  function sseTexts(chunk) {  // "data: {…}" lines → [{text, reason}]
    return chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => {
      try {
        const c = ((JSON.parse(l.slice(5)).candidates) || [])[0] || {};
        return { text: ((c.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || "").join(""), reason: c.finishReason || "" };
      } catch (e) { return { text: "", reason: "" }; }
    });
  }
  const gemini = {
    on: () => !!gemStore.get(GEM_KEY),
    models() { try { const m = JSON.parse(gemStore.get(GEM_MODELS)); return Array.isArray(m) && m.length ? m : GEM_FALLBACK.slice(); } catch (e) { return GEM_FALLBACK.slice(); } },
    async connect(key) {  // checks the key with Google, then keeps it on this device → the models it can use
      key = String(key || "").trim();
      if (!/^[\w.-]{20,}$/.test(key)) throw fail("key", "That doesn't look like a Google AI key: copy it again from aistudio.google.com/apikey.");  // (older keys start "AIza…", newer ones "AQ.…"; Google checks it next)
      let r;
      try { r = await fetch(`${GEM_API}/models?pageSize=200`, { headers: { "x-goog-api-key": key } }); } catch (e) { throw fail("net", "Couldn't reach Google's AI service."); }
      if (!r.ok) throw fail("key", r.status === 400 || r.status === 403 ? "Google refused that key: check it was copied whole." : `Google's AI service answered with an error (${r.status}).`);
      const names = (((await r.json()).models) || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name).replace(/^models\//, ""));
      const models = rankModels(names);
      gemStore.set(GEM_KEY, key); gemStore.set(GEM_MODELS, JSON.stringify(models));
      return models;
    },
    forget() { gemStore.set(GEM_KEY, ""); gemStore.set(GEM_MODELS, ""); gemStore.set(GEM_TTS, ""); },
    // → {text, model}; onText(textSoFar) as it streams
    async generate({ system, contents, onText, signal, temperature = 0.4 }) {
      const key = gemStore.get(GEM_KEY);
      if (!key) throw fail("nokey", "Switch on ✦ Intel AI first.");
      // (a "thinking" model counts its thinking in the output budget: room for both)
      const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature, maxOutputTokens: 8192 } });
      const models = gemini.models();
      for (const model of models) {
        let r;
        try {
          r = await fetch(`${GEM_API}/models/${model}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body, signal });
        } catch (e) { if (signal && signal.aborted) throw e; throw fail("net", "Couldn't reach Google's AI service."); }
        if (r.status === 429 || r.status === 404 || r.status >= 500) continue;  // quota used up, gone or busy: the next model
        if (r.status === 401 || r.status === 403 || (r.status === 400 && /API_KEY/.test(await r.clone().text()))) throw fail("key", "Google refused the key: add it again in ✦ Intel AI.");
        if (!r.ok) throw fail("http", `Intel AI couldn't answer (${r.status}).`);
        let text = ""; let reason = "";
        const take = (chunk) => { for (const x of sseTexts(chunk)) { reason = x.reason || reason; if (x.text) { text += x.text; if (onText) onText(text); } } };
        if (r.body && r.body.getReader) {
          const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
          for (;;) {
            const { value, done } = await rd.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const cut = buf.lastIndexOf("\n"); if (cut >= 0) { take(buf.slice(0, cut)); buf = buf.slice(cut + 1); }
          }
          take(buf);
        } else take(await r.text());
        if (!text) throw fail("blocked", reason === "RECITATION" ? "Intel AI stopped: the answer would have copied the article word for word. Try asking in a different way." : `Intel AI gave no answer${reason ? ` (${reason.toLowerCase()})` : ""}.`);
        if (models[0] !== model) gemStore.set(GEM_MODELS, JSON.stringify([model, ...models.filter((m) => m !== model)]));  // start with the one that works
        return { text, model };
      }
      throw fail("quota", "The free AI quota is used up for now. Try again in a minute; if it's the daily limit, tomorrow.");
    },
    // One JSON answer to a schema (Gemini's form: "OBJECT", "STRING"…); parts may carry images ({inlineData}). → {data, model}
    async json({ system, parts, schema, signal, temperature = 0.3 }) {
      const key = gemStore.get(GEM_KEY);
      if (!key) throw fail("nokey", "Switch on ✦ Intel AI first.");
      const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }],
        generationConfig: { temperature, maxOutputTokens: 8192, responseMimeType: "application/json", responseSchema: schema } });
      const models = gemini.models();
      for (const model of models) {
        let r;
        try {
          r = await fetch(`${GEM_API}/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body, signal });
        } catch (e) { if (signal && signal.aborted) throw e; throw fail("net", "Couldn't reach Google's AI service."); }
        if (r.status === 429 || r.status === 404 || r.status >= 500) continue;  // quota used up, gone or busy: the next model
        if (r.status === 401 || r.status === 403 || (r.status === 400 && /API_KEY/.test(await r.clone().text()))) throw fail("key", "Google refused the key: add it again in ✦ Intel AI.");
        if (!r.ok) throw fail("http", `Intel AI couldn't answer (${r.status}).`);
        const c = (((await r.json()).candidates) || [])[0] || {};
        const text = ((c.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (!text) throw fail("blocked", `Intel AI gave no answer${c.finishReason ? ` (${String(c.finishReason).toLowerCase()})` : ""}.`);
        let data;
        try { data = JSON.parse(text); } catch (e) { throw fail("http", "Intel AI's reply was cut short: try again."); }
        if (models[0] !== model) gemStore.set(GEM_MODELS, JSON.stringify([model, ...models.filter((m) => m !== model)]));
        return { data, model };
      }
      throw fail("quota", "The free AI quota is used up for now. Try again in a minute; if it's the daily limit, tomorrow.");
    },
  };
  // Gemini's text-to-speech models the key can use: Flash before Pro (more free quota), newest first
  async function ttsModels(key) {
    try { const m = JSON.parse(gemStore.get(GEM_TTS)); if (Array.isArray(m) && m.length) return m; } catch (e) { /* none kept yet */ }
    let names = [];
    try {
      const r = await fetch(`${GEM_API}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
      if (r.ok) names = (((await r.json()).models) || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name).replace(/^models\//, "")).filter((n) => /tts/i.test(n));
    } catch (e) { /* offline: the usual names */ }
    const ver = (n) => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)-/) || [])[1] || 0);
    const out = names.sort((a, b) => (/pro/i.test(a) - /pro/i.test(b)) || ver(b) - ver(a));
    const list = out.length ? out : TTS_FALLBACK.slice();
    if (out.length) gemStore.set(GEM_TTS, JSON.stringify(list));
    return list;
  }
  function audioBlob({ mimeType = "", data }) {  // base64 audio → a playable Blob (raw 16-bit PCM gets a WAV header)
    const bin = atob(data); const pcm = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
    if (mimeType && !/L16|pcm/i.test(mimeType)) return new Blob([pcm], { type: mimeType });
    const rate = Number((mimeType.match(/rate=(\d+)/) || [])[1]) || 24000;
    const h = new DataView(new ArrayBuffer(44)); const tag = (o, t) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, t.charCodeAt(i)); };
    tag(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); tag(8, "WAVE"); tag(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true);
    h.setUint16(22, 1, true); h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
    tag(36, "data"); h.setUint32(40, pcm.length, true);
    return new Blob([h.buffer, pcm], { type: "audio/wav" });
  }
  // Read text aloud in one of Gemini's natural voices (its text-to-speech, on the viewer's key) → {blob (audio), model}
  gemini.speech = async function speech({ text, voice = "Aoede", signal }) {
    const key = gemStore.get(GEM_KEY);
    if (!key) throw fail("nokey", "Switch on ✦ Intel AI first.");
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } });
    const models = await ttsModels(key);
    for (const model of models) {
      let r;
      try {
        r = await fetch(`${GEM_API}/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body, signal });
      } catch (e) { if (signal && signal.aborted) throw e; throw fail("net", "Couldn't reach Google's AI service."); }
      if (r.status === 401 || r.status === 403 || (r.status === 400 && /API_KEY/.test(await r.clone().text()))) throw fail("key", "Google refused the key: add it again in ✦ Intel AI.");
      if (!r.ok) continue;  // quota used up, gone, busy, or no audio from this model: the next one
      const c = (((await r.json()).candidates) || [])[0] || {};
      const part = ((c.content || {}).parts || []).find((p) => p.inlineData && p.inlineData.data);
      if (!part) continue;
      if (models[0] !== model) gemStore.set(GEM_TTS, JSON.stringify([model, ...models.filter((m) => m !== model)]));
      return { blob: audioBlob(part.inlineData), model };
    }
    throw fail("quota", "its free voice quota is used up for now");
  };

  // Gemini's Markdown → safe HTML: headings, bullets, numbered lists, bold, italics, code, http(s) links.
  function mdHtml(t) {
    const inline = (x) => esc(x).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, a, u) => `<a href="${u}" target="_blank" rel="noopener">${a}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>");
    let html = ""; let open = null;
    const close = () => { if (open) { html += `</${open}>`; open = null; } };
    for (const raw of String(t || "").replace(/\r/g, "").split("\n")) {
      const l = raw.trimEnd(); let m;
      if (!l.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(l)) { close(); continue; }
      if ((m = l.match(/^\s*#{1,6}\s+(.*)$/))) { close(); html += `<p class="bot-sub">${inline(m[1].replace(/\*\*/g, ""))}</p>`; continue; }
      if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) { if (open !== "ul") { close(); html += "<ul>"; open = "ul"; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { if (open !== "ol") { close(); html += "<ol>"; open = "ol"; } html += `<li>${inline(m[1])}</li>`; continue; }
      close(); html += `<p>${inline(l)}</p>`;
    }
    close();
    return html;
  }
  // The key form, shown in the bot. The UIs call gemini.bindForms(onDone) once: it listens on the page.
  function geminiPanel() {
    const on = gemini.on();
    return `<div class="gem-box"><p class="bot-sub">✦ Intel AI ${on ? "is on" : "(free)"}</p>
      <p>${on ? "Intel answers your questions, MCQs, Mains outlines, Hindi and background in its own words, from the story's article."
        : "Switch it on and Intel answers any question about a story in its own words, grounded in the article: explanations, MCQs, Mains outlines, Hindi."}</p>
      ${on ? `<p><button class="linkbtn" data-gem="forget">Switch off (removes the key from this device)</button></p>`
        : `<form class="gem-form"><input type="password" name="key" placeholder="Paste your free Google AI key" autocomplete="off" spellcheck="false" aria-label="Google AI key"><button type="submit">Save</button></form>
      <p class="bot-src">Get a key free at ${link("https://aistudio.google.com/apikey", "aistudio.google.com/apikey")}. It stays in this browser and goes only to Google.</p>`}
      <p class="bot-src">Intel AI runs on Google's Gemini: your questions and the story's text go to Google to answer. On the free tier Google may use them to improve its products, so don't type anything private.</p></div>`;
  }
  let gemBound = false;
  function bindGemini(onDone) {
    if (gemBound || typeof document === "undefined") return;
    gemBound = true;
    document.addEventListener("submit", async (e) => {
      const f = e.target.closest && e.target.closest("form.gem-form"); if (!f) return;
      e.preventDefault();
      const btn = f.querySelector("button"); const input = f.querySelector("input");
      btn.disabled = true; btn.textContent = "Checking…";
      try { await gemini.connect(input.value); onDone({ ok: true, html: "<p>✦ Intel AI is on. Ask me anything about the story.</p>" }); }
      catch (err) { btn.disabled = false; btn.textContent = "Save"; onDone({ ok: false, html: `<p>${esc(err.message)}</p>` }); }
    });
    document.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest('[data-gem="forget"]'); if (!b) return;
      gemini.forget(); onDone({ ok: true, html: "<p>✦ Intel AI is off and the key is removed from this device. Answers now quote the reports and the article again.</p>" });
    });
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
    "Link to syllabus", "Summary", "Search the web", "5W", "Prelims facts", "Other outlets", "Related stories", "Videos", "✦ Intel AI", "Ask Claude ↗"];
  const DAY_CHIPS = ["Top stories", "GS1", "GS2", "GS3", "GS4", "Prelims", "✦ Intel AI", "Ask Claude ↗"];
  // "What is the issue with …", "What is India's stand on …": a question about the story, not a term to define
  const ABOUT_STORY = /\b(issue|problem|impact|effect|reason|stand|stance|position|role|significance|concern|debate|controversy|dispute|row|happen\w*|said|says|say|mean for|means for|latest|update|outcome|result|decision|plan|deal|response|reaction|status|matter|point|argument|view)\b|['’]s\b/i;
  function intentOf(q) {
    const t = String(q || "").toLowerCase().trim();
    if (/^✦?\s*(intel ai|gemini|ai)( key| settings)?$/.test(t)) return "gemini";  // the ✦ Intel AI switch
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

    // ── Gemini answers (when the viewer added a key): grounded in the story's article and reports ──
    const GEM_INTENTS = new Set(["ask", "deep", "s60", "background", "mcq", "outline", "hindi", "mainsq", "matters", "syllabus", "prelims"]);
    const GEM_TASKS = {
      s60: "Summarise this story in about 60 words for quick revision.",
      background: "Give me the static background for this story: the institution, law, scheme, place or concept involved, its history and its constitutional or legal basis. 5-8 bullets.",
      mcq: "Make 2 UPSC Prelims-style MCQs on this story. Make at least one statement-based (\"Consider the following statements… Which of the statements given above is/are correct?\"). Give options (a)-(d), then the answer and a one-line explanation for each.",
      outline: "Write a UPSC Mains answer outline (15 marks, 250 words) on this story: the likely question, then Introduction, Body (3-4 dimensions with sub-points), Way forward and Conclusion.",
      hindi: "इस खबर को UPSC (हिंदी माध्यम) के लिए सरल हिंदी में समझाइए: 6-8 बुलेट पॉइंट में मुख्य तथ्य, पृष्ठभूमि और GS पेपर से जुड़ाव।",
      mainsq: "Frame 2 likely UPSC Mains questions from this story (name the GS paper and the word limit), with the key points each answer should cover.",
      matters: "Why does this story matter for UPSC? Link it to the GS papers and syllabus topics, then list the Prelims facts to remember and the Mains angles.",
      prelims: "List the Prelims-relevant facts in this story (names, numbers, places, institutions, laws, dates), then 3-5 related static facts worth revising. Short bullets.",
    };
    GEM_TASKS.syllabus = GEM_TASKS.matters;
    const GEM_SYSTEM = `You are Intel, the UPSC Civil Services Exam tutor inside the UPSC Intel current-affairs app. The STORY CONTEXT is the news article and the reports for what the student is reading.
Rules:
- Your name is Intel. Speak as Intel; don't call yourself Gemini or a Google assistant. If asked what powers you, say Intel runs on Google's Gemini.
- Facts about this news event (who, what, numbers, dates, names, quotes) come only from the STORY CONTEXT. If it doesn't say, say "The article doesn't say". Never guess or invent figures, dates, names or quotes.
- You may add well-established static knowledge (constitutional articles, laws, institutions, history, geography) when it helps; keep it clearly marked, e.g. under a "Background" heading.
- Your own knowledge of recent events may be out of date: for anything recent, rely on the context only.
- Be exam-oriented and concise: short bullets, **bold** key terms, GS paper links, Prelims facts, Mains angles. Under 250 words unless asked for more.
- Answer in the language of the question (Hindi in Devanagari when asked in Hindi).
- Format with Markdown: short ### headings, - bullets, numbered lists, **bold**. No tables.`;
    const noteCovers = (n, intent) => !!n && ((intent === "mcq" && (n.mcqs || []).length) || (intent === "outline" && n.mains_outline)
      || (intent === "hindi" && (n.hindi || []).length) || (intent === "s60" && n.summary60) || (intent === "background" && n.background));
    const history = new Map();  // story id (or "day") → the last few turns, so follow-up questions work
    const ctxCache = new Map();
    const clip = (t, n) => (String(t || "").length > n ? String(t).slice(0, n).replace(/\s+\S*$/, "") + "…" : String(t || ""));
    async function storyContext4(s, onStep) {  // → {text, page}: what Gemini answers from
      if (ctxCache.has(s.id)) return ctxCache.get(s.id);
      const e = s.explain || {}; let page = builtPage(s);
      if (page && isOpen(page.url)) {  // the build keeps the article's opening: read all of it
        try {
          if (onStep) onStep(`Reading ${page.domain}…`);
          const full = trimEdges(await read(page.url), s);
          if (full.words > page.words && sameStory(full, words(s.title), OWN_FIT)) page = { ...full, via: page.via };
        } catch (err) { if (err.code === "rate") { /* the opening will do */ } }
      } else if (!page) {
        const r = await fromWeb(s, onStep);
        if (r.g && r.g.read.length) page = r.g.read[0];
      }
      const sg = L().subject_gs || {};
      const lines = [`Headline: ${s.title}`, `Date: ${s.date || ""}`,
        `Syllabus: ${(s.subjects || []).map((x) => `${labelOf(x)}${sg[x] ? ` (${sg[x]})` : ""}`).join(", ")}${(s.tags || []).length ? ` · Tags: ${s.tags.join(", ")}` : ""}`,
        `Outlets: ${[...new Set((s.sources || []).map((x) => x.p).filter(Boolean))].join(", ")}`];
      const w = [["Why in news", e.why_in_news], ["What happened", e.what], ["When", e.when], ["Where", e.where], ["Who", e.who],
        ["Background", !e.auto && e.background], ["Why it matters", !e.auto && (e.significance || []).join("; ")]].filter(([, v]) => v && !WEAK.test(v));
      if (w.length) lines.push("", "WRITE-UP:", ...w.map(([k, v]) => `${k}: ${v}`));
      if (page) lines.push("", `ARTICLE (${page.domain}${page.via === "search" ? ", a free report of the same story" : ""}):`, clip(page.paragraphs.join("\n"), 12000));
      const reports = (s.texts || []).slice(0, 4).map((t) => `- ${t.p || "An outlet"}: ${clip(t.x, 700)}`);
      if (reports.length) lines.push("", "OTHER REPORTS:", ...reports);
      const out = { text: lines.join("\n"), page };
      ctxCache.set(s.id, out);
      return out;
    }
    async function geminiStory(s, q, intent, { onStep, onPartial } = {}) {
      const ctx = await storyContext4(s, onStep);
      if (onStep) onStep("✦ Intel is writing…");
      const contents = [...(history.get(s.id) || []), { role: "user", parts: [{ text: GEM_TASKS[intent] || q }] }];
      const { text, model } = await gemini.generate({ system: `${GEM_SYSTEM}\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n\nSTORY CONTEXT\n${ctx.text}`,
        contents, onText: (t) => { if (onPartial) onPartial(mdHtml(t)); } });
      history.set(s.id, [...contents, { role: "model", parts: [{ text }] }].slice(-8));
      const from = ctx.page ? `the article on ${link(ctx.page.url, ctx.page.domain)}${ctx.page.via === "search" ? ", a free report of the same story" : ""}` : "the reports in the brief";
      return `${mdHtml(text)}<p class="bot-src" title="${esc(model)}">✦ Intel AI, from ${from}. Check key facts against the source before quoting.</p>`;
    }
    async function storyAnswer(s, q, opts = {}) {
      const intent = opts.deep ? "deep" : intentOf(q);
      if (intent === "gemini") return geminiPanel();
      if (gemini.on() && GEM_INTENTS.has(intent) && !noteCovers(noteOf(s), intent)) {
        try { return await geminiStory(s, q, intent, opts); } catch (err) {
          if (err && err.name === "AbortError") throw err;
          return `<p class="bot-src">✦ ${esc(err.message)} This answer comes from the reports instead.</p>${await ruleAnswer(s, q, opts)}`;
        }
      }
      return ruleAnswer(s, q, opts);
    }

    async function ruleAnswer(s, q, { onStep, deep } = {}) {
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

    const DAY_LISTS = /prelims facts?|\bfacts\b|quick facts|\btop\b|summar|highlight|what happened|must.?know|overview|\bgs ?[1-4]\b|^prelims$/i;
    async function dayAnswerAny(q, opts = {}) {
      if (intentOf(q) === "gemini") return geminiPanel();
      const d = H.day();
      if (!gemini.on() || !d || DAY_LISTS.test(q)) return dayAnswer(q);
      try {
        if (opts.onStep) opts.onStep("✦ Intel is writing…");
        const item = (x) => `- ${x.title}${x.explain && (x.explain.why_in_news || x.explain.what) ? `: ${clip(x.explain.why_in_news || x.explain.what, 220)}` : ""}`;
        const ctx = [`THE DAILY BRIEF (${d.label})`, "MUST-KNOW:", ...d.cards.slice(0, 40).map(item),
          ...(d.prelims || []).length ? ["", "PRELIMS FACTS:", ...d.prelims.slice(0, 30).map(item)] : [],
          ...(d.editorials || []).length ? ["", "EDITORIALS:", ...d.editorials.slice(0, 15).map(item)] : [],
          ...(d.explained || []).length ? ["", "EXPLAINERS:", ...d.explained.slice(0, 10).map(item)] : []].join("\n");
        const contents = [...(history.get("day") || []), { role: "user", parts: [{ text: q }] }];
        const { text, model } = await gemini.generate({ system: `${GEM_SYSTEM.replace(/STORY CONTEXT/g, "BRIEF")}\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n\nBRIEF\n${clip(ctx, 16000)}`,
          contents, onText: (t) => { if (opts.onPartial) opts.onPartial(mdHtml(t)); } });
        history.set("day", [...contents, { role: "model", parts: [{ text }] }].slice(-8));
        const all = d.cards.concat(d.prelims || [], d.more, d.editorials, d.explained);
        const hits = rank(all.map((x) => ({ x, text: `${x.title}. ${(x.explain && (x.explain.why_in_news || x.explain.what)) || x.summary || ""}` })), q).slice(0, 4);
        return `${mdHtml(text)}${hits.length ? `${sub("Stories in this brief")}<ul class="bot-stories">${hits.map((o) => storyLine(o.x)).join("")}</ul>` : ""}
          <p class="bot-src" title="${esc(model)}">✦ Intel AI, from the day's brief.</p>`;
      } catch (err) {
        return `<p class="bot-src">✦ ${esc(err.message)} This answer comes from the brief instead.</p>${dayAnswer(q)}`;
      }
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
      const gem = gemini.on() ? " ✦ Intel AI is on: ask in your own words." : "";
      return s ? `<p>Ask me about <b>${esc(s.title)}</b>: a summary of the full article (I find a free copy on the web when the original is paywalled), 60 words, the 5 Ws, background, MCQs, a Mains outline, Hindi, or anything in it.${gem}</p>`
        : `<p>Ask me about the day: the top stories, one GS paper or subject, or a topic like “RBI” or “Manipur”.${gem}</p>`;
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
      answer: (s, q, opts) => (s ? storyAnswer(s, q, opts) : dayAnswerAny(q, opts)),
      read: readAnswer,
      claudeFor: (s, q) => (s ? claudePrompt(s, q && intentOf(q) !== "claude" ? q : "Explain this story for UPSC: an 8-point summary, the static background, 2 Prelims MCQs with answers, and a Mains answer outline.") : dayPrompt(q && intentOf(q) !== "claude" ? q : "")),
    };
  }

  // ─────────────────────────── Practice hub (data/practice, data/cards, the day files) ───────────────────────────
  // One widget for the dashboard and the app, five modes:
  //   MCQs:        a day's questions (UPSC-style ones written with the AI notes first), sets of 10/15/20, practice or exam
  //   Revise:      spaced-repetition flashcards from the notes (Again / Hard / Good / Easy, Anki-like intervals)
  //   Mains:       write an answer to a day's Mains question (typed, or photos of a handwritten one); Intel AI evaluates
  //                it like a UPSC examiner (on the viewer's own key)
  //   Weekly mock: 50 questions from the last seven days, 60 minutes, exam mode
  //   Mistakes:    every question answered wrong, until it's answered right
  // Scores, the revision schedule and drafts stay on this device (shared by the dashboard and the app).
  const PX_KEY = "upsc-practice";
  const pxStore = {
    get() {
      try { const v = JSON.parse(localStorage.getItem(PX_KEY) || "{}") || {}; return { seen: v.seen || {}, attempts: v.attempts || [], wrong: v.wrong || {} }; }
      catch (e) { return { seen: {}, attempts: [], wrong: {} }; }
    },
    set(v) {
      const seen = Object.entries(v.seen).sort((a, b) => b[1] - a[1]).slice(0, 3000);
      const wrong = Object.entries(v.wrong || {}).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 300);
      try { localStorage.setItem(PX_KEY, JSON.stringify({ seen: Object.fromEntries(seen), attempts: v.attempts.slice(-80), wrong: Object.fromEntries(wrong) })); } catch (e) { /* private mode or full */ }
    },
  };
  const PX_TYPE = { statements: "Statements", pairs: "Match the pairs", fact: "Fact", figure: "Figure", claude: "By Claude", upsc: "UPSC-style" };
  const PX_MARK = { right: 2, wrong: -0.66 };
  const PX_QUOTA = { pairs: 0.08, statements: 0.5, fact: 0.25, figure: 0.17, claude: 1, upsc: 1 };
  const MOCK_N = 50; const MOCK_MIN = 60;
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
    return { attempts: st.attempts, subj, accuracy: tot[1] ? Math.round((tot[0] * 100) / tot[1]) : null, seen: Object.keys(st.seen).length,
      mistakes: Object.keys(st.wrong).length, mains: mainsStore.get().slice(-20), revise: srsStats() };
  }

  // ── spaced repetition: an Anki-like schedule per flashcard, in days (IST) ──
  const SRS_KEY = "upsc-srs"; const SRS_NEW = 20;  // new cards a day
  const dayNo = (t = Date.now()) => Math.floor((t + 5.5 * 3600e3) / 864e5);
  const srsStore = {
    get() { try { const v = JSON.parse(localStorage.getItem(SRS_KEY) || "{}") || {}; return { cards: v.cards || {}, day: v.day || 0, fresh: v.fresh || 0 }; } catch (e) { return { cards: {}, day: 0, fresh: 0 }; } },
    set(v) { try { localStorage.setItem(SRS_KEY, JSON.stringify(v)); } catch (e) { /* private mode or full */ } },
  };
  // grade: 1 Again, 2 Hard, 3 Good, 4 Easy → the card's next state {ease, ivl (days), reps, lapses, due (day number)}
  function srsNext(prev, grade, today = dayNo()) {
    const s = { ease: 2.5, ivl: 0, reps: 0, lapses: 0, ...(prev || {}) };
    if (grade === 1) { if (prev && prev.reps) s.lapses += 1; s.reps = 0; s.ivl = 0; s.ease = Math.max(1.3, s.ease - 0.2); }
    else if (!s.reps) { s.ivl = grade === 4 ? 3 : 1; s.reps = 1; if (grade === 4) s.ease += 0.15; if (grade === 2) s.ease = Math.max(1.3, s.ease - 0.15); }
    else {
      s.ivl = grade === 2 ? Math.max(1, Math.round(s.ivl * 1.2)) : grade === 3 ? Math.max(s.ivl + 1, Math.round(s.ivl * s.ease))
        : Math.max(s.ivl + 2, Math.round(s.ivl * s.ease * 1.3));
      s.reps += 1; s.ease = Math.max(1.3, s.ease + (grade === 2 ? -0.15 : grade === 4 ? 0.15 : 0));
    }
    s.due = today + s.ivl;
    return s;
  }
  const srsWhen = (prev, g) => { const n = srsNext(prev, g).ivl; return n === 0 ? "again soon" : n === 1 ? "1 day" : n < 30 ? `${n} days` : `${Math.round(n / 30)} mo`; };
  function srsStats() {
    const st = srsStore.get(); const today = dayNo(); const all = Object.values(st.cards);
    return { learned: all.filter((c) => c.reps > 0).length, due: all.filter((c) => c.due <= today).length, total: all.length };
  }

  // ── Mains: answers and their evaluations ──
  const MAINS_KEY = "upsc-mains"; const DRAFT_KEY = "upsc-mains-draft";
  const mainsStore = {
    get() { try { return JSON.parse(localStorage.getItem(MAINS_KEY) || "[]") || []; } catch (e) { return []; } },
    add(x) { try { localStorage.setItem(MAINS_KEY, JSON.stringify([...mainsStore.get(), x].slice(-100))); } catch (e) { /* full */ } },
  };
  const drafts = {
    get(id) { try { return (JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}") || {})[id] || ""; } catch (e) { return ""; } },
    set(id, text) {
      try {
        const all = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}") || {};
        if (text) all[id] = text; else delete all[id];
        localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-20))));
      } catch (e) { /* full */ }
    },
  };
  const wordCount = (t) => (String(t || "").trim().match(/\S+/g) || []).length;
  const MAINS_SYSTEM = `You are a senior UPSC Civil Services Mains examiner. Evaluate the candidate's answer the way UPSC does:
- Demand of the question: does it answer the directive (discuss, examine, critically analyse, comment) and every part of it?
- Content: accuracy and depth. Use the STORY CONTEXT for the facts of the news event.
- Dimensions: political, economic, social, environmental, legal and constitutional, ethical, international, administrative, as relevant.
- Structure: a focused introduction, an organised body (points or sub-headings), a conclusion with a way forward.
- Substantiation: examples, data, committee reports, Supreme Court judgments, constitutional Articles, schemes.
- Presentation and the word limit (150 words for 10 marks, 250 for 15).
Score like UPSC, out of {marks}: an average answer gets about 35-45% of the marks, a very good one 55-65%; above 70% is rare. Use steps of half a mark.
If pages are attached as images, first transcribe the handwritten answer faithfully into transcript; otherwise leave transcript empty.
rubric: each criterion from 0 to 10. strengths, improve, missed (dimensions or points left out): short, specific points, at most 5 each.
keywords: terms an examiner looks for that the answer lacks. examples: data, reports, cases or schemes it should cite.
better_intro and better_conclusion: rewritten in 2-3 sentences each. outline: a model answer outline in 6-10 short points.
Write the feedback in the language of the answer (Hindi if it is in Hindi). Be encouraging but honest.`;
  const STR = { type: "STRING" }; const STRS = { type: "ARRAY", items: STR }; const INT = { type: "INTEGER" };
  const MAINS_SCHEMA = { type: "OBJECT", properties: {
    transcript: STR, score: { type: "NUMBER" }, verdict: STR,
    rubric: { type: "OBJECT", properties: { demand: INT, content: INT, dimensions: INT, structure: INT, substantiation: INT, presentation: INT },
      required: ["demand", "content", "dimensions", "structure", "substantiation", "presentation"] },
    strengths: STRS, improve: STRS, missed: STRS, keywords: STRS, examples: STRS, better_intro: STR, better_conclusion: STR, outline: STRS },
    required: ["transcript", "score", "verdict", "rubric", "strengths", "improve", "missed", "keywords", "examples", "better_intro", "better_conclusion", "outline"] };
  const RUBRIC = [["demand", "Answers the demand"], ["content", "Content"], ["dimensions", "Dimensions"], ["structure", "Structure"], ["substantiation", "Examples & data"], ["presentation", "Presentation"]];
  function shrinkImage(file) {  // a photo → a JPEG at most 1600 px on its longest side: {data (base64), url}
    return new Promise((resolve, reject) => {
      const src = URL.createObjectURL(file); const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.width, img.height)); const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(src);
        const url = c.toDataURL("image/jpeg", 0.82); resolve({ data: url.split(",")[1], url });
      };
      img.onerror = () => { URL.revokeObjectURL(src); reject(new Error("That picture couldn't be read.")); };
      img.src = src;
    });
  }

  // host: { day() → "YYYY-MM-DD", days() → days with questions, newest first, load(day) → Promise<{questions}>,
  //         label(day) → text, subject(key) → name, claude(prompt),
  //         cardDays() → days with flashcards, loadCards(day) → Promise<{cards}>, loadDay(day) → Promise<the day's brief> }
  function mountPractice(el, host) {
    const P = { tab: "mcq", view: "setup", day: host.day(), size: 15, mode: "practice", pool: null, loading: false, err: "", s: null, timer: 0 };
    const R = { loaded: false, loading: false, deck: [], queue: [], i: 0, flip: false, done: 0, due: 0, fresh: 0, on: false };
    const M = { day: host.day(), stories: null, loading: false, err: "", pick: null, q: "", marks: 15, text: "", images: [], busy: false, result: null };
    const L = (k) => (host.subject ? host.subject(k) : k) || k;
    async function load(day) {
      P.day = day; P.pool = null; P.loading = true; P.err = ""; render();
      try { const x = await host.load(day); P.pool = ((x && x.questions) || []).map((q) => ({ ...q, day })); } catch (e) { P.pool = []; P.err = "No practice questions for this day yet."; }
      P.loading = false; render();
    }
    function start(qs, opts = {}) {
      const st = pxStore.get(); const now = Date.now();
      P.s = { day: opts.day || P.day, qs, i: 0, ans: {}, checked: {}, mode: opts.mode || P.mode, t0: now, swapped: 0, src: opts.src || "day",
        label: opts.label || "", deadline: opts.secs ? now + opts.secs * 1000 : 0 };
      if (qs[0]) st.seen[qs[0].id] = now;
      pxStore.set(st); P.view = "quiz"; render();
      clearInterval(P.timer);
      if (P.s.deadline) {
        P.timer = setInterval(() => {  // the mock's clock: ticks in place; at zero the set is submitted
          const left = Math.max(0, P.s && P.s.deadline ? P.s.deadline - Date.now() : 0); const t = el.querySelector(".px-timer");
          if (t) t.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
          if (!left && P.view === "quiz") finish();
        }, 1000);
      }
    }
    async function swap() {
      const S = P.s; const cur = S.qs[S.i]; const st = pxStore.get();
      const inSet = new Set(S.qs.map((q) => q.id));
      let next = S.src === "day" ? pxPick(P.pool, 1, st.seen, inSet).find((q) => !st.seen[q.id]) : null;
      if (!next) {  // this day's pool is used up: the days before it
        for (const d of (host.days() || []).filter((x) => x < S.day).slice(0, 7)) {
          try { const x = await host.load(d); next = pxPick(((x && x.questions) || []).map((q) => ({ ...q, day: d })), 1, st.seen, inSet).find((q) => !st.seen[q.id]); } catch (e) { next = null; }
          if (next) break;
        }
      }
      if (!next) { toastIn("No unseen question left for this day or the week before it."); return; }
      st.seen[next.id] = Date.now(); pxStore.set(st);
      S.qs[S.i] = next; delete S.ans[cur.id]; delete S.checked[cur.id]; S.swapped += 1; render();
    }
    function finish() {
      clearInterval(P.timer);
      const S = P.s; const st = pxStore.get();
      let right = 0; let wrong = 0; const subj = {};
      for (const q of S.qs) {
        const a = S.ans[q.id]; const k = q.subject || "other"; subj[k] = subj[k] || [0, 0]; subj[k][1] += 1;
        if (a == null) continue;
        if (a === q.answer) { right += 1; subj[k][0] += 1; delete st.wrong[q.id]; }  // right at last: out of the notebook
        else { wrong += 1; st.wrong[q.id] = { ...q, day: q.day || S.day, misses: ((st.wrong[q.id] || {}).misses || 0) + 1, at: Date.now() }; }
      }
      const res = { day: S.day, label: S.label, n: S.qs.length, right, wrong, skipped: S.qs.length - right - wrong,
        score: Math.round((right * PX_MARK.right + wrong * PX_MARK.wrong) * 100) / 100, max: S.qs.length * PX_MARK.right,
        secs: Math.round((Date.now() - S.t0) / 1000), at: Date.now(), subj, mode: S.mode, src: S.src };
      st.attempts.push(res); pxStore.set(st);
      S.result = res; P.view = "result"; render();
    }
    async function startMock() {
      P.loading = true; render();
      const pool = [];
      for (const d of (host.days() || []).slice(0, 7)) {
        try { const x = await host.load(d); for (const q of (x && x.questions) || []) pool.push({ ...q, day: d }); } catch (e) { /* a day without questions */ }
      }
      P.loading = false;
      const qs = pxPick(pool, MOCK_N, pxStore.get().seen);
      if (!qs.length) { toastIn("No questions for the last seven days yet."); return; }
      const days = [...new Set(qs.map((q) => q.day))].sort();
      start(qs, { mode: "exam", src: "mock", secs: MOCK_MIN * 60, day: days[days.length - 1], label: `Weekly mock · ${host.label(days[0])} to ${host.label(days[days.length - 1])}` });
    }
    let toastMsg = "";
    function toastIn(m) { toastMsg = m; render(); setTimeout(() => { toastMsg = ""; render(); }, 3500); }
    const optLabel = (i) => "abcd"[i];
    const toast = () => (toastMsg ? `<p class="px-toast">${esc(toastMsg)}</p>` : "");
    function tabsHtml() {
      const nWrong = Object.keys(pxStore.get().wrong).length; const due = srsStats().due;
      const t = (k, label, badge) => `<button class="px-tab${P.tab === k ? " on" : ""}" data-px="tab" data-t="${k}" role="tab" aria-selected="${P.tab === k}">${label}${badge ? ` <i>${badge}</i>` : ""}</button>`;
      return `<nav class="px-tabs nosb" role="tablist">${t("mcq", "MCQs")}${t("revise", "Revise", due)}${t("mains", "Mains")}${t("mock", "Weekly mock")}${t("mistakes", "Mistakes", nWrong)}</nav>`;
    }
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
    const daySelect = (cur, attr) => {
      const days = [...new Set([cur, ...(host.days() || [])])].sort().reverse().slice(0, 14);
      return `<select class="px-day" ${attr} aria-label="Day">${days.map((d) => `<option value="${d}"${d === cur ? " selected" : ""}>${esc(host.label(d))}</option>`).join("")}</select>`;
    };
    function setupHtml() {
      const st = pxStore.get(); const pool = P.pool || [];
      const unseen = pool.filter((q) => !st.seen[q.id]).length; const upsc = pool.filter((q) => q.type === "upsc").length;
      const stats = practiceStats(); const last = st.attempts.slice(-4).reverse();
      const subj = Object.entries(stats.subj).filter(([, [, t]]) => t >= 3).map(([k, [r, t]]) => [k, Math.round((r * 100) / t), t]).sort((a, b) => a[1] - b[1]).slice(0, 5);
      const n = Math.min(P.size, pool.length);
      return `<section class="px">${tabsHtml()}
        <header class="px-head"><div class="px-eyebrow">Practice · ${esc(host.label(P.day))}</div>
          <h2>${P.loading ? "Loading the questions…" : pool.length ? `${pool.length} questions from this day's brief` : "No practice questions for this day yet"}</h2>
          <p>${pool.length ? `${unseen} you haven't seen yet${upsc ? ` · ${upsc} UPSC-style` : ""} · statements, match the pairs, facts and figures · UPSC marking: +2 right, −0.66 wrong` : esc(P.err || "They are built with each day's brief: try another day.")}</p></header>
        <div class="px-row"><span class="px-lab">Day</span>${daySelect(P.day, "data-px-day")}</div>
        <div class="px-row"><span class="px-lab">Questions</span>${[10, 15, 20].map((k) => `<button class="px-chip${P.size === k ? " on" : ""}" data-px="size" data-n="${k}">${k}</button>`).join("")}</div>
        <div class="px-row"><span class="px-lab">Mode</span><button class="px-chip${P.mode === "practice" ? " on" : ""}" data-px="mode" data-m="practice">Practice · answer after each</button><button class="px-chip${P.mode === "exam" ? " on" : ""}" data-px="mode" data-m="exam">Exam · answers at the end</button></div>
        <button class="px-go" data-px="start"${n ? "" : " disabled"}>Start ${n} question${n === 1 ? "" : "s"}</button>
        ${last.length ? `<div class="px-hist"><h3>Your last attempts</h3><ul>${last.map((a) => `<li><b>${a.score} / ${a.max}</b> · ${a.right} right, ${a.wrong} wrong, ${a.skipped} skipped · ${esc(a.label || host.label(a.day))}</li>`).join("")}</ul>
          ${subj.length ? `<p class="px-fine">Weakest areas so far: ${subj.map(([k, pc, t]) => `${esc(L(k))} ${pc}% (${t} Qs)`).join(" · ")}</p>` : ""}</div>` : ""}
        <p class="px-fine">Every question comes from the day's reports, and every answer shows its source. Want more? <button class="px-link" data-px="claude">Make 10 more with Claude ↗</button></p>
        ${toast()}</section>`;
    }
    function quizHtml() {
      const S = P.s; const q = S.qs[S.i]; const n = S.qs.length; const last = S.i === n - 1;
      const answered = S.ans[q.id] != null; const done = Object.keys(S.ans).length;
      const nextLabel = S.mode === "exam" ? (last ? "Submit" : "Next") : last ? "Finish" : answered ? "Next" : "Skip";
      const left = S.deadline ? Math.max(0, S.deadline - Date.now()) : 0;
      return `<section class="px"><div class="px-top"><span>Q ${S.i + 1} of ${n}</span><div class="px-bar"><i style="width:${Math.round((done * 100) / n)}%"></i></div>
          ${S.deadline ? `<span class="px-timer" title="Time left">${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}</span>` : `<span class="px-fine">${done} answered</span>`}<button class="px-link" data-px="end">End</button></div>
        ${qHtml(q, S)}
        <div class="px-nav">${S.src === "day" ? `<button class="px-btn" data-px="swap" title="Replace it with a question you haven't seen"${S.checked[q.id] ? " disabled" : ""}>↻ Swap question</button>` : ""}
          <span class="px-sp"></span>${S.i > 0 ? `<button class="px-btn" data-px="prev">Back</button>` : ""}<button class="px-btn primary" data-px="next">${nextLabel}</button></div>
        ${toast()}</section>`;
    }
    function resultHtml() {
      const S = P.s; const r = S.result; const acc = r.right + r.wrong ? Math.round((r.right * 100) / (r.right + r.wrong)) : 0;
      const bars = Object.entries(r.subj).sort((a, b) => b[1][1] - a[1][1]).map(([k, [rt, t]]) => `<div class="px-sbar"><span>${esc(L(k))}</span><div><i style="width:${Math.round((rt * 100) / t)}%"></i></div><b>${rt}/${t}</b></div>`).join("");
      const wrongN = S.qs.filter((q) => S.ans[q.id] != null && S.ans[q.id] !== q.answer).length;
      return `<section class="px"><header class="px-res"><div class="px-eyebrow">Result · ${esc(S.label || host.label(S.day))} · ${S.mode === "exam" ? "exam" : "practice"} mode</div>
          <div class="px-score">${r.score} <small>/ ${r.max}</small></div>
          <p>${r.right} right · ${r.wrong} wrong · ${r.skipped} skipped · ${acc}% accuracy · ${Math.floor(r.secs / 60)} min ${r.secs % 60} s${wrongN ? ` · the ${wrongN} wrong ones are in <b>Mistakes</b>` : ""}</p></header>
        <div class="px-sbars">${bars}</div>
        <div class="px-nav">${S.src === "day" ? `<button class="px-btn primary" data-px="again">New set (questions you haven't seen)</button>` : ""}${wrongN ? `<button class="px-btn" data-px="retry">Retry the ${wrongN} wrong</button>` : ""}<button class="px-btn" data-px="setup">Back</button></div>
        <h3 class="px-rh">Review</h3>${S.qs.map((q, i) => `<div class="px-rev"><p class="px-fine">Q${i + 1}</p>${qHtml(q, S, true)}</div>`).join("")}</section>`;
    }

    // ── Revise ──
    async function loadDeck() {
      R.loading = true; render();
      const ids = new Set(); const deck = [];
      await Promise.all(((host.cardDays && host.cardDays()) || []).slice(0, 30).map(async (d) => {
        try { const x = await host.loadCards(d); for (const c of (x && x.cards) || []) if (!ids.has(c.id)) { ids.add(c.id); deck.push({ ...c, day: c.day || d }); } } catch (e) { /* a day without cards */ }
      }));
      deck.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));  // newest first
      R.deck = deck; R.loaded = true; R.loading = false; plan(); render();
    }
    function plan() {  // today's queue: cards due (the most overdue first), then new ones up to the day's limit
      const st = srsStore.get(); const today = dayNo();
      const due = R.deck.filter((c) => st.cards[c.id] && st.cards[c.id].due <= today).sort((a, b) => st.cards[a.id].due - st.cards[b.id].due);
      const fresh = R.deck.filter((c) => !st.cards[c.id]).slice(0, Math.max(0, SRS_NEW - (st.day === today ? st.fresh : 0)));
      R.queue = [...due, ...fresh]; R.due = due.length; R.fresh = fresh.length; R.i = 0; R.flip = false; R.done = 0;
    }
    function grade(g) {
      const c = R.queue[R.i]; const st = srsStore.get(); const today = dayNo(); const prev = st.cards[c.id];
      if (!prev) { if (st.day !== today) { st.day = today; st.fresh = 0; } st.fresh += 1; }
      st.cards[c.id] = srsNext(prev, g, today); srsStore.set(st); R.done += 1;
      if (g === 1) R.queue.splice(Math.min(R.i + 4, R.queue.length), 0, c);  // again: back in a few cards
      R.i += 1; R.flip = false; render();
    }
    function reviseHtml() {
      if (!R.loaded) { if (!R.loading) setTimeout(loadDeck); return `<section class="px">${tabsHtml()}<p class="px-fine">Loading your flashcards…</p></section>`; }
      const st = srsStore.get();
      if (R.on && R.i < R.queue.length) {
        const c = R.queue[R.i]; const prev = st.cards[c.id];
        return `<section class="px"><div class="px-top"><span>Card ${R.i + 1} of ${R.queue.length}</span><div class="px-bar"><i style="width:${Math.round((R.i * 100) / R.queue.length)}%"></i></div><button class="px-link" data-px="rv-end">End</button></div>
          <article class="px-q px-card"><div class="px-tags"><span class="px-type">${prev ? "Review" : "New"}</span><span>${esc(L(c.subject))}</span><span>${esc(host.label(c.day))}</span></div>
            <p class="px-cq">${esc(c.q)}</p>
            ${R.flip ? `<p class="px-ca">${esc(c.a)}</p><p class="px-src">${c.url ? `<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">Source: ${esc(c.src || domainOf(c.url))} ↗</a> · ` : ""}${esc(c.title)}</p>`
              : `<button class="px-go" data-px="rv-flip">Show answer</button>`}</article>
          ${R.flip ? `<div class="px-grades">${["Again", "Hard", "Good", "Easy"].map((name, i) => `<button class="px-grade g${i + 1}" data-px="rv-grade" data-g="${i + 1}"><b>${name}</b><small>${srsWalk(prev, i + 1)}</small></button>`).join("")}</div>
            <p class="px-fine">How well did you remember it? The card comes back just before you'd forget it.</p>` : ""}</section>`;
      }
      const s = srsStats();
      const doneToday = R.on && R.i >= R.queue.length;
      if (doneToday) R.on = false;
      return `<section class="px">${tabsHtml()}
        <header class="px-head"><div class="px-eyebrow">Revise · spaced repetition</div>
          <h2>${doneToday ? `Done for now 🎉 ${R.done} card${R.done === 1 ? "" : "s"} revised` : R.queue.length ? `${R.queue.length} card${R.queue.length === 1 ? "" : "s"} for today` : R.deck.length ? "Nothing due today" : "No flashcards yet"}</h2>
          <p>${R.deck.length ? `${R.due} due for review · ${R.fresh} new (up to ${SRS_NEW} a day) · ${s.learned} learned of ${R.deck.length} in your deck` : "Flashcards come with the AI notes of each Must-know and Prelims-facts story. They appear as the day's notes are written."}</p></header>
        ${R.queue.length && !doneToday ? `<button class="px-go" data-px="rv-start">Start revision</button>` : doneToday ? `<button class="px-go" data-px="rv-more">Check for more</button>` : ""}
        <p class="px-fine">Each card returns after 1 day, then 3, 7, 16… days: the longer you remember it, the longer the gap. A card you forget comes back soon. Your schedule stays on this device.</p>
        ${toast()}</section>`;
    }
    const srsWalk = (prev, g) => srsWhen(prev, g);

    // ── Mains ──
    async function loadMains(day) {
      M.day = day; M.stories = null; M.loading = true; M.err = ""; render();
      try {
        const x = await host.loadDay(day); const v = ((x && x.days) || {})[day] || {};
        const by = new Map(((x && x.stories) || []).map((s) => [s.id, s]));
        M.stories = [...(v.news || []), ...(v.prelims || []), ...(v.editorials || []), ...(v.explained || [])].map((id) => by.get(id))
          .filter((s) => s && s.explain && !s.explain.auto && s.explain.mains);
      } catch (e) { M.stories = []; M.err = "Couldn't load this day's brief."; }
      M.loading = false; render();
    }
    function pickMains(id) {
      const s = (M.stories || []).find((x) => x.id === id); if (!s) return;
      M.pick = s; M.q = s.explain.mains; M.text = drafts.get(s.id); M.images = []; M.result = null; M.err = "";
      M.marks = /\b10\s*marks?\b|150 words/i.test(M.q) ? 10 : 15; render();
    }
    async function evaluate() {
      const s = M.pick;
      if (!M.text.trim() && !M.images.length) { M.err = "Write your answer, or add a photo of it, first."; render(); return; }
      M.busy = true; M.err = ""; render();
      const e = s.explain || {};
      const ctx = [`Headline: ${s.title}`, e.why_in_news && `Why in news: ${e.why_in_news}`, e.what && `What happened: ${e.what}`, e.background && `Background: ${e.background}`,
        (e.significance || []).length && `Why it matters: ${e.significance.join("; ")}`, s.sum && s.sum.text && `ARTICLE (${s.sum.domain}):\n${s.sum.text}`].filter(Boolean).join("\n");
      const limit = M.marks === 10 ? 150 : 250;
      const parts = [{ text: `STORY CONTEXT\n${ctx}\n\nQUESTION (${M.marks} marks, ${limit} words): ${M.q}\n\nCANDIDATE'S ANSWER${M.images.length ? " (typed part, if any; the handwritten pages are the attached images)" : ""}:\n${M.text.trim() || "(see the attached pages)"}` },
        ...M.images.map((im) => ({ inlineData: { mimeType: "image/jpeg", data: im.data } }))];
      try {
        const { data, model } = await gemini.json({ system: MAINS_SYSTEM.replace(/\{marks\}/g, M.marks), parts, schema: MAINS_SCHEMA });
        const score = Math.max(0, Math.min(M.marks, Math.round((Number(data.score) || 0) * 2) / 2));
        M.result = { ...data, score, max: M.marks, model, words: wordCount(M.text) || wordCount(data.transcript) };
        mainsStore.add({ day: M.day, story_id: s.id, title: s.title, q: M.q, marks: M.marks, score, words: M.result.words, at: Date.now() });
      } catch (err) { M.err = err.message; }
      M.busy = false; render();
    }
    function keyFormHtml() {
      return `<div class="mn-key"><p><b>✦ Switch on Intel AI to get answers evaluated.</b> Paste your free Google AI key (the same one as in Ask Intel); it stays on this device.</p>
        <div class="gem-form"><input type="password" data-mn-key placeholder="Paste your free Google AI key" autocomplete="off" spellcheck="false" aria-label="Google AI key"><button data-px="mn-key">Save</button></div>
        <p class="px-fine">Get one free at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Your answer and the story go to Google's Gemini to be evaluated.</p></div>`;
    }
    function mainsHtml() {
      if (M.stories == null && !M.loading) { setTimeout(() => loadMains(M.day)); }
      if (M.pick && M.result) return mainsResultHtml();
      if (M.pick) return mainsWriteHtml();
      const hist = mainsStore.get().slice(-5).reverse();
      const avg = hist.length ? Math.round(hist.reduce((x, h) => x + (h.score * 100) / h.marks, 0) / hist.length) : null;
      return `<section class="px">${tabsHtml()}
        <header class="px-head"><div class="px-eyebrow">Mains · answer writing · ${esc(host.label(M.day))}</div>
          <h2>${M.loading ? "Loading the day's questions…" : (M.stories || []).length ? `${M.stories.length} Mains question${M.stories.length === 1 ? "" : "s"} from this day's brief` : "No Mains questions for this day yet"}</h2>
          <p>Write an answer (or photograph your handwritten one) and Intel AI marks it like a UPSC examiner: a score, what works, what's missing, a better intro and conclusion, and a model outline.</p></header>
        <div class="px-row"><span class="px-lab">Day</span>${daySelect(M.day, "data-mn-day")}</div>
        ${(M.stories || []).map((s) => `<button class="mn-item" data-px="mn-pick" data-id="${esc(s.id)}"><span class="px-tags">${(s.gs || []).filter((g) => g !== "Prelims").map((g) => `<span>${esc(g)}</span>`).join("")}<span>${esc(L((s.subjects || [])[0]))}</span>${drafts.get(s.id) ? "<span class=\"px-type\">Draft</span>" : ""}</span>
          <b>${esc(s.explain.mains)}</b><small>${esc(s.title)}</small></button>`).join("")}
        ${M.err ? `<p class="px-toast">${esc(M.err)}</p>` : ""}
        ${hist.length ? `<div class="px-hist"><h3>Your last answers${avg != null ? ` · average ${avg}%` : ""}</h3><ul>${hist.map((h) => `<li><b>${h.score} / ${h.marks}</b> · ${esc(h.title)} <span class="px-fine">${h.words} words</span></li>`).join("")}</ul></div>` : ""}
        ${toast()}</section>`;
    }
    function mainsWriteHtml() {
      const s = M.pick; const limit = M.marks === 10 ? 150 : 250; const wc = wordCount(M.text);
      return `<section class="px"><div class="px-top"><button class="px-link" data-px="mn-back">← Questions</button><span class="px-sp"></span><span class="px-fine">${esc(host.label(M.day))}</span></div>
        <article class="px-q"><div class="px-tags"><span class="px-type">Mains</span>${(s.gs || []).filter((g) => g !== "Prelims").map((g) => `<span>${esc(g)}</span>`).join("")}</div>
          <p class="px-stem">${esc(M.q)}</p><p class="px-fine">From: ${esc(s.title)}</p>
          <div class="px-row">${[10, 15].map((k) => `<button class="px-chip${M.marks === k ? " on" : ""}" data-px="mn-marks" data-n="${k}">${k} marks · ${k === 10 ? 150 : 250} words</button>`).join("")}</div>
          <textarea class="mn-text" data-mn-text rows="12" placeholder="Write your answer here: introduction, body (points or sub-headings), conclusion with a way forward…"${M.busy ? " disabled" : ""}>${esc(M.text)}</textarea>
          <div class="mn-bar"><span class="mn-wc${wc > limit * 1.1 ? " over" : ""}">${wc} / ${limit} words</span><span class="px-sp"></span>
            <label class="px-btn mn-photo">📷 Add photo of handwritten answer<input type="file" accept="image/*" multiple data-mn-photo hidden${M.busy ? " disabled" : ""}></label></div>
          ${M.images.length ? `<div class="mn-thumbs">${M.images.map((im, i) => `<figure><img src="${im.url}" alt="Page ${i + 1}"><button data-px="mn-unphoto" data-i="${i}" aria-label="Remove page ${i + 1}">✕</button></figure>`).join("")}</div>` : ""}
        </article>
        ${gemini.on() ? `<button class="px-go" data-px="mn-eval"${M.busy ? " disabled" : ""}>${M.busy ? "✦ Intel is evaluating your answer…" : "✦ Evaluate my answer"}</button>` : keyFormHtml()}
        ${M.err ? `<p class="px-toast">${esc(M.err)}</p>` : ""}
        <p class="px-fine">Your draft is kept on this device. Photos: up to 4 pages, written clearly.</p></section>`;
    }
    function mainsResultHtml() {
      const r = M.result; const pct = Math.round((r.score * 100) / r.max);
      const list = (title, items, cls = "") => (items && items.length ? `<div class="mn-block ${cls}"><h3>${title}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "");
      return `<section class="px"><div class="px-top"><button class="px-link" data-px="mn-back">← Questions</button><span class="px-sp"></span><span class="px-fine" title="${esc(r.model)}">✦ Intel AI</span></div>
        <header class="px-res"><div class="px-eyebrow">Evaluation · ${M.marks} marks · ${r.words} words</div>
          <div class="px-score">${r.score} <small>/ ${r.max}</small></div><p><b>${pct}%</b> · ${esc(r.verdict)}</p></header>
        <div class="px-sbars">${RUBRIC.map(([k, name]) => { const v = Math.max(0, Math.min(10, Number((r.rubric || {})[k]) || 0)); return `<div class="px-sbar"><span>${name}</span><div><i style="width:${v * 10}%"></i></div><b>${v}/10</b></div>`; }).join("")}</div>
        ${list("What works", r.strengths, "ok")}${list("Improve", r.improve)}${list("Missed dimensions or points", r.missed, "bad")}
        ${r.keywords && r.keywords.length ? `<div class="mn-block"><h3>Keywords to use</h3><p class="mn-kw">${r.keywords.map((k) => `<span>${esc(k)}</span>`).join("")}</p></div>` : ""}
        ${list("Examples, data and reports to cite", r.examples)}
        ${r.better_intro ? `<div class="mn-block"><h3>A stronger introduction</h3><p>${esc(r.better_intro)}</p></div>` : ""}
        ${r.better_conclusion ? `<div class="mn-block"><h3>A stronger conclusion</h3><p>${esc(r.better_conclusion)}</p></div>` : ""}
        ${r.outline && r.outline.length ? `<div class="mn-block"><h3>Model answer outline</h3><ol>${r.outline.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>` : ""}
        <details class="mn-block"><summary>Your answer${r.transcript ? " (as Intel read it)" : ""}</summary><p class="mn-mine">${esc(r.transcript || M.text)}</p></details>
        <div class="px-nav"><button class="px-btn primary" data-px="mn-rewrite">Rewrite it</button><button class="px-btn" data-px="mn-back">Another question</button></div>
        <p class="px-fine">Marked by Intel AI as a UPSC examiner would; check the facts it adds against a source.</p></section>`;
    }

    // ── Weekly mock, Mistakes ──
    function mockHtml() {
      const mocks = pxStore.get().attempts.filter((a) => a.src === "mock").slice(-4).reverse();
      return `<section class="px">${tabsHtml()}
        <header class="px-head"><div class="px-eyebrow">Weekly mock</div><h2>${MOCK_N} questions from the last seven days</h2>
          <p>${MOCK_MIN} minutes, exam mode (answers at the end), UPSC marking: +2 right, −0.66 wrong. Questions you haven't seen come first.</p></header>
        <button class="px-go" data-px="mock"${P.loading ? " disabled" : ""}>${P.loading ? "Gathering the week's questions…" : `Start the ${MOCK_MIN}-minute mock`}</button>
        ${mocks.length ? `<div class="px-hist"><h3>Your mocks</h3><ul>${mocks.map((a) => `<li><b>${a.score} / ${a.max}</b> · ${a.right} right, ${a.wrong} wrong · ${esc(a.label || "")}</li>`).join("")}</ul></div>` : ""}
        ${toast()}</section>`;
    }
    function mistakesHtml() {
      const wrong = Object.values(pxStore.get().wrong).sort((a, b) => (b.at || 0) - (a.at || 0));
      const by = {}; for (const q of wrong) by[q.subject || "other"] = (by[q.subject || "other"] || 0) + 1;
      return `<section class="px">${tabsHtml()}
        <header class="px-head"><div class="px-eyebrow">Mistake notebook</div><h2>${wrong.length ? `${wrong.length} question${wrong.length === 1 ? "" : "s"} to get right` : "No mistakes to revisit 🎉"}</h2>
          <p>Every question you answer wrong lands here, and leaves once you answer it right.${wrong.length ? ` By subject: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(L(k))} ${n}`).join(" · ")}.` : ""}</p></header>
        ${wrong.length ? `<button class="px-go" data-px="mistakes">Re-test ${Math.min(20, wrong.length)} of them</button>
          <ul class="mn-list">${wrong.slice(0, 8).map((q) => `<li>${esc(q.title || q.q)} <span class="px-fine">· ${esc(PX_TYPE[q.type] || q.type)} · missed ${q.misses || 1}×</span></li>`).join("")}</ul>` : ""}
        ${toast()}</section>`;
    }

    function render() {
      el.innerHTML = P.view === "quiz" && P.s ? quizHtml() : P.view === "result" && P.s ? resultHtml()
        : P.tab === "revise" ? reviseHtml() : P.tab === "mains" ? mainsHtml() : P.tab === "mock" ? mockHtml() : P.tab === "mistakes" ? mistakesHtml() : setupHtml();
      const on = el.querySelector(".px-tab.on");  // on a phone the mode row scrolls: keep the open one in view
      if (on && on.parentElement) on.parentElement.scrollLeft = Math.max(0, on.offsetLeft - 24);
    }
    el.onchange = async (ev) => {
      const t = ev.target;
      if (t.matches("[data-px-day]")) load(t.value);
      else if (t.matches("[data-mn-day]")) loadMains(t.value);
      else if (t.matches("[data-mn-photo]")) {
        const files = [...(t.files || [])].slice(0, Math.max(0, 4 - M.images.length));
        try { for (const f of files) M.images.push(await shrinkImage(f)); } catch (err) { M.err = err.message; }
        render();
      }
    };
    el.oninput = (ev) => {
      if (!ev.target.matches("[data-mn-text]")) return;
      M.text = ev.target.value; drafts.set(M.pick.id, M.text);
      const wc = el.querySelector(".mn-wc"); const limit = M.marks === 10 ? 150 : 250; const n = wordCount(M.text);
      if (wc) { wc.textContent = `${n} / ${limit} words`; wc.classList.toggle("over", n > limit * 1.1); }
    };
    el.onclick = async (ev) => {
      const t = ev.target.closest("[data-px]"); if (!t || !el.contains(t)) return;
      const a = t.dataset.px; const S = P.s;
      if (a === "tab") { P.tab = t.dataset.t; P.view = "setup"; render(); }
      else if (a === "size") { P.size = Number(t.dataset.n); render(); }
      else if (a === "mode") { P.mode = t.dataset.m; render(); }
      else if (a === "start" || a === "again") { const st = pxStore.get(); const qs = pxPick(P.pool || [], P.size, st.seen); if (qs.length) start(qs); }
      else if (a === "retry") { const qs = S.qs.filter((q) => S.ans[q.id] != null && S.ans[q.id] !== q.answer); if (qs.length) start(qs, { mode: "practice", src: "mistakes", label: "Retry" }); }
      else if (a === "setup") { clearInterval(P.timer); P.view = "setup"; render(); }
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
      else if (a === "mock") await startMock();
      else if (a === "mistakes") {
        const qs = Object.values(pxStore.get().wrong).sort((x, y) => (x.at || 0) - (y.at || 0)).slice(0, 20);
        if (qs.length) start(qs, { mode: "practice", src: "mistakes", label: "Mistake notebook" });
      }
      else if (a === "rv-start") { R.on = true; R.i = 0; render(); }
      else if (a === "rv-flip") { R.flip = true; render(); }
      else if (a === "rv-grade") grade(Number(t.dataset.g));
      else if (a === "rv-end") { R.on = false; plan(); render(); }
      else if (a === "rv-more") { plan(); R.on = !!R.queue.length; render(); }
      else if (a === "mn-pick") pickMains(t.dataset.id);
      else if (a === "mn-back") { M.pick = null; M.result = null; M.err = ""; render(); }
      else if (a === "mn-marks") { M.marks = Number(t.dataset.n); render(); }
      else if (a === "mn-unphoto") { M.images.splice(Number(t.dataset.i), 1); render(); }
      else if (a === "mn-eval") await evaluate();
      else if (a === "mn-rewrite") { M.result = null; render(); }
      else if (a === "mn-key") {
        const input = el.querySelector("[data-mn-key]");
        try { await gemini.connect(input ? input.value : ""); M.err = ""; } catch (err) { M.err = err.message; }
        render();
      } else if (a === "claude") {
        const facts = (P.pool || []).filter((q) => q.why).slice(0, 25).map((q, i) => `${i + 1}. ${q.title}: ${q.why.replace(/^The report says: /, "")}`.slice(0, 400));
        host.claude(`Make 10 new UPSC Prelims-style MCQs (statement-based "consider the following statements", "how many pairs are correctly matched", and direct questions), each with four options, the answer and a one-line explanation, from these news facts of ${host.label(P.day)}:\n${facts.join("\n")}`);
      }
    };
    load(P.day);
    return { setDay: (d) => { if (d && d !== P.day && P.view === "setup" && P.tab === "mcq") load(d); }, render, tab: (k) => { P.tab = k; P.view = "setup"; render(); } };
  }

  // ─────────────────────────── India's Ranks: India in global indices ───────────────────────────
  // The tracker (data/rankings.json, pipeline/rankings.py): each index's name, publisher and what it measures, and
  // India's latest rank as an article reported it, with the change from the previous edition, the reasons and the
  // source. host.load() → the payload. The areas filter the list; the latest reports lead.
  const RK_AREAS = [["all", "All"], ["economy", "Economy"], ["society", "Society & welfare"], ["governance", "Governance"],
    ["environment", "Environment & climate"], ["security", "Security & defence"], ["science", "Science, tech & soft power"], ["other", "Other"]];
  const ordinal = (n) => { const v = n % 100; return `${n}${v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`; };
  function rankMove(x) {  // → {cls, text}: the change from the previous edition, read by which way is better
    const L = x.latest; if (!L || !L.previous || L.previous === L.rank) return L && L.previous ? { cls: "same", text: `No change from ${ordinal(L.previous)}` } : null;
    const d = Math.abs(L.previous - L.rank); const up = L.rank < L.previous;
    const places = `${d} place${d === 1 ? "" : "s"}`;
    const good = x.better === "none" ? null : x.better === "high" ? !up : up;
    const tail = x.better === "high" ? (up ? " (worse)" : " (better)") : "";
    return { cls: good == null ? "flat" : good ? "good" : "bad", text: `${up ? "▲ Up" : "▼ Down"} ${places} from ${ordinal(L.previous)}${tail}` };
  }
  const dayLabel = (d) => { try { return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); } catch (e) { return d; } };
  function rankCard(x) {
    const L = x.latest; const mv = rankMove(x);
    if (!L) {
      return `<article class="rk empty"><div class="rk-h"><div><b>${esc(x.name)}</b><small>${esc(x.publisher)}</small></div><div class="rk-rank"><span class="rk-n">—</span></div></div>
        ${x.about ? `<p class="rk-about">${esc(x.about)}</p>` : ""}<p class="rk-src">${x.checked ? `Not in the news since the build started watching (looked on ${esc(dayLabel(x.checked))}); it appears here when the next edition is reported.` : "Being looked up in the news: it appears here within a few hours."}</p></article>`;
    }
    const hist = (x.history || []).slice(1, 5);
    return `<article class="rk" data-rk="${esc(x.key)}"><div class="rk-h"><div><b>${esc(x.name)}</b><small>${esc(x.publisher)} · ${esc(L.edition)} edition</small></div>
        <div class="rk-rank"><span class="rk-n">${L.rank}<sup>${esc(ordinal(L.rank).replace(/^\d+/, ""))}</sup></span>${L.total ? `<small>of ${L.total}</small>` : ""}</div></div>
      ${mv ? `<div class="rk-move ${mv.cls}">${esc(mv.text)}</div>` : ""}
      ${L.score ? `<p class="rk-score">Score: ${esc(L.score)}</p>` : ""}
      ${x.about ? `<p class="rk-about"><b>What it measures:</b> ${esc(x.about)}</p>` : ""}
      ${L.why && L.why.length ? `<div class="rk-why"><b>Why India is here</b><ul>${L.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
      <p class="rk-src">${L.url ? `<a href="${esc(safeUrl(L.url))}" target="_blank" rel="noopener">${esc(L.source || domainOf(L.url) || "Source")}</a>` : esc(L.source || "")}${L.day ? ` · ${esc(dayLabel(L.day))}` : ""}${hist.length ? ` · earlier: ${hist.map((h) => `${esc(h.edition)} ${ordinal(h.rank)}`).join(", ")}` : ""}</p></article>`;
  }
  function ranksHtml(data, area = "all") {
    const all = (data && data.indices) || [];
    const have = all.filter((x) => x.latest);
    const areas = RK_AREAS.filter(([k]) => k === "all" || all.some((x) => x.area === k));
    const list = all.filter((x) => area === "all" || x.area === area)
      .sort((a, b) => (!!b.latest - !!a.latest) || ((b.latest || {}).day || "").localeCompare((a.latest || {}).day || "") || a.name.localeCompare(b.name));
    const recent = have.slice().sort((a, b) => (b.latest.day || "").localeCompare(a.latest.day || "")).slice(0, 5);
    return `<section class="rks"><header class="rk-top"><div class="rk-eyebrow">India's ranks</div>
        <h2>India in ${all.length} global indices${have.length < all.length ? ` · ${have.length} with a rank so far` : ""}</h2>
        <p>Each rank is taken from a news report of the index, with its source. It changes when a new edition is in the news; indices not seen for a month are looked up again.${data && data.updated ? ` Last change ${esc(dayLabel(data.updated.slice(0, 10)))}.` : ""}</p></header>
      ${recent.length && area === "all" ? `<div class="rk-latest"><b>Latest reports</b>${recent.map((x) => `<button type="button" data-rk-go="${esc(x.key)}">${esc(x.name)} · <strong>${ordinal(x.latest.rank)}</strong></button>`).join("")}</div>` : ""}
      <div class="rk-areas" role="tablist">${areas.map(([k, l]) => `<button type="button" role="tab" data-rk-area="${k}" aria-selected="${k === area}">${esc(l)}</button>`).join("")}</div>
      <div class="rk-list">${list.map(rankCard).join("") || '<p class="rk-src">Nothing in this area yet.</p>'}</div></section>`;
  }
  function mountRanks(el, host) {
    const R = { data: null, area: "all", err: "" };
    const paint = () => { el.innerHTML = R.data ? ranksHtml(R.data, R.area) : `<p class="rk-src" style="padding:16px">${esc(R.err || "Loading India's ranks…")}</p>`; };
    el.onclick = (e) => {
      const a = e.target.closest && e.target.closest("[data-rk-area]");
      if (a) { R.area = a.dataset.rkArea; paint(); return; }
      const g = e.target.closest && e.target.closest("[data-rk-go]");
      if (g) { const c = el.querySelector(`[data-rk="${g.dataset.rkGo}"]`); if (c && c.scrollIntoView) { c.scrollIntoView({ behavior: "smooth", block: "center" }); c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 1600); } }
    };
    paint();
    Promise.resolve(host.load()).then((d) => { R.data = d; paint(); }).catch(() => { R.err = "Couldn't load India's ranks. Check the connection and open this again."; paint(); });
    return { reload: () => Promise.resolve(host.load()).then((d) => { R.data = d; paint(); }) };
  }

  // ─────────────────────────── Dossiers: running stories with their timeline ───────────────────────────
  // data/dossiers.json (pipeline/dossiers.py): each running story's timeline from the news (the latest first) and a
  // story so far, UPSC angle and what to watch, written by the AI when the timeline changes. Following a dossier keeps
  // it at the top and marks it "new" when a report lands after you last opened it (on this device).
  // host: load() → the payload; open(id, day) → the story in that day's brief.
  const FOLLOW_KEY = "upsc-follow";
  const follows = {
    get() { try { const v = JSON.parse(localStorage.getItem(FOLLOW_KEY) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } },
    put(v) { try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    toggle(key, last) { const v = follows.get(); if (key in v) delete v[key]; else v[key] = last || ""; follows.put(v); return key in v; },
    seen(key, last) { const v = follows.get(); if (key in v && v[key] !== last) { v[key] = last; follows.put(v); } },
  };
  const dsNew = (d, f) => d.key in f && (d.last_day || "") > (f[d.key] || "");
  const dsSpan = (d) => `${d.n} report${d.n === 1 ? "" : "s"} on ${d.days} day${d.days === 1 ? "" : "s"} · ${dayLabel(d.first_day)} to ${dayLabel(d.last_day)}`;
  function dossiersHtml(data, opts = {}) {
    const f = opts.follow || {}; const q = (opts.q || "").trim().toLowerCase();
    const all = (data && data.dossiers) || [];
    const list = all.filter((d) => (opts.only !== "follow" || d.key in f) && (!q || d.name.toLowerCase().includes(q) || d.timeline.some((x) => x.title.toLowerCase().includes(q))))
      .sort((a, b) => ((b.key in f) - (a.key in f)) || (b.last_day || "").localeCompare(a.last_day || "") || b.n - a.n);
    const nf = all.filter((d) => d.key in f).length;
    const card = (d) => {
      const lead = (d.summary && d.summary.so_far && d.summary.so_far[d.summary.so_far.length - 1]) || (d.timeline[0] && d.timeline[0].title) || "";
      return `<article class="ds-card${d.key in f ? " followed" : ""}" data-ds="${esc(d.key)}">
        <button type="button" class="ds-go" data-ds-go="${esc(d.key)}"><span class="ds-name">${esc(d.name)}${dsNew(d, f) ? ' <span class="ds-new">New</span>' : ""}</span>
          <small>${esc(dsSpan(d))}${d.summary && d.summary.gs && d.summary.gs.length ? ` · ${esc(d.summary.gs.join(", "))}` : ""}</small>
          ${lead ? `<span class="ds-lead">${esc(lead)}</span>` : ""}</button>
        <button type="button" class="ds-follow" data-ds-follow="${esc(d.key)}" aria-pressed="${d.key in f}">${d.key in f ? "★ Following" : "☆ Follow"}</button></article>`;
    };
    return `<section class="ds"><header class="ds-top"><div class="ds-eyebrow">Dossiers</div>
        <h2>${all.length ? `${all.length} running stor${all.length === 1 ? "y" : "ies"}` : "Running stories"}</h2>
        <p>Each dossier follows one ongoing issue across days: its reports in order, and the story so far with the UPSC angle, written by the AI when a new report lands. Follow the ones you're tracking.</p></header>
      ${all.length ? `<div class="ds-tools"><input type="search" class="ds-q" data-ds-q placeholder="Find a dossier or a headline" value="${esc(opts.q || "")}" aria-label="Find a dossier">
        <div class="ds-seg" role="tablist"><button type="button" role="tab" data-ds-only="all" aria-selected="${opts.only !== "follow"}">All</button><button type="button" role="tab" data-ds-only="follow" aria-selected="${opts.only === "follow"}">Following${nf ? ` · ${nf}` : ""}</button></div></div>` : ""}
      <div class="ds-list">${list.map(card).join("") || `<p class="ds-note">${all.length ? (opts.only === "follow" && !nf ? "Follow a dossier to keep it here." : "No dossier matches.") : "Dossiers appear once a running story has been in the news on two days: the build names each card's running story as it reads the brief."}</p>`}</div></section>`;
  }
  function dossierHtml(d, opts = {}) {
    const f = opts.follow || {}; const s = d.summary;
    const list = (xs) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join("");
    return `<section class="ds ds-one" data-ds="${esc(d.key)}"><button type="button" class="ds-back" data-ds-back>‹ All dossiers</button>
      <header class="ds-top"><div class="ds-eyebrow">Dossier${s && s.gs && s.gs.length ? ` · ${esc(s.gs.join(", "))}` : ""}</div><h2>${esc(d.name)}</h2>
        <p>${esc(dsSpan(d))}</p><button type="button" class="ds-follow" data-ds-follow="${esc(d.key)}" aria-pressed="${d.key in f}">${d.key in f ? "★ Following" : "☆ Follow"}</button></header>
      ${s ? `<div class="ds-sum"><h3>The story so far</h3><ol>${list(s.so_far)}</ol>
        ${s.upsc && s.upsc.length ? `<h3>UPSC angle</h3><ul>${list(s.upsc)}</ul>` : ""}
        ${s.watch && s.watch.length ? `<h3>What to watch</h3><ul>${list(s.watch)}</ul>` : ""}
        <p class="ds-by">✦ Written by ${esc(s.by || "the AI")} from the reports below${s.day ? `, ${esc(dayLabel(s.day))}` : ""}.${d.fresh ? "" : " Newer reports have landed since; it's rewritten on a coming run."} Check the facts against the reports.</p></div>`
        : '<p class="ds-note">The story so far is written by the AI on a coming run (when it has quota). The timeline below is complete.</p>'}
      <h3 class="ds-h">Timeline · latest first</h3>
      <ol class="ds-tl">${d.timeline.map((x) => `<li><time datetime="${esc(x.day)}">${esc(dayLabel(x.day))}</time><div>
        <a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.grade ? ` <span class="pill g-${esc(x.grade)}">${esc(x.grade === "NOTE" ? "Must-know" : x.grade === "SKIM" ? "Quick read" : x.grade === "READ" ? "Background" : "Low")}</span>` : ""}
        ${x.line && x.line !== x.title ? `<p>${esc(x.line)}</p>` : ""}<small>${esc(x.source || domainOf(x.url) || "")}${x.card && opts.canOpen ? ` · <button type="button" class="linkbtn" data-ds-read="${esc(x.id)}" data-at="${esc(x.day)}">Open in the brief ›</button>` : ""}</small></div></li>`).join("")}</ol></section>`;
  }
  function dossierChips(topics) {  // a card's running stories (s.topics [{k, n}]): a link to each dossier
    if (!topics || !topics.length) return "";
    return `<p class="ds-chips"><span>📂 Running story:</span>${topics.map((t) => `<button type="button" class="ds-chip" data-ds-open="${esc(t.k)}">${esc(t.n)} ›</button>`).join("")}</p>`;
  }
  function mountDossiers(el, host) {
    const D = { data: null, key: host.key || null, q: "", only: "all", err: "" };
    const find = (k) => ((D.data && D.data.dossiers) || []).find((d) => d.key === k);
    const paint = () => {
      if (!D.data) { el.innerHTML = `<p class="ds-note" style="padding:16px">${esc(D.err || "Loading the dossiers…")}</p>`; return; }
      const f = follows.get(); const d = D.key && find(D.key);
      if (D.key && !d) {
        el.innerHTML = `<section class="ds"><button type="button" class="ds-back" data-ds-back>‹ All dossiers</button><p class="ds-note">This running story isn't a dossier yet: it becomes one once it has been in the news on two days.</p></section>`;
        return;
      }
      if (d) { follows.seen(d.key, d.last_day); el.innerHTML = dossierHtml(d, { follow: follows.get(), canOpen: !!host.open }); return; }
      el.innerHTML = dossiersHtml(D.data, { follow: f, q: D.q, only: D.only });
    };
    const show = (k) => { D.key = k || null; if (host.onShow) host.onShow(D.key); paint(); if (el.scrollIntoView && k) el.scrollIntoView({ block: "start" }); };
    el.onclick = (e) => {
      const t = e.target.closest && e.target.closest("button"); if (!t) return;
      if (t.dataset.dsGo) return show(t.dataset.dsGo);
      if (t.hasAttribute("data-ds-back")) return show(null);
      if (t.dataset.dsOnly) { D.only = t.dataset.dsOnly; return paint(); }
      if (t.dataset.dsFollow) { const d = find(t.dataset.dsFollow); follows.toggle(t.dataset.dsFollow, d && d.last_day); return paint(); }
      if (t.dataset.dsRead && host.open) host.open(t.dataset.dsRead, t.dataset.at);
    };
    el.oninput = (e) => {
      if (!e.target.matches || !e.target.matches("[data-ds-q]")) return;
      D.q = e.target.value; const at = e.target.selectionStart;
      paint(); const box = el.querySelector("[data-ds-q]"); if (box) { box.focus(); try { box.setSelectionRange(at, at); } catch (er) { /* type=search */ } }
    };
    paint();
    Promise.resolve(host.load()).then((x) => { D.data = x; paint(); }).catch(() => { D.err = "Couldn't load the dossiers. Check the connection and open this again."; paint(); });
    return { show, get key() { return D.key; } };
  }

  // ─────────────────────────── Places in the news: the map ───────────────────────────
  // data/places.json (pipeline/dossiers.py): the last month's brief cards by place, with coordinates. The map (Leaflet,
  // loaded from the site's own static files when first opened; OpenStreetMap tiles) shows a dot per place, sized by
  // its reports, India and the world in two colours; the lists below group India by state and the world by country.
  // host: load() → the payload; open(id, day) → the story in that day's brief; base: the path of static/.
  const isIndia = (p) => /^(india|bharat)$/i.test((p && p.country) || "");
  const shiftDay = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  function placesIn(data, range = 7) {  // → {places (their reports in the range), india: [[state, places]], world: [[country, places]], stories}
    const st = (data && data.stories) || {}; const to = (data && data.to) || "";
    const from = !to || range >= 30 ? "" : shiftDay(to, -(Math.max(1, range) - 1));
    const places = ((data && data.places) || []).map((p) => ({ ...p, ids: (p.ids || []).filter((i) => st[i] && st[i].day >= from) }))
      .filter((p) => p.ids.length && Number.isFinite(p.lat) && Number.isFinite(p.lon)).sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name));
    const group = (list, key) => {
      const m = new Map(); for (const p of list) { const k = key(p); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
      return [...m.entries()].sort((a, b) => b[1].reduce((n, p) => n + p.ids.length, 0) - a[1].reduce((n, p) => n + p.ids.length, 0) || a[0].localeCompare(b[0]));
    };
    return { places, india: group(places.filter(isIndia), (p) => p.state || (p.kind === "country" ? "All India" : "India")),
      world: group(places.filter((p) => !isIndia(p)), (p) => p.country || "Elsewhere"), stories: new Set(places.flatMap((p) => p.ids)).size };
  }
  let leafletP = null;
  function loadLeaflet(base) {
    if (root.L && root.L.map) return Promise.resolve(root.L);
    if (leafletP) return leafletP;
    leafletP = new Promise((res, rej) => {
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = `${base}leaflet.css`; document.head.appendChild(css);
      const js = document.createElement("script"); js.src = `${base}leaflet.js`; js.async = true;
      js.onload = () => (root.L && root.L.map ? res(root.L) : rej(new Error("Leaflet didn't start")));
      js.onerror = () => { leafletP = null; js.remove(); rej(new Error("Leaflet didn't load")); };
      document.head.appendChild(js);
    });
    return leafletP;
  }
  function mountMap(el, host) {
    const M = { data: null, range: 7, view: "india", err: "", map: null, layer: null, marks: {}, ready: null, L: null };
    const kindOf = (p) => [p.kind && p.kind !== "other" ? p.kind : "", isIndia(p) ? p.state : p.country].filter(Boolean).join(" · ");
    const pop = (p) => {
      const st = M.data.stories || {};
      return `<div class="mp-pop"><b>${esc(p.name)}</b><small>${esc(kindOf(p))}</small><ul>${p.ids.slice(0, 6).map((i) => {
        const s = st[i]; return `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.title)}</a><span>${esc(dayLabel(s.day))}${host.open ? ` · <button type="button" class="linkbtn" data-mp-read="${esc(i)}" data-at="${esc(s.day)}">In the brief ›</button>` : ""}</span></li>`;
      }).join("")}</ul>${p.ids.length > 6 ? `<small>+${p.ids.length - 6} more reports</small>` : ""}</div>`;
    };
    const groupHtml = (title, groups) => `<div class="mp-group"><h3>${esc(title)} · ${groups.reduce((n, g) => n + g[1].length, 0)}</h3>${groups.length ? groups.map(([k, ps]) => `<div class="mp-area"><b>${esc(k)}</b>${ps.map((p) => `<button type="button" class="mp-place" data-mp-go="${esc(p.k)}">${esc(p.name)}${p.ids.length > 1 ? ` <span>${p.ids.length}</span>` : ""}</button>`).join("")}</div>`).join("") : '<p class="mp-note">None in this period.</p>'}</div>`;
    const RANGES = [[1, "Today"], [7, "7 days"], [30, "30 days"]];
    function paint() {
      if (!M.data) { el.innerHTML = `<p class="mp-note" style="padding:16px">${esc(M.err || "Loading the places in the news…")}</p>`; return; }
      if (!el.querySelector("[data-mp-map]")) {
        el.innerHTML = '<section class="mp"><header class="mp-top" data-mp-head></header><div class="mp-map" data-mp-map role="region" aria-label="Map of the places in the news"></div><div class="mp-lists" data-mp-lists></div></section>';
        M.map = null; M.layer = null;
      }
      const g = placesIn(M.data, M.range);
      el.querySelector("[data-mp-head]").innerHTML = `<div class="mp-eyebrow">Places in the news</div>
        <h2>${g.places.length} place${g.places.length === 1 ? "" : "s"} in ${g.stories} report${g.stories === 1 ? "" : "s"}</h2>
        <p>Where the brief's stories happened: revise them for the Prelims map questions. Tap a dot, or a place below, for its reports. <span class="mp-key"><i class="in"></i>India <i class="out"></i>World</span></p>
        <div class="mp-bar"><div class="mp-seg" role="tablist" aria-label="Period">${RANGES.map(([n, l]) => `<button type="button" role="tab" data-mp-range="${n}" aria-selected="${M.range === n}">${l}</button>`).join("")}</div>
        <div class="mp-seg" role="tablist" aria-label="Map view">${[["india", "India"], ["world", "World"]].map(([k, l]) => `<button type="button" role="tab" data-mp-view="${k}" aria-selected="${M.view === k}">${l}</button>`).join("")}</div></div>`;
      el.querySelector("[data-mp-lists]").innerHTML = g.places.length ? groupHtml("India", g.india) + groupHtml("World", g.world)
        : `<p class="mp-note">${(M.data.places || []).length ? "No places in this period: try a longer one." : "Places appear as the build reads the brief's cards: today's and yesterday's first."}</p>`;
      draw();
    }
    async function draw() {
      const box = el.querySelector("[data-mp-map]"); if (!box) return;
      if (!M.map) {
        if (!M.ready) {
          M.ready = loadLeaflet(host.base || "static/").then((L) => {
            const b = el.querySelector("[data-mp-map]"); if (!b || M.map) return;
            M.L = L;
            M.map = L.map(b, { scrollWheelZoom: false, worldCopyJump: true, zoomSnap: 0.25 }).setView([22.5, 80], 4);
            L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 12,
              attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(M.map);
            M.layer = L.layerGroup().addTo(M.map);
            setTimeout(() => { if (M.map) M.map.invalidateSize(); }, 80);
          });
        }
        try { await M.ready; } catch (e) {
          M.ready = null; box.classList.add("off");
          box.innerHTML = '<p class="mp-note">The map couldn\'t load (it needs a connection). The lists below have every place.</p>';
          return;
        }
        if (!M.map) return;
      }
      const g = placesIn(M.data, M.range); const L = M.L;
      M.layer.clearLayers(); M.marks = {};
      const pts = [];
      for (const p of g.places) {
        const ind = isIndia(p); const n = p.ids.length;
        const m = L.circleMarker([p.lat, p.lon], { radius: Math.min(5 + n * 2, 15), weight: 1.5, color: ind ? "#1c5cab" : "#a84a14",
          fillColor: ind ? "#2a78d6" : "#e8793a", fillOpacity: 0.75 });
        m.bindPopup(pop(p), { maxWidth: 280 }); m.bindTooltip(p.name, { direction: "top", offset: [0, -6] });
        m.addTo(M.layer); M.marks[p.k] = m; pts.push([p.lat, p.lon]);
      }
      fit(g);
    }
    function fit(g) {  // India: the whole of India, as in the exam's maps; World: every place
      const pts = M.view === "india" ? [[7, 68.5], [35.5, 97.2]] : g.places.map((p) => [p.lat, p.lon]);
      if (pts.length) M.map.fitBounds(pts, { padding: [12, 12], maxZoom: 5 }); else M.map.setView([22.5, 80], 4);
    }
    el.onclick = (e) => {
      const t = e.target.closest && e.target.closest("button"); if (!t) return;
      if (t.dataset.mpRange) { M.range = Number(t.dataset.mpRange) || 7; paint(); return; }
      if (t.dataset.mpView) {
        M.view = t.dataset.mpView === "world" ? "world" : "india";
        el.querySelectorAll("[data-mp-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mpView === M.view)));
        if (M.map) fit(placesIn(M.data, M.range));
        return;
      }
      if (t.dataset.mpGo) {
        const m = M.marks[t.dataset.mpGo]; const box = el.querySelector("[data-mp-map]");
        if (m && M.map) { M.map.setView(m.getLatLng(), Math.max(M.map.getZoom(), 6)); m.openPopup(); if (box && box.scrollIntoView) box.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
        return;
      }
      if (t.dataset.mpRead && host.open) host.open(t.dataset.mpRead, t.dataset.at);
    };
    paint();
    Promise.resolve(host.load()).then((x) => { M.data = x; paint(); }).catch(() => { M.err = "Couldn't load the places. Check the connection and open this again."; paint(); });
    return { refit: () => { if (M.map) M.map.invalidateSize(); } };
  }

  // ─────────────────────────── Glossary: tap a term for its meaning ───────────────────────────
  // The day's glossary (written by the build: days[d].glossary {key: {t: term, m: meaning}}) marks the first mention of
  // each term in a story's text; a tap opens a small card with its meaning (a sheet on a phone). An acronym or a
  // numbered Article is matched in its own capitals only ("SIR", not "sir").
  const gloss = (() => {
    let dict = {}; let rx = null; let pop = null; let openEl = null;
    const keyOf = (t) => String(t || "").trim().replace(/\s+/g, " ").toLowerCase();
    const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = (t) => /[A-Z][^a-z]*[A-Z]|\d/.test(t);
    function set(d) {
      dict = {};
      for (const v of Object.values(d || {})) if (v && v.t && v.m) dict[keyOf(v.t)] = v;
      const ts = Object.values(dict).map((v) => v.t).sort((a, b) => b.length - a.length);
      rx = ts.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${ts.map(reEsc).join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu") : null;
    }
    function html(text, seen = new Set()) {  // escaped text, each term's first mention (per `seen`) a button
      const s = String(text == null ? "" : text);
      if (!rx) return esc(s);
      let out = ""; let at = 0; let m;
      rx.lastIndex = 0;
      while ((m = rx.exec(s))) {
        const word = m[2]; const start = m.index + m[1].length; const k = keyOf(word); const v = dict[k];
        if (!v || seen.has(k) || (exact(v.t) && word !== v.t)) continue;
        seen.add(k);
        out += `${esc(s.slice(at, start))}<button type="button" class="gl" data-gl="${esc(k)}" aria-expanded="false" title="What is ${esc(v.t)}?">${esc(word)}</button>`;
        at = start + word.length;
      }
      return out + esc(s.slice(at));
    }
    function close() {
      if (pop) { pop.remove(); pop = null; }
      if (openEl) { openEl.setAttribute("aria-expanded", "false"); openEl = null; }
    }
    function open(el, k) {
      const v = dict[k]; if (!v || typeof document === "undefined") return;
      close();
      pop = document.createElement("div"); pop.className = "glpop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", v.t);
      pop.innerHTML = `<div class="glpop-h"><b>${esc(v.t)}</b><button type="button" class="glpop-x" data-gl-close aria-label="Close">✕</button></div><p>${esc(v.m)}</p><small>✦ Intel AI glossary</small>`;
      document.body.appendChild(pop);
      const W = root.innerWidth || 1024; const H = root.innerHeight || 768;
      if (W < 640) pop.classList.add("sheet");
      else {
        const r = el.getBoundingClientRect(); const w = pop.offsetWidth; const h = pop.offsetHeight;
        let y = r.bottom + 8; if (y + h > H - 8) y = r.top - h - 8;
        pop.style.left = `${Math.min(Math.max(8, r.left), W - w - 8)}px`; pop.style.top = `${Math.max(8, y)}px`;
      }
      el.setAttribute("aria-expanded", "true"); openEl = el;
    }
    if (typeof document !== "undefined") {
      document.addEventListener("click", (e) => {  // (capture: a term inside a clickable card opens its meaning, not the card)
        const t = e.target; const b = t && t.closest && t.closest("[data-gl]");
        if (b) { e.preventDefault(); e.stopPropagation(); if (openEl === b) close(); else open(b, b.dataset.gl); return; }
        if (pop && (!t.closest || t.closest("[data-gl-close]") || !t.closest(".glpop"))) close();
      }, true);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      document.addEventListener("scroll", () => { if (pop && !pop.classList.contains("sheet")) close(); }, true);
    }
    return { set, html, open, close, get size() { return Object.keys(dict).length; }, meaning: (t) => dict[keyOf(t)] || null };
  })();

  // ─────────────────────────── Listen: the day's brief read aloud ───────────────────────────
  // The Must-know stories (headline and summary points), then the Prelims facts, as a player: the day's articles (tap
  // one to hear it) and the open article's lines (tap one to start there; the line being read is lit).
  // Language: English, or Hindi as spoken Hinglish. Intel AI (the viewer's key) turns each article's lines into
  // Hinglish; without it the free translator gives plain Hindi. Kept on this device.
  // Voice: the device's own (speechSynthesis: free, offline; its most natural voice for the language first), or ✦ Intel
  // AI's natural voices (Gemini's text-to-speech on the viewer's key: one clip per article, the lit line following the
  // clip; the device's voice takes over when it's unavailable). The device reads a few sentences at a time (a long
  // utterance stops after ~15 s in Chrome); its pause cancels and play restarts the sentence (pausing speech is
  // unreliable on Android). The UIs give a provider of the items and a [data-listen="start"] button; the player is
  // this module's own.
  function listenItems(cards, facts = []) {  // story objects → [{id, title, kind, lines}]
    const pts = (s, n) => {
      const p = (s.sum && s.sum.points) || [];
      if (p.length) return p.slice(0, n);
      const e = s.explain || {};
      return [e.why_in_news, e.what].filter((x) => x && !WEAK.test(x)).slice(0, n);
    };
    const say = (t) => String(t || "").replace(/₹\s?|\bRs\.?\s?/g, "rupees ").replace(/\s+/g, " ").trim();
    const item = (s, kind, n) => ({ id: s.id, title: s.title, kind, lines: [s.title, ...pts(s, n)].map(say).filter(Boolean) });
    return [...cards.map((s) => item(s, "must", 8)), ...facts.map((s) => item(s, "fact", 2))];
  }
  const HINGLISH_SYSTEM = `You turn English news lines into natural spoken Hinglish for a UPSC aspirant who is listening, the way a friendly Indian teacher explains the news: Hindi sentences in Devanagari script, keeping in English (Latin script) the words Indians say in English: the names of schemes, laws, courts, institutions, organisations, countries and places, technical and economic terms; numbers as digits. Keep every fact, name and number exactly; add nothing, drop nothing. Return one output line for each input line, in the same order.`;
  const HINGLISH_SCHEMA = { type: "OBJECT", properties: { lines: { type: "ARRAY", items: { type: "STRING" } } }, required: ["lines"] };
  const AI_VOICES = [["Aoede", "female, warm"], ["Kore", "female, clear"], ["Charon", "male, calm"], ["Puck", "male, lively"]];
  const NO_HINDI = "This device has no Hindi voice. Android: Settings → Text-to-speech → Google → install Hindi; iPhone: Settings → Accessibility → Spoken Content → Voices → Hindi. Or pick a ✦ Intel AI voice.";
  const listen = (() => {
    const synth = () => root.speechSynthesis || null;
    const LSN_KEY = "upsc-listen"; const HING_KEY = "upsc-hinglish";
    const prefs = (() => { try { return JSON.parse(localStorage.getItem(LSN_KEY) || "{}") || {}; } catch (e) { return {}; } })();
    // pick[lang]: "ai:<Gemini voice>", "dev:<device voice name>" or "" (Hinglish: Intel AI's voice when it's on; English: the device's best)
    const S = { items: [], i: 0, l: 0, chunks: [], c: 0, on: false, paused: false, open: false, busy: "", note: "", mode: "dev", aiDown: "",
      rate: prefs.rate || 1, lang: prefs.lang === "hi" ? "hi" : "en", pick: { en: "", hi: "", ...(prefs.pick || {}) }, gen: 0, audio: null };
    const RATES = [1, 1.25, 1.5, 0.85];
    let provider = null; let el = null;
    const save = () => { try { localStorage.setItem(LSN_KEY, JSON.stringify({ rate: S.rate, lang: S.lang, pick: S.pick })); } catch (e) { /* private mode */ } };
    function devVoices(lang) {  // the device's voices for the language, the most natural first
      const vs = (synth() && synth().getVoices()) || [];
      const fit = vs.filter((v) => (lang === "hi" ? /^hi([-_]|$)/i : /^en([-_]|$)/i).test(v.lang || ""));
      const score = (v) => (/natural|neural|online|premium|enhanced|wavenet/i.test(v.name || "") ? 4 : 0) + (/google/i.test(v.name || "") ? 2 : 0)
        + (lang === "en" ? (/^en[-_]IN/i.test(v.lang) ? 3 : /^en[-_]GB/i.test(v.lang) ? 1 : 0) : 0);
      return fit.map((v, n) => [v, score(v) - n / 1000]).sort((a, b) => b[1] - a[1]).map(([v]) => v);
    }
    const choice = () => S.pick[S.lang] || (S.lang === "hi" && gemini.on() ? `ai:${AI_VOICES[0][0]}` : "");
    const aiVoice = () => (!S.aiDown && gemini.on() && choice().startsWith("ai:") ? choice().slice(3) : "");
    const devVoice = () => { const vs = devVoices(S.lang); const want = choice().replace(/^dev:/, ""); return vs.find((v) => v.name === want) || vs[0] || null; };
    const chunk = (t) => {  // a few sentences, up to ~220 characters
      const out = []; let cur = "";
      for (const x of String(t).match(/[^.!?।]+[.!?।]*\s*/g) || [t]) {
        if (cur && (cur + x).length > 220) { out.push(cur.trim()); cur = x; } else cur += x;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    // Hinglish lines: Intel AI's, else the free translator's plain Hindi; kept on this device (the last 80 articles)
    const hing = new Map(); const pending = new Map();
    function cached(id) {
      if (hing.has(id)) return hing.get(id);
      try { const c = JSON.parse(localStorage.getItem(HING_KEY) || "{}")[id]; if (c && Array.isArray(c.lines)) { hing.set(id, c.lines); return c.lines; } } catch (e) { /* none */ }
      return null;
    }
    function keep(id, lines, by) {
      hing.set(id, lines);
      try {
        const all = JSON.parse(localStorage.getItem(HING_KEY) || "{}") || {}; all[id] = { lines, by, at: Date.now() };
        const ids = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 80);
        localStorage.setItem(HING_KEY, JSON.stringify(Object.fromEntries(ids.map((k) => [k, all[k]]))));
      } catch (e) { /* full or private: kept for this visit */ }
    }
    function hinglish(it) {
      const got = cached(it.id); if (got) return Promise.resolve(got);
      if (!pending.has(it.id)) {
        const p = (async () => {
          let out;
          if (gemini.on()) {
            const { data } = await gemini.json({ system: HINGLISH_SYSTEM, parts: [{ text: it.lines.map((l, n) => `${n + 1}. ${l}`).join("\n") }], schema: HINGLISH_SCHEMA, temperature: 0.2 });
            out = it.lines.map((l, n) => String(((data && data.lines) || [])[n] || "").replace(/^\s*\d+[.)]\s*/, "").trim() || l);
            keep(it.id, out, "ai");
          } else {
            out = await Promise.all(it.lines.map((l) => toHindi(l)));
            keep(it.id, out, "mt");
          }
          return out;
        })();
        pending.set(it.id, p); p.then(() => pending.delete(it.id), () => pending.delete(it.id));
      }
      return pending.get(it.id);
    }
    const linesOf = (i) => { const it = S.items[i]; if (!it) return null; return S.lang === "hi" ? cached(it.id) : it.lines; };
    const intro = (i) => {
      const it = S.items[i]; const k = S.items.slice(0, i + 1).filter((x) => x.kind === it.kind).length;
      if (S.lang === "hi") return it.kind === "fact" ? `प्रीलिम्स फ़ैक्ट ${k}: ` : `ख़बर ${k}: `;
      return it.kind === "fact" ? `Prelims fact ${k}: ` : `Story ${k}: `;
    };
    function hush() { S.gen += 1; if (synth()) synth().cancel(); if (S.audio) { try { S.audio.pause(); } catch (e) { /* none */ } } }  // stale handlers see an old generation
    async function go(i, l = 0) {  // read article i from line l
      hush();
      if (!S.on) return;
      if (i >= S.items.length) { stop(); return; }
      S.i = Math.max(0, i); S.l = Math.max(0, l); S.paused = false; S.note = ""; S.chunks = []; S.c = 0;
      const g = S.gen;
      let lines = linesOf(S.i);
      if (!lines) {  // not in Hinglish yet
        S.busy = gemini.on() ? "Turning this story into Hinglish…" : "Translating into Hindi…"; paint();
        try { lines = await hinglish(S.items[S.i]); } catch (e) {
          if (g !== S.gen) return;
          S.busy = ""; halt(`${e.message}${gemini.on() ? "" : " Switch on ✦ Intel AI for Hinglish."}`); return;
        }
        if (g !== S.gen) return;
        S.busy = "";
      }
      S.l = Math.min(S.l, lines.length - 1);
      if (S.lang === "hi" && S.items[S.i + 1]) hinglish(S.items[S.i + 1]).catch(() => {});  // the next one, ready in time
      S.mode = aiVoice() ? "ai" : "dev";
      if (S.mode === "ai") clip(g); else line(g);
    }
    function line(g) {  // the device's voice: the current line, a few sentences at a time
      const lines = linesOf(S.i) || [];
      if (S.l >= lines.length) { go(S.i + 1); return; }
      S.chunks = chunk((S.l === 0 ? intro(S.i) : "") + lines[S.l]); S.c = 0; paint(); utter(g);
    }
    function utter(g) {
      if (g !== S.gen || !S.on || S.paused) return;
      if (S.c >= S.chunks.length) { S.l += 1; line(g); return; }
      const v = devVoice();
      if (!v && S.lang === "hi") { halt(NO_HINDI); return; }
      if (!synth() || !root.SpeechSynthesisUtterance) { halt("This browser can't read aloud: pick a ✦ Intel AI voice."); return; }
      const u = new root.SpeechSynthesisUtterance(S.chunks[S.c]);
      u.rate = S.rate;
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-IN";
      u.onend = () => { if (g === S.gen && S.on && !S.paused) { S.c += 1; utter(g); } };
      u.onerror = (e) => {  // (a cancelled sentence reports "interrupted"; a real failure stops, it doesn't race through the brief)
        if (g !== S.gen || !S.on || S.paused || (e && /interrupted|canceled/.test(e.error || ""))) return;
        halt(`Your device couldn't read aloud${e && e.error ? ` (${e.error})` : ""}. Check that a text-to-speech voice is installed, or pick a ✦ Intel AI voice.`);
      };
      synth().speak(u);
    }
    // ✦ Intel AI's voice: one clip per article; the lit line follows the clip (each line's share of the text)
    const clips = new Map();
    function clipFor(i) {
      const it = S.items[i]; const lines = linesOf(i); const v = aiVoice();
      if (!it || !lines || !v) return Promise.reject(new Error("nothing to record"));
      const k = `${it.id}|${S.lang}|${v}`;
      if (!clips.has(k)) {
        const said = lines.map((x, n) => (n === 0 ? intro(i) : "") + x);
        const style = S.lang === "hi" ? "Read this aloud in natural spoken Hinglish, like a friendly Indian teacher explaining the news: warm, clear, at an easy pace."
          : "Read this aloud like a warm, clear Indian news presenter, at an easy pace.";
        const p = gemini.speech({ text: `${style}\n\n${said.join("\n")}`, voice: v }).then(({ blob, model }) => {
          const total = said.reduce((n, x) => n + x.length + 1, 0); let at = 0;
          return { url: URL.createObjectURL(blob), model, offs: said.map((x) => { const o = at / total; at += x.length + 1; return o; }) };
        });
        clips.set(k, p); p.catch(() => clips.delete(k));
        while (clips.size > 8) { const old = clips.keys().next().value; clips.get(old).then((c) => URL.revokeObjectURL(c.url), () => {}); clips.delete(old); }
      }
      return clips.get(k);
    }
    async function clip(g) {
      S.busy = "✦ Intel AI is recording this story…"; paint();
      let c;
      try { c = await clipFor(S.i); } catch (e) {
        if (g !== S.gen) return;
        S.busy = ""; S.aiDown = e.message; S.mode = "dev"; S.note = `✦ Intel AI's voice isn't available (${e.message}): using this device's voice.`;
        line(g); return;
      }
      if (g !== S.gen) return;
      S.busy = "";
      const a = S.audio || (S.audio = new root.Audio());
      const lit = () => { if (g !== S.gen || !a.duration) return; const f = a.currentTime / a.duration; let l = 0; c.offs.forEach((o, n) => { if (o <= f + 0.001) l = n; }); if (l !== S.l) { S.l = l; paint(); } };
      a.ontimeupdate = lit;
      a.onended = () => { if (g === S.gen) go(S.i + 1); };
      a.onerror = () => { if (g === S.gen) { S.aiDown = "the clip didn't play"; S.mode = "dev"; line(g); } };
      const seek = () => { if (g === S.gen && S.l > 0 && a.duration) a.currentTime = c.offs[S.l] * a.duration; };
      a.onloadedmetadata = seek;
      a.src = c.url; a.playbackRate = S.rate;
      paint();
      try { await a.play(); } catch (e) {
        if (g === S.gen) { S.aiDown = "the browser blocked playback"; S.mode = "dev"; S.note = "The browser blocked the ✦ Intel AI clip: using this device's voice."; line(g); }
        return;
      }
      if (S.items[S.i + 1]) Promise.resolve(S.lang === "hi" ? hinglish(S.items[S.i + 1]) : null).then(() => { if (g === S.gen) return clipFor(S.i + 1); }).catch(() => {});  // the next one, ready in time
    }
    function unlock() {  // phones allow sound only from a tap: wake the voice and the audio player while this one lasts
      try { if (synth() && root.SpeechSynthesisUtterance) synth().speak(new root.SpeechSynthesisUtterance("")); } catch (e) { /* none */ }
      try {
        if (root.Audio && gemini.on()) {
          S.audio = S.audio || new root.Audio();
          S.audio.src = URL.createObjectURL(audioBlob({ mimeType: "audio/L16;rate=8000", data: btoa("\0\0\0\0\0\0\0\0") }));
          const p = S.audio.play(); if (p && p.catch) p.catch(() => {});
        }
      } catch (e) { /* none */ }
    }
    function play(items) {
      if (!items || !items.length) return false;
      if (!(synth() && root.SpeechSynthesisUtterance) && !(root.Audio && gemini.on())) return false;
      S.items = items; S.on = true; S.aiDown = ""; unlock(); go(0, 0); return true;
    }
    function stop() { hush(); S.on = false; S.paused = false; S.busy = ""; S.note = ""; paint(); }
    function halt(msg) { hush(); S.paused = true; S.busy = ""; S.note = msg; paint(); }  // stays open: a voice or the language can be changed
    function toggle() {
      if (!S.on) return;
      const ai = S.mode === "ai" && S.audio && S.audio.src && !S.busy;
      if (S.paused) {
        S.paused = false; S.note = "";
        if (ai) { const p = S.audio.play(); if (p && p.catch) p.catch(() => {}); } else if (S.chunks.length) { hush(); utter(S.gen); } else go(S.i, S.l);
      } else { S.paused = true; if (ai) S.audio.pause(); else hush(); }
      paint();
    }
    function rate() {
      S.rate = RATES[(RATES.indexOf(S.rate) + 1) % RATES.length]; save();
      if (S.mode === "ai" && S.audio) S.audio.playbackRate = S.rate;
      else if (S.on && !S.paused && S.chunks.length) { hush(); utter(S.gen); }
      paint();
    }
    function setLang(lang) { if (lang !== "en" && lang !== "hi") return; S.lang = lang; S.aiDown = ""; save(); if (S.on) go(S.i, S.l); else paint(); }
    function setVoice(v) { S.pick[S.lang] = String(v || ""); S.aiDown = ""; save(); if (S.on) go(S.i, S.l); else paint(); }
    function paint() {
      if (typeof document === "undefined") return;
      if (!el) { el = document.createElement("div"); el.className = "lsn"; el.setAttribute("role", "region"); el.setAttribute("aria-label", "Listen"); document.body.appendChild(el); }
      el.hidden = !S.on;
      if (!S.on) return;
      el.classList.toggle("open", S.open);
      const it = S.items[S.i] || {}; const lines = linesOf(S.i);
      const status = S.busy || S.note || `${S.paused ? "Paused" : "Listening"} · ${S.i + 1} of ${S.items.length}${S.lang === "hi" ? " · हिंदी" : ""}${S.mode === "ai" ? " · ✦ Intel AI voice" : ""}`;
      const bar = `<div class="lsn-bar"><button class="lsn-t" data-listen="panel" aria-expanded="${S.open}" title="${S.open ? "Hide" : "Choose"} the story and the line">
          <small>🎧 ${esc(status)}</small><b>${esc(it.title || "")}</b></button>
        <button data-listen="prev" aria-label="Previous">⏮</button><button data-listen="toggle" class="lsn-main" aria-label="${S.paused ? "Play" : "Pause"}">${S.paused ? "▶" : "⏸"}</button><button data-listen="next" aria-label="Next story">⏭</button><button data-listen="rate" aria-label="Speed">${S.rate}×</button><button data-listen="panel" class="lsn-more" aria-label="${S.open ? "Hide" : "Show"} the stories and lines">${S.open ? "▾" : "☰"}</button><button data-listen="stop" aria-label="Stop">✕</button></div>`;
      if (!S.open) { el.innerHTML = bar; return; }
      const dv = devVoices(S.lang); const cur = choice(); const devSel = dv.find((v) => cur === `dev:${v.name}`) || (cur.startsWith("ai:") && gemini.on() ? null : dv[0]);
      const opts = `${gemini.on() ? `<optgroup label="✦ Intel AI · natural voices">${AI_VOICES.map(([n, d]) => `<option value="ai:${n}"${cur === `ai:${n}` ? " selected" : ""}>✦ ${n} (${d})</option>`).join("")}</optgroup>` : ""}
        <optgroup label="This device">${dv.length ? dv.map((v) => `<option value="dev:${esc(v.name)}"${v === devSel ? " selected" : ""}>${esc(v.name)}</option>`).join("") : `<option value="" disabled${devSel === undefined && !cur.startsWith("ai:") ? " selected" : ""}>No ${S.lang === "hi" ? "Hindi" : "English"} voice on this device</option>`}</optgroup>`;
      let fk = 0; let mk = 0;
      const list = S.items.map((x, n) => `<li><button data-listen="item" data-i="${n}"${n === S.i ? ' class="on" aria-current="true"' : ""}><span>${x.kind === "fact" ? `P${++fk}` : ++mk}</span>${esc(x.title)}</button></li>`).join("");
      const body = lines ? lines.map((t, n) => `<button data-listen="line" data-l="${n}" class="${n === 0 ? "head" : ""}${n === S.l ? " on" : ""}"${n === S.l ? ' aria-current="true"' : ""}>${esc(t)}</button>`).join("")
        : `<p class="lsn-wait">${esc(S.busy || "Tap ▶ to translate this story.")}</p>`;
      el.innerHTML = `${bar}<div class="lsn-panel">
        <div class="lsn-opts"><div class="lsn-seg" role="group" aria-label="Language"><button data-listen="lang" data-v="en" aria-pressed="${S.lang === "en"}">English</button><button data-listen="lang" data-v="hi" aria-pressed="${S.lang === "hi"}">हिंदी · Hinglish</button></div>
          <label class="lsn-voice"><span>Voice</span><select data-listen-voice aria-label="Voice">${opts}</select></label></div>
        ${gemini.on() ? "" : `<p class="lsn-fine">Switch on ✦ Intel AI (in Ask Intel) for natural voices${S.lang === "hi" ? " and Hinglish; for now it's the free translator's plain Hindi" : ""}.</p>`}
        <div class="lsn-cols"><ol class="lsn-list" aria-label="Stories: tap one to hear it">${list}</ol><div class="lsn-lines" aria-label="Lines: tap one to start there">${body}</div></div></div>`;
      for (const sel of [".lsn-list .on", ".lsn-lines .on"]) {
        const x = el.querySelector(sel); const box = x && x.closest(".lsn-list, .lsn-lines");
        if (x && box) box.scrollTop = Math.max(0, x.offsetTop - box.offsetTop - box.clientHeight / 3);
      }
    }
    if (typeof document !== "undefined") {
      document.addEventListener("click", (e) => {
        const b = e.target.closest && e.target.closest("[data-listen]"); if (!b) return;
        const a = b.dataset.listen;
        if (a === "start") { S.open = true; play(provider ? provider() : []); }
        else if (a === "toggle") toggle();
        else if (a === "next") go(S.i + 1);
        else if (a === "prev") go(S.l > 0 ? S.i : S.i - 1);
        else if (a === "rate") rate();
        else if (a === "stop") stop();
        else if (a === "panel") { S.open = !S.open; paint(); }
        else if (a === "item") go(Number(b.dataset.i) || 0, 0);
        else if (a === "line") go(S.i, Number(b.dataset.l) || 0);
        else if (a === "lang") setLang(b.dataset.v);
      });
      document.addEventListener("change", (e) => { if (e.target && e.target.matches && e.target.matches("[data-listen-voice]")) setVoice(e.target.value); });
      if (synth() && synth().addEventListener) synth().addEventListener("voiceschanged", () => { if (S.on && S.open) paint(); });
      root.addEventListener && root.addEventListener("pagehide", stop);
    }
    return { get supported() { return !!(synth() && root.SpeechSynthesisUtterance) || !!(root.Audio && gemini.on()); }, provider: (fn) => { provider = fn; },
      play, stop, toggle, rate, setLang, setVoice, next: () => go(S.i + 1), prev: () => go(S.l > 0 ? S.i : S.i - 1),
      pick: (i) => go(i, 0), from: (l) => go(S.i, l), open: (v) => { S.open = v !== false; paint(); },
      state: () => ({ on: S.on, paused: S.paused, i: S.i, l: S.l, n: S.items.length, rate: S.rate, lang: S.lang, mode: S.mode, busy: S.busy, note: S.note, text: S.chunks[S.c] || "" }) };
  })();

  root.UPSCCore = Object.freeze({
    STOPW, stem, words, sentencesOf, FURNITURE, overlap, rank, summarize, brief, termOf, termFrom, searchQuery, esc, safeUrl,
    makeBot, intentOf, clozes, toHindi, cleanText, localPoints, WEAK,
    summaryNow, summaryFor, sourceHtml, prefetch, onSummary, readerLoad,
    gemini: Object.freeze({ on: gemini.on, connect: gemini.connect, forget: gemini.forget, models: gemini.models, generate: gemini.generate, json: gemini.json, panel: geminiPanel, bind: bindGemini, rankModels }),
    mdHtml,
    web: Object.freeze({ OPEN_DOMAINS, isOpen, paywalled, domainOf, read, search, gather, sentencesFrom, mainText, keyQuery, matchOf }),
    wiki, expandAcronym, claudePrompt, openClaude,
    mountPractice, practiceStats, pxPick, srsNext, dayNo, listen, listenItems, gloss, mountRanks, ranksHtml, rankMove,
    mountDossiers, dossiersHtml, dossierHtml, dossierChips, follows, mountMap, placesIn,
  });
})(window);

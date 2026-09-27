/* Tests for upsc_intel/web/static/intel-core.js (the Ask bot's engine). Plain Node, no packages:
   node tests/js/intel_core.test.js. The web is stubbed: fetch returns the reader's JSON for canned pages. */
"use strict";
const assert = require("assert");
const path = require("path");

global.window = globalThis;
const PAGES = {};  // url → markdown the stubbed reader returns
const WIKI = {};   // part of a Wikipedia search query → the pages it returns (else a default pair)
let calls = [];
global.fetch = async (url) => {
  calls.push(url);
  const u = String(url);
  if (u.startsWith("https://r.jina.ai/")) {
    const target = u.slice("https://r.jina.ai/".length);
    const md = PAGES[target.startsWith("https://www.bing.com/news/search") ? "BING" : target];
    if (md == null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ code: 200, data: { title: "A page", url: target, content: md } }) };
  }
  if (u.includes("wikipedia.org/w/rest.php")) {
    const q = decodeURIComponent((u.match(/[?&]q=([^&]+)/) || [])[1] || "").replace(/\+/g, " ");
    const hit = Object.keys(WIKI).find((k) => q.toLowerCase().includes(k.toLowerCase()));
    return { ok: true, json: async () => ({ pages: hit ? WIKI[hit] : [
      { key: "European_Space_Agency", title: "European Space Agency", description: "Space agency of Europe", excerpt: "space exploration" },
      { key: "Western_Ghats", title: "Western Ghats", description: "Mountain range in India", excerpt: "Kerala Karnataka forests ecologically sensitive" },
    ] }) };
  }
  if (u.includes("wikipedia.org/api/rest_v1/page/summary/")) {
    const key = decodeURIComponent(u.split("/summary/")[1]);
    return { ok: true, json: async () => ({ type: "standard", title: key.replace(/_/g, " "), description: "", extract: `${key.replace(/_/g, " ")} is a thing.`, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${key}` } } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
require(path.join(__dirname, "../../upsc_intel/web/static/intel-core.js"));
const C = window.UPSCCore;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("sentences keep decimals, initials and abbreviations whole", () => {
  const s = C.sentencesOf("RBI kept the repo rate at 5.5% on Friday, the committee said. If the 886.7 sq km of non-forest area is excluded, the concern is met. Chief Minister V. D. Satheesan met Dr. Rao in the capital on Monday.");
  assert.deepStrictEqual(s, [
    "RBI kept the repo rate at 5.5% on Friday, the committee said.",
    "If the 886.7 sq km of non-forest area is excluded, the concern is met.",
    "Chief Minister V. D. Satheesan met Dr. Rao in the capital on Monday.",
  ]);
});

const ARTICLE = [
  "Advertisement", "[](https://example.com/)", "* [Home](https://ex.com/) * [India](https://ex.com/india) * [World](https://ex.com/world)",
  "## Maharashtra declares drought in 265 talukas",
  "The Maharashtra government on Saturday declared 265 of the 358 talukas in the state as drought affected, activating the first trigger of its drought manual.",
  "Trigger-1 is the first stage in the state's drought framework, activated by a rainfall deficit of more than 25 per cent combined with a dry spell of 21 days.",
  "Farmers in drought-affected areas will get full exemption from land revenue, while examination fees for school and college students will also be waived.",
  "The government has ordered an immediate stay on the recovery of agriculture-related loans and a restructuring of crop loans for the season.",
  "Also read: [Monsoon ends early](https://ex.com/a) [Rain deficit](https://ex.com/b) [Dams dry](https://ex.com/c)",
  "Follow us on social media for more updates from the state and the country every day of the week.",
  "© 2026 Example News. All rights reserved.",
].join("\n\n");

test("the cleaner keeps the article and drops menus, links and furniture", () => {
  const p = C.web.mainText(ARTICLE);
  assert.strictEqual(p.length, 4);
  assert.ok(p[0].startsWith("The Maharashtra government on Saturday declared 265"));
  assert.ok(!p.some((x) => /Also read|Follow us|©|Home/.test(x)));
});

test("teasers for other stories around the article are dropped", () => {
  const md = "'Over 92 lakh names deleted’: party implemented the revision to capture the state, says leader KOLKATA: The leader alleged that the commission implemented the revision of electoral rolls on...\n\n" + ARTICLE;
  const p = C.web.mainText(md);
  assert.ok(!p.some((x) => x.includes("KOLKATA")));
  assert.ok(p[0].startsWith("The Maharashtra government"));
  assert.strictEqual(C.web.mainText("KOZHIKODE: Highland farmers have demanded that a special session of the Assembly be convened to reject the draft notification on sensitive areas.")[0].slice(0, 10), "KOZHIKODE:");
});

test("summaries quote the article, lead first, in order", () => {
  const sents = C.web.sentencesFrom({ domain: "ndtv.com", url: "https://www.ndtv.com/x", paragraphs: C.web.mainText(ARTICLE) });
  const pts = C.summarize(sents, 3);
  assert.strictEqual(pts.length, 3);
  assert.ok(pts[0].text.startsWith("The Maharashtra government"));
  assert.ok(pts.every((x) => sents.includes(x)));  // quoted, never rewritten
  assert.ok(C.brief(sents, 60).split(/\s+/).length <= 75);
});

test("only free-to-read sites are opened", () => {
  assert.ok(C.web.isOpen("https://www.ndtv.com/india-news/x-123"));
  assert.ok(C.web.isOpen("https://pib.gov.in/PressReleasePage.aspx?PRID=1"));
  assert.ok(C.web.isOpen("https://theprint.in/india/x/"));
  for (const u of ["https://www.thehindu.com/news/x.ece", "https://indianexpress.com/article/x/", "https://www.livemint.com/x",
    "https://economictimes.indiatimes.com/x", "https://www.business-standard.com/x", "https://news.google.com/rss/articles/x",
    "https://timesofindia.indiatimes.com/toi-plus/x/123.cms", "https://example-blog.com/x"]) {
    assert.ok(!C.web.isOpen(u), u);
  }
  assert.ok(C.web.paywalled("thehindu.com") && C.web.paywalled("frontline.thehindu.com") && !C.web.paywalled("ndtv.com"));
});

const BING = [
  "Title: search - BingNews", "",
  "### [Drought declared in 265 talukas across Maharashtra](http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=1&url=https%3a%2f%2fwww.deccanchronicle.com%2fnation%2fdrought-265-talukas-1&c=1&mkt=en-in)",
  "Chief Minister directed collectors to begin crop surveys in 265 talukas.",
  "[Deccan Chronicle](http://www.bing.com/news/apiclick.aspx?url=x)", "Sat, 26 Sep 2026 03:35:00 GMT", "",
  "### [Maharashtra declares 265 talukas drought-hit](http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fwww.livemint.com%2fnews%2fdrought-2&c=2)",
  "Crop loan restructuring and power concessions announced.", "Sat, 26 Sep 2026 04:39:00 GMT",
].join("\n");

test("the news search decodes real links and marks free sites", async () => {
  PAGES.BING = BING;
  const hits = await C.web.search("Maharashtra drought 265 talukas");
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].url, "https://www.deccanchronicle.com/nation/drought-265-talukas-1");
  assert.strictEqual(hits[0].open, true);
  assert.strictEqual(hits[1].domain, "livemint.com");
  assert.strictEqual(hits[1].open, false);
  assert.ok(hits[0].snippet.startsWith("Chief Minister") && hits[0].date.startsWith("Sat, 26 Sep"));
});

test("a paywalled story is read from a free report of the same event", async () => {
  PAGES.BING = BING;
  PAGES["https://www.deccanchronicle.com/nation/drought-265-talukas-1"] = ARTICLE;
  calls = [];
  const story = { id: "s1", title: "Maharashtra govt declares 265 of 358 talukas drought-affected", sources: [{ p: "The Hindu", u: "https://www.thehindu.com/news/x.ece" }] };
  const g = await C.web.gather(story);
  assert.deepStrictEqual(g.closed, ["thehindu.com"]);
  assert.strictEqual(g.read.length, 1);
  assert.strictEqual(g.read[0].domain, "deccanchronicle.com");
  assert.strictEqual(g.read[0].via, "search");
  assert.ok(!calls.some((u) => /thehindu\.com|livemint\.com/.test(u.replace(/^https:\/\/r\.jina\.ai\/https:\/\/www\.bing\.com.*/, ""))), "never fetches a paywalled page");
});

test("key-term search: names, acronyms, figures and the place", () => {
  const q = C.web.keyQuery({ title: "Do not spread fears over ESA notification: Minister", explain: { where: "Kerala" }, sources: [{ p: "The Hindu" }] });
  assert.strictEqual(q, "ESA Kerala notification");
  assert.strictEqual(C.web.keyQuery({ title: "Maharashtra govt declares 265 of 358 talukas drought-affected", sources: [] }).split(" ").slice(0, 2).join(" "), "265 358");
});

test("acronyms are expanded from the story's own words", () => {
  assert.strictEqual(C.expandAcronym("ESA", "the final notification on the Western Ghats Ecologically Sensitive Area, confined to forest land"), "Ecologically Sensitive Area");
  assert.strictEqual(C.expandAcronym("RBI", "The Reserve Bank of India kept rates on hold"), "Reserve Bank of India");
  assert.strictEqual(C.expandAcronym("UN", "no expansion here"), "");
});

test("question weighting: a rare word counts more than a common one", () => {
  const corpus = ["The minister spoke to reporters about the forest department.", "The minister visited the district office on Monday.", "The state wants to cut the number of villages covered from 131 to 98."].map((text) => ({ text, src: "x" }));
  const r = C.rank(corpus, "what did the minister say about villages?");
  assert.ok(r[0].text.includes("villages"));
  assert.ok(r[0].share >= 0.5 && r[0].cover === 0.5);
});

test("fact MCQs: the right answer is the article's figure, options are distinct", () => {
  const sents = C.web.sentencesFrom({ domain: "x", url: "https://x", paragraphs: C.web.mainText(ARTICLE) });
  const q = C.clozes(sents, 2);
  assert.strictEqual(q.length, 2);
  for (const m of q) {
    assert.strictEqual(new Set(m.options).size, 4);
    assert.ok(m.q.includes("_____"));
    assert.ok(m.why.includes(m.options[m.answer].replace(/ per cent$/, "")));
  }
  assert.strictEqual(q[0].options[q[0].answer], "265");
});

test("chips and questions map to the right answer", () => {
  const cases = { "Summary": "summary", "60-word summary": "s60", "5W": "5w", "Static background": "background", "Make 2 Prelims MCQs": "mcq",
    "Mains answer outline": "outline", "हिंदी में समझाएं": "hindi", "Link to syllabus": "syllabus", "Search the web": "web", "Ask Claude ↗": "claude",
    "who": "w", "why is it in news": "win", "what relief was announced for farmers": "ask" };
  for (const [q, want] of Object.entries(cases)) assert.strictEqual(C.intentOf(q), want, q);
});

test("the bot's summary reads the free copy and says where it came from", async () => {
  PAGES.BING = BING;
  PAGES["https://www.deccanchronicle.com/nation/drought-265-talukas-1"] = ARTICLE;
  const bot = C.makeBot({});
  const story = { id: "s2", title: "Maharashtra govt declares 265 of 358 talukas drought-affected", grade: "NOTE", gs: ["GS3"], subjects: ["agriculture"], tags: [],
    sources: [{ p: "The Hindu", u: "https://www.thehindu.com/news/x.ece" }], explain: { why_in_news: "Reported on 26 Sep by The Hindu.", auto: true } };
  const html = await bot.answer(story, "Summary");
  assert.ok(html.includes("Summary · ") && html.includes("deccanchronicle.com") && html.includes("subscriber-only"));
  assert.ok(!html.includes("Reported on 26 Sep"));  // a placeholder is never presented as a summary
  const qa = await bot.answer(story, "what about crop loans?");
  assert.ok(qa.includes("restructuring of crop loans"));
});

test("one summary per story, shared by every screen: the brief's lines, then the free full article", async () => {
  PAGES.BING = BING;
  PAGES["https://www.deccanchronicle.com/nation/drought-265-talukas-1"] = ARTICLE;
  const story = { id: "s9", title: "Maharashtra govt declares 265 of 358 talukas drought-affected", sources: [{ p: "The Hindu", u: "https://www.thehindu.com/news/x.ece" }],
    explain: { why_in_news: "Reported on 26 Sep by The Hindu.", auto: true }, summary: "Source: The post has been created based on the article. The state declared 265 talukas drought-affected on Saturday after a weak monsoon." };
  const before = C.summaryNow(story);
  assert.strictEqual(before.from, "brief");
  assert.ok(before.points.length === 1 && before.points[0].startsWith("The state declared"));  // placeholder and furniture dropped
  const heard = [];
  C.onSummary((id, out) => heard.push([id, !!out.points]));
  const [a, b] = await Promise.all([C.summaryFor(story), C.summaryFor(story)]);  // asked twice, read once
  assert.strictEqual(a, b);
  const now = C.summaryNow(story);
  assert.strictEqual(now.from, "web");
  assert.strictEqual(now.src.domain, "deccanchronicle.com");
  assert.ok(now.points[0].startsWith("The Maharashtra government"));
  assert.ok(C.sourceHtml(now.src).includes("free report of the same story") && C.sourceHtml(now.src).includes("thehindu.com"));
  assert.deepStrictEqual(heard, [["s9", true]]);
});

test("background picks the Wikipedia page that fits the story", async () => {
  const bot = C.makeBot({});
  const story = { id: "s3", title: "Do not spread fears over ESA notification: Minister", grade: "SKIM", gs: ["GS3"], subjects: ["environment"], tags: [], sources: [],
    explain: { where: "Kerala", auto: true }, texts: [{ p: "PTI", x: "Keralam has sought the final notification on the Western Ghats Ecologically Sensitive Area, confined to forest land, the minister said on Friday in Kerala." }] };
  const html = await bot.answer(story, "Static background");
  assert.ok(html.includes("Western Ghats") && !html.includes("European Space Agency"));
});

test("the day bot lists the Must-know cards and the Prelims facts separately", async () => {
  const st = (id, title, subj) => ({ id, title, subjects: [subj], gs: [], tags: [], sources: [] });
  const day = { label: "26 Sep", cards: [st("a", "Parliament passes the Judicature Amendment Bill", "polity")],
    prelims: [st("b", "Exercise VARUNA 2026 begins off Toulon", "defence"), st("c", "New Begonia species found in Arunachal", "environment")],
    more: [st("d", "PM's BRICS visit is loaded with expectations", "ir")], editorials: [], explained: [] };
  const bot = C.makeBot({ day: () => day, labels: () => ({ subjects: { polity: "Polity", defence: "Defence", environment: "Environment", ir: "IR" } }) });
  const top = await bot.answer(null, "What are today's top stories?");
  assert.ok(top.includes("Judicature") && !top.includes("VARUNA") && top.includes("2 Prelims facts") && top.includes("1 one-liner."));
  const facts = await bot.answer(null, "Prelims facts");
  assert.ok(facts.includes("VARUNA") && facts.includes("Begonia") && !facts.includes("Judicature"));
  const p = bot.claudeFor(null, "");
  assert.ok(p.includes("MUST-KNOW") && p.includes("PRELIMS FACTS") && p.includes("Begonia"));
});

const RUSSIAN_OIL = { id: "ro1", title: "Tariffs, Russian oil and the uneasy India-US relationship", editorial: true, grade: "READ", gs: ["GS2"],
  subjects: ["ir"], tags: [], summary: "Talking trade amid coercive tariffs", explain: { keywords: [] },
  sources: [{ p: "Deccan Herald", u: "https://www.deccanherald.com/opinion/tariffs-russian-oil" }] };

test("background: a story's topic, never a country page for a headline", async () => {
  assert.strictEqual(C.termOf(RUSSIAN_OIL), "India–United States relations");
  const jai = { title: "Jaishankar at UN urges end to war, flags Gulf and Ukraine risks", sources: [], explain: {} };
  assert.notStrictEqual(C.termOf(jai), "Gulf and Ukraine");
  WIKI["India–United States relations"] = [
    { key: "India", title: "India", description: "Country in South Asia", excerpt: "India United States relations trade tariffs" },
    { key: "India–United_States_relations", title: "India–United States relations", description: "Bilateral relations", excerpt: "diplomatic relations" }];
  PAGES["https://www.deccanherald.com/opinion/tariffs-russian-oil"] = "Not much seems to have changed since the last copy of the first edition of that book was sold, and it shows.";
  const bot = C.makeBot({});
  const html = await bot.answer(RUSSIAN_OIL, "Static background");
  assert.ok(html.includes("India–United States relations") && !html.includes("Country in South Asia"), html);
  assert.ok(!html.includes("may not be what this story means"));
});

test("background: no page that fits the story means none is shown", async () => {
  const st = { id: "nf1", title: "Zorblat committee meets on quibble norms", grade: "SKIM", gs: [], subjects: ["polity"], tags: [], sources: [], explain: { keywords: ["Zorblat committee"] } };
  WIKI["Zorblat"] = [{ key: "India", title: "India", description: "Country in South Asia", excerpt: "a country" }];
  WIKI["quibble"] = [{ key: "Pakistan", title: "Pakistan", description: "Country in South Asia", excerpt: "a country" }];
  const html = await C.makeBot({}).answer(st, "Static background");
  assert.ok(html.includes("No Wikipedia page clearly fits this story") && !html.includes("Country in South Asia"), html);
});

test("a question about the story is answered from the article, not Wikipedia", async () => {
  const st = { id: "q1", title: "Jaishankar at UN urges end to war, flags Gulf and Ukraine risks", grade: "SKIM", gs: ["GS2"], subjects: ["ir"], tags: [],
    explain: {}, sources: [{ p: "India Today", u: "https://news.google.com/rss/articles/x" }],
    sum: { points: ["India told the UN that endless war must give way to an end to war."], url: "https://www.indiatoday.in/world/story/jaishankar-unga", domain: "indiatoday.in", via: "search",
      text: "India told world leaders at the United Nations that endless war must give way now to an end to war.\nHe said there is an urgent need to address the security of seafarers, and the supply of food grains and energy to the Global South." } };
  const calls0 = calls.length;
  const html = await C.makeBot({}).answer(st, "What is the issue with food and energy supplies?");
  assert.ok(html.includes("From the full article") && html.includes("food grains and energy"), html);
  assert.ok(!calls.slice(calls0).some((u) => String(u).includes("wikipedia")), "no Wikipedia lookup for a question about the story");
  assert.strictEqual(C.summaryNow(st).from, "web");  // the build's points show on the card straight away
});

test("an acronym question gets the page that spells it out", async () => {
  WIKI["CBAM"] = [{ key: "UK_CBAM", title: "UK CBAM", description: "UK tariff", excerpt: "tariffs imports United Kingdom India" },
    { key: "Carbon_Border_Adjustment_Mechanism", title: "Carbon Border Adjustment Mechanism", description: "EU carbon tariff", excerpt: "carbon" }];
  const html = await C.makeBot({}).answer(RUSSIAN_OIL, "What is CBAM?");
  assert.ok(html.includes("Background: <b>Carbon Border Adjustment Mechanism"), html);
});

test("an editorial's summary gives the argument, not the opening anecdote", () => {
  const sents = ["Not much seems to have changed since the last copy of the first edition of that book was sold in 1995.",
    "India and the US remain estranged even though both still need each other in a world of power conflicts.",
    "The tariffs on Indian goods over purchases of Russian oil have strained the trade negotiations badly.",
    "New Delhi must diversify its crude imports and should keep talking trade with Washington.",
    "India needs to balance its energy security with its strategic partnership with the United States.",
    "The way forward is a limited trade deal that separates the oil question from the tariff talks."].map((text) => ({ text }));
  const pts = C.summarize(sents, 3, { editorial: true }).map((x) => x.text);
  assert.ok(!pts.includes(sents[0].text) && pts.some((p) => /must|needs to|way forward/.test(p)), pts.join(" | "));
});

const pxq = (id, story, type = "statements", subject = "polity") => ({ id, story_id: story, type, subject, gs: ["GS2"], q: `Q ${id}`, items: ["a", "b"],
  ask: "Which is correct?", options: ["1 only", "2 only", "Both", "Neither"], answer: 2, why: "The report says so.", src: "PIB", url: "https://pib.gov.in/x", title: `Story ${story}` });

test("practice sets: unseen first, one pairs question at most, a story once before twice", () => {
  const pool = [pxq("p1", "s1", "pairs"), pxq("p2", "s2", "pairs"), ...Array.from({ length: 12 }, (_, i) => pxq(`q${i}`, `s${i % 6}`, ["statements", "fact", "figure"][i % 3]))];
  const set = C.pxPick(pool, 6, { q0: 1, q1: 1 });
  assert.strictEqual(set.length, 6);
  assert.ok(set.filter((q) => q.type === "pairs").length <= 1);
  assert.ok(!set.some((q) => q.id === "q0" || q.id === "q1"), "questions seen before wait until the unseen ones run out");
  assert.strictEqual(new Set(set.map((q) => q.story_id)).size, 6, "six different stories");
  assert.deepStrictEqual(C.pxPick(pool, 6, { q0: 1, q1: 1 }).map((q) => q.id), set.map((q) => q.id), "the same set in the same order");
});

test("practice widget: a set start to finish, with a swap and a UPSC-marked result", async () => {
  const mem = {}; global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const pools = { "2026-09-26": Array.from({ length: 8 }, (_, i) => pxq(`d26-${i}`, `s${i}`)), "2026-09-25": [pxq("d25-0", "t0")] };
  const el = { innerHTML: "", querySelector: () => null, contains: () => true };
  C.mountPractice(el, { day: () => "2026-09-26", days: () => ["2026-09-26", "2026-09-25"], load: async (d) => ({ questions: pools[d] || [] }),
    label: (d) => d, subject: (k) => k, claude: () => {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(el.innerHTML.includes("8 questions from this day's brief"), el.innerHTML.slice(0, 300));
  const click = async (px, data = {}) => el.onclick({ target: { closest: () => ({ dataset: { px, ...data } }) } });
  await click("size", { n: "10" });
  await click("start");
  assert.ok(el.innerHTML.includes("Q 1 of 8"));
  await click("swap");  // an unseen question from this day replaces it... none left here, so the day before gives one
  assert.ok(!el.innerHTML.includes("No unseen question"), "a swap found a question");
  for (let i = 0; i < 8; i += 1) { await click("pick", { i: i < 5 ? "2" : "0" }); await click("next"); }
  const st = JSON.parse(mem["upsc-practice"]);
  const a = st.attempts[st.attempts.length - 1];
  assert.strictEqual(a.right + a.wrong + a.skipped, 8);
  assert.strictEqual(a.score, Math.round((a.right * 2 - a.wrong * 0.66) * 100) / 100);
  assert.ok(el.innerHTML.includes(`${a.score} <small>/ 16</small>`) && el.innerHTML.includes("Retry the"));
  assert.ok(Object.keys(st.seen).length >= 8);
  assert.strictEqual(C.practiceStats().attempts.length, st.attempts.length);
});

test("the Claude prompt carries the story and the question", () => {
  const p = C.claudePrompt({ title: "RBI keeps repo rate unchanged", date: "2026-09-26", explain: { why_in_news: "The MPC held the rate." }, sources: [{ u: "https://www.rbi.org.in/x" }] }, "What is the MPC?");
  assert.ok(p.includes("RBI keeps repo rate unchanged") && p.includes("The MPC held the rate.") && p.includes("https://www.rbi.org.in/x") && p.endsWith("MY QUESTION: What is the MPC?"));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed += 1; console.log(`not ok - ${name}\n  ${e.stack.split("\n").slice(0, 3).join("\n  ")}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();

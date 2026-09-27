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

test("a trending strip of linked headlines never becomes the article, even when it outweighs each paragraph", () => {
  const link = (t, i) => `[${t}](https://timesofindia.indiatimes.com/x/articleshow/${i}.cms "${t}")`;
  const strip = ["Bigg Boss Malayalam 8 preview: Mohanlal to make a decision on the issue, says I am here to listen to you",
    "Suniel Shetty recalls his childhood obsession with cricket, reveals he has been following Rohit Sharma since he was 16",
    "Numerology prediction, September 27 to October 03, 2026, based on the first letter of your name",
    "Why do some Indian villages still cook food underground? The centuries-old cooking technique that turns pits into natural ovens.",
    "NCMC card mandatory for senior citizens, women passengers on MSRTC buses from October 1"].map(link).join("").repeat(4);
  const md = ["# Vijay government exempts Tamil Nadu Public (Law & Order) department from RTI", "",
    "NEW DELHI: The Tamil Nadu government has exempted the Public (Law and Order) Department from the ambit of the Right to Information Act.A Gazette notification classifies it as an Intelligence and Security Organisation under Section 24(4).", "",
    "> — ANI (@ANI) [September 27, 2026](https://x.com/ANI/status/1)", "", "### What the exemption means", "",
    "The Public (Law and Order) Department deals with policing, public order and law-and-order administration, so RTI requests on these matters will be refused.", "",
    "Join conversation", "", "View All Comments (2) →", "", "Post Comment", "", "[Sponsored Links](https://popup.taboola.com/x)", "", "You May Like", "", "Undo", "",
    "However, Section 24 of the RTI Act does not provide a blanket exemption: information on allegations of corruption and human-rights violations must still be given.", "",
    "Priyanka Jaiswal has four years of experience in digital journalism, news agency reporting and video production at the paper.", "",
    strip].join("\n");
  const p = C.web.mainText(md);
  assert.ok(p[0].startsWith("NEW DELHI: The Tamil Nadu government"), p[0]);
  assert.ok(p.some((x) => x.startsWith("However, Section 24")) && p.some((x) => x.includes("Act. A Gazette")));
  assert.ok(!p.some((x) => /Bigg Boss|Numerology|Priyanka Jaiswal/.test(x)));
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

// ── Gemini (the viewer's own key, on the device) ──
function gemStub({ busy = [], reply = "### Section 24\n- The **RTI Act** exempts intelligence and security bodies.\n- Corruption and human-rights information must still be given." } = {}) {
  const seen = [];
  const prev = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith("https://generativelanguage.googleapis.com/")) return prev(url, init);
    seen.push({ u, init });
    if (u.includes("/models?")) return new Response(JSON.stringify({ models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "text-embedding-004"]
      .map((n) => ({ name: `models/${n}`, supportedGenerationMethods: n.includes("embedding") ? ["embedContent"] : ["generateContent"] })) }), { status: 200 });
    const model = u.split("/models/")[1].split(":")[0];
    if (busy.includes(model)) return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 });
    const half = Math.floor(reply.length / 2);
    const sse = [reply.slice(0, half), reply.slice(half)].map((t, i) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, ...(i ? { finishReason: "STOP" } : {}) }] })}\r\n\r\n`).join("");
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return { seen, restore: () => { global.fetch = prev; } };
}
const TN = { id: "tn", title: "Tamil Nadu government exempts Public (Law and Order) Department from RTI Act", date: "2026-09-27", subjects: ["polity"], gs: ["GS2"], tags: [],
  sources: [{ p: "Times of India", u: "https://timesofindia.indiatimes.com/tn.cms" }], explain: { why_in_news: "A Gazette notification exempted the department.", auto: true },
  sum: { points: ["x"], url: "https://timesofindia.indiatimes.com/tn.cms", domain: "timesofindia.indiatimes.com", via: "",
    text: "NEW DELHI: The Tamil Nadu government has exempted the Public (Law and Order) Department from the ambit of the RTI Act under Section 24(4).\nEven exempted bodies must disclose information on corruption and human-rights violations." } };

test("Intel AI: the key is checked with Google and kept on the device; models ranked best first", async () => {
  assert.strictEqual(C.intentOf("✦ Intel AI"), "gemini");
  const mem = {}; global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const g = gemStub();
  try {
    await assert.rejects(C.gemini.connect("short"), /doesn't look like/);
    await C.gemini.connect("AQ.Ab8NEWFORMATtestkey-0123456789_abc");  // Google's newer key format has a dot
    assert.strictEqual(mem["upsc-gemini-key"], "AQ.Ab8NEWFORMATtestkey-0123456789_abc");
    const models = await C.gemini.connect("  AIzaSyTESTKEY-0123456789abcdef  ");
    assert.deepStrictEqual(models, ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"]);
    assert.ok(C.gemini.on() && mem["upsc-gemini-key"] === "AIzaSyTESTKEY-0123456789abcdef");
    assert.ok(g.seen.every((x) => !x.u.includes("key=") && x.init.headers["x-goog-api-key"]), "the key travels only in a header");
    C.gemini.forget(); assert.ok(!C.gemini.on());
  } finally { g.restore(); }
});

test("Gemini: a free question is answered from the article, streamed, with a used-up model skipped", async () => {
  const mem = { "upsc-gemini-key": "AIzaSyTESTKEY-0123456789abcdef", "upsc-gemini-models": JSON.stringify(["gemini-2.5-flash", "gemini-2.5-flash-lite"]) };
  global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  PAGES["https://timesofindia.indiatimes.com/tn.cms"] = "NEW DELHI: The Tamil Nadu government has exempted the Public (Law and Order) Department from the ambit of the Right to Information Act, classifying it as an intelligence organisation.\n\nThe notification under Section 24(4) of the RTI Act means information held by the department is outside the scope of requests.\n\nEven organisations covered by the provision must provide information relating to allegations of corruption and human-rights violations.";
  const g = gemStub({ busy: ["gemini-2.5-flash"] });
  try {
    const bot = C.makeBot({ labels: () => ({ subjects: { polity: "Polity" }, subject_gs: { polity: "GS2" } }) });
    const partial = [];
    const html = await bot.answer(TN, "What does Section 24 of the RTI Act do here?", { onPartial: (h) => partial.push(h) });
    assert.ok(html.includes("<b>RTI Act</b>") && html.includes("<p class=\"bot-sub\">Section 24</p>") && html.includes('title="gemini-2.5-flash-lite">✦ Intel AI, from the article on'), html);
    assert.ok(!/Gemini/.test(html.replace(/title="[^"]*"/g, "")), "the answer speaks as Intel");
    assert.ok(partial.length >= 2 && partial[0].length < partial[partial.length - 1].length, "the answer streams in");
    const body = JSON.parse(g.seen.find((x) => x.u.includes("flash-lite:streamGenerateContent")).init.body);
    assert.ok(body.systemInstruction.parts[0].text.includes("Section 24(4) of the RTI Act means information held"), "the full article is in the context");
    assert.strictEqual(JSON.parse(mem["upsc-gemini-models"])[0], "gemini-2.5-flash-lite", "the model that worked goes first next time");
    await bot.answer(TN, "And what are the exceptions?");
    const second = JSON.parse(g.seen[g.seen.length - 1].init.body);
    assert.strictEqual(second.contents.length, 3, "a follow-up carries the earlier turn");
  } finally { g.restore(); }
});

test("Gemini: when every model's quota is used up, the reports answer instead, saying why", async () => {
  const mem = { "upsc-gemini-key": "AIzaSyTESTKEY-0123456789abcdef", "upsc-gemini-models": JSON.stringify(["gemini-2.5-flash"]) };
  global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const g = gemStub({ busy: ["gemini-2.5-flash"] });
  try {
    const html = await C.makeBot({}).answer(TN, "Make 2 Prelims MCQs");
    assert.ok(/✦ The free AI quota is used up.*from the reports instead/.test(html) && !/Intel AI, from/.test(html), html.slice(0, 200));
  } finally { g.restore(); }
});

test("Gemini's Markdown is rendered safely", () => {
  const h = C.mdHtml("## Head\n- **bold** <img src=x onerror=alert(1)>\n1. [ok](https://pib.gov.in/x) [bad](javascript:alert(1))");
  assert.ok(h.includes("<p class=\"bot-sub\">Head</p>") && h.includes("<ul><li><b>bold</b> &lt;img") && h.includes('<a href="https://pib.gov.in/x"'));
  assert.ok(!/<img|href="javascript/.test(h), h);
});

// ── Practice hub: revision, mistakes, the weekly mock, Mains ──
function memStore(init = {}) { const mem = { ...init }; global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } }; return mem; }
function hub(host) {
  const el = { innerHTML: "", querySelector: () => null, contains: () => true };
  const w = C.mountPractice(el, { day: () => "2026-09-26", days: () => ["2026-09-26"], load: async () => ({ questions: [] }), label: (d) => d,
    subject: (k) => k, claude: () => {}, cardDays: () => [], loadCards: async () => ({ cards: [] }), loadDay: async () => ({ days: {}, stories: [] }), ...host });
  const click = async (px, data = {}) => el.onclick({ target: { closest: () => ({ dataset: { px, ...data } }) } });
  return { el, w, click, tick: () => new Promise((r) => setTimeout(r, 5)) };
}

test("spaced repetition: intervals grow with each recall and reset on a lapse", () => {
  const t = 20000;
  let c = C.srsNext(null, 3, t); assert.deepStrictEqual([c.ivl, c.due, c.reps], [1, t + 1, 1]);
  c = C.srsNext(c, 3, t); assert.strictEqual(c.ivl, 3);
  c = C.srsNext(c, 3, t); assert.strictEqual(c.ivl, 8);
  const easy = C.srsNext(c, 4, t); assert.ok(easy.ivl > 8 * 2.5 && easy.ease > c.ease);
  const lapse = C.srsNext(c, 1, t); assert.deepStrictEqual([lapse.ivl, lapse.lapses, lapse.reps], [0, 1, 0]);
  assert.strictEqual(C.srsNext(null, 4, t).ivl, 3);
});

test("revise: today's cards, graded, come back on schedule", async () => {
  const mem = memStore();
  const cards = [1, 2, 3].map((i) => ({ id: `fc${i}`, story_id: `s${i}`, q: `Question ${i}?`, a: `Answer ${i}`, day: "2026-09-26", subject: "polity", url: "https://pib.gov.in/x", title: "T" }));
  const H = hub({ cardDays: () => ["2026-09-26"], loadCards: async () => ({ cards }) });
  await H.click("tab", { t: "revise" }); await H.tick(); await H.tick();
  assert.ok(H.el.innerHTML.includes("3 cards for today"), H.el.innerHTML.slice(0, 400));
  await H.click("rv-start");
  assert.ok(H.el.innerHTML.includes("Question") && H.el.innerHTML.includes("Show answer"));
  for (let i = 0; i < 3; i += 1) { await H.click("rv-flip"); assert.ok(H.el.innerHTML.includes("Answer")); await H.click("rv-grade", { g: "3" }); }
  assert.ok(H.el.innerHTML.includes("Done for now"), H.el.innerHTML.slice(0, 300));
  const st = JSON.parse(mem["upsc-srs"]);
  assert.strictEqual(Object.keys(st.cards).length, 3); assert.strictEqual(st.fresh, 3);
  assert.ok(Object.values(st.cards).every((c) => c.due === C.dayNo() + 1));
});

test("mistakes: a wrong answer is kept until it's answered right", async () => {
  const mem = memStore();
  const qs = Array.from({ length: 3 }, (_, i) => pxq(`m${i}`, `s${i}`));
  const H = hub({ load: async () => ({ questions: qs }) }); await H.tick();
  await H.click("size", { n: "10" }); await H.click("start");
  const first = H.el.innerHTML.match(/class="px-stem">Q (m\d)</)[1];  // (a set is shuffled: whichever comes first)
  for (let i = 0; i < 3; i += 1) { await H.click("pick", { i: i === 0 ? "0" : "2" }); await H.click("next"); }  // the first wrong
  let st = JSON.parse(mem["upsc-practice"]);
  assert.deepStrictEqual(Object.keys(st.wrong), [first]);
  await H.click("setup"); await H.click("tab", { t: "mistakes" });
  assert.ok(H.el.innerHTML.includes("1 question to get right"), H.el.innerHTML.slice(0, 400));
  await H.click("mistakes"); await H.click("pick", { i: "2" }); await H.click("next");
  st = JSON.parse(mem["upsc-practice"]);
  assert.deepStrictEqual(st.wrong, {});
});

test("weekly mock: fifty questions from the week, on the clock, in exam mode", async () => {
  memStore();
  const days = ["2026-09-26", "2026-09-25", "2026-09-24", "2026-09-23", "2026-09-22", "2026-09-21", "2026-09-20", "2026-09-19"];
  const byDay = Object.fromEntries(days.map((d, k) => [d, Array.from({ length: 12 }, (_, i) => pxq(`${d}-${i}`, `${d}-s${i}`))]));
  const loaded = [];
  const H = hub({ days: () => days, load: async (d) => { loaded.push(d); return { questions: byDay[d] || [] }; } }); await H.tick();
  await H.click("tab", { t: "mock" });
  assert.ok(H.el.innerHTML.includes("50 questions from the last seven days"));
  await H.click("mock");
  assert.ok(H.el.innerHTML.includes("Q 1 of 50") && H.el.innerHTML.includes("px-timer") && H.el.innerHTML.includes(">60:00<"), H.el.innerHTML.slice(0, 300));
  assert.ok(!loaded.includes("2026-09-19"), "only the last seven days");
  await H.click("pick", { i: "1" });
  assert.ok(!H.el.innerHTML.includes("px-why"), "exam mode: no answer shown");
  await H.click("end");
  assert.ok(H.el.innerHTML.includes("/ 100") && H.el.innerHTML.includes("Weekly mock"));
});

test("Mains: an answer is evaluated by Intel AI and kept in the history", async () => {
  const mem = memStore({ "upsc-gemini-key": "AIzaSyTESTKEY-0123456789abcdef", "upsc-gemini-models": JSON.stringify(["gemini-2.5-flash"]) });
  const story = { id: "tn", title: "Tamil Nadu exempts department from RTI", gs: ["GS2"], subjects: ["polity"], sum: { text: "Section 24(4) of the RTI Act.", domain: "toi.com" },
    explain: { mains: "Discuss the scope of exemptions under Section 24 of the RTI Act. (15 marks, 250 words)", why_in_news: "A Gazette notification." } };
  const verdict = { transcript: "", score: 6.7, verdict: "A fair answer that misses the judicial angle.", rubric: { demand: 6, content: 5, dimensions: 4, structure: 7, substantiation: 3, presentation: 6 },
    strengths: ["Clear introduction"], improve: ["Cite the CIC's rulings"], missed: ["Federal angle"], keywords: ["Section 24(4)", "proviso"], examples: ["2019 amendment"],
    better_intro: "The RTI Act, 2005…", better_conclusion: "Transparency and security…", outline: ["Intro: Section 24", "Body: scope", "Way forward"] };
  let sent = null;
  const prev = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (!String(url).includes(":generateContent")) return prev(url, init);
    sent = { url: String(url), init };
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(verdict) }] } }] }), { status: 200 });
  };
  try {
    const H = hub({ loadDay: async (d) => ({ days: { [d]: { news: ["tn"] } }, stories: [story] }) });
    await H.click("tab", { t: "mains" }); await H.tick(); await H.tick();
    assert.ok(H.el.innerHTML.includes("1 Mains question from this day's brief"), H.el.innerHTML.slice(0, 500));
    await H.click("mn-pick", { id: "tn" });
    assert.ok(H.el.innerHTML.includes("Discuss the scope") && H.el.innerHTML.includes("0 / 250 words"));
    H.el.oninput({ target: { matches: (sel) => sel === "[data-mn-text]", value: "The RTI Act 2005 lets states exempt intelligence bodies under Section 24(4) but corruption information must still be given." } });
    assert.ok(JSON.parse(mem["upsc-mains-draft"]).tn.startsWith("The RTI Act"), "the draft is kept");
    await H.click("mn-eval");
    const body = JSON.parse(sent.init.body);
    assert.ok(sent.url.includes("gemini-2.5-flash:generateContent") && sent.init.headers["x-goog-api-key"] && !sent.url.includes("key="));
    assert.ok(body.generationConfig.responseMimeType === "application/json" && body.contents[0].parts[0].text.includes("QUESTION (15 marks, 250 words)"));
    assert.ok(H.el.innerHTML.includes("6.5 <small>/ 15</small>") && H.el.innerHTML.includes("Model answer outline") && H.el.innerHTML.includes("Cite the CIC"), H.el.innerHTML.slice(0, 400));
    const hist = JSON.parse(mem["upsc-mains"]);
    assert.strictEqual(hist[0].score, 6.5); assert.strictEqual(hist[0].story_id, "tn");
  } finally { global.fetch = prev; }
});

const flush = async (n = 8) => { for (let k = 0; k < n; k++) await new Promise((r) => setTimeout(r, 0)); };
const LISTEN_CARDS = [{ id: "a", title: "Cabinet approves ECLGS 5.0", sum: { points: ["The scheme gives ₹2 lakh crore of guaranteed credit.", "It runs until March 2027."] } },
  { id: "b", title: "Delhi HC on POCSO", explain: { why_in_news: "Personal law is no shield against POCSO." } }];
const LISTEN_FACTS = [{ id: "c", title: "Exercise Varuna begins", explain: { what: "India and France hold the naval drill." } }];
function fakeSpeech(voices) {
  const out = { spoken: [], current: null };
  global.SpeechSynthesisUtterance = function (text) { this.text = text; };
  global.speechSynthesis = { speak: (u) => { if (u.text) { out.spoken.push(u); out.current = u; } }, cancel: () => { out.current = null; }, getVoices: () => voices };
  return out;
}
const unspeech = () => { C.listen.stop(); delete global.speechSynthesis; delete global.SpeechSynthesisUtterance; delete global.Audio; };

test("listen: each story's lines; a story or a line can be picked; pause, next and stop", async () => {
  memStore();
  const T = fakeSpeech([{ lang: "en-US", name: "US" }, { lang: "en-IN", name: "India" }, { lang: "en-IN", name: "Microsoft Neerja Online (Natural)" }, { lang: "hi-IN", name: "Hindi" }]);
  try {
    const items = C.listenItems(LISTEN_CARDS, LISTEN_FACTS);
    assert.strictEqual(items.length, 3);
    assert.deepStrictEqual(items[0].lines, ["Cabinet approves ECLGS 5.0", "The scheme gives rupees 2 lakh crore of guaranteed credit.", "It runs until March 2027."]);
    assert.deepStrictEqual([items[1].kind, items[2].kind], ["must", "fact"]);
    C.listen.setLang("en"); C.listen.setVoice("");
    assert.ok(C.listen.supported && C.listen.play(items));
    await flush();
    assert.strictEqual(T.spoken[0].text, "Story 1: Cabinet approves ECLGS 5.0");
    assert.strictEqual(T.spoken[0].voice.name, "Microsoft Neerja Online (Natural)", "the most natural Indian English voice");
    T.current.onend(); await flush();
    assert.strictEqual(C.listen.state().l, 1); assert.ok(T.spoken.at(-1).text.startsWith("The scheme gives rupees 2 lakh crore"));
    C.listen.from(2); await flush();  // a tapped line
    assert.strictEqual(T.spoken.at(-1).text, "It runs until March 2027."); assert.strictEqual(C.listen.state().l, 2);
    C.listen.pick(2); await flush();  // a tapped story
    assert.strictEqual(T.spoken.at(-1).text, "Prelims fact 1: Exercise Varuna begins");
    C.listen.toggle(); assert.ok(C.listen.state().paused);
    const n = T.spoken.length; C.listen.toggle(); assert.ok(!C.listen.state().paused && T.spoken.length === n + 1 && T.spoken.at(-1).text === T.spoken.at(-2).text, "play restarts the sentence");
    const stale = T.spoken.at(-2); const before = T.spoken.length; stale.onend(); assert.strictEqual(T.spoken.length, before, "a cancelled sentence's end is ignored");
    C.listen.prev(); await flush(); assert.strictEqual(C.listen.state().i, 1, "prev at a story's start: the story before");
    C.listen.next(); await flush(); assert.strictEqual(C.listen.state().i, 2);
    T.current.onend(); await flush(); T.current.onend(); await flush();
    assert.ok(!C.listen.state().on, "the last line ends the brief");
  } finally { unspeech(); }
});

test("listen: Hindi as Hinglish from Intel AI, kept on the device, read in a Hindi voice", async () => {
  const mem = memStore({ "upsc-gemini-key": "AIzaSyTESTKEY-0123456789abcdef", "upsc-gemini-models": JSON.stringify(["gemini-2.5-flash"]) });
  const T = fakeSpeech([{ lang: "en-IN", name: "India" }, { lang: "hi-IN", name: "Lekha" }, { lang: "hi-IN", name: "Google हिन्दी" }]);
  const prev = global.fetch; const sent = [];
  global.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), body: JSON.parse(init.body || "{}") });
    const n = ((JSON.parse(init.body).contents[0].parts[0].text).match(/^\d+\./gm) || []).length;
    const lines = Array.from({ length: n }, (_, k) => `${k + 1}. सरकार ने ECLGS 5.0 को मंज़ूरी दी, लाइन ${k + 1}`);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lines }) }] } }] }) };
  };
  try {
    const items = C.listenItems(LISTEN_CARDS, LISTEN_FACTS);
    C.listen.setLang("hi"); C.listen.setVoice("");  // with Intel AI on, Hinglish would default to its voice: this test takes the device's
    C.listen.setVoice("dev:");
    assert.ok(C.listen.play(items));
    await flush();
    const ask = sent[0];
    assert.ok(ask.url.includes("gemini-2.5-flash:generateContent") && ask.body.systemInstruction.parts[0].text.includes("Hinglish"));
    assert.ok(ask.body.contents[0].parts[0].text.startsWith("1. Cabinet approves ECLGS 5.0\n2. The scheme gives rupees"));
    assert.strictEqual(T.spoken[0].text, "ख़बर 1: सरकार ने ECLGS 5.0 को मंज़ूरी दी, लाइन 1");
    assert.strictEqual(T.spoken[0].voice.name, "Google हिन्दी", "the natural (Google) Hindi voice first");
    assert.strictEqual(JSON.parse(mem["upsc-hinglish"]).a.by, "ai");
    assert.ok(sent.some((x) => x.body.contents[0].parts[0].text.includes("Delhi HC on POCSO")), "the next story is translated ahead");
    C.listen.stop(); const k = sent.length; C.listen.play(items); await flush();
    assert.strictEqual(sent.length, k, "a translated story isn't asked again");
    C.listen.setLang("en"); await flush();
    assert.strictEqual(T.spoken.at(-1).text, "Story 1: Cabinet approves ECLGS 5.0", "English again, from the same line");
  } finally { global.fetch = prev; unspeech(); }
});

test("listen: no Hindi voice on the device says how to get one", async () => {
  memStore();
  const T = fakeSpeech([{ lang: "en-IN", name: "India" }]);
  const prev = global.fetch;
  global.fetch = async (url) => ({ ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: `हिंदी: ${decodeURIComponent(String(url).split("q=")[1].split("&")[0])}` } }) });
  try {
    C.listen.setLang("hi"); C.listen.setVoice("");
    C.listen.play(C.listenItems(LISTEN_CARDS)); await flush();
    const st = C.listen.state();
    assert.ok(st.paused && /no Hindi voice/.test(st.note) && !T.spoken.length, JSON.stringify(st));
  } finally { global.fetch = prev; C.listen.setLang("en"); unspeech(); }
});

test("listen: ✦ Intel AI's natural voice records each story; the line follows the clip; a used-up quota hands over to the device", async () => {
  memStore({ "upsc-gemini-key": "AIzaSyTESTKEY-0123456789abcdef", "upsc-gemini-models": JSON.stringify(["gemini-2.5-flash"]) });
  const T = fakeSpeech([{ lang: "en-IN", name: "India" }]);
  class FakeAudio { constructor() { this.src = ""; this.currentTime = 0; this.duration = 0; this.playing = false; FakeAudio.all.push(this); } play() { this.playing = true; return Promise.resolve(); } pause() { this.playing = false; } }
  FakeAudio.all = []; global.Audio = FakeAudio;
  const prev = global.fetch; const tts = []; let quota = false;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/models?")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-pro-preview-tts", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] }] }) };
    const body = JSON.parse(init.body); tts.push({ u, body });
    if (quota) return { ok: false, status: 429, text: async () => "", clone() { return this; }, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.alloc(4800).toString("base64") } }] } }] }) };
  };
  try {
    const items = C.listenItems(LISTEN_CARDS, LISTEN_FACTS);
    C.listen.setLang("en"); C.listen.setVoice("ai:Charon");
    C.listen.play(items); await flush(12);
    const first = tts[0];
    assert.ok(first.u.includes("gemini-2.5-flash-preview-tts:generateContent"), "Flash's voice first: " + first.u);
    assert.deepStrictEqual(first.body.generationConfig.responseModalities, ["AUDIO"]);
    assert.strictEqual(first.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Charon");
    assert.ok(first.body.contents[0].parts[0].text.includes("Story 1: Cabinet approves ECLGS 5.0\nThe scheme gives rupees"));
    const a = FakeAudio.all.at(-1);
    assert.ok(a.playing && a.src.startsWith("blob:") && C.listen.state().mode === "ai");
    const wav = await require("buffer").resolveObjectURL(a.src).arrayBuffer();
    assert.strictEqual(Buffer.from(wav).subarray(0, 4).toString(), "RIFF"); assert.strictEqual(wav.byteLength, 44 + 4800);
    a.duration = 10; a.currentTime = 9; a.ontimeupdate();
    assert.strictEqual(C.listen.state().l, 2, "the lit line follows the clip");
    const n = tts.length; C.listen.from(1); await flush(); a.duration = 10; a.onloadedmetadata();
    assert.ok(a.currentTime > 2 && a.currentTime < 9 && tts.length === n, `a tapped line seeks into the same clip (${a.currentTime})`);
    C.listen.toggle(); assert.ok(!a.playing && C.listen.state().paused); C.listen.toggle(); assert.ok(a.playing);
    quota = true; C.listen.pick(2); await flush(12);  // the voice's free quota runs out: the device's voice goes on
    const st = C.listen.state();
    assert.ok(st.mode === "dev" && /isn't available/.test(st.note) && T.spoken.at(-1).text === "Prelims fact 1: Exercise Varuna begins", JSON.stringify(st));
  } finally { global.fetch = prev; unspeech(); }
});

test("glossary: each term's first mention is a button; acronyms keep their capitals; text stays escaped", () => {
  const G = C.gloss;
  G.set({});
  assert.strictEqual(G.html("A <b>bold</b> & plain line"), "A &lt;b&gt;bold&lt;/b&gt; &amp; plain line", "no glossary: plain escaped text");
  G.set({ a: { t: "Article 142", m: "Lets the Supreme Court do complete justice." }, b: { t: "SIR", m: "Special Intensive Revision of electoral rolls." },
    c: { t: "repo rate", m: "The rate at which the RBI lends to banks." }, d: { t: "CEPA", m: "Comprehensive Economic Partnership Agreement." },
    e: { t: "Article 14", m: "Equality before law." } });
  assert.strictEqual(G.size, 5);
  const seen = new Set();
  const a = G.html("The court used Article 142 & the <SIR>; sir, the Repo Rate and the repo rate. Article 14 too.", seen);
  assert.ok(a.includes('<button type="button" class="gl" data-gl="article 142"') && a.includes(">Article 142</button>"), a);
  assert.ok(a.includes("&amp; the &lt;<button") && a.includes(">SIR</button>&gt;"), "the text around a term stays escaped");
  assert.strictEqual((a.match(/data-gl="sir"/g) || []).length, 1, "an acronym: its own capitals only ('sir' stays plain)");
  assert.ok(a.includes('data-gl="repo rate"') && a.includes(">Repo Rate</button>") && (a.match(/data-gl="repo rate"/g) || []).length === 1, "a common term: any case, once");
  assert.ok(a.includes('data-gl="article 14"') && !a.includes("Article 14</button>2"), "Article 14 is not the start of Article 142");
  const b = G.html("CEPA, SIR and Article 142 again.", seen);
  assert.ok(b.includes('data-gl="cepa"') && !b.includes('data-gl="sir"') && !b.includes('data-gl="article 142"'), "once per story across its blocks");
  assert.strictEqual(G.meaning("cepa").t, "CEPA");
  G.set({});
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed += 1; console.log(`not ok - ${name}\n  ${e.stack.split("\n").slice(0, 3).join("\n  ")}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();

/* Tests for upsc_intel/web/static/intel-core.js (the Ask bot's engine). Plain Node, no packages:
   node tests/js/intel_core.test.js. The web is stubbed: fetch returns the reader's JSON for canned pages. */
"use strict";
const assert = require("assert");
const path = require("path");

global.window = globalThis;
const PAGES = {};  // url → markdown the stubbed reader returns
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
    return { ok: true, json: async () => ({ pages: [
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

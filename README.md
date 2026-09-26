# UPSC Intel: live current-affairs dashboard

A self-updating website that reads **~140 sources** every 15 minutes and turns hundreds of
stories a day into a short **Daily Brief** you can actually finish. The sources include:
- PIB, RBI, SEBI, PRS and NITI
- The Hindu, Indian Express, Mint, BS, ET, HT and more
- 13 opinion pages and 7 explainer desks
- coaching desks (IE UPSC, Insights, ForumIAS, Drishti…)
- a 42-query Google News watchlist

For each day it picks about 25 must-know stories, 15 editorials and 12 explainers, balanced across the syllabus. Each one comes with:
- a UPSC-style explainer
- the closest-matching YouTube video

Week and Month views recap everything the daily briefs covered.

![Daily Brief](docs/dashboard-day.png)

| Editorials (by GS paper) | Explained |
|---|---|
| ![Editorials](docs/dashboard-editorials.png) | ![Explained](docs/dashboard-explained.png) |

| Week in review | Phone |
|---|---|
| ![Week](docs/dashboard-week.png) | ![Mobile](docs/dashboard-mobile.png) |

## What you get

- **Daily Brief (the default view).** Every must-know story of the day, with no fixed number, picked from the 400–600 reported. A busy day (a summit, a Parliament session) has a long brief and a quiet day a short one.
  - **Must-know bar:**
    - Each story gets a brief score. That's its grade, lifted when the headline reports an examinable development (a Bill passed, an Act in force, a Cabinet approval, a pact signed, a named exercise, a species found, a GI tag, an index rank…) and lowered for reactions and commentary (says, slams, "Who is…", "Watch:", LIVE).
    - The rules live in `config/topics.yaml` → `brief`, next to the other rules.
  - **Two tiers:**
    - Stories clearly above the bar are full cards with the write-up, video and notes.
    - Those just below it are one-line entries under **Also in the news**. Tap a line for its summary and sources.
    - Typical day: 20–60 cards plus 15–70 lines.
  - **Nothing thin on a quiet day:** a light day is topped up to 20 cards and 40 stories in all. Every syllabus area also gets its best story.
  - **Same event, one card:** reports of the same event from different outlets, which clustering kept apart, fold into one card. They're listed on it as "Also reported".
  - **Editorials and explainers:** every SKIM-or-better piece, topped up to 15 editorials and 12 explainers.
  - **Measured, not guessed:** four days were hand-labelled for must-know events, one of them blind. The brief caught 87–95% of them. The old fixed 25-story brief caught 35–73%, and dropped the most on the busiest days.
  - **The rest:** everything graded NOTE, SKIM or READ stays in **Everything**. Each card there says whether it made the brief and in which tier.
  - **What's left out:**
    - another country's internal politics with no India link (e.g. Sri Lanka's constitutional amendments): rejected as not UPSC material
    - crime and celebrity stories
    - political spats
    - results notices, quizzes, routine Treasury-bill auctions and coaching "daily current affairs" roundups
    - regulators' case-by-case paperwork (SEBI settlement orders, recovery certificates), tenders, and department housekeeping (memento e-auctions, cleanliness drives)
  - **Each piece appears once:** exam-prep sites often repost an op-ed or explainer under its original headline. Such a copy joins the original, so the brief doesn't carry the same article twice.
  - **Days follow IST (India time).** The site always opens on today. Just after midnight the new day is nearly empty and says so, with a link to yesterday's brief. The header shows the last update's time in IST.
  - **Permanent archive:** three days after a month ends, its Briefs and stories are frozen as the site showed them and saved to the repository's `archive` branch. Every build publishes all archived months, so any past date stays one calendar tap away. The working database keeps only the last 45 days (`UPSC_KEEP_DAYS` in the workflow), so updates stay fast. Only public content is archived.
  - **Calendar:** tap the date in the header to pick any day. Days with news have a dot. Month and year menus jump anywhere at once, and the keyboard works too (arrows, Enter, Esc).
  - **Everything tab:** a story appears on every day it's in the news, but joins the brief once, on the day it was first reported. Every card says **"✓ In 26 Sep brief"** or why it isn't in the brief.
- **A write-up on every brief story,** in the format coaching notes use:
  - **Why in news** · **What happened** · **When** · **Where** · **Who** · **Background** · **Why it matters** · **Prelims facts** · **Mains question** · **Keywords**
  - **Without a key (the default)**, the write-up is built from what *all* the outlets covering the story published, with repeated lines dropped:
    - When, Where and Who list only the dates, places, people and bodies that appear in that text (e.g. "Amit Shah (Home Minister), Ministry of Home Affairs"). Nothing is made up.
    - A story that only headline-only feeds carried gets a short write-up.
  - With an Anthropic API key, Claude writes full notes from the fetched text, and never invents news facts.
- **Up to two YouTube videos per story, one ▶ English and one ▶ हिंदी:**
  1. **The library comes first:** 23 channels' feeds.
     - English: Sansad TV, PIB, DD India, The Hindu, Indian Express, WION, Drishti English, StudyIQ English, Vajiram & Ravi, NEXT IAS, PW OnlyIAS, Vision IAS, Sleepy Classes, ClearIAS, Prep together
     - Hindi: DD News, Drishti IAS, StudyIQ IAS, NEXT IAS Hindi, UPSC Wallah, Sanskriti IAS, Dhyeya TV, Khan Global Studies
  2. **Then YouTube search:** the story's key terms, then the same terms plus "UPSC" (accepted from UPSC channels only), then the terms plus "UPSC Hindi".
  3. **Hindi or English only.** Anything else is rejected:
     - other scripts (Tamil, Telugu, Malayalam, Bengali and so on)
     - titles that say "in Malayalam" and similar
     - channels named after another language or a state, e.g. "Mission IAS Malayalam", "News18 Bangla", "DD NEWS Telangana"
  4. **What counts as a match:**
     - Words are weighted by rarity, so "AFSPA" or "Cybercrime" count far more than "minister" or "art".
     - The video has to be from the story's week.
     - Channels outside the UPSC, official and national-news lists must match much more strongly.
     - Shorts, vlogs, quizzes, admissions and stock-tip videos are rejected.
  5. **When nothing is confident enough,** the card shows a **Find video** search button instead of a wrong link.
- **Editorials of the day (about 15):**
  - **Sources:**
    - The Hindu (Editorial, Lead, Op-Ed, Columns)
    - Indian Express (Editorials, Columns, Opinion)
    - HT (Editorials, Opinion, HT Insight)
    - ET (Editorial, Opinion)
    - Mint, BusinessLine, Business Standard, Financial Express, Deccan Herald, ThePrint, The Tribune and EPW
    - Insights' UPSC Editorial Analysis
  - **How they're ranked:** by syllabus relevance, with no paper taking more than a third of the day. The Editorials tab groups them by GS paper.
  - **Also caught:** opinion pieces that arrive through news feeds are recognised from their URL (`/opinion/`, `/editorials/`, `/columns/`).
- **Explained (about 12 a day), in its own section and tab:**
  - **Sources:**
    - Indian Express Explained, Expert Explains and Knowledge Nugget
    - The Hindu's "… | Explained"
    - Mint Explainer, ThePrint Essential, Deccan Herald Explained
    - News18 and Firstpost explainers
  - **Also caught:** question headlines ("What is …?", "Why has …?") from quality outlets.
  - **Kept separate from news:** explainers never merge into a news card, so the news story and the deep dive both show up.
- **Headline-only feeds get real text:** every Indian Express feed ships headlines only. For each new item the fetcher reads the article's public preview text (`og:description`, what link previews show), so the explainer card says what the piece is about.
- **Videos tab:**
  - matched explainers for the brief stories
  - the day's analysis videos: news analysis, PIB summaries, Sansad TV programmes
- **Week in review / Month in review:**
  - "N stories covered"
  - a *What we covered* strip by subject, with gaps flagged
  - the brief-per-day chart
  - Top 10 / Top 15
  - everything the daily briefs covered, grouped by subject and dated
- **Progress tracking:** tick **Mark done** on each card, and the bar at the top shows how much of the day's brief you've finished. Stars and notes build your revision list.
- **Everything tab:** the full graded firehose, with:
  - filters (paper, subject, grade, source type)
  - the syllabus-coverage radar
  - the easy-miss watch (marine/EEZ, DPI, neighbourhood politics, appointments, defence-tech deals)
  - LOW-grade items, hidden but never deleted
- **Live updates:** a "🔴 N new stories" button appears when a fetch lands.
- **Refresh button:**
  - **Local / Docker:** fetches *every* source right now (1–3 min) and reports "Done · N new stories".
  - **Pages site:** checks for a newer build and loads it, or tells you when the last update ran and when the next one is due. GitHub starts scheduled runs on a best-effort basis; if a build is more than 15 min overdue, the header says "running late" and Refresh says so instead of promising a time.
- **Self-healing sources:** every source has a fallback chain (direct feed → alternate URL → Google News `site:` → headless browser). The **Sources** tab shows what each source is using right now.
- **Keyboard:** `/` search · `t` today · `d w m` views · `← →` step · Export any view to Markdown notes.

## Quick start (full version, on your laptop)

```bash
git clone <this repo> && cd UPSC
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium        # optional: enables the headless-browser fallback
cp .env.example .env                         # optional: premium email, AI key
python -m upsc_intel serve                   # → http://127.0.0.1:8000
```

The first fetch starts within seconds and takes about 1–2 minutes. After that the server refreshes every 15 minutes, as long as it keeps running.

To open it from your phone, run it on a home PC or VPS with `UPSC_HOST=0.0.0.0` behind [Tailscale](https://tailscale.com), or use Docker (below).

## Three ways to host it

| | What you get | Premium sources |
|---|---|---|
| **Local** `python -m upsc_intel serve` | Full app, live every 15 min, stars and notes saved in SQLite | ✅ |
| **Docker** `docker compose up -d` | The same, always on (VPS, home server, NAS). Data kept in `./data`, PDFs in `./inbox` | ✅ |
| **GitHub Pages** (`.github/workflows/pages.yml`) | Free public URL, rebuilt **every 20 minutes** by GitHub Actions. Stars and notes are saved per browser | ❌ public sources only |

**Turning on the GitHub Pages site takes 2 clicks:**
1. Merge this branch into `main`. Scheduled workflows only run on the default branch.
2. Go to **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then open **Actions → "Live dashboard (GitHub Pages)" → Run workflow** once.

The site will be at `https://<user>.github.io/<repo>/` (the path is case-sensitive) and refreshes every 20 minutes after that.

- **Private repos:** Pages needs a paid GitHub plan.
- **What each run fetches:** only the sources that are due. Most are every 15 minutes; Google News queries are hourly. The database, with each source's last-fetch time, is carried between runs in the Actions cache, and older caches are deleted.
- **Minutes:** each run takes about 2–4 Actions minutes. That's free for public repos. On a private repo on the free plan (2,000 min/month), change the cron to every 2–3 hours and set `UPSC_SITE_REFRESH_MIN` to match.
- **Inactivity:** GitHub pauses scheduled workflows in a public repo after 60 days without a commit. If that happens, re-enable the workflow in the **Actions** tab.
- **The update timer (`keepalive.yml`):** GitHub's cron is best-effort. On this repository it took hours to start, it can skip or delay runs, and GitHub switches it off after 60 days without a commit. So a watchdog workflow, **Update timer**, makes sure updates keep coming:
  - Every 5 minutes it looks at the latest site build. If none started in the last ~21 minutes and none is running, it starts one.
  - While GitHub's schedule works, it starts nothing.
  - One watchdog run lasts about 5 hours, then hands over to the next. Every build restarts it if it isn't running.
  - To stop it: **Actions → Update timer → ⋯ → Disable workflow**.

## Plugging in your premium accounts

The dashboard links out to the original article. When you click a story, it opens in **your own logged-in browser**, so your subscription handles the paywall. The paid content itself comes in through the channels your subscriptions already deliver:

1. **Newsletters and e-paper emails (IMAP).**
   1. In Gmail, turn on 2-step verification.
   2. Create an [App Password](https://myaccount.google.com/apppasswords).
   3. Make a label called `UPSC`, and a filter that puts every newsletter under it: The Hindu, IE UPSC Essentials, Mint, BS, your coaching emails.
   4. Set `IMAP_*` in `.env`.

   Each email becomes a card, and every headline link inside it becomes its own story. E-paper download links are pinned as "Today's e-paper". The mailbox is opened **read-only**.
2. **PDFs you download** (Vision IAS / Drishti / ForumIAS monthly magazines, e-paper PDFs, class notes). Drop them into `inbox/`. Every page is indexed, GS-tagged and searchable in the **Library** tab, and links straight back to that page of the PDF.
3. **Telegram, YouTube and private feeds.**
   1. Copy `config/sources.local.example.yaml` to `config/sources.local.yaml`.
   2. Add public Telegram channels (`kind: telegram`), YouTube channels (`kind: youtube`), paid Substack private feeds, and Inoreader/Feedly output feeds.
   3. For sites with no feed, use any RSSHub route; `docker compose --profile rsshub up -d` runs RSSHub for you.

Premium, email and library content **never** goes to the public Pages site.

> What this deliberately doesn't do: crack paywalls, log in to paid sites with bots, or dodge anti-bot systems. That breaks the sites' access controls, it breaks every few weeks, and it gets paid accounts banned. The routes above get the same coverage without any of that.

## How it works

```
config/sources.yaml ─► fetchers (rss · youtube · gnews · pib · telegram · html · browser · imap · documents)
                          │ fallback chain per source, retries, per-host limits, per-source intervals
                          │ + preview text for headline-only feeds
                          ▼
                       normalise  (canonical URL, IST date, clean title)
                          ▼
                       kind       (news · editorial · explained: source flag, headline, URL)
                          ▼
                       classify   (config/topics.yaml: 18 subjects → GS1–4, Prelims tags, watch areas,
                          ▼         India angle, grade)
                       cluster    (same story across outlets → one card, within its kind; "N outlets" = importance)
                          ▼
                       brief      (per day: coverage pass + importance fill · editorials · explainers)
                          ▼
                       videos     (trusted-channel library → YouTube search, IDF-weighted matching)
                          ▼
                       explain    (Claude explainer, or the auto-summary without a key)
                          ▼
                       SQLite + full-text search ─► FastAPI JSON API ─► dashboard (plain HTML/JS, no build)
                                                 └► static export (JSON per month) ─► GitHub Pages
```

- **PIB:** the RSS feed forces Hindi, so the fetcher reads the English release list (`allRel.aspx`) plus each new release's full text, with the exact "Posted On" time.
- **Grades:** each story's score combines:
  - how official or exam-focused the source is
  - high-yield words (Act, notified, judgment, index, MoU, appointed…)
  - how strongly it matches a syllabus subject
  - Prelims tags
  - how many outlets carried it

  The score is then pushed down by:
  - noise words (crime, celebrity, market ticks, party spats, ceremonies, results notices, quizzes, SEBI case orders, tenders)
  - content farms and notice-only portals (`low_value_publishers`): −3 on their own items, so they never lead alone
  - foreign news with no India link: −1.5, or −1 for the neighbourhood. Editorials, explainers, official and exam-prep sources are exempt.
  - another country's internal affairs: its polity, governance and security score counts as International Relations

- **Auto-reject:** some things are not UPSC material in any subject, so they are forced to LOW. LOW never reaches the site, however many outlets carry the story. The rules live in `config/topics.yaml`:
  - `noise_patterns`: about 60 headline patterns covering
    - sports results and congratulations
    - party politics
    - weather alerts and school closures
    - jobs, admit cards and results
    - market and stock chatter
    - corporate PR
    - local civic works
    - train services, crime and accidents
    - coaching digests, PDFs and quizzes
    - live-blog furniture
  - `blocked_publishers`: stock-filing bots, press-release wires, foreign local TV, video links
  - a foreign country's local news: one country named, no India link and no world-affairs angle. A Sri Lankan constitutional amendment, a Nepali citizenship bill, a US governor's race, a Tanzanian court case.
  - no syllabus subject at all
  - headlines in scripts other than English or Hindi
  - old material republished (a date in the headline over 20 days old)
  - if most copies of a story are rejected, the whole story is: one copy that slips past the rules can't bring it back. A single rejected copy next to a good one (a wire reprint on a blocked site) doesn't sink the story.

  Measured against 1,519 hand-labelled live stories: 95% of the irrelevant ones are rejected, and 0.7% of the relevant ones are lost. Those are borderline cases, like a UN News item on a foreign conflict.

  NOTE ≥ 5.5, SKIM ≥ 3.2, READ ≥ 1.6, otherwise LOW.
- **Tuning:** edit `config/topics.yaml` (keywords, weights, noise, watchlist queries), then run `python -m upsc_intel reclassify`.

## Command line

```bash
python -m upsc_intel serve [--port 8000] [--no-scheduler] [--public-only]
python -m upsc_intel fetch [--only pib hindu-] [--force] [--public-only] [--enrich]
python -m upsc_intel sources            # health table: which step each source is using, counts, errors
python -m upsc_intel reclassify         # re-tag everything after editing config/topics.yaml or sources.yaml
python -m upsc_intel enrich [--limit N] # AI explainers for the brief (needs ANTHROPIC_API_KEY)
python -m upsc_intel export-static --out site [--days 62]
python -m pytest                        # 148 tests
```

## AI explainers (recommended)

Set `ANTHROPIC_API_KEY` in `.env`. On GitHub, set it as an Actions secret instead.

- **What runs:** after each fetch, every full brief card, explainer and editorial of the last two days gets a full explainer, up to `UPSC_AI_MAX_PER_RUN` (default 40). Each story is written once and cached.
- **Contents:** headline, why in news, what happened, background, why it matters, Prelims facts, a Mains question, keywords, and a tailored YouTube search query. The query is used to find a better video on the next run.
- **Model:** `claude-opus-5` at low effort by default; `UPSC_AI_MODEL` switches it. Server-side refusal fallback is enabled, so a declined story is answered by another model instead of being dropped.
- **Cost:** the day's full cards plus editorials and explainers, roughly 50–90 stories on a typical day, with a few thousand tokens each. That's around one to three dollars a day on the default model. `UPSC_AI_MAX_PER_RUN` caps each run, and a smaller model costs less.
- **Accuracy rules:**
  - News facts come only from the fetched text.
  - The Background line may use well-established static knowledge (what an institution or Article is), and is left empty when unsure.
  - Thin text is flagged as insufficient instead of guessed.

## Tuning

| Setting | Default | What it does |
|---|---|---|
| `UPSC_SITE_REFRESH_MIN` | 60 (20 in the Pages workflow) | minutes between static-site rebuilds, shown on the page |
| `UPSC_VIDEO_LANG` | `en,hi` | `en` = English only · `any` = every language |
| `UPSC_VIDEO_SEARCH` | on | `0` = only the trusted-channel library, no YouTube search |
| `YOUTUBE_API_KEY` | — | use the official YouTube Data API for searches |
| `config/topics.yaml` | — | keywords, noise list, India-angle terms, watchlist queries (then `python -m upsc_intel reclassify`) |

## Project layout

```
config/            sources.yaml · topics.yaml · sources.local.example.yaml
upsc_intel/
  fetchers/        rss, gnews, pib, telegram, html_links (html + browser), email_imap, documents, http,
                   describe (preview text for headline-only feeds), fallback chain
  pipeline/        normalize, kinds (news/editorial/explained), classify, cluster, brief (daily picks),
                   enrich (explainers), videos (matching), run
  web/             app.py (API + scheduler) · static/ (index.html, app.js, styles.css)
  static_export.py
tests/             parsers, classifier, clustering, brief selection, explainers, video matching, fallback chain, API, export
inbox/             your PDFs (gitignored)
data/              SQLite database (gitignored)
```

# UPSC Intel: live current-affairs dashboard

A self-updating website that reads **~110 sources** every 15 minutes and turns hundreds of
stories a day into a short **Daily Brief** you can actually finish. The sources include:
- PIB, RBI, SEBI, PRS and NITI
- The Hindu, Indian Express, Mint, BS, ET, HT and more
- coaching desks (IE UPSC, Insights, ForumIAS, Drishti…)
- a 42-query Google News watchlist

For each day it picks about 25 must-know stories and 8 editorials, balanced across the syllabus. Each one comes with:
- a UPSC-style explainer
- the closest-matching YouTube video

Week and Month views recap everything the daily briefs covered.

![Daily Brief](docs/dashboard-day.png)

| Week in review | Phone |
|---|---|
| ![Week](docs/dashboard-week.png) | ![Mobile](docs/dashboard-mobile.png) |

## What you get

- **Daily Brief (the default view).**
  - About 25 must-know stories, picked from the 400–600 reported each day.
  - **A coverage pass first:** the best story from every syllabus subject, so no area is skipped.
  - **Then the rest by importance,** with max 4 per subject. Importance combines grade, source weight and how many outlets covered it.
  - **What's left out:**
    - foreign news with no India link
    - crime and celebrity stories
    - political spats
    - results notices and quizzes
- **An explainer on every brief story,** in the format coaching notes use:
  - **Why in news** · **What happened** · **Background** · **Why it matters** · **Prelims facts** · **Mains question** · **Keywords**
  - With an Anthropic API key, Claude writes these from the fetched text, and never invents news facts.
  - Without a key you get a shorter auto-summary built from the feed text.
- **The most relevant YouTube video per story:**
  1. It first matches against a library of trusted channels (Sansad TV, PIB, DD News, The Hindu, Indian Express, Drishti, StudyIQ, ClearIAS, Prep together).
  2. Then it searches YouTube.
  3. **What counts as a match:** words are weighted by rarity, so "AFSPA" or "Cybercrime" count far more than "minister" or "art". The video also has to be from the story's week. Travel vlogs, quiz videos and other-language uploads are rejected.
  4. **When nothing is confident enough,** the card shows a **Find video** search button instead of a wrong link.
- **Editorials of the day:** The Hindu (Editorial, Lead, Op-Ed), Indian Express (Editorials, Columns) and Mint Opinion. Each has its core argument, GS paper and a Mains question.
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
| **GitHub Pages** (`.github/workflows/pages.yml`) | Free public URL, rebuilt **hourly** by GitHub Actions. Stars and notes are saved per browser | ❌ public sources only |

**Turning on the GitHub Pages site takes 2 clicks:**
1. Merge this branch into `main`. Scheduled workflows only run on the default branch.
2. Go to **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then open **Actions → "Live dashboard (GitHub Pages)" → Run workflow** once.

The site will be at `https://<user>.github.io/<repo>/` and refreshes every hour after that.

- **Private repos:** Pages needs a paid GitHub plan.
- **Minutes:** hourly runs use about 2–3 Actions minutes each. That's free for public repos, but on a private repo on the free plan (2,000 min/month) it gets tight. Change the cron to every 2–3 hours if that matters.

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
                          ▼
                       normalise  (canonical URL, IST date, clean title)
                          ▼
                       classify   (config/topics.yaml: 18 subjects → GS1–4, Prelims tags, watch areas,
                          ▼         India angle, grade)
                       cluster    (same story across outlets → one card; "N outlets" = importance)
                          ▼
                       brief      (per day: coverage pass + importance fill, editorials)
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
  - noise (crime, celebrity, cricket, market ticks, party spats, PIB ceremonies, results notices, quizzes)
  - foreign stories with no India link (global institutions and the neighbourhood are exempt)

  NOTE ≥ 5, SKIM ≥ 3.2, READ ≥ 1.6, otherwise LOW.
- **Tuning:** edit `config/topics.yaml` (keywords, weights, noise, watchlist queries), then run `python -m upsc_intel reclassify`.

## Command line

```bash
python -m upsc_intel serve [--port 8000] [--no-scheduler] [--public-only]
python -m upsc_intel fetch [--only pib hindu-] [--force] [--public-only] [--enrich]
python -m upsc_intel sources            # health table: which step each source is using, counts, errors
python -m upsc_intel reclassify         # re-tag everything after editing config/topics.yaml
python -m upsc_intel enrich [--limit N] # AI explainers for the brief (needs ANTHROPIC_API_KEY)
python -m upsc_intel export-static --out site [--days 62]
python -m pytest                        # 56 tests
```

## AI explainers (recommended)

Set `ANTHROPIC_API_KEY` in `.env`. On GitHub, set it as an Actions secret instead.

- **What runs:** after each fetch, every brief story and editorial of the last two days gets a full explainer, up to `UPSC_AI_MAX_PER_RUN` (default 40). Each story is written once and cached.
- **Contents:** headline, why in news, what happened, background, why it matters, Prelims facts, a Mains question, keywords, and a tailored YouTube search query. The query is used to find a better video on the next run.
- **Model:** `claude-opus-5` at low effort by default; `UPSC_AI_MODEL` switches it. Server-side refusal fallback is enabled, so a declined story is answered by another model instead of being dropped.
- **Cost:** roughly 30–35 stories a day with a few thousand tokens each. That's around a dollar a day on the default model; a smaller model costs less.
- **Accuracy rules:**
  - News facts come only from the fetched text.
  - The Background line may use well-established static knowledge (what an institution or Article is), and is left empty when unsure.
  - Thin text is flagged as insufficient instead of guessed.

## Tuning

| Setting | Default | What it does |
|---|---|---|
| `UPSC_BRIEF_SIZE` | 25 | must-know stories per day |
| `UPSC_BRIEF_EDITORIALS` | 8 | editorials per day |
| `UPSC_VIDEO_LANG` | `en` | `hi` or `any` to allow Hindi / other-language explainer videos |
| `UPSC_VIDEO_SEARCH` | on | `0` = only the trusted-channel library, no YouTube search |
| `YOUTUBE_API_KEY` | — | use the official YouTube Data API for searches |
| `config/topics.yaml` | — | keywords, noise list, India-angle terms, watchlist queries (then `python -m upsc_intel reclassify`) |

## Project layout

```
config/            sources.yaml · topics.yaml · sources.local.example.yaml
upsc_intel/
  fetchers/        rss, gnews, pib, telegram, html_links (html + browser), email_imap, documents, http, fallback chain
  pipeline/        normalize, classify, cluster, brief (daily picks), enrich (explainers), videos (matching), run
  web/             app.py (API + scheduler) · static/ (index.html, app.js, styles.css)
  static_export.py
tests/             parsers, classifier, clustering, brief selection, explainers, video matching, fallback chain, API, export
inbox/             your PDFs (gitignored)
data/              SQLite database (gitignored)
```

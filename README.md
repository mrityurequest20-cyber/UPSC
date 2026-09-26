# UPSC Intel: live current-affairs dashboard

A self-updating website that pulls **every UPSC-relevant news item** from ~110 sources, including:
- PIB, RBI, SEBI, PRS and NITI
- The Hindu, Indian Express, Mint, BS, ET, HT and more
- coaching desks (IE UPSC, Insights, ForumIAS, Drishti…)
- international wires
- Sansad TV and PIB on YouTube
- a 42-query Google News watchlist

Every item gets tagged by **GS paper, syllabus subject and Prelims type**. It is graded **NOTE / SKIM / READ**, and the same story from different outlets is merged into one card. You browse it all by **Day, Week or Month**.

Your **premium subscriptions** plug in too: newsletter/e-paper emails, PDFs you download, private feeds and Telegram/YouTube channels.

![Day view](docs/dashboard-day.png)

| Week view | Phone |
|---|---|
| ![Week](docs/dashboard-week.png) | ![Mobile](docs/dashboard-mobile.png) |

## What it does

- **Live.** The server fetches every source every 15 minutes. When new stories land, the open dashboard shows a "🔴 N new stories" button.
- **Day / Week / Month.** Step back through the archive with ‹ ›. In Week and Month view, a stories-per-day chart opens any day in one click.
- **Nothing missed.**
  - **Syllabus coverage** shows story counts per subject for the period, and flags any subject with **0** stories as a blind spot.
  - **Easy-miss watch** tracks five areas that are usually missed:
    - marine/EEZ/Blue Economy
    - Digital Public Infrastructure and data governance
    - neighbourhood political change
    - constitutional and statutory appointments
    - defence-tech agreements
  - LOW-grade items are **hidden, never deleted**. Tick "Show LOW too" to see everything.
- **Self-healing sources.** Each source has a fallback chain:
  1. direct feed
  2. alternate URL
  3. Google News `site:` query
  4. headless browser

  If a step breaks, the next one takes over within the same fetch, and after 2 bad runs it becomes the default. The original is re-tried every ~3 hours. The **Sources** tab shows what each source is using right now and why.
- **Revision tools.** You can:
  - star a story (Starred tab, across all dates)
  - mark it read
  - add notes
  - search the whole archive (Enter in the search box)
  - export any view to Markdown notes

  Keyboard: `/` search · `t` today · `d w m` views · `← →` step.
- **Optional AI notes.** Add an Anthropic API key and the top NOTE stories get:
  - a 2-line summary
  - Prelims facts
  - a Mains angle

  The notes are written only from the fetched text; if that text is too thin, the notes say so instead of guessing.

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
                       classify   (config/topics.yaml: 18 subjects → GS1–4, Prelims tags, watch areas, grade)
                          ▼
                       cluster    (same story across outlets → one card; "N outlets" = importance)
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

  The score is then pushed down by noise (crime, celebrity, cricket, market ticks, party spats, PIB ceremonies). NOTE ≥ 5, SKIM ≥ 3.2, READ ≥ 1.6, otherwise LOW.
- **Tuning:** edit `config/topics.yaml` (keywords, weights, noise, watchlist queries), then run `python -m upsc_intel reclassify`.

## Command line

```bash
python -m upsc_intel serve [--port 8000] [--no-scheduler] [--public-only]
python -m upsc_intel fetch [--only pib hindu-] [--force] [--public-only] [--enrich]
python -m upsc_intel sources            # health table: which step each source is using, counts, errors
python -m upsc_intel reclassify         # re-tag everything after editing config/topics.yaml
python -m upsc_intel enrich [--limit N] # AI notes (needs ANTHROPIC_API_KEY)
python -m upsc_intel export-static --out site [--days 62]
python -m pytest                        # 37 tests
```

## AI notes (optional)

Set `ANTHROPIC_API_KEY` in `.env`. On GitHub, set it as an Actions secret instead.

- **What runs:** each fetch cycle enriches up to `UPSC_AI_MAX_PER_RUN` (default 30) of the highest-scoring NOTE stories. Each story is done once and cached.
- **Model:** `claude-opus-5` by default (`UPSC_AI_MODEL`), at low effort.
- **Declines:** server-side refusal fallback is enabled, so if the model declines a story, another model answers instead of the story being dropped.
- **Output:** a JSON schema forces the structure: summary, Prelims facts, Mains angle, GS paper.

## Project layout

```
config/            sources.yaml · topics.yaml · sources.local.example.yaml
upsc_intel/
  fetchers/        rss, gnews, pib, telegram, html_links (html + browser), email_imap, documents, http, fallback chain
  pipeline/        normalize, classify, cluster, run, enrich
  web/             app.py (API + scheduler) · static/ (index.html, app.js, styles.css)
  static_export.py
tests/             parsers, classifier, clustering, fallback chain, API, static export
inbox/             your PDFs (gitignored)
data/              SQLite database (gitignored)
```

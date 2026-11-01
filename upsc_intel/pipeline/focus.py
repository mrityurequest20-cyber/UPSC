"""Today's focus: the day's brief cut down to what an aspirant must read, in the time they have.

The full brief keeps everything that clears the bar: the Must-know cards, the Prelims facts, the "Also in the news"
lines, the editorials and the explainers. That is often 100+ items and reads as 5-6 hours. The focus (days[d].focus
in the day's brief) ranks all of it on one scale of UPSC value and lays it out so a page can fill a reading-time
budget of 30, 60 or 90 minutes (static/intel-core.js, focusFit):

* cards: the Must-know cards, best first. Read in full. One that doesn't fit the budget becomes a one-liner at the
  top of the lines: a Must-know story is never left out (unless its headline is a routine notice).
* lines: the other news worth knowing the gist of, best first (one line each).
* facts: Prelims facts (an exercise, a scheme, a species, a pact, a place…), best first, with their own share of the
  budget so the big news of the day never crowds them out.
* eds: editorials worth reading for Mains (Gemini's 2-3, else NOTE or SKIM), one per topic.
* bg: background reads: explainers and evergreen pieces that aren't about a card's event, one per topic.
* min: {id: minutes} for the cards, editorials and background reads: the pages' own estimate of a full read
  (app/app.js minutesOf), so a budget is filled by what each piece takes.
* attach: {id: [ids]}: an explainer, editorial, fact or line about a card's event sits under that card (word rarity
  over the fortnight, as same-event reports are folded: pipeline/brief.py), and a fact's near-duplicates under it.

Everything else stays in the full brief, and the pages list it under "Everything else today". No AI call: the value
uses Gemini's grade (pipeline/triage.py) where the story has one, the rules' grade otherwise, then the headline's
examinable development (a Bill passed, a Cabinet approval, a pact signed: pipeline/classify.py's brief signals), how
widely it was reported, an official source, a syllabus topic and a running story. Reactions and commentary, routine
events (workshops, conclaves, felicitations), a state's routine administration and notices (last dates, admit cards,
redemption prices) count for less.
"""
from __future__ import annotations

import re

CARD_FLOOR = 5.0    # a Must-know card valued below this (a routine notice) isn't guaranteed a place
ATTACH_SIM = 0.15   # a related piece joins a card at this similarity (same-event folding uses 0.25)
FOLD_SIM = 0.25     # two facts this similar are one fact
FACT_MIN = 3.0      # a line below this value isn't a fact worth a slot
READ_MIN = 3.4      # an editorial or a background read below this isn't in the focus

UP_BASE = {3: 6.0, 2: 3.6, 1: 1.6, 0: 0.0}                      # Gemini's 0-3
GRADE_BASE = {"NOTE": 4.8, "SKIM": 3.2, "READ": 1.6, "LOW": 0.5}  # the rules' grade, without a verdict
SECTION_BONUS = {"news": 1.0, "prelims": 0.3}                    # where the brief put it

STATES = (r"Andhra( Pradesh)?|Arunachal( Pradesh)?|Assam|Bihar|Chhattisgarh|Goa|Gujarat|Haryana|Himachal( Pradesh)?|"
          r"Jharkhand|Karnataka|Kerala|Keralam|Madhya Pradesh|MP|Maharashtra|Manipur|Meghalaya|Mizoram|Nagaland|"
          r"Odisha|Punjab|Rajasthan|Sikkim|Tamil Nadu|TN|Telangana|Tripura|Uttar Pradesh|UP|U\.P\.|Uttarakhand|"
          r"(West )?Bengal|Delhi|J&K|Jammu and Kashmir|Ladakh|Puducherry|Chandigarh")
# a state's own routine administration: "Punjab Cabinet approves service rules…", "Gujarat expands scholarship…"
LOCAL = re.compile(rf"^(\S+\s){{0,2}}?({STATES})\b('s)?\s+(cabinet|govt|government|minister|cm|chief minister|"
                   rf"approves|introduces|rolls out|earmarks|expands|signs|sets up|proposes|announces|launches|"
                   rf"notifies|issues|forms)\b", re.I)
NOTICE = re.compile(r"\b(last date|applications? (are )?(invited|open)|admit cards?|recruitment|vacanc(y|ies)|apply online|"
                    r"registrations? (open|begin)|results? (declared|out)|answer key|exam (date|schedule)|hall tickets?|"
                    r"redemption price|premature redemption|issue price|cut-?off (price|yield)|auction results?)\b", re.I)
# an occasion rather than a development: "Regional Workshop … held", "two-day capacity-building programme", "felicitates"
ROUTINE = re.compile(r"\b(workshops?|conclave|seminar|webinar|symposium|capacity[- ]building|awareness (programme|program|campaign|drive)|"
                     r"felicitat\w*|inaugurates? (the )?\w+ (conclave|summit|conference|fair|mela|festival|exhibition)|"
                     r"review meeting|chintan shivir|outreach programme|stakeholder consultation|roadshow|walkathon|"
                     r"pays? (tribute|homage)|extends? (best )?wishes|greets|condoles|birth anniversary)\b", re.I)


def value(it: dict, section: str) -> float:
    """A story's UPSC value for the focus (higher first). it: title, grade, up (Gemini's 0-3 or None), n_pub, tier
    (the source's), syl (syllabus topics), topics (running stories), event and talk (the headline's brief signals:
    an examinable development, reaction or commentary), soft (a preview, a spat or a niche case)."""
    up = it.get("up")
    v = UP_BASE[up] if up in UP_BASE else GRADE_BASE.get(it.get("grade") or "", 1.0)
    v += SECTION_BONUS.get(section, 0.0)
    v += 0.5 * min(float(it.get("event") or 0), 3.0)  # a Bill passed, a Cabinet approval, a pact signed
    v -= 0.6 * min(float(it.get("talk") or 0), 2.0)   # reactions, commentary, question headlines
    if it.get("soft"):
        v -= 0.6
    n = max(1, min(int(it.get("n_pub") or 1), 10))
    v += 0.12 * (n - 1) ** 0.8  # widely reported (at most +0.7: PIB releases are republished everywhere)
    if it.get("tier") == "official":
        v += 0.3
    if it.get("syl"):
        v += 0.3
    if it.get("topics"):
        v += 0.3
    title = it.get("title") or ""
    if NOTICE.search(title):
        v -= 4.0
    elif LOCAL.search(title) and up != 3:
        v -= 2.0
    if ROUTINE.search(title):
        v -= 1.5
    return round(v, 2)


def minutes(it: dict, section: str) -> int:
    """A full read, as the app estimates it (app/app.js minutesOf): an editorial 6, an explainer 5, a card 3, a minute
    more for a Must-know grade and one more for a story 5+ outlets reported."""
    base = 6 if section == "editorials" else 5 if section == "explained" else 3
    return base + (it.get("grade") == "NOTE") + (int(it.get("n_pub") or 0) >= 5)


def focus_day(day: dict, items: dict[str, dict], rarity) -> dict:
    """day: the day's lists (news, prelims, more, editorials, explained); items: {id: title, tokens, grade, up, news
    (Gemini: a news event, not an evergreen piece), fact (a Prelims fact), n_pub, tier, syl, topics, event, talk,
    soft}; rarity: pipeline/brief.py's _Rarity for the day. → {cards, must, lines, facts, eds, bg, min, attach}"""
    sec: dict[str, str] = {}
    for key in ("news", "prelims", "more", "editorials", "explained"):
        for i in day.get(key) or []:
            if i in items and i not in sec:
                sec[i] = key
    val = {i: value(items[i], s) for i, s in sec.items()}
    tok = {i: set(items[i].get("tokens") or []) for i in sec}
    topics = {i: set(items[i].get("topics") or []) for i in sec}
    best = lambda ids: sorted(ids, key=lambda i: (-val[i], i))
    cards = best(i for i in sec if sec[i] == "news")

    # 1. an explainer, editorial, fact or line about a card's event goes under that card
    attach: dict[str, list[str]] = {}
    for i in sec:
        if sec[i] == "news":
            continue
        top, top_sim = None, 0.0
        for c in cards:
            s = rarity.similar(tok[i], tok[c])
            if topics[i] & topics[c]:  # the same running story
                s = max(s, ATTACH_SIM)
            if s > top_sim:
                top, top_sim = c, s
        if top is not None and top_sim >= ATTACH_SIM:
            attach.setdefault(top, []).append(i)
    attached = {i for v in attach.values() for i in v}

    # 2. lines and facts: the news among the Prelims-facts cards and the lines, best first, a Prelims fact (the
    # brief's Prelims-facts card, or one Gemini or the rules call a fact) in facts, the rest in lines; a
    # near-duplicate joins the line or fact it repeats
    evergreen = lambda i: items[i].get("news") is False
    lines: list[str] = []
    facts: list[str] = []
    for i in best(i for i in sec if sec[i] in ("prelims", "more") and i not in attached and not evergreen(i)
                  and val[i] >= FACT_MIN):
        twin = next((f for f in lines + facts if rarity.similar(tok[i], tok[f]) >= FOLD_SIM), None)
        if twin:
            attach.setdefault(twin, []).append(i)
        elif sec[i] == "prelims" or items[i].get("fact"):
            facts.append(i)
        else:
            lines.append(i)

    # 3. editorials and background reads (explainers, evergreen pieces), one per topic
    def one_per_topic(ids: list[str]) -> list[str]:
        out: list[str] = []
        for i in ids:
            twin = next((o for o in out if rarity.similar(tok[i], tok[o]) >= FOLD_SIM or topics[i] & topics[o]), None)
            if twin:
                attach.setdefault(twin, []).append(i)
            else:
                out.append(i)
        return out
    eds = one_per_topic(best(i for i in sec if sec[i] == "editorials" and i not in attached and val[i] >= READ_MIN))
    bg = one_per_topic(best(i for i in sec if i not in attached and val[i] >= READ_MIN and (
        sec[i] == "explained" or (sec[i] in ("prelims", "more") and evergreen(i)))))
    return {"cards": cards, "must": [i for i in cards if val[i] >= CARD_FLOOR], "lines": lines, "facts": facts,
            "eds": eds, "bg": bg, "min": {i: minutes(items[i], sec[i]) for i in cards + eds + bg},
            "attach": {k: best(v) for k, v in attach.items()}}

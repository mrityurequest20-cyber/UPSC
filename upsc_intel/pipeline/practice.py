"""Daily practice MCQs in the UPSC Prelims style, built from the day's brief. No AI: every answer is a line a
report carries, and every question links to it.

For each day a pool of questions (data/practice/<day>.json) from the Must-know cards, the Prelims facts, the
editorials and the explainers, using the free full article the build read (pipeline/articles.py) or the
outlets' reports:

- statements: "With reference to X, consider the following statements: 1. … 2. … Which of the statements given
  above is/are correct?" True statements are the report's own sentences; a false one is a true sentence with
  one name or figure swapped for another of the same kind (a country for a country, a state for a state, a
  body for a body, a figure for a nearby figure) that the story never mentions.
- pairs: "Consider the following pairs … How many of the above pairs are correctly matched?" (exercise and
  partner country, place in news and state) from the week's stories; wrong pairs swap in a real partner of
  another item.
- fact: a key sentence with a name blanked out, and three names of the same kind as options.
- figure: a key sentence with a figure blanked out, and nearby figures as options.
- claude: the multiple-choice questions of a Claude study note, when the notes routine wrote one.

A question is dropped rather than shipped when any check fails (a statement too short or too long, a
pronoun with nothing to refer to, a decoy the story mentions, duplicate options).
"""
from __future__ import annotations

import hashlib
import re
from datetime import date, timedelta

from .articles import FURNITURE, sentences_of, summarize

STATES = ["Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
          "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
          "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
          "Uttar Pradesh", "Uttarakhand", "West Bengal", "Jammu and Kashmir", "Ladakh", "Delhi", "Puducherry",
          "Lakshadweep", "Andaman and Nicobar Islands"]
COUNTRIES = ["Sri Lanka", "Nepal", "Bangladesh", "Pakistan", "Maldives", "Bhutan", "Myanmar", "Afghanistan", "China",
             "United States", "Russia", "Ukraine", "United Kingdom", "France", "Germany", "Italy", "Spain", "Japan",
             "South Korea", "Iran", "Israel", "Saudi Arabia", "United Arab Emirates", "Qatar", "Oman", "Egypt", "Turkey",
             "Canada", "Australia", "New Zealand", "Brazil", "Mexico", "Argentina", "South Africa", "Nigeria", "Kenya",
             "Ethiopia", "Indonesia", "Thailand", "Vietnam", "Philippines", "Malaysia", "Singapore", "Mongolia",
             "Kazakhstan", "Netherlands", "Greece", "Chile", "Peru", "Poland", "Armenia", "Mauritius", "Seychelles"]
ALIASES = {"US": "United States", "USA": "United States", "U.S.": "United States", "UK": "United Kingdom",
           "UAE": "United Arab Emirates", "Britain": "United Kingdom", "Türkiye": "Turkey"}
# bodies in groups, so a decoy is the same kind of body (a regulator for a regulator, never "ICMR passed the Bill")
BODIES = {
    "house": ["Lok Sabha", "Rajya Sabha"],
    "court": ["Supreme Court", "High Court", "NGT"],
    "regulator": ["RBI", "SEBI", "TRAI", "IRDAI", "PFRDA", "CCI", "FSSAI", "CDSCO", "UIDAI", "NPCI", "BIS", "PNGRB", "CERC"],
    "research": ["ISRO", "DRDO", "ICMR", "IMD", "INCOIS", "CSIR", "ICAR", "BARC"],
    "probe": ["CBI", "NIA", "ED", "NCB"],
    "commission": ["Election Commission", "Finance Commission", "Law Commission", "NHRC", "UPSC", "CAG", "NITI Aayog",
                   "GST Council", "NCW", "NCSC", "NCST"],
    "intl": ["United Nations", "WHO", "WTO", "IMF", "World Bank", "BRICS", "SCO", "G20", "ASEAN", "Quad", "IAEA", "UNESCO",
             "UNFCCC", "ICJ", "NATO", "OPEC", "IPCC", "GCC", "BIMSTEC", "SAARC", "OECD"],
}
KINDS = {"state": STATES, "country": COUNTRIES, **BODIES}
ENTITY_ORDER = ("exercise", "country", "state", *BODIES)

# "Mongolian troops", "the French Navy": the partner country of an exercise
DEMONYM = {"Mongolian": "Mongolia", "French": "France", "American": "United States", "Japanese": "Japan",
           "Australian": "Australia", "Russian": "Russia", "British": "United Kingdom", "Egyptian": "Egypt",
           "Maldivian": "Maldives", "Nepali": "Nepal", "Nepalese": "Nepal", "Sri Lankan": "Sri Lanka", "Thai": "Thailand",
           "Malaysian": "Malaysia", "Indonesian": "Indonesia", "Vietnamese": "Vietnam", "Omani": "Oman", "Saudi": "Saudi Arabia",
           "Kazakh": "Kazakhstan", "Bangladeshi": "Bangladesh", "Singaporean": "Singapore", "German": "Germany", "Greek": "Greece"}
# recurring exercises and their standing partner, used only when the report names none
KNOWN_PARTNER = {"yudh abhyas": "United States", "nomadic elephant": "Mongolia", "varuna": "France", "garuda": "France",
                 "shakti": "France", "dharma guardian": "Japan", "mitra shakti": "Sri Lanka", "maitree": "Thailand",
                 "ekuverin": "Maldives", "harimau shakti": "Malaysia", "cope india": "United States", "sampriti": "Bangladesh",
                 "surya kiran": "Nepal", "ajeya warrior": "United Kingdom", "kazind": "Kazakhstan", "khaan quest": "Mongolia",
                 "lamitiye": "Seychelles", "al najah": "Oman", "vajra prahar": "United States", "cyclone": "Egypt"}
PER_STORY = 2
POOL_MAX = 60
PRONOUN = re.compile(r"^(he|she|it|they|this|these|that|those|his|her|their|its|but|and|however|also|meanwhile|further|"
                     r"moreover|besides|here|there|such|so|then|while|yet|according)\b", re.I)
# first and second person (a speech, an invitation to read on), not a reported fact
VOICE = re.compile(r"\b(I|we|We|our|Our|us|my|My|you|You|your|Your)\b|\blearn more\b|\bclick\b|\bread (more|on)\b", )
WIRE = r"\((?:PTI|ANI|IANS|UNI|Reuters|AP|AFP)\)"
MONTHS = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
DATELINE = re.compile(r"^(?:(?i:news|context|aim|about|objective|details?)\s*:\s*"
                      rf"|[A-Z][A-Za-z .]{{2,30}},\s+{MONTHS}\s+\d{{1,2}}(?:,?\s+\d{{4}})?\s*(?:{WIRE})?\s*[:\-–—]?\s+"
                      rf"|[A-Z][A-Za-z .]{{2,30}}\s*{WIRE}\s*[:\-–—]?\s*"
                      r"|[A-Z][a-z]+(?: [A-Z][a-z]+)?:\s+(?=[A-Z]))")  # "Panaji: The state cabinet…"
NUM_RX = re.compile(r"(\bRs\.?\s?|₹\s?)?\b(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d,]*[a-z])"
                    r"(\s?(?:%|per ?cent|crore|lakh|million|billion|trillion|sq\.? ?km|km|MW|GW|tonnes?|hectares?|acres?|mm)(?![a-z]))?", re.I)
MONTH = re.compile(r"\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|"
                   r"nov(ember)?|dec(ember)?)\b", re.I)
EXERCISE = re.compile(r"\b(?:Exercise|Ex\.?)\s+[‘'\"“]?([A-Z][A-Za-z-]+(?:\s+[A-Z][A-Za-z-]+){0,2})|"
                      r"\b([A-Z][A-Za-z-]+(?:\s+[A-Z][A-Za-z-]+)?)\s+(?:20\d\d\s+)?(?:joint |military |naval |air )?exercise\b")
PLACE = re.compile(r"\b((?:[A-Z][\w'’-]+\s+){1,3}(?:National Park|Wildlife Sanctuary|Tiger Reserve|Bird Sanctuary|"
                   r"Biosphere Reserve|Lake|Wetland|Hills|Valley|Reservoir|Port|Airport|Dam))\b")
OPT_TWO = ["1 only", "2 only", "Both 1 and 2", "Neither 1 nor 2"]
OPT_HOW_MANY = ["Only one", "Only two", "All three", "None"]


def _h(*parts) -> int:
    return int(hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:8], 16)


def qid(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:12]


def _title(s: dict) -> str:
    t = str(s.get("title") or "")
    m = re.match(r"^(.{20,}?)\s+[|–—-]\s+([^|]{2,40})$", t)
    return m.group(1) if m and len(m.group(2).split()) <= 4 else t


def _norm_entities(text: str) -> str:
    for a, full in ALIASES.items():
        text = re.sub(rf"(?<![\w.]){re.escape(a)}(?![\w])", full, text)
    return text


def _found(text: str, names: list[str], ci: bool = False) -> list[str]:
    """Names that stand on their own in the text: "Shakti" isn't found in "Tarang Shakti" or "Jal Shakti",
    nor "Delhi" in "New Delhi" (a capitalised word right before or after means a longer name)."""
    out = []
    for n in names:
        for m in re.finditer(rf"(?<![\w-]){re.escape(n)}(?![\w-])", text, re.I if ci else 0):
            before = re.search(r"([A-Za-z][\w'’-]*)\s$", text[max(0, m.start() - 30):m.start()])
            after = re.match(r"\s([A-Z][\w'’-]*)", text[m.end():m.end() + 30])
            joined_before = before and before.group(1)[0].isupper() and before.group(1) not in ("Exercise", "Ex", "The", "In", "At", "By")
            joined_after = after and after.group(1) not in ("Navy", "Army", "Air", "Force", "Government", "Minister", "Ministry")
            if not joined_before and not joined_after:
                out.append(n)
                break
    return out


# ─────────────────────────── the story's usable sentences ───────────────────────────
def _clean_sentence(x: str) -> str:
    x = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", x)
    x = DATELINE.sub("", x.strip())
    return x[0].upper() + x[1:] if x else x


def fact_sentences(story: dict, paragraphs: list[str]) -> list[str]:
    """Declarative, self-contained sentences of the story's text, key ones first: 10-36 words, no quotes, no
    pronoun opening, no furniture."""
    if paragraphs:
        sents = [x for p in paragraphs for x in sentences_of(p)]
    else:
        e = story.get("explain") or {}
        blob = " ".join(str(t or "") for t in [e.get("why_in_news"), e.get("what"), *[t.get("x") for t in story.get("texts") or []],
                                                   story.get("summary")] if t and not str(t).lower().startswith("reported "))
        sents = sentences_of(blob)
    out, seen = [], set()
    ranked = summarize(sents, 12, editorial=bool(story.get("editorial"))) if len(sents) > 12 else sents
    for x in ranked + [s for s in sents if s not in ranked]:
        x = _clean_sentence(x)
        n = len(x.split())
        k = x[:50].lower()
        facty = re.search(r"\d", x) or re.search(r"\s[A-Z][\w-]+", x[1:])  # a figure or a name, not a general remark
        glued = re.search(r"[a-z]{3,}[A-Z][a-z]{2,}", x)  # "droughtThe": a link's text run into the sentence
        if (n < 10 or n > 36 or k in seen or glued or FURNITURE.search(x) or PRONOUN.match(x) or VOICE.search(x) or not facty
                or re.search(r"[“”\"?]|\bsaid\b|\bsays\b", x) or x.endswith("…") or not re.search(r"[.!]$", x)):
            continue
        seen.add(k)
        out.append(x)
    return out


# ─────────────────────────── decoys ───────────────────────────
def _num_decoys(raw: str, unit: str, text: str) -> list[str]:
    v = float(raw.replace(",", ""))
    dec = len(raw.split(".")[1]) if "." in raw else 0
    year = not unit and re.fullmatch(r"(19|20)\d\d", raw)
    if year:
        alts = [v - 3, v - 1, v + 2, v + 4]
    else:
        alts = [v * k for k in (0.5, 0.75, 1.3, 1.6)]
    out = []
    for a in alts:
        s = f"{a:,.{dec}f}" if "," in raw else f"{a:.{dec}f}"
        if s != raw and s not in text and s not in out and float(s.replace(",", "")) != v:
            out.append(s)
    return out


def _usable_number(x: str, m: re.Match, title: str) -> bool:
    raw, unit = m.group(2), m.group(3) or ""
    v = float(raw.replace(",", ""))
    around = x[max(0, m.start() - 16):m.end() + 12]
    if re.match(r"^0\d", raw) or (v < 10 and not unit):
        return False
    if re.search(r"[\w][-–]$", x[:m.start()]) or re.match(r"[-–]\d", x[m.end():]):
        return False  # part of a name or a range: "Su-30", "GSAAP-2025", "2027-28"
    if MONTH.search(around) and not unit:  # a date ("26 September 2026", "Sep 26")
        return False
    if re.fullmatch(r"(19|20)\d\d", raw):
        if re.search(rf"\b{raw}\b", title):  # the year in the headline: too easy
            return False
        if re.search(r"(Act|Policy|Bill|Rules|Scheme|Mission|Code|Programme|Plan|Vision|Summit|Games),?\s*$", x[:m.start()]):
            return False  # a name's year ("FPO Policy, 2026")
        if re.match(r"\s*[-–]\s*\d", x[m.end():]) or re.search(r"\d\s*[-–]\s*$", x[:m.start()]):
            return False  # a range ("2027 - 2028")
    return not re.search(rf"(?<![\d.,]){re.escape(raw)}(?![\d.,])", title)


def _swap(sentence: str, story_text: str, pools: dict[str, list[str]], seed: int, title: str = "") -> tuple[str, str, str] | None:
    """(false sentence, what was swapped out, what went in): one name or figure replaced by a same-kind decoy
    the story never mentions."""
    s = _norm_entities(sentence)
    text = _norm_entities(story_text)
    for kind in ENTITY_ORDER:
        ci = kind == "exercise"
        for name in _found(s, pools.get(kind) or [], ci):
            if kind == "country" and name == "India":
                continue
            decoys = [d for d in pools.get(kind) or [] if d.lower() != name.lower() and d.lower() not in text.lower()]
            if decoys:
                d = decoys[seed % len(decoys)]
                return re.sub(rf"(?<![\w-]){re.escape(name)}(?![\w-])", d, s, count=1, flags=re.I if ci else 0), name, d
    for m in NUM_RX.finditer(s):
        raw, unit = m.group(2), m.group(3) or ""
        if not _usable_number(s, m, title):
            continue
        alts = _num_decoys(raw, unit, text)
        if alts:
            d = alts[seed % len(alts)]
            return s[:m.start(2)] + d + s[m.end(2):], raw + unit, d + unit
    return None


# ─────────────────────────── question makers ───────────────────────────
def _base(story: dict, kind: str) -> dict:
    src = next((x for x in story.get("sources") or [] if str(x.get("u", "")).startswith("http") and "news.google." not in x.get("u", "")), None)
    b = story.get("sum") or {}
    url = (src or {}).get("u") or b.get("url") or ""
    outlet = (src or {}).get("p") or b.get("domain") or ((story.get("sources") or [{}])[0].get("p") or "")
    return {"type": kind, "story_id": story["id"], "title": _title(story), "subject": (story.get("subjects") or [""])[0],
            "gs": [g for g in story.get("gs") or [] if g != "Prelims"], "src": outlet, "url": url}


def statements_q(story: dict, sents: list[str], story_text: str, pools: dict) -> dict | None:
    seed = _h(story["id"], "st")
    use = sents[:3] if len(sents) >= 3 and seed % 3 == 0 else sents[:2]
    if len(use) < 2:
        return None
    n = len(use)
    pattern = [bool(seed >> (i + 2) & 1) for i in range(n)]  # True: this statement stays true
    items, notes = [], []
    for i, (x, keep) in enumerate(zip(use, pattern)):
        if keep:
            items.append(x)
            notes.append(f"Statement {i + 1} is correct.")
            continue
        sw = _swap(x, story_text, pools, seed + i, str(story.get("title") or ""))
        if not sw:
            items.append(x)
            pattern[i] = True
            notes.append(f"Statement {i + 1} is correct.")
            continue
        items.append(sw[0])
        notes.append(f"Statement {i + 1} is incorrect: it is {sw[1]}, not {sw[2]}. The report says: “{x}”")
    k = sum(pattern)
    if n == 2:
        options, ask = OPT_TWO, "Which of the statements given above is/are correct?"
        answer = 2 if k == 2 else 3 if k == 0 else (0 if pattern[0] else 1)
    else:
        options, ask = OPT_HOW_MANY, "How many of the above statements are correct?"
        answer = {1: 0, 2: 1, 3: 2, 0: 3}[k]
    q = f"With reference to “{_title(story)}”, consider the following statements:"
    return {**_base(story, "statements"), "id": qid("st", story["id"], *items), "q": q, "items": items, "ask": ask,
            "options": options, "answer": answer, "why": " ".join(notes)}


def fact_q(story: dict, sents: list[str], story_text: str, pools: dict) -> dict | None:
    text = _norm_entities(story_text)
    for x in sents[:6]:
        s = _norm_entities(x)
        for kind in ENTITY_ORDER:
            ci = kind == "exercise"
            names = [n for n in _found(s, pools.get(kind) or [], ci) if n != "India"]
            if not names:
                continue
            name = names[0]
            if len(re.findall(rf"(?<![\w-]){re.escape(name)}(?![\w-])", s, re.I if ci else 0)) > 1:
                continue  # the sentence names it again: the blank would give itself away
            decoys = [d for d in pools.get(kind) or [] if d.lower() != name.lower() and d.lower() not in text.lower()]
            if len(decoys) < 3:
                continue
            seed = _h(story["id"], "fact", name)
            picks = [decoys[(seed + i * 7) % len(decoys)] for i in range(3)]
            if len(set(picks)) < 3:
                picks = list(dict.fromkeys(decoys))[:3]
            options = picks[:]
            pos = seed % 4
            options.insert(pos, name)
            stem = re.sub(rf"(?<![\w-]){re.escape(name)}(?![\w-])", "______", s, count=1, flags=re.I if ci else 0)
            return {**_base(story, "fact"), "id": qid("fa", story["id"], stem), "q": "Which of the following fills the blank correctly?",
                    "items": [stem], "ask": "", "options": options, "answer": pos, "why": f"The report says: “{x}”"}
    return None


def figure_q(story: dict, sents: list[str], story_text: str) -> dict | None:
    for x in sents[:8]:
        for m in NUM_RX.finditer(x):
            raw, unit, pre = m.group(2), m.group(3) or "", m.group(1) or ""
            if not _usable_number(x, m, str(story.get("title") or "")):
                continue
            alts = _num_decoys(raw, unit, story_text)
            if len(alts) < 3:
                continue
            seed = _h(story["id"], "fig", raw)
            opts = [f"{pre}{a}{unit}" for a in alts[:3]]
            pos = seed % 4
            opts.insert(pos, f"{pre}{raw}{unit}")
            stem = x[:m.start()] + "______" + x[m.end():]
            return {**_base(story, "figure"), "id": qid("fg", story["id"], stem), "q": "Which figure fills the blank correctly?",
                    "items": [stem], "ask": "", "options": opts, "answer": pos, "why": f"The report says: “{x}”"}
    return None


def claude_qs(story: dict) -> list[dict]:
    ai = story.get("ai") or {}
    out = []
    for m in (ai.get("mcqs") or [])[:2] if ai.get("source") == "claude-notes" else []:
        opts = [str(o) for o in m.get("options") or []]
        if len(opts) == 4 and isinstance(m.get("answer"), int) and 0 <= m["answer"] < 4:
            out.append({**_base(story, "claude"), "id": qid("cl", story["id"], m.get("q")), "q": str(m.get("q") or ""),
                        "items": [], "ask": "", "options": opts, "answer": m["answer"], "why": str(m.get("why") or "")})
    return out


def pairs_q(week: list[dict], texts: dict[str, str], day: str) -> list[dict]:
    """Pairs questions over the week's cards: exercise → partner country, place in news → state."""
    relations: dict[str, dict[str, tuple[str, dict]]] = {"exercise": {}, "place": {}}
    for s in week:
        t = _norm_entities(f"{s.get('title', '')}. {texts.get(s['id'], '')}")
        head = _norm_entities(str(s.get("title") or ""))
        m = EXERCISE.search(head)
        if m:
            name = (m.group(1) or m.group(2) or "").strip()
            name = name.title() if name.isupper() and len(name) > 4 else name
            partners = list(dict.fromkeys([c for c in _found(t, COUNTRIES) if c != "India"]
                                          + [c for d, c in DEMONYM.items() if re.search(rf"\b{d}\b", t)]))
            partner = partners[0] if len(partners) == 1 else KNOWN_PARTNER.get(name.lower(), "") if not partners else ""
            if len(partners) > 1 and KNOWN_PARTNER.get(name.lower()) in partners:
                partner = KNOWN_PARTNER[name.lower()]
            if name and partner and name.lower() not in {"joint", "military", "naval", "air", "the"}:
                relations["exercise"].setdefault(name, (partner, s))
        pm = PLACE.search(head)
        if pm:
            states = _found(t, STATES)
            if states:
                relations["place"].setdefault(pm.group(1).strip(), (max(states, key=lambda x: t.count(x)), s))
    out = []
    heads = {"exercise": ("Exercise", "Partner country"), "place": ("Place in news", "State / UT")}
    for rel, items in relations.items():
        if len(items) < 3:
            continue
        names = sorted(items)[:3] if len(items) == 3 else sorted(items, key=lambda n: -_h(day, rel, n))[:3]
        truth = [items[n][0] for n in names]
        seed = _h(day, rel, *names)
        wrong = seed % 4  # how many pairs to break: 0-3
        shown = truth[:]
        pool = KINDS["country" if rel == "exercise" else "state"]
        for i in range(wrong):
            others = [p for p in pool if p not in truth and p not in shown]
            shown[i] = others[(seed + i) % len(others)] if others else shown[i]
        correct = sum(1 for a, b in zip(shown, truth) if a == b)
        a, b = heads[rel]
        pairs = [f"{n} — {p}" for n, p in zip(names, shown)]
        why = "; ".join(f"{n}: {t}" for n, t in zip(names, truth))
        lead = items[names[0]][1]
        out.append({**_base(lead, "pairs"), "id": qid("pr", day, rel, *pairs), "title": f"{a}s in the news this week",
                    "q": f"Consider the following pairs ({a} — {b}):", "items": pairs, "ask": "How many of the above pairs are correctly matched?",
                    "options": OPT_HOW_MANY, "answer": {1: 0, 2: 1, 3: 2, 0: 3}[correct], "why": f"Correct pairs: {why}."})
    return out


# ─────────────────────────── the day's pool ───────────────────────────
def build_practice(payload: dict, day: str, paragraphs: dict[str, list[str]], week: list[dict] | None = None,
                   extra_names: dict[str, list[str]] | None = None) -> dict:
    """payload: brief_payload(day, day, full=True); paragraphs: {story_id: the free article's paragraphs};
    week: the last seven days' cards (for pairs). → {"day", "questions": [...]}"""
    v = (payload.get("days") or {}).get(day) or {}
    by_id = {s["id"]: s for s in payload.get("stories") or []}
    order = [i for k in ("news", "prelims", "editorials", "explained") for i in v.get(k) or [] if i in by_id]
    pools = {k: list(vals) for k, vals in KINDS.items()}
    exercises = set()
    for s in (week or []) + [by_id[i] for i in order]:
        m = EXERCISE.search(str(s.get("title") or ""))
        if m and (m.group(1) or m.group(2)):
            exercises.add((m.group(1) or m.group(2)).strip())
    known = {"Varuna", "Malabar", "Garuda", "Yudh Abhyas", "Nomadic Elephant", "Tarang Shakti", "Mitra Shakti", "Maitree",
             "Dharma Guardian", "Ekuverin", "Harimau Shakti", "Cope India", "Red Flag", "Pitch Black", "Desert Knight", "Shakti"}
    names = {n.title() if n.isupper() and len(n) > 4 else n for n in exercises | set((extra_names or {}).get("exercise") or [])}
    pools["exercise"] = sorted(names | known, key=lambda n: (-len(n), n))
    questions: list[dict] = []
    for sid in order:
        s = by_id[sid]
        paras = paragraphs.get(sid) or []
        text = " ".join([str(s.get("title") or ""), *paras, str(s.get("summary") or ""),
                         *[str(t.get("x") or "") for t in s.get("texts") or []]])
        sents = fact_sentences(s, paras)
        mine: list[dict] = claude_qs(s)
        kinds = ["statements", "fact", "figure"] if s.get("editorial") is not True else ["statements", "figure"]
        for kind in kinds:
            if len(mine) >= PER_STORY:
                break
            q = (statements_q(s, sents, text, pools) if kind == "statements" else fact_q(s, sents, text, pools) if kind == "fact"
                 else figure_q(s, sents, text))
            if q and len(set(q["options"])) == 4 and all(q["options"]):
                mine.append(q)
        questions += mine
    if week is not None:
        today = [by_id[i] for i in order]
        texts = {s["id"]: " ".join(paragraphs.get(s["id"]) or []) or " ".join((s.get("sum") or {}).get("points") or [])
                 or str(s.get("summary") or "") for s in week + today}
        questions = pairs_q(week + [x for x in today if x["id"] not in {w["id"] for w in week}], texts, day) + questions
    seen: set[str] = set()
    pool = [q for q in questions if not (q["id"] in seen or seen.add(q["id"]))]
    return {"day": day, "n": len(pool[:POOL_MAX]), "questions": pool[:POOL_MAX]}


def week_before(day: str, n: int = 6) -> list[str]:
    d = date.fromisoformat(day)
    return [(d - timedelta(days=i)).isoformat() for i in range(1, n + 1)]

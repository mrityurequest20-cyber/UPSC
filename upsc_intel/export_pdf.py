"""The Daily Brief as a PDF: a newspaper-style revision document, one file per day.

Built from the same day payload the site shows (web/app.py → brief_payload), laid out like the Cowork daily
brief: a masthead; Must-know by syllabus area, each a 10-12 line briefing note taken from the free full
article's key points (pipeline/articles.py) or, failing that, the outlets' reports, with its source link;
Prelims facts (2-3 lines each); Editorial Watch (each piece's argument in 2-3 sentences); Explained; Also in
the news (one line each); and a coverage check. Every line quotes a report: nothing is made up.

Only reportlab's base fonts are used, so text is kept to what they can draw: the rupee sign becomes "Rs.",
subscripts and other symbols are spelt out or dropped, and nothing renders as a black box.
"""
from __future__ import annotations

import html
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import Flowable, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .pipeline.articles import FURNITURE, sentences_of, summarize
from .pipeline.normalize import IST

INK, MUTED = colors.HexColor("#14171c"), colors.HexColor("#5b636e")
RULE, LINK = colors.HexColor("#c9ced6"), colors.HexColor("#1a4fa0")
ACCENT = colors.HexColor("#1c5cab")
GRADE = {"NOTE": ("MAKE NOTES", "#8c1d1d", "#f6e6e6"), "SKIM": ("QUICK READ", "#1f6b4a", "#e4f0ea"),
         "READ": ("BACKGROUND", "#5b636e", "#eceef1"), "LOW": ("LOW", "#5b636e", "#eceef1")}
NOTE_WORDS = 175     # a Must-know briefing note: about 10-12 lines
FACT_WORDS = 55      # a Prelims fact: 2-3 lines
EDIT_WORDS = 70      # an editorial's argument: 2-3 sentences
EXPL_WORDS = 40
WEAK = re.compile(r"^(reported (on|by) |(opinion piece|explainer)\b.*open it for the full (argument|piece)\.?$)", re.I)
SPELL = {"₹": "Rs. ", "₂": "2", "₃": "3", "²": "2", "³": "3", "°": " deg", "≈": "~", "→": "->", "←": "<-", "≥": ">=", "≤": "<=",
         "​": "", " ": " ", " ": " ", " ": " "}


def clean(t) -> str:
    """Text the base fonts can draw (Windows-1252), with the rupee and other symbols spelt out."""
    s = "".join(SPELL.get(c, c) for c in str(t or ""))
    out = []
    for c in unicodedata.normalize("NFC", s):
        try:
            c.encode("cp1252")
            out.append(c)
        except UnicodeEncodeError:
            out.append(unicodedata.normalize("NFKD", c).encode("ascii", "ignore").decode())
    return re.sub(r"[ \t]+", " ", "".join(out)).strip()


def esc(t) -> str:
    return html.escape(clean(t), quote=False)


def href(u: str) -> str:
    return html.escape(str(u or ""), quote=True)


def _s(name, font, size, lead, color=INK, align=TA_LEFT, **kw):
    return ParagraphStyle(name, fontName=font, fontSize=size, leading=lead, textColor=color, alignment=align, **kw)


S = {
    "kicker": _s("k", "Helvetica", 7.6, 10, MUTED, TA_CENTER, spaceAfter=1),
    "masthead": _s("m", "Times-Bold", 26, 29, INK, TA_CENTER, spaceAfter=2),
    "dateline": _s("d", "Helvetica-Bold", 8.4, 11, ACCENT, TA_CENTER),
    "standfirst": _s("sf", "Times-Italic", 9.4, 12.5, MUTED, TA_CENTER),
    "banner": _s("b", "Helvetica-Bold", 8.8, 12, LINK, TA_CENTER),
    "fine": _s("f", "Helvetica-Oblique", 7.0, 9.2, MUTED, TA_LEFT, spaceAfter=3),
    "section": _s("sec", "Helvetica-Bold", 12.5, 15, INK),
    "subsec": _s("ss", "Helvetica-Bold", 9.6, 12, ACCENT, spaceBefore=4, spaceAfter=3, keepWithNext=1),
    "head": _s("h", "Times-Bold", 11.4, 13.6, INK, spaceBefore=1, spaceAfter=3, keepWithNext=1),
    "body": _s("bo", "Times-Roman", 9.6, 13.2, INK, TA_JUSTIFY, spaceAfter=2),
    "meta": _s("me", "Helvetica", 7.6, 10, colors.HexColor("#3c4450"), spaceAfter=2),
    "why": _s("w", "Times-Italic", 9.0, 12.2, colors.HexColor("#3c4450"), leftIndent=11, spaceAfter=2),
    "src": _s("s", "Helvetica-Oblique", 7.4, 9.5, LINK, spaceAfter=1),
    "fhead": _s("fh", "Times-Bold", 10.2, 12.4, INK, spaceAfter=2, keepWithNext=1),
    "fbody": _s("fb", "Times-Roman", 9.0, 12.0, INK, TA_JUSTIFY, spaceAfter=1),
    "edhead": _s("eh", "Times-Bold", 9.4, 11.6, INK, spaceAfter=1),
    "edbody": _s("eb", "Times-Roman", 8.7, 11.4, colors.HexColor("#2b323b"), TA_JUSTIFY, spaceAfter=1),
    "line": _s("l", "Times-Roman", 8.8, 11.4, INK, leftIndent=8, firstLineIndent=-8, spaceAfter=1.5),
    "audit": _s("a", "Helvetica", 8.0, 11.2, colors.HexColor("#2b323b"), TA_JUSTIFY, spaceAfter=3),
}


class Rule(Flowable):
    def __init__(self, thick=0.6, color=RULE, space=2):
        super().__init__()
        self.w, self.thick, self.color, self.space = 0, thick, color, space

    def wrap(self, aw, ah):
        self.w = aw
        return aw, self.thick + self.space

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.thick)
        self.canv.line(0, self.space, self.w, self.space)


def pill(text: str, fg: str, bg: str, fs: float = 6.2):
    text = clean(text)
    p = Paragraph(html.escape(text, quote=False), _s("p", "Helvetica-Bold", fs, fs + 1.4, colors.HexColor(fg), TA_CENTER))
    w = stringWidth(text, "Helvetica-Bold", fs) + 9.0
    t = Table([[p]], colWidths=[w], rowHeights=[fs + 5.0])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(bg)), ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor(fg)),
                           ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 2),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 2), ("TOPPADDING", (0, 0), (-1, -1), 0),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    return t, w


def tagrow(labels: list[tuple[str, str, str]]):
    cells, widths = [], []
    for text, fg, bg in labels:
        t, w = pill(text, fg, bg)
        cells.append(t)
        widths.append(w + 4)
    t = Table([cells + [""]], colWidths=widths + [None])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))
    t.keepWithNext = 1  # the pills stay with the headline, the headline with the note's first lines
    return t


def title_of(s: dict) -> str:
    """The headline without an outlet tag at its end ("… | Akashvani News")."""
    t = str(s.get("title") or "")
    m = re.match(r"^(.{20,}?)\s+[|–—-]\s+([^|]{2,40})$", t)
    return m.group(1) if m and len(m.group(2).split()) <= 4 and not re.search(r"\d", m.group(2)) else t


def link(url: str, label: str) -> str:
    return f'<link href="{href(url)}" color="#1a4fa0"><u>{esc(label)}</u></link>'


# ─────────────────────────── what each item says ───────────────────────────
def _source(s: dict) -> tuple[str, str]:
    """(outlet, URL) to cite: the first source with a real article link (not a Google News redirect)."""
    srcs = s.get("sources") or []
    for x in srcs:
        u = x.get("u") or ""
        if u.startswith("http") and "news.google." not in u:
            return x.get("p") or "Source", u
    b = s.get("sum") or {}
    if b.get("url"):
        return b.get("domain") or "Source", b["url"]
    return (srcs[0].get("p") or "Source", srcs[0].get("u") or "") if srcs else ("Source", s.get("url") or "")


def _report_sentences(s: dict) -> list[str]:
    e = s.get("explain") or {}
    out, seen = [], set()
    for text in [e.get("why_in_news"), e.get("what"), *[t.get("x") for t in s.get("texts") or []], s.get("summary")]:
        text = str(text or "").strip()
        if not text or WEAK.match(text):
            continue
        for x in sentences_of(text) or ([text] if len(text) > 30 else []):
            k = x[:60].lower()
            if k in seen or FURNITURE.search(x) or WEAK.match(x):
                continue
            seen.add(k)
            out.append(x)
    return out


def note_of(s: dict, max_words: int) -> tuple[str, bool]:
    """(the item's briefing text, whether it comes from the full article), cut at about max_words."""
    pts = [p for p in (s.get("sum") or {}).get("points") or [] if p]
    full = bool(pts)
    if not pts:
        sents = _report_sentences(s)
        pts = summarize(sents, 8, editorial=bool(s.get("editorial"))) if len(sents) > 3 else sents
    out, n = [], 0
    for p in pts:
        k = len(p.split())
        if n and n + k > max_words + 15:
            break
        out.append(p)
        n += k
        if n >= max_words:
            break
    return " ".join(out), full


def _facts_line(s: dict) -> str:
    e = s.get("explain") or {}
    parts = []
    when = str(e.get("when") or "")
    if when and not when.lower().startswith("reported"):
        parts.append(f"<b>When:</b> {esc(when)}")
    for k, name in (("where", "Where"), ("who", "Who")):
        if e.get(k):
            parts.append(f"<b>{name}:</b> {esc(e[k])}")
    if e.get("prelims"):
        parts.append("<b>Prelims:</b> " + esc("; ".join(e["prelims"][:3])))
    return " &nbsp;·&nbsp; ".join(parts)


def _syllabus_line(s: dict, labels: dict) -> str:
    subj = ", ".join(labels["subjects"].get(k, k) for k in s.get("subjects") or [])
    gs = " / ".join(g for g in s.get("gs") or [] if g != "Prelims")
    tags = ", ".join(s.get("tags") or [])
    bits = [f"{gs}: {subj}" if gs else subj, f"Prelims angle: {tags}" if tags else ""]
    return esc(" · ".join(b for b in bits if b))


def _why(s: dict) -> str:
    """A real "why it matters" (Claude's note or AI write-up), never the auto syllabus tags."""
    e = s.get("explain") or {}
    if e.get("auto"):
        return ""
    sig = [x for x in e.get("significance") or [] if x and not re.match(r"^(GS\d|Prelims angle|Widely reported|Easy-miss)", x)]
    return "; ".join(sig[:2])


def _grade_pill(g: str) -> tuple[str, str, str]:
    return GRADE.get(g or "", GRADE["READ"])


# ─────────────────────────── blocks ───────────────────────────
def must_know_block(s: dict, labels: dict, folded: list[dict]) -> list:
    subj = labels["subjects"].get((s.get("subjects") or [""])[0], "")
    gs = " ".join(g for g in s.get("gs") or [] if g != "Prelims")
    pills = ([(gs, "#243244", "#e8ecf2")] if gs else []) + [_grade_pill(s.get("grade"))]
    body, full = note_of(s, NOTE_WORDS)
    fl = [tagrow(pills), Paragraph(esc(title_of(s)), S["head"]),
          Paragraph(esc(body) if body else "<i>Only the headline was reported; open the source for the details.</i>", S["body"])]
    facts = _facts_line(s)
    if facts:
        fl.append(Paragraph(facts, S["meta"]))
    why = _why(s)
    if why:
        fl.append(Paragraph("<b>Why it matters —</b> " + esc(why), S["why"]))
    fl.append(Paragraph("<b>Syllabus:</b> " + _syllabus_line(s, labels), S["meta"]))
    outlet, url = _source(s)
    src = [link(url, f"{outlet}: read the source")] if url else [esc(outlet)]
    b = s.get("sum") or {}
    if full and b.get("url") and b["url"] != url:
        src.append(link(b["url"], f"free copy on {b.get('domain') or 'the web'}"))
    others = [o for o in dict.fromkeys(_source(f)[0] for f in folded) if o != outlet]
    if others:
        src.append("also reported by " + esc(", ".join(others)))
    fl += [Paragraph(" · ".join(src), S["src"]), Spacer(1, 8)]
    return fl


def fact_block(s: dict, labels: dict) -> list:
    subj = labels["subjects"].get((s.get("subjects") or [""])[0], "")
    tags = [t for t in s.get("tags") or [] if t != "Data/Stats"][:2]
    pills = [(subj.upper() or "NEWS", "#243244", "#e8ecf2")] + [(t.upper(), "#6b4e00", "#fff4d6") for t in tags] + [_grade_pill(s.get("grade"))]
    body, _ = note_of(s, FACT_WORDS)
    outlet, url = _source(s)
    fl = [tagrow(pills), Paragraph(esc(title_of(s)), S["fhead"])]
    if body:
        fl.append(Paragraph(esc(body), S["fbody"]))
    fl += [Paragraph(link(url, f"{outlet}: source") if url else esc(outlet), S["src"]), Spacer(1, 6)]
    return fl


def editorial_cell(s: dict) -> list:
    body, _ = note_of(s, EDIT_WORDS)
    outlet, url = _source(s)
    gs = " ".join(g for g in s.get("gs") or [] if g != "Prelims") or "GS"
    return [Paragraph(f"<font color='#1c5cab'><b>{esc(gs)}</b></font> &nbsp; {esc(title_of(s))}", S["edhead"]),
            Paragraph(esc(body) if body else "<i>Open the piece for its argument.</i>", S["edbody"]),
            Paragraph(link(url, outlet) if url else esc(outlet), S["src"])]


def two_columns(cells: list[list], width: float) -> list:
    out = []
    for i in range(0, len(cells), 2):
        pair = cells[i:i + 2] + ([[Spacer(1, 1)]] if len(cells[i:i + 2]) == 1 else [])
        t = Table([[pair[0], pair[1]]], colWidths=[width / 2 - 6, width / 2 - 6])
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                               ("RIGHTPADDING", (0, 0), (0, 0), 12), ("TOPPADDING", (0, 0), (-1, -1), 0),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
        out.append(t)
    return out


def section(title: str, note: str = "") -> list:
    out = [Spacer(1, 4), Rule(1.6, INK, 3), Spacer(1, 5), Paragraph(esc(title.upper()), S["section"])]
    if note:
        out.append(Paragraph(esc(note), S["fine"]))
    return out + [Rule(0.8, RULE, 2), Spacer(1, 5)]


# ─────────────────────────── the document ───────────────────────────
def build_day_pdf(payload: dict, day: str, labels: dict, out: str | Path, reported: int | None = None,
                  site_url: str = "", built_at: str | None = None) -> Path:
    """Writes the day's brief as a PDF and returns its path. payload: brief_payload(day, day, full=True)."""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    v = (payload.get("days") or {}).get(day) or {}
    by_id = {s["id"]: s for s in payload.get("stories") or []}
    pick = lambda ids: [by_id[i] for i in ids or [] if i in by_id]  # noqa: E731
    news, facts, more = pick(v.get("news")), pick(v.get("prelims")), pick(v.get("more"))
    eds, exps = pick(v.get("editorials")), pick(v.get("explained"))
    folded = {k: pick(ids) for k, ids in (v.get("folded") or {}).items()}
    dt = datetime.fromisoformat(day)
    built = datetime.fromisoformat(built_at) if built_at else datetime.now(timezone.utc)
    width = A4[0] - 34 * mm

    counts = [f"{len(news)} must-know stories", f"{len(facts)} Prelims facts", f"{len(eds)} editorials", f"{len(exps)} explainers"]
    stand = (f"{', '.join(counts[:-1])} and {counts[-1]}"
             + (f", picked from {reported:,} stories reported" if reported else "")
             + ". Each item links to its source; notes quote the reports.")
    story: list = [Rule(1.6, INK, 3), Spacer(1, 5), Paragraph("UPSC CIVIL SERVICES  ·  DAILY CURRENT AFFAIRS", S["kicker"]),
                   Paragraph("UPSC Intel · Daily Brief", S["masthead"]),
                   Paragraph(esc(dt.strftime("%A, %d %B %Y").upper()), S["dateline"]), Spacer(1, 4), Rule(0.8, RULE, 2),
                   Spacer(1, 5), Paragraph(esc(stand), S["standfirst"]), Spacer(1, 6)]
    if site_url:
        story += [Paragraph(link(f"{site_url}#day/{day}", "Open this brief online: summaries, Ask Intel and practice MCQs"), S["banner"]),
                  Spacer(1, 6)]
    story += [Rule(1.6, INK, 3), Spacer(1, 8)]

    if news:
        story += section("Must-know", "High-yield stories: make notes on these. Grouped by syllabus area.")
        order = list(labels["subjects"])
        groups: dict[str, list] = {}
        for s in news:
            groups.setdefault((s.get("subjects") or ["other"])[0], []).append(s)
        for k in sorted(groups, key=lambda k: order.index(k) if k in order else len(order)):
            head = [Paragraph(esc(labels["subjects"].get(k, k.title())), S["subsec"])]
            for i, s in enumerate(groups[k]):
                story += (head if i == 0 else []) + must_know_block(s, labels, folded.get(s["id"], []))
    if facts:
        story += section("Prelims facts", "Concrete developments worth a quick read: exercises, pacts, Acts, approvals, "
                                          "schemes, species, verdicts.")
        for s in facts:
            story += fact_block(s, labels)
    if eds:
        story += section("Editorial watch", "What the opinion pages argued: two or three lines each.")
        story += two_columns([editorial_cell(s) for s in eds], width)
    if exps:
        story += section("Explained", "The concept behind the news, one or two lines each.")
        for s in exps:
            body, _ = note_of(s, EXPL_WORDS)
            outlet, url = _source(s)
            story.append(KeepTogether([Paragraph(f"<b>{esc(title_of(s))}</b>" + (f" {esc(body)}" if body else ""), S["fbody"]),
                                       Paragraph(link(url, outlet) if url else esc(outlet), S["src"]), Spacer(1, 4)]))
    if more:
        story += section("Also in the news", "Reactions, previews and smaller stories: one line each.")
        for s in more:
            outlet, url = _source(s)
            subj = labels["subjects"].get((s.get("subjects") or [""])[0], "")
            story.append(Paragraph(f"&bull; {esc(title_of(s))} <font color='#5b636e' size='7.4'>({esc(subj)})</font> "
                                   + (link(url, outlet) if url else esc(outlet)), S["line"]))

    # coverage check
    cards = news + facts
    areas: dict[str, int] = {}
    for s in cards:
        for k in (s.get("subjects") or [])[:1]:
            areas[k] = areas.get(k, 0) + 1
    empty = [labels["subjects"][k] for k in labels["subjects"] if k not in areas]
    watch = {k: 0 for k in labels.get("watch") or {}}
    for s in cards + more + eds + exps:
        for w in s.get("watch") or []:
            if w in watch:
                watch[w] += 1
    read_full = sum(1 for s in cards + eds + exps if (s.get("sum") or {}).get("points"))
    outlets: dict[str, int] = {}
    for s in cards + eds + exps:
        outlets[_source(s)[0]] = outlets.get(_source(s)[0], 0) + 1
    story += section("Coverage check")
    story += [
        Paragraph(f"<b>Items —</b> {len(news)} must-know, {len(facts)} Prelims facts, {len(more)} in the news, "
                  f"{len(eds)} editorials, {len(exps)} explainers.", S["audit"]),
        Paragraph("<b>Syllabus areas in the cards —</b> "
                  + esc(", ".join(f"{labels['subjects'].get(k, k)} ({n})" for k, n in sorted(areas.items(), key=lambda x: -x[1])) or "none")
                  + (f". <b>Nothing today in —</b> {esc(', '.join(empty))}." if empty else "."), S["audit"]),
        Paragraph("<b>Easy-miss watch —</b> " + esc(" · ".join(f"{labels['watch'][k]}: {n or 'nothing today'}" for k, n in watch.items())),
                  S["audit"]),
        Paragraph(f"<b>Full text —</b> {read_full} of {len(cards) + len(eds) + len(exps)} items were read in full from a free "
                  "copy; the rest are summarised from the outlets' reports. Subscriber-only sites are never opened.", S["audit"]),
        Paragraph("<b>Sources in the cards —</b> " + esc(", ".join(f"{k} {n}" for k, n in sorted(outlets.items(), key=lambda x: -x[1])[:14])),
                  S["audit"]),
        Spacer(1, 4), Rule(0.8, RULE, 2), Spacer(1, 3),
        Paragraph(esc(f"Built {built.astimezone(IST).strftime('%d %b %Y, %H:%M')} IST by UPSC Intel. Notes quote the reports; "
                      "check the source before quoting a figure in an answer."), S["fine"]),
    ]

    right = dt.strftime("%d %B %Y").upper()

    def furniture(canv, doc):
        canv.saveState()
        canv.setFont("Helvetica", 7)
        canv.setFillColor(MUTED)
        canv.drawCentredString(A4[0] / 2.0, 11 * mm, f"Page {doc.page}")
        if doc.page > 1:
            canv.setFont("Helvetica", 6.6)
            canv.drawString(17 * mm, A4[1] - 11 * mm, "UPSC INTEL · DAILY BRIEF")
            canv.drawRightString(A4[0] - 17 * mm, A4[1] - 11 * mm, right)
            canv.setStrokeColor(RULE)
            canv.setLineWidth(0.4)
            canv.line(17 * mm, A4[1] - 13 * mm, A4[0] - 17 * mm, A4[1] - 13 * mm)
        canv.restoreState()

    SimpleDocTemplate(str(out), pagesize=A4, leftMargin=17 * mm, rightMargin=17 * mm, topMargin=15 * mm, bottomMargin=17 * mm,
                      title=f"UPSC Intel Daily Brief {day}", author="UPSC Intel",
                      subject="UPSC current affairs").build(story, onFirstPage=furniture, onLaterPages=furniture)
    return out

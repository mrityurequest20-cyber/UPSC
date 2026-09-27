"""Daily practice MCQs (pipeline/practice.py) and the Daily Brief PDF (export_pdf.py)."""
import re

from pypdf import PdfReader

from upsc_intel.export_pdf import build_day_pdf, clean
from upsc_intel.pipeline import practice as P

LABELS = {"subjects": {"defence": "Defence", "ir": "International Relations", "polity": "Polity & Constitution"},
          "subject_gs": {"defence": "GS3", "ir": "GS2", "polity": "GS2"},
          "watch": {"marine": "Marine & coastal", "dpi": "Digital Public Infrastructure"}}


def story(sid, title, subj="defence", paras=(), **kw):
    return {"id": sid, "title": title, "subjects": [subj], "gs": ["GS3"], "grade": "NOTE", "tags": [], "watch": [],
            "summary": "", "explain": {}, "texts": [], "sources": [{"p": "ForumIAS", "u": f"https://forumias.com/{sid}"}],
            "sum": {"points": list(paras), "url": f"https://forumias.com/{sid}", "domain": "forumias.com", "via": ""}, **kw}


VARUNA = ["INS Trishul has arrived at Toulon, France, to participate in the 24th edition of the bilateral maritime exercise Varuna.",
          "Exercise Varuna 2026 is a bilateral maritime exercise between the Indian Navy and the French Navy.",
          "The bilateral naval exercise was initiated in 1993 and was christened Varuna in 2001.",
          "We are proud to be part of this exercise with our friends from France."]
PARL = ["Parliament has passed the Transgender Persons (Protection of Rights) Amendment Bill, 2026, with the Rajya Sabha approving it today.",
        "The bill was passed by the Lok Sabha yesterday by a voice vote amid an Opposition-led walkout.",
        "The measure covers 74 per cent of the eligible population, according to the Ministry of Social Justice data."]
TARANG = ["The French Air and Space Force will participate in the IAF-hosted multinational air exercise Tarang Shakti 2026 in Jodhpur.",
          "Jal Shakti Minister C R Patil met the Netherlands minister at Bharat Mandapam in New Delhi on Friday."]


def payload(stories, day="2026-09-26"):
    return {"days": {day: {"news": [s["id"] for s in stories], "prelims": [], "more": [], "folded": {}, "editorials": [],
                           "explained": []}}, "stories": stories}


def test_statements_are_the_reports_own_lines_with_one_swap():
    s = story("v1", "Exercise VARUNA 2026", paras=VARUNA)
    q = P.statements_q(s, P.fact_sentences(s, VARUNA), " ".join(VARUNA), {**P.KINDS, "exercise": ["Varuna", "Malabar", "Garuda", "Yudh Abhyas"]})
    assert q and q["type"] == "statements" and len(q["items"]) in (2, 3) and len(set(q["options"])) == 4
    truths = [x in VARUNA for x in q["items"]]
    expect = {(True, True): 2, (False, False): 3, (True, False): 0, (False, True): 1}
    if len(truths) == 2:
        assert q["answer"] == expect[tuple(truths)]
    else:
        assert q["options"][q["answer"]] == {1: "Only one", 2: "Only two", 3: "All three", 0: "None"}[sum(truths)]
    assert not any("We are proud" in x for x in q["items"])  # first person: a speech, not a fact
    for x in q["items"]:  # a swapped-in name is never one the story itself mentions
        if x not in VARUNA:
            assert "France" not in x or "Toulon" not in x or "Varuna" not in x


def test_fact_blank_never_splits_a_name():
    s = story("t1", "Exercise Tarang Shakti 2026", paras=TARANG)
    pools = {**P.KINDS, "exercise": ["Shakti", "Tarang Shakti", "Varuna", "Garuda", "Malabar"]}
    q = P.fact_q(s, P.fact_sentences(s, TARANG), " ".join(TARANG), pools)
    assert q and "Tarang ______" not in q["items"][0] and "Jal ______" not in q["items"][0] and "New ______" not in q["items"][0]
    assert q["options"][q["answer"]] in ("Tarang Shakti", "France", "Netherlands")


def test_figures_skip_names_ranges_and_headline_years():
    s = story("p1", "Parliament passes Transgender Persons Amendment Bill, 2026", "polity", paras=PARL)
    q = P.figure_q(s, P.fact_sentences(s, PARL), " ".join(PARL))
    assert q and q["options"][q["answer"]] == "74 per cent" and "cove______" not in q["items"][0]
    rng = story("r1", "HAL helicopter programme", paras=["Initial induction is planned during FY 2027-28 for the Su-30 MKI fleet of the Air Force."])
    assert P.figure_q(rng, P.fact_sentences(rng, rng["sum"]["points"]), "") is None


def test_pairs_use_partner_countries_and_count_right():
    week = [story("a", "Exercise VARUNA 2026", paras=VARUNA),
            story("b", "Indian, Mongolian troops conduct drills during Exercise NOMADIC ELEPHANT"),
            story("c", "SkyStriker drones test-fired in Exercise Yudh Abhyas 2026")]
    qs = P.pairs_q(week, {x["id"]: " ".join(x["sum"]["points"]) for x in week}, "2026-09-26")
    assert len(qs) == 1
    q = qs[0]
    truth = {"Varuna": "France", "Nomadic Elephant": "Mongolia", "Yudh Abhyas": "United States"}
    right = sum(1 for x in q["items"] if truth[x.split(" — ")[0]] == x.split(" — ")[1])
    assert q["options"][q["answer"]] == {1: "Only one", 2: "Only two", 3: "All three", 0: "None"}[right]


def test_pairs_skip_multinational_exercises():
    week = [story("t", "Exercise ‘Tarang Shakti’ 2026 and Mission Pégase 2026",
                  paras=["The French Air and Space Force will take part in the IAF-hosted air exercise in Jodhpur."]),
            story("a", "Exercise VARUNA 2026", paras=VARUNA),
            story("b", "Indian, Mongolian troops conduct drills during Exercise NOMADIC ELEPHANT"),
            story("c", "SkyStriker drones test-fired in Exercise Yudh Abhyas 2026")]
    qs = P.pairs_q(week, {x["id"]: " ".join(x["sum"]["points"]) for x in week}, "2026-09-27")
    assert qs and not any(x.startswith("Tarang Shakti") for q in qs for x in q["items"])
    assert "Tarang Shakti" not in qs[0]["why"]


def test_pool_is_stable_and_balanced():
    stories = [story("v1", "Exercise VARUNA 2026", paras=VARUNA), story("p1", "Parliament passes Transgender Bill", "polity", paras=PARL)]
    a = P.build_practice(payload(stories), "2026-09-26", {"v1": VARUNA, "p1": PARL}, week=[])
    b = P.build_practice(payload(stories), "2026-09-26", {"v1": VARUNA, "p1": PARL}, week=[])
    assert [q["id"] for q in a["questions"]] == [q["id"] for q in b["questions"]] and a["n"] >= 3  # same day, same ids
    per = {}
    for q in a["questions"]:
        per[q["story_id"]] = per.get(q["story_id"], 0) + 1
        assert 0 <= q["answer"] < 4 and len(set(q["options"])) == 4 and q["url"].startswith("https://")
    assert max(per.values()) <= P.PER_STORY


def test_pdf_has_every_section_and_a_link_per_item(tmp_path):
    ed = {**story("e1", "The case for a maritime doctrine", "defence", paras=["India must set out a maritime doctrine that ties the Navy to its trade routes."]), "editorial": True}
    fact = story("f1", "Cabinet approves Rs 17,167-crore outer harbour at VOC Port", "ir", paras=["The Cabinet approved ₹17,167 crore for the harbour."])
    more = story("m1", "Minister slams Opposition over walkout", "polity")
    stories = [story("v1", "Exercise VARUNA 2026", paras=VARUNA), story("p1", "Parliament passes Transgender Bill", "polity", paras=PARL), ed, fact, more]
    pl = {"days": {"2026-09-26": {"news": ["v1", "p1"], "prelims": ["f1"], "more": ["m1"], "folded": {}, "editorials": ["e1"], "explained": []}},
          "stories": stories}
    out = build_day_pdf(pl, "2026-09-26", LABELS, tmp_path / "brief.pdf", reported=480, site_url="https://example.org/UPSC/")
    r = PdfReader(str(out))
    text = " ".join(p.extract_text() for p in r.pages)
    for part in ("MUST-KNOW", "PRELIMS FACTS", "EDITORIAL WATCH", "ALSO IN THE NEWS", "COVERAGE CHECK", "INS Trishul", "Rs. 17,167"):
        assert part in text, part
    assert "₹" not in text
    links = [a.get_object()["/A"]["/URI"] for p in r.pages for a in p.get("/Annots") or [] if "/A" in a.get_object()]
    assert all(f"https://forumias.com/{i}" in links for i in ("v1", "p1", "e1", "f1", "m1"))
    assert "https://example.org/UPSC/#day/2026-09-26" in links


def test_pdf_text_is_drawable():
    assert clean("₹500 crore, CO₂ at 30°C — “quoted” … ॐ") == "Rs. 500 crore, CO2 at 30 degC — “quoted” …"

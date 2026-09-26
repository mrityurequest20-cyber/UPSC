import pytest


@pytest.mark.parametrize("title,subject,min_grade", [
    ("Supreme Court constitution bench upholds sub-classification of Scheduled Castes", "polity", "NOTE"),
    ("Cabinet approves PM-KISAN extension and new Mission for Aatmanirbharta in Pulses", "agriculture", "NOTE"),
    ("Pakke Tiger Reserve gets new rescue centre; IUCN lists hornbill as vulnerable", "environment", "NOTE"),
    ("RBI keeps repo rate unchanged, monetary policy stance neutral", "economy", "SKIM"),
    ("India and the Netherlands signed 2 MoUs on water projects", "ir", "READ"),
    ("DRDO successfully flight-tests Agni missile from Odisha coast", "defence", "SKIM"),
])
def test_examinable_headlines(clf, title, subject, min_grade):
    a = clf.analyze(title)
    grade = clf.grade(clf.score(a, "quality"))
    assert subject in a.subjects, a.subject_scores
    order = ["LOW", "READ", "SKIM", "NOTE"]
    assert order.index(grade) >= order.index(min_grade), (grade, a)


@pytest.mark.parametrize("title", [
    "Actor's new film breaks box office records",
    "Horoscope today: what the stars say for Leo",
    "IPL auction: franchise buys star batter for record sum",
    "RBI to conduct Overnight Variable Rate Reverse Repo (VRRR) auction under LAF",
])
def test_noise_is_low(clf, title):
    a = clf.analyze(title)
    assert clf.grade(clf.score(a, "quality")) == "LOW"


def test_act_is_case_sensitive(clf):
    assert clf.signals.find("Parliament passes the Digital Data Act")
    assert not clf.signals.find("leaders act quickly on relief")


def test_acronym_plurals_match(clf):
    assert "Agreement/MoU" in clf.analyze("India, UAE sign three MoUs on energy").tags
    assert "ir" in clf.analyze("India, UAE sign three MoUs on energy and trade").subjects


def test_watch_areas(clf):
    a = clf.analyze("Nepal Prime Minister resigns after protests; interim government sworn in")
    assert "neighbourhood" in a.watch
    b = clf.analyze("Govt appoints new RBI Deputy Governor")
    assert "appointments" in b.watch
    c = clf.analyze("Deep Ocean Mission: India to explore seabed minerals in its EEZ")
    assert "marine" in c.watch


def test_gs_and_prelims_mapping(clf):
    assert clf.gs_for(["polity", "environment"], ["Species"]) == ["GS2", "GS3", "Prelims"]
    assert clf.gs_for([], []) == []


def test_coverage_bonus_monotonic(clf):
    assert clf.coverage_bonus(1) == 0
    assert clf.coverage_bonus(2) < clf.coverage_bonus(8) <= 3.0

from upsc_intel.pipeline.cluster import similar
from upsc_intel.pipeline.normalize import title_tokens


def s(t):
    return set(title_tokens(t))


def test_same_story_different_outlets_merges():
    a = s("Centre extends AFSPA in parts of Manipur, Nagaland and Arunachal Pradesh for six months")
    b = s("AFSPA extended in parts of Manipur, Nagaland and Arunachal")
    assert similar(a, b) > 0


def test_near_identical_headline_merges():
    assert similar(s("IAS officer Mandeep Bhandari appointed chairperson of CBSE"),
                   s("Senior IAS officer Mandeep K Bhandari appointed CBSE chairperson")) > 0


def test_different_stories_do_not_merge():
    assert similar(s("RBI keeps repo rate unchanged at 5.5%"), s("SEBI tightens rules for F&O trading")) == 0
    assert similar(s("Cyclone warning for Odisha coast"), s("Cyclone relief package for Andhra farmers")) == 0
    assert similar(s("Supreme Court on Governor's assent to Bills"), s("Supreme Court on stray dogs in Delhi")) == 0

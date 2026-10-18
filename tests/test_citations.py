from glassbox.citations import changed_sentences, filter_citations

VALID = {"c1", "c2", "c3"}


def test_keeps_cited_drops_uncited_and_unknown():
    md = "Revenue grew 42% [c1]. Margins fell [c9]. Analysts were surprised [c2][c3]. Nobody knows why."
    r = filter_citations(md, VALID)
    assert r.markdown == "Revenue grew 42% [c1]. Analysts were surprised [c2][c3]."
    assert r.dropped == ["Margins fell [c9].", "Nobody knows why."]
    assert r.cited_claim_ids == ["c1", "c2", "c3"]


def test_strips_invalid_ids_but_keeps_sentence_with_a_valid_one():
    r = filter_citations("It doubled [c1][c7].", VALID)
    assert r.markdown == "It doubled [c1]."


def test_keeps_structure_and_removes_empty_headings():
    md = "## Answer\n\n- Point one [c1].\n- Point two.\n\n## Gaps\n\nUnclear."
    r = filter_citations(md, VALID)
    assert r.markdown == "## Answer\n\n- Point one [c1]."


def test_changed_sentences():
    assert changed_sentences(["A [c1].", "B [c2]."], ["A [c1].", "C [c3]."]) == [
        "C [c3]."
    ]

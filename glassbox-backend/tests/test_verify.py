from glassbox.verify import verify_quote

PAGE = (
    "The company said on Tuesday that revenue grew 42%\u00a0year over year.\n\n"
    "Analysts called it \u201cthe strongest quarter since 2021\u201d \u2014 a surprise."
)


def check(quote, expected):
    result = verify_quote(quote, PAGE)
    assert result.verified == expected, (quote, result)
    return result


def test_exact_match_returns_original_span():
    r = check("revenue grew 42% year over year", "exact")
    assert PAGE[r.span[0] : r.span[1]] == "revenue grew 42%\u00a0year over year"


def test_normalizes_quotes_dashes_case_and_whitespace():
    check('Analysts called it "the strongest quarter since 2021" - a surprise', "exact")
    check("REVENUE   GREW 42%\nyear over year", "exact")


def test_fuzzy_match_for_tiny_differences():
    r = check(
        "Analysts called it the strongest quarter since 2021 - a surprise", "fuzzy"
    )
    assert r.score >= 95


def test_not_found_for_paraphrase_or_empty():
    check("Revenue increased by nearly half compared to last year", "not_found")
    check("", "not_found")
    assert verify_quote("anything", "").verified == "not_found"


def test_quote_stitched_with_ellipsis_verifies_each_fragment_in_order():
    r = check(
        "The company said on Tuesday that revenue grew 42%... called it \u201cthe strongest quarter since 2021\u201d",
        "exact",
    )
    assert PAGE[r.span[0] : r.span[1]].startswith("The company said") and PAGE[
        r.span[0] : r.span[1]
    ].endswith("2021")
    check(
        "called it the strongest quarter since 2021 ... The company said on Tuesday",
        "not_found",
    )  # wrong order
    check(
        "The company said on Tuesday that revenue grew 42%... and profits tripled to a record high",
        "not_found",
    )

from glassbox.control import ClaimStore, SourceStore


def store(tmp_path):
    sources, claims = SourceStore(tmp_path), ClaimStore()
    a, _ = sources.add("https://www.a.com/x", "A", "")
    b, _ = sources.add("https://b.org/y", "B", "")
    a2, _ = sources.add("https://a.com/other", "A2", "")
    return sources, claims, a, b, a2


def add(claims, text, source, verified="exact"):
    return claims.add(
        dir="d1",
        text=text,
        quote=text,
        source_id=source.source_id,
        verified=verified,
        span=None,
    )


def test_same_fact_other_domain_corroborates_and_turns_green(tmp_path):
    sources, claims, a, b, _ = store(tmp_path)
    c1 = add(claims, "Toyota plans solid-state EVs by 2027", a)
    match = claims.find_corroborated(
        "Toyota plans to launch solid-state EVs by 2027", b.domain, sources
    )
    assert match == c1.claim_id
    c2 = claims.add(
        dir="d1",
        text="x",
        quote="x",
        source_id=b.source_id,
        verified="exact",
        span=None,
        corroborates=match,
    )
    assert (
        claims.status(c1.claim_id, sources) == "green"
        and claims.status(c2.claim_id, sources) == "green"
    )


def test_different_numbers_or_same_domain_never_corroborate(tmp_path):
    sources, claims, a, b, a2 = store(tmp_path)
    add(claims, "Costs will reach $140/kWh by 2028", a)
    assert (
        claims.find_corroborated("Costs will reach $100/kWh by 2028", b.domain, sources)
        is None
    )
    assert (
        claims.find_corroborated(
            "Costs will reach $140/kWh by 2028", a2.domain, sources
        )
        is None
    )


def test_status_grey_orange_red(tmp_path):
    sources, claims, a, b, _ = store(tmp_path)
    grey = add(claims, "unverified", a, verified="not_found")
    single = add(claims, "single source fact", a)
    assert claims.status(grey.claim_id, sources) == "grey"
    assert claims.status(single.claim_id, sources) == "orange"
    claims.add(
        dir="d1",
        text="opposite",
        quote="o",
        source_id=b.source_id,
        verified="exact",
        span=None,
        contradicts=single.claim_id,
    )
    assert claims.status(single.claim_id, sources) == "red"

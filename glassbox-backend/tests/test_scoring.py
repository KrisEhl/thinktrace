import pytest

from glassbox.checker import candidate_pairs
from glassbox.control import ClaimStore, SourceStore
from glassbox.scoring import UNRATED, Scorer, publisher


def claim(cid, domain, text="Berlin became a federal state in 1990.", verified="exact", dir="d1", **links):
    return {
        "type": "claim.recorded",
        "dir": dir,
        "data": {"claim_id": cid, "text": text, "source_id": f"s-{cid}", "domain": domain, "verified": verified, **links},
    }


def score(*events):
    s = Scorer()
    for e in events:
        s.feed(e)
    return s.compute()


def conf(result, cid):
    return result["claims"][cid]["confidence"]


def test_an_unrated_source_is_ordinary_evidence_not_doubt():
    assert conf(score(claim("c1", "some-local-paper.example")), "c1") == pytest.approx(UNRATED)


def test_rated_outlets_weigh_more_and_low_rated_ones_less():
    r = score(
        claim("c1", "reuters.com", "Fact one 1."),
        claim("c2", "youtube.com", "Fact two 2."),
        claim("c3", "unknown-blog.example", "Fact three 3."),
    )
    assert conf(r, "c1") > conf(r, "c3") > conf(r, "c2")


def test_independent_agreement_raises_confidence_noisy_or():
    r = score(claim("c1", "a-paper.example"), claim("c2", "b-paper.example", corroborates="c1"))
    assert conf(r, "c1") == conf(r, "c2") == pytest.approx(1 - (1 - UNRATED) ** 2, abs=1e-3)
    assert len(r["claims"]["c1"]["origins"]) == 2


def test_the_same_publisher_counts_once():
    assert publisher("en.wikipedia.org") == publisher("de.wikipedia.org") == "wikipedia.org"
    assert publisher("news.bbc.co.uk") == "bbc.co.uk"
    alone = conf(score(claim("c1", "en.wikipedia.org")), "c1")
    copied = score(claim("c1", "en.wikipedia.org"), claim("c2", "de.wikipedia.org", corroborates="c1"))
    assert conf(copied, "c2") == pytest.approx(alone)


def test_contradiction_weighs_the_two_sides_against_each_other():
    even = score(claim("c1", "a.example", "It is 5."), claim("c2", "b.example", "It is 7.", contradicts="c1"))
    assert conf(even, "c1") == pytest.approx(0.5) and even["claims"]["c1"]["contested"]
    lopsided = score(
        claim("c1", "a.example", "It is 5."),
        claim("c2", "b.example", "It is 5 indeed.", corroborates="c1"),
        claim("c3", "c.example", "It is 7.", contradicts="c1"),
    )
    assert conf(lopsided, "c1") > 0.5 > conf(lopsided, "c3")


def test_the_fact_checkers_source_classification_is_used():
    gov = {"type": "source.classified", "data": {"domain": "berlin.de", "kind": "government"}}
    text = "Berlin is a city-state."
    assert score(claim("c1", "berlin.de", text))["claims"]["c1"]["role"] == "party"  # name heuristic alone
    r = score(gov, claim("c1", "berlin.de", text))
    assert r["claims"]["c1"]["role"] == "institution" and conf(r, "c1") == pytest.approx(0.85)


def test_unverified_quotes_score_zero_and_directions_average_their_claims():
    r = score(claim("c1", "a.example", verified="not_found"), claim("c2", "b.example"), claim("c3", "reuters.com", "Other fact 3."))
    assert conf(r, "c1") == 0 and r["claims"]["c1"]["fact"] is None
    assert r["directions"]["d1"] == pytest.approx((conf(r, "c2") + conf(r, "c3")) / 2, abs=1e-3)


def test_candidate_pairs_propose_paraphrases_across_domains(tmp_path):
    sources, claims = SourceStore(tmp_path), ClaimStore()
    rows = [
        ("https://a.example/1", "Berlin became one of Germany's 16 federal states after reunification in 1990."),
        ("https://b.example/2", "After the 1990 reunification, Berlin became a federal state of Germany."),
        ("https://a.example/3", "Berlin became a federal state in 1990 after reunification."),  # same domain as the first
        ("https://c.example/4", "Hamburg has a port."),
    ]
    for url, text in rows:
        src, _ = sources.add(url, "t", "")
        claims.add(dir="d1", text=text, quote=text, source_id=src.source_id, verified="exact", span=None)
    pairs = {(a, b) for a, b, _ in candidate_pairs(claims, sources, set())}
    assert ("c2", "c1") in pairs and ("c3", "c2") in pairs
    assert ("c3", "c1") not in pairs  # same domain is never corroboration
    assert not any("c4" in p for p in pairs)


def test_a_pair_judged_in_two_batches_is_linked_once(tmp_path):
    from glassbox.checker import Link, apply_links

    sources, claims = SourceStore(tmp_path), ClaimStore()
    for url in ("https://a.example/1", "https://b.example/2", "https://c.example/3"):
        src, _ = sources.add(url, "t", "")
        claims.add(dir="d1", text="Same fact.", quote="Same fact.", source_id=src.source_id, verified="exact", span=None)
    claims.claims["c2"].corroborates = "c3"  # c2 already agrees with another claim
    twice = [Link(claim="c2", relation="corroborates", target="c1", reason="same")] * 2
    assert len(apply_links(twice, claims, sources)) == 1


# ---- time, balance, fact-check verdicts -------------------------------------------------------------
from datetime import date, timedelta

TODAY = date(2026, 10, 18)


def dated(cid, domain, value, days_ago, kind="volatile", dir="d2"):
    as_of = (TODAY - timedelta(days=days_ago)).isoformat()
    # The text must not name the seller, or the source would count as reporting on itself.
    return claim(cid, domain, f"A new RTX 5090 cost ${value} on {as_of}.", dir=dir, as_of=as_of, kind=kind, value=value, unit="USD")


def scored(*events):
    s = Scorer()
    for e in events:
        s.feed(e)
    return s.compute(today=TODAY)


def test_an_old_volatile_claim_loses_at_most_half_its_confidence():
    r = scored(dated("c1", "shop.example", 3899, 600), dated("c2", "other.example", 3299, 1))
    assert conf(r, "c1") == pytest.approx(UNRATED * 0.5, abs=0.01)
    assert conf(r, "c2") > 0.6
    assert scored(dated("c1", "shop.example", 1999, 600, kind="stable"))["claims"]["c1"]["confidence"] == pytest.approx(UNRATED)


def test_a_changing_price_gets_a_recent_weighted_estimate_not_the_launch_spike():
    series = [(600, 3899), (480, 2999), (120, 2999), (45, 3149), (14, 3249), (7, 3299), (3, 3279)]
    events = [dated(f"c{i}", f"shop{i}.example", v, ago) for i, (ago, v) in enumerate(series, 1)]
    est = scored(*events)["direction_detail"]["d2"]["series"]
    assert est["unit"] == "USD" and 3150 < est["now"] < 3320
    assert est["trend_per_30d"] > 0 and est["in_30d"][0] < est["in_30d"][1]
    assert est["newest_days"] == 3


def test_a_direction_resting_on_self_reporting_sources_is_flagged():
    texts = ["Helion will deliver power by 2028.", "Helion raised $425M.", "Helion's Polaris works."]
    r = scored(*[claim(f"c{i}", "helionenergy.com", t) for i, t in enumerate(texts, 1)])
    assert r["direction_detail"]["d1"]["blindspot"] == "party"
    assert r["direction_detail"]["d1"]["mix"] == {"party": 1.0}


def test_a_fact_check_verdict_feeds_the_score():
    base = conf(scored(claim("c1", "a.example")), "c1")
    upheld = {"type": "claim.challenged", "data": {"claim_id": "c1", "verdict": "upheld", "evidence": [
        {"domain": "reuters.com", "stance": "supports", "verified": "exact"}]}}
    refuted = {"type": "claim.challenged", "data": {"claim_id": "c1", "verdict": "refuted", "evidence": [
        {"domain": "reuters.com", "stance": "contradicts", "verified": "exact"}]}}
    weakened = {"type": "claim.challenged", "data": {"claim_id": "c1", "verdict": "weakened", "corrected_claim": "Only in 1991.", "evidence": []}}
    assert conf(scored(claim("c1", "a.example"), upheld), "c1") > base
    r = scored(claim("c1", "a.example"), refuted)
    assert conf(r, "c1") < 0.3 and r["claims"]["c1"]["contested"]
    w = scored(claim("c1", "a.example"), weakened)
    assert conf(w, "c1") == pytest.approx(base * 0.75, abs=1e-3) and w["claims"]["c1"]["check"]["corrected_claim"] == "Only in 1991."


def test_reported_gaps_are_kept_per_direction():
    gap = {"type": "direction.finished", "dir": "d1", "data": {"id": "d1", "reason": "budget", "remaining_gaps": "No 2026 data."}}
    assert scored(claim("c1", "a.example"), gap)["direction_detail"]["d1"]["gaps"] == "No 2026 data."


def test_dates_from_the_model_are_normalised():
    from glassbox.tools import _iso_date

    assert _iso_date("2026-10-3") == "2026-10-03"
    assert _iso_date("2025-02") == "2025-02"
    assert _iso_date("October 2026") is None and _iso_date(None) is None and _iso_date("0001") is None

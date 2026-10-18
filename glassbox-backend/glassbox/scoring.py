"""Claim confidence from source reliability and independent agreement (deterministic, auditable).

The LLM decides *which* claims state the same fact or contradict each other (researcher links and the
fact-checker's pair verdicts); this module turns those links into numbers:

1. Source reliability r: expert news-domain ratings (Lin et al. 2023, PNAS Nexus, 11,520 domains) where
   available, else a role prior. Unrated sources are normal, not suspect.
2. Quote factor q: how well the quote was found in the source (exact > near match > snippet only).
3. Agreement: claims linked as "corroborates" (or near-identical with the same numbers) form one fact.
   Sources from the same publisher (registrable domain) count once: copies are not corroboration.
4. Support of a fact = 1 - prod(1 - r*q) over its independent origins (noisy-OR, as in TruthFinder,
   Yin et al. 2007). A fact contradicted by another is normalised against it as competing hypotheses:
   conf = s(1-o) / (s(1-o) + o(1-s)).
5. A direction's confidence is the mean confidence of its verified claims.
6. Time: a dated "event" or "volatile" claim decays with a half-life (90 / 14 days; settled facts do not decay). Its own
   confidence loses at most half (it is still true of its time); in the estimate of a changing quantity it weighs
   fully (Atanasov et al. 2017). That estimate is a weighted trimmed mean with a weighted trend and a widening band
   (Halawi et al. 2024; dynamic truth discovery, Li et al. 2015).
7. Balance: each direction reports the share of evidence by kind of source and flags a blindspot when one
   non-rated kind carries 80%+ of it (primary definers, Hall et al. 1978; Ground News).
8. A fact-check verdict (adversarial challenge) adds its verified supporting quotes as origins and its contradicting
   quotes as an opposing fact; "weakened" lowers confidence by a quarter.

Works on the event log, so live runs and recorded runs are scored the same way:
    uv run python -m glassbox.scoring runs/<id>
"""

from __future__ import annotations

import csv
import math
import re
import statistics
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz

# Shipped with the package; the web frontend keeps its own copy for in-browser use.
_HERE = Path(__file__).resolve().parent
RATINGS_CSV = next(
    (p for p in (_HERE / "domain_pc1.csv", _HERE.parent / "web" / "src" / "data" / "domain_pc1.csv") if p.exists()),
    _HERE / "domain_pc1.csv",
)

UNRATED = 0.65  # an ordinary source nobody has rated: counts as normal evidence
INSTITUTION = 0.85  # public institutions and scholarly indexes
PARTY = 0.5  # a source reporting on itself: informative about its own plans, not independent
QUOTE_FACTOR = {"exact": 1.0, "fuzzy": 0.9, "snippet": 0.8}
# Source kinds as classified by the fact-checker LLM (checker.py) for domains without an expert rating.
KIND = {
    "government": (0.85, "institution", "government or official body (classified by the fact-checker)"),
    "institution": (0.85, "institution", "research or international institution (classified by the fact-checker)"),
    "reference": (0.75, "unrated", "reference work (classified by the fact-checker)"),
    "news": (0.65, "unrated", "news outlet without an expert rating (classified by the fact-checker)"),
    "commercial": (0.6, "unrated", "seller or vendor site (classified by the fact-checker)"),
    "other": (0.55, "unrated", "blog, forum or other (classified by the fact-checker)"),
    "self": (PARTY, "party", "speaks about itself (classified by the fact-checker)"),
}

_INSTITUTION = re.compile(
    r"\.(gov|edu|int|mil)(\.[a-z]{2})?$|\.(ac|gov|gc)\.[a-z]{2}$|(^|\.)europa\.eu$"
    r"|(^|\.)(arxiv\.org|doi\.org|ncbi\.nlm\.nih\.gov|pubmed\.ncbi\.nlm\.nih\.gov|ssrn\.com)$"
)
_SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov", "edu"}
_NUMBER_RE = re.compile(r"\d[\d,.]*")
_COMMON = {"inside", "world", "global", "energy", "news", "open", "this", "these", "their", "with", "from"}


def bare(domain: str) -> str:
    return domain.lower().removeprefix("www.")


def publisher(domain: str) -> str:
    """Registrable domain: en.wikipedia.org and de.wikipedia.org are one publisher."""
    labels = bare(domain).split(".")
    if len(labels) >= 3 and labels[-2] in _SECOND_LEVEL and len(labels[-1]) == 2:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


@lru_cache(maxsize=1)
def ratings() -> dict[str, float]:
    if not RATINGS_CSV.exists():
        return {}
    with RATINGS_CSV.open(encoding="utf-8") as f:
        return {row["domain"].strip(): float(row["pc1"]) for row in csv.DictReader(f)}


def _rated(domain: str) -> tuple[str, float] | None:
    labels = bare(domain).split(".")
    table = ratings()
    for i in range(len(labels) - 1):
        key = ".".join(labels[i:])
        if key in table:
            return key, table[key]
    return None


def _is_party(domain: str, claim_texts: list[str]) -> bool:
    stem = publisher(domain).split(".")[0].replace("-", "")
    if len(stem) < 3:
        return False
    text = " ".join(claim_texts)
    words = [w for w in re.split(r"[^a-z0-9]+", text.lower()) if w]
    for i in range(len(words)):
        for n in (1, 2, 3):
            if "".join(words[i : i + n]) == stem:
                return True
    brands = {b.lower() for b in re.findall(r"\b(?:[A-Z][a-z]{3,}|[A-Z]{3,})\b", text)} - _COMMON
    return any(stem.startswith(b) for b in brands)


@dataclass
class Reliability:
    value: float
    role: str  # rated | institution | party | unrated
    basis: str


def reliability(domain: str, claim_texts: list[str], kind: str | None = None) -> Reliability:
    r = _rated(domain)
    if r:
        # pc1 1.0 -> 0.95, 0.85 -> 0.85, 0.5 -> 0.63, 0.2 -> 0.43: low-rated outlets fall below "unrated".
        value = 0.30 + 0.65 * r[1]
        return Reliability(round(value, 3), "rated", f"expert rating {r[1]:.2f} for {r[0]} (Lin et al. 2023)")
    if kind in KIND:
        value, role, basis = KIND[kind]
        return Reliability(value, role, basis)
    if _INSTITUTION.search(bare(domain)):
        return Reliability(INSTITUTION, "institution", "public institution or scholarly index")
    if _is_party(domain, claim_texts):
        return Reliability(PARTY, "party", "reports on itself")
    return Reliability(UNRATED, "unrated", "not in the expert ratings: counted as an ordinary source")


HALF_LIFE_DAYS = {"volatile": 14, "event": 90}  # "stable" facts do not decay
STALE_FLOOR = 0.5  # recency can at most halve a claim's own confidence
TRIM = 0.1
HORIZON_DAYS = 30


def parse_date(text: str | None) -> date | None:
    m = re.match(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$", (text or "").strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2) or 7), int(m.group(3) or (15 if m.group(2) else 1))
    try:
        return date(y, mo, d)
    except ValueError:
        return None


def decay(as_of: str | None, kind: str | None, today: date) -> float:
    d = parse_date(as_of)
    if kind not in HALF_LIFE_DAYS or d is None:
        return 1.0
    return 2 ** (-max(0, (today - d).days) / HALF_LIFE_DAYS[kind])


@dataclass
class ClaimIn:
    claim_id: str
    dir: str | None
    text: str
    source_id: str
    domain: str
    verified: str  # exact | fuzzy | not_found
    verified_against: str | None = None
    as_of: str | None = None
    kind: str | None = None
    value: float | None = None
    unit: str | None = None
    links: list[tuple[str, str]] = field(default_factory=list)  # (relation, target)


class _UnionFind:
    def __init__(self):
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb, key=_num)] = min(ra, rb, key=_num)


def _num(claim_id: str) -> int:
    return int(re.sub(r"\D", "", claim_id) or 0)


def same_fact_by_text(a: str, b: str) -> bool:
    """Fallback for links the LLM missed: near-identical wording and identical numbers."""
    return set(_NUMBER_RE.findall(a)) == set(_NUMBER_RE.findall(b)) and fuzz.token_set_ratio(a.lower(), b.lower()) >= 88


def _num_or_none(x: Any) -> float | None:
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _trimmed_mean(obs: list[tuple[float, float]]) -> float:
    """Weighted mean of (value, weight) after trimming TRIM of the weight at each tail."""
    obs = sorted(obs)
    total = sum(w for _, w in obs)
    lo, hi, acc, num, den = total * TRIM, total * (1 - TRIM), 0.0, 0.0, 0.0
    for v, w in obs:
        inside = max(0.0, min(acc + w, hi) - max(acc, lo))
        num += inside * v
        den += inside
        acc += w
    return num / den if den else float("nan")


def estimate(points: list[tuple[float, float, float]]) -> dict[str, Any] | None:
    """points: (t in days relative to today, value, weight). Weighted trimmed-mean level, weighted trend, band."""
    points = [p for p in points if p[2] > 1e-4]
    if len(points) < 3:
        return None
    W = sum(w for *_, w in points)
    mt = sum(w * t for t, _, w in points) / W
    mv = sum(w * v for _, v, w in points) / W
    sxx = sum(w * (t - mt) ** 2 for t, _, w in points)
    slope = sum(w * (t - mt) * (v - mv) for t, v, w in points) / sxx if sxx > 0 else 0.0
    sigma = math.sqrt(sum(w * (v - (mv + slope * (t - mt))) ** 2 for t, v, w in points) / W)
    level = _trimmed_mean([(v, w) for _, v, w in points])
    band = lambda t: sigma * math.sqrt(1 + t / 14)  # noqa: E731
    mid30 = level + slope * HORIZON_DAYS
    return {
        "now": round(level, 2),
        "low": round(level - sigma, 2),
        "high": round(level + sigma, 2),
        "trend_per_30d": round(slope * 30, 2),
        "in_30d": [round(mid30 - band(HORIZON_DAYS), 2), round(mid30 + band(HORIZON_DAYS), 2)],
        "n": len(points),
        "n_eff": round(W**2 / sum(w * w for *_, w in points), 1),
        "newest_days": round(min(-t for t, *_ in points)),
    }


class Scorer:
    """Feed it events (live or from a log); compute() returns per-claim and per-direction confidence."""

    def __init__(self):
        self.claims: dict[str, ClaimIn] = {}
        self.domains: dict[str, str] = {}  # source_id -> domain
        self.links: list[tuple[str, str, str]] = []  # (claim, relation, target)
        self.kinds: dict[str, str] = {}  # domain -> source kind from the fact-checker
        self.gaps: dict[str, str] = {}  # direction -> remaining gaps reported by its researcher
        self.checks: dict[str, dict] = {}  # claim -> adversarial fact-check verdict

    def feed(self, event: dict[str, Any]) -> bool:
        """Returns True when the event can change scores."""
        t, d = event.get("type"), event.get("data") or {}
        if t == "source.classified" and d.get("domain"):
            self.kinds[bare(d["domain"])] = d.get("kind", "other")
            return True
        if t == "source.added" and d.get("source_id"):
            self.domains[d["source_id"]] = d.get("domain") or ""
            return False
        if t == "claim.recorded":
            domain = d.get("domain") or self.domains.get(d.get("source_id", ""), "")
            self.domains.setdefault(d.get("source_id", ""), domain)
            self.claims[d["claim_id"]] = ClaimIn(
                d["claim_id"], event.get("dir"), d.get("text", ""), d.get("source_id", ""), domain,
                d.get("verified", "exact"), d.get("verified_against"),
                as_of=d.get("as_of") or None, kind=d.get("kind") or None,
                value=_num_or_none(d.get("value")), unit=d.get("unit") or None,
            )
            for rel in ("corroborates", "contradicts"):
                if d.get(rel) and d[rel] != "None":
                    self.links.append((d["claim_id"], rel, d[rel]))
            return True
        if t == "claim.linked" and d.get("claim_id") and d.get("target"):
            self.links.append((d["claim_id"], d.get("relation", "corroborates"), d["target"]))
            return True
        if t == "claim.challenged" and d.get("claim_id"):
            self.checks[d["claim_id"]] = d
            return True
        if t == "direction.finished" and (d.get("id") or event.get("dir")):
            if d.get("remaining_gaps"):
                self.gaps[d.get("id") or event["dir"]] = d["remaining_gaps"]
            return True
        return False

    def compute(self, today: date | None = None) -> dict[str, Any]:
        today = today or date.today()
        live = {cid: c for cid, c in self.claims.items() if c.verified != "not_found"}
        texts_by_domain: dict[str, list[str]] = {}
        for c in live.values():
            texts_by_domain.setdefault(bare(c.domain), []).append(c.text)

        def rel_of(domain: str) -> Reliability:
            return reliability(domain, texts_by_domain.get(bare(domain), []), self.kinds.get(bare(domain)))

        rel = {cid: rel_of(c.domain) for cid, c in live.items()}
        quote = {
            cid: QUOTE_FACTOR["snippet"] if c.verified_against == "snippet" else QUOTE_FACTOR.get(c.verified, 0.9)
            for cid, c in live.items()
        }
        fresh = {cid: decay(c.as_of, c.kind, today) for cid, c in live.items()}
        # A claim's own weight: reliability x quote x (recency, floored: an old claim is still true of its time).
        own_p = {cid: rel[cid].value * quote[cid] * (STALE_FLOOR + (1 - STALE_FLOOR) * fresh[cid]) for cid in live}

        uf = _UnionFind()
        for cid in live:
            uf.find(cid)
        for a, relation, b in self.links:
            if relation == "corroborates" and a in live and b in live:
                uf.union(a, b)
        ids = list(live)
        for i, a in enumerate(ids):  # the text fallback, across publishers only
            for b in ids[i + 1 :]:
                if uf.find(a) != uf.find(b) and publisher(live[a].domain) != publisher(live[b].domain) and same_fact_by_text(live[a].text, live[b].text):
                    uf.union(a, b)

        facts: dict[str, list[str]] = {}
        for cid in live:
            facts.setdefault(uf.find(cid), []).append(cid)

        def check_origins(cid: str, stance: str) -> list[dict]:
            out = []
            for ev in (self.checks.get(cid) or {}).get("evidence", []):
                if ev.get("stance") == stance and ev.get("verified") and ev.get("domain"):
                    r = rel_of(ev["domain"])
                    q = QUOTE_FACTOR.get(ev["verified"], 0.9)
                    out.append({"publisher": publisher(ev["domain"]), "domain": ev["domain"], "claim_id": None, "role": r.role,
                                "reliability": r.value, "quote_factor": q, "p": round(r.value * q, 3), "basis": f"fact-check: {r.basis}"})
            return out

        def noisy_or(origins: list[dict]) -> tuple[float, list[dict]]:
            best: dict[str, dict] = {}
            for o in origins:
                if o["publisher"] not in best or o["p"] > best[o["publisher"]]["p"]:
                    best[o["publisher"]] = o
            miss = 1.0
            for o in best.values():
                miss *= 1 - o["p"]
            return 1 - miss, sorted(best.values(), key=lambda o: -o["p"])

        def support(fact: str) -> tuple[float, list[dict]]:
            origins = [
                {"publisher": publisher(live[cid].domain), "domain": live[cid].domain, "claim_id": cid, "role": rel[cid].role,
                 "reliability": rel[cid].value, "quote_factor": quote[cid], "p": round(own_p[cid], 3), "basis": rel[cid].basis}
                for cid in facts[fact]
            ]
            for cid in facts[fact]:
                origins += check_origins(cid, "supports")
            return noisy_or(origins)

        supports = {f: support(f) for f in facts}
        opposed: dict[str, set[str]] = {}
        for a, relation, b in self.links:
            if relation == "contradicts" and a in live and b in live and uf.find(a) != uf.find(b):
                opposed.setdefault(uf.find(a), set()).add(uf.find(b))
                opposed.setdefault(uf.find(b), set()).add(uf.find(a))

        fact_conf: dict[str, float] = {}
        verdicts: dict[str, set[str]] = {}
        for f in facts:
            verdicts[f] = {(self.checks.get(cid) or {}).get("verdict") for cid in facts[f]} - {None}
        for f, (s_, _) in supports.items():
            against = [supports[g][0] for g in opposed.get(f, ())]
            check_against = [cid for cid in facts[f] if check_origins(cid, "contradicts")]
            if check_against:
                against.append(noisy_or([o for cid in check_against for o in check_origins(cid, "contradicts")])[0])
            o = max(against, default=0.0)
            conf = s_ if o == 0 else s_ * (1 - o) / (s_ * (1 - o) + o * (1 - s_))
            if "weakened" in verdicts[f]:
                conf *= 0.75
            if "refuted" in verdicts[f] and not check_against:
                conf *= 0.5
            fact_conf[f] = conf

        claims_out: dict[str, Any] = {}
        for cid, c in self.claims.items():
            check = self.checks.get(cid)
            check_out = {"verdict": check.get("verdict"), "corrected_claim": check.get("corrected_claim", "")} if check else None
            if cid not in live:
                claims_out[cid] = {"confidence": 0.0, "fact": None, "origins": [], "contested": False, "check": check_out}
                continue
            f = uf.find(cid)
            claims_out[cid] = {
                "confidence": round(fact_conf[f], 3),
                "fact": f,
                "origins": supports[f][1],
                "support": round(supports[f][0], 3),
                "contested": bool(opposed.get(f)) or bool(verdicts[f] & {"refuted", "weakened"}),
                "role": rel[cid].role,
                "recency": round(fresh[cid], 3),
                "check": check_out,
            }

        by_dir: dict[str, list[str]] = {}
        for cid, c in live.items():
            if c.dir:
                by_dir.setdefault(c.dir, []).append(cid)
        directions = {d: round(statistics.fmean(claims_out[cid]["confidence"] for cid in v), 3) for d, v in by_dir.items()}

        detail: dict[str, Any] = {}
        for d in set(by_dir) | set(self.gaps):
            cids = by_dir.get(d, [])
            weight: Counter = Counter()
            for cid in cids:
                weight[rel[cid].role] += own_p[cid]
            total = sum(weight.values())
            mix = {role: round(w / total, 3) for role, w in weight.items()} if total else {}
            top = max(mix.items(), key=lambda x: x[1], default=(None, 0))
            blindspot = top[0] if len(cids) >= 3 and top[1] >= 0.8 and top[0] != "rated" else None
            series = None
            dated = [cid for cid in cids if live[cid].kind == "volatile" and live[cid].value is not None and parse_date(live[cid].as_of)]
            if dated:
                unit = Counter(live[cid].unit for cid in dated).most_common(1)[0][0]
                points = [
                    (-(today - parse_date(live[cid].as_of)).days, live[cid].value, rel[cid].value * quote[cid] * fresh[cid])
                    for cid in dated
                    if live[cid].unit == unit
                ]
                series = estimate(points)
                if series:
                    series["unit"] = unit
                    series["as_of"] = today.isoformat()
            detail[d] = {"mix": mix, "blindspot": blindspot, "series": series, "gaps": self.gaps.get(d)}
        return {"claims": claims_out, "directions": directions, "direction_detail": detail, "n_facts": len(facts)}


def event_data(result: dict[str, Any]) -> dict[str, Any]:
    """The compact form published as a `scores.updated` event."""
    return {
        "claims": {
            cid: {k: v[k] for k in ("confidence", "fact", "contested", "role", "recency", "check") if k in v}
            | {"origins": [{k: o[k] for k in ("publisher", "domain", "role", "reliability", "p")} for o in v["origins"]]}
            for cid, v in result["claims"].items()
        },
        "directions": result["directions"],
        "direction_detail": result.get("direction_detail", {}),
        "n_facts": result["n_facts"],
    }


def score_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    scorer = Scorer()
    for e in events:
        scorer.feed(e)
    return scorer.compute()


def _old_rule(events: list[dict[str, Any]]) -> list[float]:
    """The previous rule (verified -> 0.5, 2 domains -> 0.75, 3+ -> 0.9), for comparison."""
    scorer = Scorer()
    for e in events:
        scorer.feed(e)
    out = []
    for cid, c in scorer.claims.items():
        if c.verified == "not_found":
            continue
        group = {cid} | {b for a, r, b in scorer.links if a == cid and r == "corroborates"} | {a for a, r, b in scorer.links if b == cid and r == "corroborates"}
        n = len({scorer.claims[g].domain for g in group if g in scorer.claims})
        out.append(0.9 if n >= 3 else 0.75 if n == 2 else 0.5)
    return out


def _bands(xs: list[float]) -> str:
    n = len(xs) or 1
    green = sum(x >= 0.75 for x in xs)
    mid = sum(0.5 <= x < 0.75 for x in xs)
    red = sum(x < 0.5 for x in xs)
    return f"green {green} ({green / n:.0%}) · yellow/orange {mid} ({mid / n:.0%}) · red {red} ({red / n:.0%})"


def main(argv: list[str]) -> None:
    from .events import read_events

    for run_dir in argv or ["runs/sample"]:
        events = read_events(Path(run_dir) / "events.jsonl")
        result = score_events(events)
        confs = [c["confidence"] for c in result["claims"].values() if c["fact"]]
        roles: dict[str, int] = {}
        for c in result["claims"].values():
            if c["fact"]:
                roles[c["role"]] = roles.get(c["role"], 0) + 1
        multi = sum(1 for c in result["claims"].values() if len(c["origins"]) >= 2)
        print(f"\n{run_dir}: {len(confs)} verified claims in {result['n_facts']} distinct facts; {multi} claims backed by 2+ publishers")
        print(f"  sources by role: {roles}")
        print(f"  old rule: {_bands(_old_rule(events))}")
        print(f"  new score: {_bands(confs)}  (mean {statistics.fmean(confs) if confs else 0:.2f})")
        for d, v in sorted(result["directions"].items()):
            print(f"  direction {d}: {v:.2f}")


if __name__ == "__main__":
    main(sys.argv[1:])

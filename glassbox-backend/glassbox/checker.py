"""Fact-checker: one model call that judges which claims agree or conflict, and what kind of source each
unrated domain is. The LLM makes these semantic calls; glassbox/scoring.py turns them into numbers.

Candidate pairs are proposed in code (blocking, as in record linkage): judging a short list of pairs is far more
reliable than asking the model to find every match among 50 claims, which found almost none in practice.
"""

import re
from typing import Literal

from pydantic import BaseModel, Field
from rapidfuzz import fuzz

from .control import ClaimStore, SourceStore

CHECKER_PROMPT = """You are a strict fact-checker. You get numbered claims, each from one web source (domain in brackets),
a list of CANDIDATE PAIRS to judge, and a list of SOURCES to classify.

1. For each candidate pair, decide:
   - "corroborates": both claims state the same fact about the same subject (same numbers if any). Paraphrases and
     one claim being a more detailed version of the other count. Related-but-different facts do NOT.
   - "contradicts": incompatible statements about the same thing (different numbers for the same metric, opposite
     conclusions).
   - otherwise leave the pair out.
   You may also link other pairs you notice. Link the LATER claim (higher number) to the EARLIER one, with a
   one-sentence reason.
2. For each listed source domain, say what kind of source it is, judged from the domain and what it is quoted for:
   - "government": a government, parliament, ministry, agency, court or official city/state site
   - "institution": university, research institute, international organisation, scholarly publisher or index
   - "news": a news or magazine outlet
   - "reference": an encyclopedia or reference work
   - "self": the organisation the quoted claims are ABOUT, speaking about itself (a company on its own products or
     plans, an advocacy group on its own campaign)
   - "commercial": a seller, vendor or marketing site not speaking about itself
   - "other": blog, forum, social media, SEO content or unknown
Return empty lists if there is nothing to report. Keep your reasoning short: judge each item in a sentence, then
answer with the tool call."""


class Link(BaseModel):
    claim: str = Field(description="The later claim id, e.g. c12")
    relation: Literal["corroborates", "contradicts"]
    target: str = Field(description="The earlier claim id, e.g. c3")
    reason: str = Field(description="One sentence")


SourceKind = Literal["government", "institution", "news", "reference", "self", "commercial", "other"]


class SourceRole(BaseModel):
    domain: str
    kind: SourceKind
    reason: str = Field(default="", description="A few words")


class Links(BaseModel):
    links: list[Link]
    sources: list[SourceRole] = Field(default_factory=list, description="One entry per listed source domain")


_NUM = re.compile(r"\d[\d,.]*")
_ENT = re.compile(r"\b[A-Z][\w-]{2,}\b")


def candidate_pairs(claims: ClaimStore, sources: SourceStore, exclude_dirs: set[str], limit: int = 80) -> list[tuple[str, str, int]]:
    """Pairs of claims from different domains that might state the same fact: shared wording, numbers or names."""
    live = [
        c for c in claims.claims.values()
        if c.verified != "not_found" and c.dir not in exclude_dirs and c.source_id in sources.by_id
    ]
    out = []
    for i, a in enumerate(live):
        for b in live[i + 1 :]:
            if sources.by_id[a.source_id].domain == sources.by_id[b.source_id].domain:
                continue
            score = fuzz.token_set_ratio(a.text.lower(), b.text.lower())
            shared_num = bool(set(_NUM.findall(a.text)) & set(_NUM.findall(b.text)))
            shared_ent = len(set(_ENT.findall(a.text)) & set(_ENT.findall(b.text)))
            if score >= 60 or (shared_num and score >= 45) or (shared_ent >= 2 and score >= 50):
                later, earlier = (a, b) if int(a.claim_id[1:]) > int(b.claim_id[1:]) else (b, a)
                out.append((later.claim_id, earlier.claim_id, int(score + 10 * shared_num + 5 * shared_ent)))
    out.sort(key=lambda x: -x[2])
    return out[:limit]


BATCH = 12  # small batches: a reasoning model given every pair at once spent its whole output budget thinking


def check_batches(
    claims: ClaimStore, sources: SourceStore, exclude_dirs: set[str], classify: list[str], size: int = BATCH
) -> list[str]:
    """Inputs for independent checker calls: pair batches (with only the claims they mention) and source batches."""
    pairs = candidate_pairs(claims, sources, exclude_dirs)
    batches = []
    for i in range(0, len(pairs), size):
        chunk = pairs[i : i + size]
        ids = {x for a, b, _ in chunk for x in (a, b)}
        lines = [
            f"{c.claim_id} [{sources.by_id[c.source_id].domain}]: {c.text}"
            for c in claims.claims.values()
            if c.claim_id in ids
        ]
        batches.append("\n".join(lines) + "\n\nCANDIDATE PAIRS (later ~ earlier):\n" + "\n".join(f"{a} ~ {b}" for a, b, _ in chunk))
    for i in range(0, len(classify), size):
        batches.append("No candidate pairs in this batch.\n\nSOURCES to classify:\n" + "\n".join(classify[i : i + size]))
    return batches


def claims_listing(
    claims: ClaimStore, sources: SourceStore, exclude_dirs: set[str]
) -> str:
    lines = []
    for c in claims.claims.values():
        if (
            c.verified == "not_found"
            or c.dir in exclude_dirs
            or c.source_id not in sources.by_id
        ):
            continue
        lines.append(f"{c.claim_id} [{sources.by_id[c.source_id].domain}]: {c.text}")
    return "\n".join(lines)


def apply_links(
    links: list[Link], claims: ClaimStore, sources: SourceStore
) -> list[dict]:
    """Apply checker links that pass code-level rules. Returns the accepted links."""
    accepted = []
    seen: set[tuple[str, str, str]] = set()  # batches can judge the same pair twice
    for link in links:
        a, b = claims.claims.get(link.claim), claims.claims.get(link.target)
        if (
            not a
            or not b
            or a.claim_id == b.claim_id
            or "not_found" in (a.verified, b.verified)
        ):
            continue
        if int(a.claim_id[1:]) < int(b.claim_id[1:]):
            a, b = b, a
        if (a.claim_id, link.relation, b.claim_id) in seen:
            continue
        seen.add((a.claim_id, link.relation, b.claim_id))
        domain_a, domain_b = (
            sources.by_id[a.source_id].domain,
            sources.by_id[b.source_id].domain,
        )
        if link.relation == "corroborates":
            if domain_a == domain_b or claims.group_root(b.claim_id) == claims.group_root(a.claim_id):
                continue  # same origin is not corroboration; already in the same fact
            # A claim can agree with several others (the scorer uses every link); the store keeps one pointer.
            target = claims.group_root(b.claim_id)
            if not a.corroborates:
                a.corroborates = target
        else:
            if a.contradicts:
                continue
            a.contradicts = b.claim_id
        accepted.append(
            {
                "claim_id": a.claim_id,
                "relation": link.relation,
                "target": b.claim_id if link.relation == "contradicts" else target,
                "by": "checker",
                "reason": link.reason,
            }
        )
    return accepted

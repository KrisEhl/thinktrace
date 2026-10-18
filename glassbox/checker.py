"""Fact-checker: one model call that links claims stating the same fact (corroboration) or opposing facts."""

from typing import Literal

from pydantic import BaseModel, Field

from .control import ClaimStore, SourceStore

CHECKER_PROMPT = """You are a strict fact-checker. You get numbered claims, each from one web source (domain in brackets).

Find pairs where:
- "corroborates": two claims from DIFFERENT domains state the same fact (same numbers, same subject). Paraphrases count;
  related-but-different facts do NOT.
- "contradicts": two claims make incompatible statements about the same thing (different numbers for the same metric,
  opposite conclusions).

Only report links you are confident about. Link the LATER claim (higher number) to the EARLIER one.
Give a one-sentence reason for each link. Return an empty list if there are none."""


class Link(BaseModel):
    claim: str = Field(description="The later claim id, e.g. c12")
    relation: Literal["corroborates", "contradicts"]
    target: str = Field(description="The earlier claim id, e.g. c3")
    reason: str = Field(description="One sentence")


class Links(BaseModel):
    links: list[Link]


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
        domain_a, domain_b = (
            sources.by_id[a.source_id].domain,
            sources.by_id[b.source_id].domain,
        )
        if link.relation == "corroborates":
            if (
                domain_a == domain_b
                or a.corroborates
                or claims.group_root(b.claim_id) == a.claim_id
            ):
                continue  # same origin is not corroboration
            a.corroborates = claims.group_root(b.claim_id)
        else:
            if a.contradicts:
                continue
            a.contradicts = b.claim_id
        accepted.append(
            {
                "claim_id": a.claim_id,
                "relation": link.relation,
                "target": b.claim_id
                if link.relation == "contradicts"
                else a.corroborates,
                "by": "checker",
                "reason": link.reason,
            }
        )
    return accepted

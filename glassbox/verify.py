"""Quote verification: is the quoted passage really in the source text, and where?"""

import re
from dataclasses import dataclass

from rapidfuzz import fuzz

FUZZY_THRESHOLD = 95.0
_TRANSLATE = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201a": "'",
        "\u201b": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201e": '"',
        "\u201f": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u2212": "-",
        "\u00a0": " ",
        "\u2026": "...",
    }
)


@dataclass
class Verification:
    verified: str  # "exact" | "fuzzy" | "not_found"
    span: tuple[int, int] | None
    score: float


def _normalize_with_map(text: str) -> tuple[str, list[int]]:
    """Lower-case, unify punctuation, collapse whitespace; keep a map back to original offsets."""
    out: list[str] = []
    index: list[int] = []
    prev_space = True
    for i, ch in enumerate(text):
        for c in ch.translate(_TRANSLATE).lower():
            if c.isspace():
                if prev_space:
                    continue
                c, prev_space = " ", True
            else:
                prev_space = False
            out.append(c)
            index.append(i)
    while out and out[-1] == " ":
        out.pop()
        index.pop()
    return "".join(out), index


def normalize(text: str) -> str:
    return _normalize_with_map(text)[0]


def verify_quote(
    quote: str, source_text: str, *, allow_span: bool = True
) -> Verification:
    """Verify a quote; quotes stitched from fragments with '...' are verified fragment by fragment, in order."""
    fragments = [
        f
        for f in re.split(r"\s*(?:\.\.\.|\u2026|\[\.\.\.\])\s*", quote)
        if len(normalize(f).strip(" \"'")) >= 12
    ]
    if len(fragments) <= 1:
        return _verify_single(quote, source_text, allow_span=allow_span)
    results, cursor = [], 0
    for fragment in fragments:
        r = _verify_single(fragment, source_text, allow_span=True)
        if r.verified == "not_found" or (r.span and r.span[0] < cursor):
            return Verification("not_found", None, r.score)
        results.append(r)
        cursor = r.span[1] if r.span else cursor
    verified = "exact" if all(r.verified == "exact" for r in results) else "fuzzy"
    span = (
        (results[0].span[0], results[-1].span[1])
        if allow_span and results[0].span and results[-1].span
        else None
    )
    return Verification(verified, span, min(r.score for r in results))


def _verify_single(
    quote: str, source_text: str, *, allow_span: bool = True
) -> Verification:
    quote_n = normalize(quote).strip(" \"'")
    if not quote_n or not source_text:
        return Verification("not_found", None, 0.0)
    text_n, index = _normalize_with_map(source_text)

    pos = text_n.find(quote_n)
    if pos >= 0:
        span = (index[pos], index[pos + len(quote_n) - 1] + 1) if allow_span else None
        return Verification("exact", span, 100.0)

    if len(quote_n) >= 20:
        alignment = fuzz.partial_ratio_alignment(quote_n, text_n)
        if (
            alignment
            and alignment.score >= FUZZY_THRESHOLD
            and alignment.dest_end > alignment.dest_start
        ):
            span = (
                (index[alignment.dest_start], index[alignment.dest_end - 1] + 1)
                if allow_span
                else None
            )
            return Verification("fuzzy", span, round(alignment.score, 1))
        return Verification(
            "not_found", None, round(alignment.score, 1) if alignment else 0.0
        )
    return Verification("not_found", None, 0.0)


_WS = re.compile(r"\s+")


def snippet(text: str, span: tuple[int, int] | None, pad: int = 80) -> str:
    if not span:
        return ""
    start, end = span
    return _WS.sub(" ", text[max(0, start - pad) : end + pad]).strip()

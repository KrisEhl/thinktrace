"""Citation filter: keep only sentences that cite at least one known, verified claim."""

import re
from dataclasses import dataclass, field

CITE_RE = re.compile(r"\[(c\d+)\]")
STRUCTURE_RE = re.compile(r"^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)")


@dataclass
class FilterResult:
    markdown: str
    cited_claim_ids: list[str] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)
    sentences: list[str] = field(default_factory=list)


def _split_sentences(text: str) -> list[str]:
    """Split after sentence punctuation, keeping trailing citations attached to their sentence."""
    parts, start = [], 0
    for match in re.finditer(r"[.!?](?:\s*\[c\d+\])*(?=\s+|$)", text):
        end = match.end()
        parts.append(text[start:end].strip())
        start = end
    tail = text[start:].strip()
    if tail:
        parts.append(tail)
    return [p for p in parts if p]


def filter_citations(markdown: str, valid_ids: set[str]) -> FilterResult:
    result = FilterResult(markdown="")
    cited: list[str] = []
    out_lines: list[str] = []
    for line in markdown.splitlines():
        if not line.strip():
            out_lines.append("")
            continue
        prefix_match = STRUCTURE_RE.match(line)
        prefix = prefix_match.group(0) if prefix_match else ""
        body = line[len(prefix) :]
        if prefix.lstrip().startswith("#"):
            out_lines.append(line)  # headings carry no claims
            continue
        kept = []
        for sentence in _split_sentences(body):
            ids = [i for i in CITE_RE.findall(sentence) if i in valid_ids]
            if ids:
                # Strip citations to unknown/unverified claims, keep the valid ones.
                clean = CITE_RE.sub(
                    lambda m: m.group(0) if m.group(1) in valid_ids else "", sentence
                ).strip()
                kept.append(clean)
                result.sentences.append(clean)
                cited.extend(i for i in ids if i not in cited)
            else:
                result.dropped.append(sentence)
        if kept:
            out_lines.append(prefix + " ".join(kept))
    text = "\n".join(out_lines)
    result.markdown = re.sub(r"\n{3,}", "\n\n", text).strip()
    # Drop headings that ended up with nothing beneath them.
    result.markdown = re.sub(
        r"(^#{1,6} .*\n*)(?=^#{1,6} |\Z)", "", result.markdown, flags=re.M
    ).strip()
    result.cited_claim_ids = cited
    return result


def changed_sentences(previous: list[str], current: list[str]) -> list[str]:
    before = set(previous)
    return [s for s in current if s not in before]

"""The six research tools. Each returns (content for the model, artifact for the logger)."""

import asyncio
from dataclasses import dataclass
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool
from pydantic import BaseModel, Field

from .config import Config
from .control import ClaimStore, RunControl, SourceStore, direction_of
from .events import EventWriter
from .verify import verify_quote


@dataclass
class RunContext:
    run_id: str
    question: str
    cfg: Config
    writer: EventWriter
    sources: SourceStore
    claims: ClaimStore
    control: RunControl
    tavily: Any  # TavilyClient-compatible: .search(query, ...) and .extract(urls=[...])


class DirectionIn(BaseModel):
    id: str = Field(description="Direction id: d1, d2, ...")
    title: str = Field(description="Short title of the research direction")
    why: str = Field(
        description="One line: why this direction matters for the question"
    )
    queries: list[str] = Field(description="1-3 first search queries")


def _blocked_content(reason: str) -> str:
    if reason == "dropped":
        return "USER STEERING: this direction was dropped by the user. Call finish_direction(reason='dropped_by_user') now."
    return "Budget used up for this direction. Call finish_direction(reason='budget') with what you have."


def make_tools(ctx: RunContext) -> dict[str, Any]:
    cfg, control, sources, claims = ctx.cfg, ctx.control, ctx.sources, ctx.claims

    async def fetch_text(source) -> str | None:
        """Fetch and store a source's full text. Returns an error message, or None on success."""
        try:
            response = await asyncio.to_thread(ctx.tavily.extract, urls=[source.url])
            results = response.get("results", [])
            text = results[0].get("raw_content") if results else None
        except Exception as exc:  # network / API errors are research facts, not crashes
            return str(exc)
        if not text:
            return "extraction failed"
        sources.set_text(source.source_id, text)
        return None

    @tool(response_format="content_and_artifact", parse_docstring=True)
    async def plan_research(directions: list[DirectionIn]) -> tuple[str, dict]:
        """Record the research plan. Call this once, before delegating any research.

        Args:
            directions: 3-4 non-overlapping research directions, ids d1, d2, ...
        """
        if control.directions and any(
            d.id.startswith("d") and not d.id.startswith("dn")
            for d in control.directions.values()
        ):
            return "A plan already exists. Delegate its directions with task.", {
                "blocked": "exists"
            }
        cleaned, seen = [], set()
        for i, d in enumerate(directions[: cfg.max_directions], start=1):
            data = d.model_dump() if isinstance(d, BaseModel) else dict(d)
            if (
                not data.get("id")
                or data["id"] in seen
                or not str(data["id"]).startswith("d")
            ):
                data["id"] = f"d{i}"
            seen.add(data["id"])
            data["queries"] = list(data.get("queries") or [])[:3]
            cleaned.append(data)
        control.add_plan(cleaned)
        listing = "\n".join(f"[{d['id']}] {d['title']}: {d['why']}" for d in cleaned)
        return (
            f"Plan recorded:\n{listing}\n\nNow delegate ALL directions in ONE message with one task call each. "
            "Each task description must start with its id in brackets, e.g. '[d1] ...', followed by the title, why, and first queries.",
            {"directions": cleaned},
        )

    @tool(response_format="content_and_artifact", parse_docstring=True)
    async def think(
        reflection: str,
        next_action: Literal["search", "read", "stop"],
        reason: str,
        runtime: ToolRuntime,
    ) -> tuple[str, dict]:
        """Record your reasoning before every search, read, or stop. Keep it short.

        Args:
            reflection: What you know so far and what is still missing.
            next_action: What you will do next: search, read, or stop.
            reason: One sentence: why this is the right next step.
        """
        return "ok", {
            "next_action": next_action,
            "reason": reason,
            "reflection": reflection,
        }

    @tool(response_format="content_and_artifact", parse_docstring=True)
    async def tavily_search(query: str, runtime: ToolRuntime) -> tuple[str, dict]:
        """Search the web. Returns numbered sources [sN] with a short snippet.

        Args:
            query: A focused web search query.
        """
        dir_id = direction_of(runtime.state)
        blocked = control.guard(dir_id, "tavily_search")
        if blocked:
            limit = cfg.budget.search
            return _blocked_content(blocked), {
                "query": query,
                "results": [],
                "blocked": blocked,
                "limit": limit,
            }
        if query in sources.search_cache:
            raw = sources.search_cache[query]
        else:
            response = await asyncio.to_thread(
                ctx.tavily.search, query, max_results=5, search_depth="advanced"
            )
            raw = response.get("results", [])
            sources.search_cache[query] = raw
        results, new_sources, lines = [], [], []
        for r in raw:
            source, is_new = sources.add(
                r.get("url", ""), r.get("title", ""), r.get("content", "")
            )
            if is_new:
                new_sources.append(sources.public(source))
            results.append(sources.public(source) | {"score": r.get("score")})
            lines.append(
                f"[{source.source_id}] {source.title} ({source.domain})\n{(r.get('content') or '')[:500]}"
            )
        content = "\n\n".join(lines) or "No results."
        if dir_id:
            d = control.ensure(dir_id)
            content += f"\n\n(Budget left in this direction: {d.search_left} searches, {d.extract_left} reads.)"
        return content, {"query": query, "results": results, "new_sources": new_sources}

    @tool(response_format="content_and_artifact", parse_docstring=True)
    async def tavily_extract(source_id: str, runtime: ToolRuntime) -> tuple[str, dict]:
        """Read the full text of a source found by tavily_search.

        Args:
            source_id: The source id from search results, e.g. s3.
        """
        source = sources.by_id.get(source_id)
        if source is None:
            return (
                f"Unknown source_id {source_id}. Use an id like s3 from search results.",
                {
                    "source_id": source_id,
                    "ok": False,
                    "error": "unknown source_id",
                    "blocked": "invalid",
                },
            )
        dir_id = direction_of(runtime.state)
        blocked = control.guard(dir_id, "tavily_extract")
        if blocked:
            return _blocked_content(blocked), {
                "source_id": source_id,
                "url": source.url,
                "ok": False,
                "blocked": blocked,
                "limit": cfg.budget.extract,
            }
        if source.text is None:
            error = await fetch_text(source)
            if error:
                return f"Could not read {source_id}: {error}", {
                    "source_id": source_id,
                    "url": source.url,
                    "ok": False,
                    "error": error,
                    "chars": 0,
                }
        text = source.text or ""
        shown = text[: cfg.extract_chars_for_model]
        more = (
            f"\n\n[truncated, {len(text)} chars total]"
            if len(text) > len(shown)
            else ""
        )
        return f"[{source_id}] {source.title}\n\n{shown}{more}", {
            "source_id": source_id,
            "url": source.url,
            "chars": len(text),
            "ok": True,
        }

    @tool(response_format="content_and_artifact", parse_docstring=True)
    async def record_claim(
        claim: str,
        quote: str,
        source_id: str,
        runtime: ToolRuntime,
        corroborates: str | None = None,
        contradicts: str | None = None,
    ) -> tuple[str, dict]:
        """Record one atomic factual claim with an exact supporting quote copied from the source text.

        Args:
            claim: The claim in your own words, one fact.
            quote: A short passage copied EXACTLY from the source text that supports the claim.
            source_id: The source the quote comes from, e.g. s3.
            corroborates: Optional claim id (e.g. c2) that this claim confirms from a different source.
            contradicts: Optional claim id (e.g. c2) that this claim contradicts.
        """
        source = sources.by_id.get(source_id)
        if source is None:
            return f"Unknown source_id {source_id}. Nothing recorded.", {
                "blocked": "invalid"
            }
        dir_id = direction_of(runtime.state)
        if dir_id and control.ensure(dir_id).status == "dropped":
            return _blocked_content("dropped"), {"blocked": "dropped"}
        auto_read = False
        result = verify_quote(
            quote, source.text or source.snippet, allow_span=source.text is not None
        )
        if result.verified == "not_found" and source.text is None:
            # The quote may be longer than the search snippet: fetch the page to check it (not charged to the read budget).
            auto_read = await fetch_text(source) is None
            if auto_read:
                result = verify_quote(quote, source.text or "", allow_span=True)
        corroborates = corroborates if corroborates in claims.claims else None
        contradicts = contradicts if contradicts in claims.claims else None
        corroboration = "agent" if corroborates else None
        if not corroborates and not contradicts and result.verified != "not_found":
            corroborates = claims.find_corroborated(claim, source.domain, sources)
            corroboration = "auto" if corroborates else None
        c = claims.add(
            dir=dir_id,
            text=claim,
            quote=quote,
            source_id=source_id,
            verified=result.verified,
            span=result.span,
            corroborates=corroborates,
            contradicts=contradicts,
        )
        if result.verified == "not_found":
            content = f"{c.claim_id} recorded, but the quote was NOT found in {source_id}. Copy the quote exactly from the text, or read the source first."
        else:
            content = f"{c.claim_id} recorded, quote verified ({result.verified})."
            if corroboration == "auto":
                content += f" It matches {corroborates} from another source, so it counts as corroboration."
        return content, {
            "claim_id": c.claim_id,
            "text": claim,
            "quote": quote,
            "source_id": source_id,
            "url": source.url,
            "domain": source.domain,
            "verified": result.verified,
            "span": list(result.span) if result.span else None,
            "corroborates": corroborates,
            "contradicts": contradicts,
            "corroboration": corroboration,
            "verified_against": "full_text" if source.text is not None else "snippet",
            "auto_read": auto_read,
        }

    @tool(response_format="content_and_artifact", parse_docstring=True)
    async def finish_direction(
        reason: Literal["enough_evidence", "nothing_new", "budget", "dropped_by_user"],
        summary: str,
        claim_ids: list[str],
        runtime: ToolRuntime,
    ) -> tuple[str, dict]:
        """Close your direction. Call this exactly once, as your last tool call.

        Args:
            reason: Why you stop: enough_evidence, nothing_new (two steps added nothing), budget, or dropped_by_user.
            summary: Two or three sentences summarising what this direction found and what is still uncertain.
            claim_ids: The claim ids recorded in this direction.
        """
        dir_id = direction_of(runtime.state)
        if (
            dir_id
            and control.has_pending(dir_id)
            and control.ensure(dir_id).status != "dropped"
        ):
            items = control.drain(dir_id, "researcher")
            return (
                "Not closed: " + " ".join(i["text"] for i in items),
                {"blocked": "steer_pending"},
            )
        if dir_id:
            control.mark_done(dir_id)
        if dir_id and control.ensure(dir_id).status == "dropped":
            reason = "dropped_by_user"
        return (
            "Direction closed. Reply with a short final summary listing the claim ids.",
            {
                "reason": reason,
                "summary": summary,
                "claim_ids": [c for c in claim_ids if c in claims.claims],
            },
        )

    return {
        "plan_research": plan_research,
        "think": think,
        "tavily_search": tavily_search,
        "tavily_extract": tavily_extract,
        "record_claim": record_claim,
        "finish_direction": finish_direction,
    }

"""GlassboxLogger: turns LangChain callbacks into Glassbox events.

All event writing for the agent happens here, so the direction/agent attribution
(which branch of the graph an event belongs to) lives in exactly one place.
"""

import re
import time
from typing import Any
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from rapidfuzz import fuzz

from .events import EventWriter

DIR_RE = re.compile(r"^\s*\[(d\d+)\]")
ARG_LIMIT = 2000
PREVIEW = 400


def _s(run_id: UUID | None) -> str | None:
    return str(run_id) if run_id else None


def _truncate(value: Any, limit: int = ARG_LIMIT) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + "…"
    if isinstance(value, dict):
        return {k: _truncate(v, limit) for k, v in value.items()}
    if isinstance(value, list):
        return [_truncate(v, limit) for v in value]
    return value


def _tool_output(output: Any) -> tuple[str, Any, bool]:
    """Return (content, artifact, ok) from whatever on_tool_end received."""
    content = getattr(output, "content", output)
    artifact = getattr(output, "artifact", None)
    ok = getattr(output, "status", "success") != "error"
    if not isinstance(content, str):
        content = str(content)
    return content, artifact, ok


def _reasoning_text(message: Any) -> str | None:
    kwargs = getattr(message, "additional_kwargs", {}) or {}
    for key in ("reasoning_content", "reasoning", "thinking"):
        value = kwargs.get(key)
        if isinstance(value, str) and value.strip():
            return value
    content = getattr(message, "content", None)
    if isinstance(content, list):
        parts = [
            block.get("reasoning") or block.get("thinking") or block.get("text", "")
            for block in content
            if isinstance(block, dict)
            and block.get("type") in ("reasoning", "thinking")
        ]
        text = "\n".join(p for p in parts if p)
        return text or None
    return None


def _text_content(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return str(content)


class GlassboxLogger(AsyncCallbackHandler):
    raise_error = False
    run_inline = True

    def __init__(
        self, writer: EventWriter, prices: dict[str, tuple[float, float]] | None = None
    ):
        self.w = writer
        self.prices = prices or {}
        self.runs: dict[str, dict[str, Any]] = {}
        self.plan: dict[str, dict[str, Any]] = {}
        self.started_dirs: set[str] = set()
        self.finished_dirs: set[str] = set()
        self.finish_reasons: dict[str, str] = {}
        self.on_researcher_end = None  # optional callable(dir_id), set by the run
        self.totals = {
            "searches": 0,
            "reads": 0,
            "claims": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0.0,
        }
        self._adhoc = 0

    # ---- run tree ---------------------------------------------------------

    def _register(
        self,
        run_id: UUID,
        parent_run_id: UUID | None,
        kind: str,
        name: str,
        metadata: dict | None,
    ) -> dict:
        parent = self.runs.get(_s(parent_run_id), {}) if parent_run_id else {}
        metadata = metadata or {}
        node = {
            "parent": _s(parent_run_id),
            "kind": kind,
            "name": name,
            "dir": metadata.get("dir") or parent.get("dir"),
            "agent": metadata.get("agent") or parent.get("agent") or "orchestrator",
            "t0": time.monotonic(),
        }
        if node["dir"] and node["agent"] == "orchestrator" and kind != "tool":
            node["agent"] = "researcher"
        self.runs[str(run_id)] = node
        return node

    def _emit(
        self,
        type: str,
        data: dict,
        run_id: UUID | None,
        node: dict | None = None,
        **overrides,
    ) -> None:
        node = node or self.runs.get(_s(run_id), {})
        self.w.emit(
            type,
            data,
            span=_s(run_id),
            parent_span=node.get("parent"),
            dir=overrides.get("dir", node.get("dir")),
            agent=overrides.get("agent", node.get("agent", "orchestrator")),
        )

    def _assign_direction(self, description: str) -> tuple[str, bool]:
        match = DIR_RE.match(description or "")
        if match:
            return match.group(1), False
        if self.plan:
            best = max(
                self.plan.values(),
                key=lambda d: fuzz.partial_ratio(
                    d["title"].lower(), description.lower()
                ),
            )
            if (
                fuzz.partial_ratio(best["title"].lower(), description.lower()) >= 80
                and best["id"] not in self.started_dirs
            ):
                return best["id"], False
        self._adhoc += 1
        return f"dx{self._adhoc}", True

    # ---- chains -----------------------------------------------------------

    async def on_chain_start(
        self, serialized, inputs, *, run_id, parent_run_id=None, metadata=None, **kwargs
    ):
        name = (serialized or {}).get("name") or kwargs.get("name") or "chain"
        self._register(run_id, parent_run_id, "chain", name, metadata)

    async def on_chain_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        if parent_run_id is None:
            self._emit("run.error", {"where": "chain", "message": str(error)}, run_id)

    # ---- models -----------------------------------------------------------

    async def on_chat_model_start(
        self,
        serialized,
        messages,
        *,
        run_id,
        parent_run_id=None,
        metadata=None,
        **kwargs,
    ):
        metadata = metadata or {}
        model = (
            metadata.get("ls_model_name")
            or ((serialized or {}).get("kwargs") or {}).get("model_name")
            or "unknown"
        )
        node = self._register(run_id, parent_run_id, "llm", model, metadata)
        node["model"] = model
        self._emit(
            "llm.started",
            {"model": model, "n_messages": len(messages[0]) if messages else 0},
            run_id,
            node,
        )

    async def on_llm_end(self, response, *, run_id, parent_run_id=None, **kwargs):
        node = self.runs.get(_s(run_id), {})
        model = node.get("model", "unknown")
        message = None
        try:
            message = response.generations[0][0].message
        except (AttributeError, IndexError):
            pass
        usage = getattr(message, "usage_metadata", None) or {}
        in_tok, out_tok = (
            usage.get("input_tokens", 0) or 0,
            usage.get("output_tokens", 0) or 0,
        )
        price_in, price_out = self.prices.get(model, (0.0, 0.0))
        cost = (in_tok * price_in + out_tok * price_out) / 1_000_000
        self.totals["input_tokens"] += in_tok
        self.totals["output_tokens"] += out_tok
        self.totals["cost_usd"] += cost
        tool_calls = [
            tc.get("name") for tc in (getattr(message, "tool_calls", None) or [])
        ]
        latency_ms = int((time.monotonic() - node.get("t0", time.monotonic())) * 1000)
        self._emit(
            "llm.completed",
            {
                "model": model,
                "input_tokens": in_tok,
                "output_tokens": out_tok,
                "latency_ms": latency_ms,
                "cost_usd": round(cost, 6),
                "tool_calls": tool_calls,
                "text_preview": _text_content(message)[:PREVIEW] if message else "",
            },
            run_id,
            node,
        )
        thought = _reasoning_text(message) if message else None
        if thought:
            self._emit(
                "model.thought", {"text": _truncate(thought, 4000)}, run_id, node
            )

    async def on_llm_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self._emit("run.error", {"where": "llm", "message": str(error)}, run_id)

    # ---- tools ------------------------------------------------------------

    async def on_tool_start(
        self,
        serialized,
        input_str,
        *,
        run_id,
        parent_run_id=None,
        metadata=None,
        inputs=None,
        **kwargs,
    ):
        name = (serialized or {}).get("name") or kwargs.get("name") or "tool"
        node = self._register(run_id, parent_run_id, "tool", name, metadata)
        args = inputs if isinstance(inputs, dict) else {"input": input_str}
        args = {
            k: v for k, v in args.items() if k not in ("runtime", "callbacks", "config")
        }

        if name == "task":
            dir_id, adhoc = self._assign_direction(str(args.get("description", "")))
            node["dir"], node["agent"] = dir_id, "orchestrator"
            node["is_direction_root"] = True
            self.started_dirs.add(dir_id)
            title = (
                self.plan.get(dir_id, {}).get("title")
                or DIR_RE.sub("", str(args.get("description", ""))).strip()[:120]
            )
            self._emit(
                "tool.started", {"name": name, "args": _truncate(args)}, run_id, node
            )
            self._emit(
                "direction.started",
                {
                    "id": dir_id,
                    "title": title,
                    "task_description": _truncate(args.get("description", "")),
                    "adhoc": adhoc,
                },
                run_id,
                node,
            )
            # Everything below the task call is the researcher.
            node["agent"] = "researcher"
            return

        self._emit(
            "tool.started", {"name": name, "args": _truncate(args)}, run_id, node
        )
        if name == "think":
            self._emit(
                "decision",
                {
                    "next_action": args.get("next_action"),
                    "reason": args.get("reason"),
                    "reflection": _truncate(args.get("reflection", "")),
                },
                run_id,
                node,
            )
        elif name == "tavily_search":
            self._emit("search.started", {"query": args.get("query")}, run_id, node)
        elif name == "tavily_extract":
            self._emit(
                "read.started",
                {"source_id": args.get("source_id"), "reason": args.get("reason")},
                run_id,
                node,
            )

    async def on_tool_end(self, output, *, run_id, parent_run_id=None, **kwargs):
        node = self.runs.get(_s(run_id), {})
        name = node.get("name", "tool")
        content, artifact, ok = _tool_output(output)
        artifact = artifact if isinstance(artifact, dict) else {}
        is_root = node.get("is_direction_root")
        self._emit(
            "tool.completed",
            {"name": name, "ok": ok, "content_preview": content[:PREVIEW]},
            run_id,
            node,
            **({"agent": "orchestrator"} if is_root else {}),
        )
        blocked = artifact.get("blocked")

        if name == "task":
            self.close_direction(node.get("dir"), run_id, node)
            if self.on_researcher_end and node.get("dir"):
                self.on_researcher_end(node["dir"])
        elif name == "plan_research" and not blocked:
            for d in artifact.get("directions", []):
                self.plan[d["id"]] = d
            self._emit(
                "plan.created",
                {"directions": artifact.get("directions", [])},
                run_id,
                node,
            )
        elif name == "tavily_search":
            if blocked == "budget":
                self._emit(
                    "budget.hit",
                    {"tool": name, "limit": artifact.get("limit")},
                    run_id,
                    node,
                )
            for source in artifact.get("new_sources", []):
                self._emit("source.added", source, run_id, node)
            if not blocked:
                self.totals["searches"] += 1
            self._emit(
                "search.completed",
                {
                    "query": artifact.get("query"),
                    "reason": artifact.get("reason"),
                    "recent": artifact.get("recent", False),
                    "results": artifact.get("results", []),
                    "blocked": blocked,
                    **({"error": artifact["error"]} if artifact.get("error") else {}),
                },
                run_id,
                node,
            )
        elif name == "tavily_extract":
            if blocked == "budget":
                self._emit(
                    "budget.hit",
                    {"tool": name, "limit": artifact.get("limit")},
                    run_id,
                    node,
                )
            if not blocked:
                self.totals["reads"] += 1
            self._emit(
                "read.completed",
                {
                    k: artifact.get(k)
                    for k in ("source_id", "url", "chars", "ok", "error")
                }
                | {"blocked": blocked},
                run_id,
                node,
            )
        elif name == "record_claim" and not blocked and artifact.get("claim_id"):
            self.totals["claims"] += 1
            self._emit("claim.recorded", artifact, run_id, node)
        elif name == "finish_direction" and node.get("dir") and not blocked:
            self.finished_dirs.add(node["dir"])
            self.finish_reasons[node["dir"]] = artifact.get("reason", "no_reason")
            self._emit(
                "direction.finished",
                {
                    "id": node["dir"],
                    "reason": artifact.get("reason", "no_reason"),
                    "summary": artifact.get("summary", ""),
                    "claim_ids": artifact.get("claim_ids", []),
                    "remaining_gaps": artifact.get("remaining_gaps", ""),
                },
                run_id,
                node,
            )

    async def on_tool_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        node = self.runs.get(_s(run_id), {})
        self._emit(
            "tool.completed",
            {"name": node.get("name"), "ok": False, "error": str(error)[:PREVIEW]},
            run_id,
            node,
        )
        if node.get("is_direction_root"):
            self.close_direction(node.get("dir"), run_id, node)

    def close_direction(
        self, dir_id: str | None, run_id: Any = None, node: dict | None = None
    ) -> None:
        """Emit direction.finished(no_reason) if the researcher ended without calling finish_direction."""
        if not dir_id or dir_id in self.finished_dirs:
            return
        self.finished_dirs.add(dir_id)
        self.finish_reasons[dir_id] = "no_reason"
        self.w.emit(
            "direction.finished",
            {"id": dir_id, "reason": "no_reason", "summary": "", "claim_ids": []},
            span=_s(run_id) if isinstance(run_id, UUID) else run_id,
            parent_span=(node or {}).get("parent"),
            dir=dir_id,
            agent="researcher",
        )

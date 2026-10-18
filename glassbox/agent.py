"""GlassboxRun: wires orchestrator, researchers, writer, logger and steering for one question."""

import asyncio
import time
import uuid
from typing import Any

from deepagents import create_deep_agent
from langchain.agents import create_agent
from langchain.agents.middleware import ToolCallLimitMiddleware
from langchain_core.runnables import RunnableConfig
from langchain_core.messages import HumanMessage, SystemMessage

from .checker import CHECKER_PROMPT, Links, apply_links, claims_listing
from .citations import changed_sentences, filter_citations
from .config import Config, make_chat_model
from .control import ClaimStore, RunControl, SourceStore
from .events import EventWriter
from .logger import GlassboxLogger, _text_content
from .prompts import ORCHESTRATOR_PROMPT, RESEARCHER_PROMPT, WRITER_PROMPT, today
from .steering import ForcePlanMiddleware, SteeringMiddleware
from .tools import RunContext, make_tools

RESEARCHER_TOOLS = (
    "think",
    "tavily_search",
    "tavily_extract",
    "record_claim",
    "finish_direction",
)
RESEARCHER_RECURSION_LIMIT = 120


def _default_tavily():
    from tavily import TavilyClient

    return TavilyClient()


class GlassboxRun:
    def __init__(
        self,
        question: str,
        *,
        cfg: Config | None = None,
        run_id: str | None = None,
        tavily: Any = None,
        models: dict[str, Any] | None = None,
    ):
        """`models` overrides chat models by role (orchestrator/researcher/writer); used by tests."""
        self.cfg = cfg or Config()
        self.question = question
        self.run_id = run_id or "r_" + uuid.uuid4().hex[:8]
        self.run_dir = self.cfg.runs_dir / self.run_id
        self.writer = EventWriter(self.run_id, self.run_dir)
        self.logger = GlassboxLogger(self.writer, self.cfg.prices)
        self.control = RunControl(self.cfg, self.writer)
        self.control.logger = self.logger
        self.logger.on_researcher_end = self.control.on_direction_closed
        self.ctx = RunContext(
            run_id=self.run_id,
            question=question,
            cfg=self.cfg,
            writer=self.writer,
            sources=SourceStore(self.run_dir),
            claims=ClaimStore(),
            control=self.control,
            tavily=tavily or _default_tavily(),
        )
        models = models or {}
        self.models = {
            role: models.get(role)
            or make_chat_model(getattr(self.cfg, f"{role}_model"), self.cfg)
            for role in ("orchestrator", "researcher", "writer", "checker")
        }
        tools = make_tools(self.ctx)

        self.researcher = create_agent(
            self.models["researcher"],
            tools=[tools[name] for name in RESEARCHER_TOOLS],
            system_prompt=RESEARCHER_PROMPT.format(today=today()),
            middleware=[SteeringMiddleware(self.control, "researcher")],
            name="researcher",
        ).with_config(recursion_limit=RESEARCHER_RECURSION_LIMIT)

        self.orchestrator = create_deep_agent(
            model=self.models["orchestrator"],
            tools=[tools["plan_research"]],
            system_prompt=ORCHESTRATOR_PROMPT.format(today=today()),
            subagents=[
                {
                    "name": "researcher",
                    "description": "Researches exactly one direction. The description must start with its id, e.g. '[d1] ...'.",
                    "runnable": self.researcher,
                }
            ],
            middleware=[  # ty: ignore[invalid-argument-type]  # ToolCallLimitMiddleware's generic state type
                ForcePlanMiddleware(self.control),
                SteeringMiddleware(self.control, "orchestrator"),
                ToolCallLimitMiddleware(
                    tool_name="task",
                    run_limit=self.cfg.max_directions + 2,
                    exit_behavior="continue",
                ),
            ],
        )
        self.control.spawn_researcher = self._spawn_researcher

        self.report_version = 0
        self.last_sentences: list[str] = []
        self.orchestrator_done = False
        self.closed = False
        self._dirty = False
        self._rewrites: set[asyncio.Task] = set()
        self._write_lock = asyncio.Lock()
        self._t0 = time.monotonic()
        self._main: asyncio.Task | None = None

    # ---- running ----------------------------------------------------------

    def _config(self, **metadata) -> RunnableConfig:
        return {
            "callbacks": [self.logger],
            "metadata": metadata,
            "recursion_limit": 300,
        }

    async def _spawn_researcher(self, dir_id: str, message: str) -> None:
        try:
            await self.researcher.ainvoke(
                {"messages": [HumanMessage(content=message)]},
                config={
                    "callbacks": [self.logger],
                    "metadata": {"dir": dir_id, "agent": "researcher"},
                },
            )
        except Exception as exc:
            self.writer.emit(
                "run.error",
                {"where": f"researcher {dir_id}", "message": str(exc)},
                dir=dir_id,
                agent="researcher",
            )
        finally:
            self.logger.close_direction(dir_id)
            self.control.on_direction_closed(dir_id)

    async def run(self) -> None:
        self.writer.emit(
            "run.started",
            {
                "question": self.question,
                "models": {
                    r: getattr(m, "model_name", type(m).__name__)
                    for r, m in self.models.items()
                },
                "budgets": {
                    "search": self.cfg.budget.search,
                    "extract": self.cfg.budget.extract,
                },
            },
        )
        try:
            await self.orchestrator.ainvoke(
                {"messages": [HumanMessage(content=self.question)]},
                config=self._config(),
            )
        except Exception as exc:
            self.writer.emit(
                "run.error",
                {"where": "orchestrator", "message": str(exc)},
                agent="orchestrator",
            )
        self._start_undelegated()
        self.orchestrator_done = True
        await self.settle()

    def _start_undelegated(self) -> None:
        """The orchestrator may skip planning or delegating. Research is never skipped: start what's missing."""
        control, logger = self.control, self.logger
        if not control.directions:
            plan: list[dict[str, Any]] = [
                {
                    "id": "d1",
                    "title": self.question[:120],
                    "why": "Fallback: the orchestrator made no plan.",
                    "queries": [self.question[:200]],
                }
            ]
            control.add_plan(plan)
            for d in plan:
                logger.plan[d["id"]] = d
            self.writer.emit(
                "plan.created", {"directions": plan, "fallback": True}, agent="system"
            )
        for d in list(control.directions.values()):
            if d.status != "planned" or d.id in logger.started_dirs:
                continue
            d.status = "running"
            logger.started_dirs.add(d.id)
            description = f"[{d.id}] {d.title}\nWhy: {d.why}\nFirst queries: {'; '.join(d.queries)}"
            self.writer.emit(
                "direction.started",
                {
                    "id": d.id,
                    "title": d.title,
                    "task_description": description,
                    "adhoc": False,
                },
                dir=d.id,
            )
            control.track(self._spawn_researcher(d.id, description))

    async def settle(self) -> None:
        """Wait for all research to finish, then cross-check and (re)write the answer."""
        await self.control.wait_idle()
        async with self._write_lock:
            await self.control.wait_idle()
            await self._cross_check()
            await self._write()
            self.writer.emit("run.idle", {"report_version": self.report_version})

    async def _cross_check(self) -> None:
        dropped = {
            d.id for d in self.control.directions.values() if d.status == "dropped"
        }
        listing = claims_listing(self.ctx.claims, self.ctx.sources, dropped)
        if listing.count("\n") < 1:
            return
        self.writer.emit(
            "check.started", {"n_claims": listing.count("\n") + 1}, agent="checker"
        )
        try:
            model = self.models["checker"].with_structured_output(
                Links, method="function_calling"
            )
            result = await model.ainvoke(
                [SystemMessage(content=CHECKER_PROMPT), HumanMessage(content=listing)],
                config={"callbacks": [self.logger], "metadata": {"agent": "checker"}},
            )
        except Exception as exc:
            self.writer.emit(
                "run.error", {"where": "checker", "message": str(exc)}, agent="checker"
            )
            return
        for link in apply_links(
            result.links if result else [], self.ctx.claims, self.ctx.sources
        ):
            claim = self.ctx.claims.claims[link["claim_id"]]
            self.writer.emit("claim.linked", link, dir=claim.dir, agent="checker")

    def start(self) -> asyncio.Task:
        self._main = asyncio.ensure_future(self.run())
        return self._main

    # ---- writer -----------------------------------------------------------

    def _claims_brief(self) -> tuple[str, set[str]]:
        claims, sources, control = self.ctx.claims, self.ctx.sources, self.control
        lines, valid = [], set()
        for d in control.directions.values():
            if d.status == "dropped":
                continue
            reason = self.logger.finish_reasons.get(d.id, "unknown")
            lines.append(f"\n## [{d.id}] {d.title} (stopped: {reason})")
            for c in claims.claims.values():
                if c.dir != d.id:
                    continue
                status = claims.status(c.claim_id, sources)
                if status == "grey":
                    continue
                valid.add(c.claim_id)
                domain = (
                    sources.by_id[c.source_id].domain
                    if c.source_id in sources.by_id
                    else "?"
                )
                lines.append(f"- {c.claim_id} [{status}] ({domain}): {c.text}")
        return "\n".join(lines).strip(), valid

    async def _write(self) -> None:
        self._dirty = False
        brief, valid = self._claims_brief()
        self.writer.emit(
            "synthesis.started",
            {"n_claims": len(valid), "version": self.report_version + 1},
            agent="writer",
        )
        if not valid:
            raw = "No verified claims were recorded, so there is no sourced answer."
        else:
            try:
                response = await self.models["writer"].ainvoke(
                    [
                        SystemMessage(content=WRITER_PROMPT),
                        HumanMessage(
                            content=f"Question: {self.question}\n\nClaims by direction:\n{brief}"
                        ),
                    ],
                    config={
                        "callbacks": [self.logger],
                        "metadata": {"agent": "writer"},
                    },
                )
                raw = _text_content(response)
            except Exception as exc:
                self.writer.emit(
                    "run.error",
                    {"where": "writer", "message": str(exc)},
                    agent="writer",
                )
                return
        result = filter_citations(raw, valid)
        if not valid:
            result.markdown, result.dropped = raw, []
        self.report_version += 1
        changed = (
            changed_sentences(self.last_sentences, result.sentences)
            if self.report_version > 1
            else []
        )
        self.last_sentences = result.sentences
        self.writer.emit(
            "report.final",
            {
                "version": self.report_version,
                "markdown": result.markdown,
                "raw_markdown": raw,
                "cited_claim_ids": result.cited_claim_ids,
                "dropped": result.dropped,
                "changed": changed,
            },
            agent="writer",
        )

    # ---- steering ---------------------------------------------------------

    def steer(self, action: str, dir_id: str, text: str | None = None) -> dict:
        result = self.control.steer(
            action, dir_id, text, self.ctx.claims, self.ctx.sources
        )
        self._dirty = True
        if self.orchestrator_done:
            # The first answer may already exist: rewrite it once the steered work is done.
            task = asyncio.ensure_future(self._rewrite_after_steer())
            self._rewrites.add(task)
            task.add_done_callback(self._rewrites.discard)
        return result

    async def _rewrite_after_steer(self) -> None:
        await asyncio.sleep(0)  # let the steer's own research tasks register first
        await self.control.wait_idle()
        async with self._write_lock:
            await self.control.wait_idle()
            if not self._dirty:
                return  # another rewrite already covered this steer
            await self._cross_check()
            await self._write()
            self.writer.emit("run.idle", {"report_version": self.report_version})

    async def wait_quiet(self) -> None:
        """Wait until research and any pending rewrites are done."""
        while (
            self.control.tasks
            or self._rewrites
            or (self._main and not self._main.done())
        ):
            await asyncio.gather(
                *self.control.tasks,
                *self._rewrites,
                *([self._main] if self._main else []),
                return_exceptions=True,
            )

    # ---- closing ----------------------------------------------------------

    def totals(self) -> dict:
        return {
            "searches": self.logger.totals["searches"],
            "reads": self.logger.totals["reads"],
            "claims": len(self.ctx.claims.claims),
            "directions": len(self.control.directions),
            "steers": self.control.steers,
            "restarts": 0,
            "input_tokens": self.logger.totals["input_tokens"],
            "output_tokens": self.logger.totals["output_tokens"],
            "cost_usd": round(self.logger.totals["cost_usd"], 4),
        }

    def close(self, status: str = "ok") -> None:
        if self.closed:
            return
        self.closed = True
        self.writer.emit(
            "run.finished",
            {
                "status": status,
                "duration_ms": int((time.monotonic() - self._t0) * 1000),
                "totals": self.totals(),
            },
        )
        self.writer.close()

    def latest_report(self) -> str:
        from .events import read_events

        reports = [
            e for e in read_events(self.writer.path) if e["type"] == "report.final"
        ]
        return reports[-1]["data"]["markdown"] if reports else ""

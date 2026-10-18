"""Per-run shared state: sources, claims, direction status/budgets, and steering."""

import asyncio
import itertools
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from rapidfuzz import fuzz

from .config import Budget, Config
from .events import EventWriter

if TYPE_CHECKING:
    from .logger import GlassboxLogger

DIR_RE = re.compile(r"^\s*\[(d\w+)\]")
_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")


def direction_of(state: Any) -> str | None:
    """The researcher's first human message is its task description, which starts with [dN]."""
    messages = (
        state.get("messages", [])
        if isinstance(state, dict)
        else getattr(state, "messages", [])
    )
    for message in messages:
        if getattr(message, "type", None) == "human":
            content = (
                message.content
                if isinstance(message.content, str)
                else str(message.content)
            )
            match = DIR_RE.match(content)
            return match.group(1) if match else None
    return None


def domain_of(url: str) -> str:
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


# ---- sources --------------------------------------------------------------


@dataclass
class Source:
    source_id: str
    url: str
    title: str
    domain: str
    snippet: str
    text: str | None = None


class SourceStore:
    def __init__(self, run_dir):
        self.dir = run_dir / "sources"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.by_id: dict[str, Source] = {}
        self.by_url: dict[str, Source] = {}
        self.search_cache: dict[str, list[dict]] = {}
        self._ids = itertools.count(1)

    def add(self, url: str, title: str, snippet: str) -> tuple[Source, bool]:
        if url in self.by_url:
            return self.by_url[url], False
        source = Source(
            f"s{next(self._ids)}", url, title or url, domain_of(url), snippet or ""
        )
        self.by_id[source.source_id] = source
        self.by_url[url] = source
        return source, True

    def set_text(self, source_id: str, text: str) -> None:
        source = self.by_id[source_id]
        source.text = text
        (self.dir / f"{source_id}.txt").write_text(text, encoding="utf-8")

    def public(self, source: Source) -> dict:
        return {
            "source_id": source.source_id,
            "url": source.url,
            "title": source.title,
            "domain": source.domain,
        }


# ---- claims ---------------------------------------------------------------


@dataclass
class Claim:
    claim_id: str
    dir: str | None
    text: str
    quote: str
    source_id: str
    verified: str
    span: tuple[int, int] | None
    corroborates: str | None = None
    contradicts: str | None = None
    as_of: str | None = None  # YYYY / YYYY-MM / YYYY-MM-DD the fact refers to
    kind: str | None = None  # stable | event | volatile
    value: float | None = None
    unit: str | None = None


class ClaimStore:
    def __init__(self):
        self.claims: dict[str, Claim] = {}
        self._ids = itertools.count(1)

    def add(self, **kwargs) -> Claim:
        claim = Claim(claim_id=f"c{next(self._ids)}", **kwargs)
        self.claims[claim.claim_id] = claim
        return claim

    def group_root(self, claim_id: str) -> str:
        seen = set()
        while (
            claim_id in self.claims
            and self.claims[claim_id].corroborates
            and claim_id not in seen
        ):
            seen.add(claim_id)
            claim_id = self.claims[claim_id].corroborates or claim_id
        return claim_id

    def find_corroborated(
        self, text: str, domain: str, sources: "SourceStore"
    ) -> str | None:
        """An earlier verified claim from a different domain that states the same fact, if any.

        Conservative on purpose: wording must nearly match AND the numbers must be identical,
        so "$140/kWh" never corroborates "$100/kWh".
        """
        numbers = set(_NUMBER_RE.findall(text))
        best, best_score = None, 0.0
        for c in self.claims.values():
            if c.verified == "not_found" or c.source_id not in sources.by_id:
                continue
            if (
                sources.by_id[c.source_id].domain == domain
                or set(_NUMBER_RE.findall(c.text)) != numbers
            ):
                continue
            score = fuzz.token_set_ratio(text.lower(), c.text.lower())
            if score >= 85 and score > best_score:
                best, best_score = c.claim_id, score
        return self.group_root(best) if best else None

    def status(self, claim_id: str, sources: SourceStore) -> str:
        """Same rule as the frontend: grey / red / green / orange."""
        claim = self.claims[claim_id]
        if claim.verified == "not_found":
            return "grey"
        root = self.group_root(claim_id)
        group = [
            c
            for c in self.claims.values()
            if self.group_root(c.claim_id) == root and c.verified != "not_found"
        ]
        ids = {c.claim_id for c in group}
        contradicted = any(
            c.contradicts in ids
            for c in self.claims.values()
            if c.verified != "not_found"
        )
        if contradicted or any(c.contradicts for c in group):
            return "red"
        domains = {
            sources.by_id[c.source_id].domain
            for c in group
            if c.source_id in sources.by_id
        }
        return "green" if len(domains) >= 2 else "orange"


# ---- directions and steering ----------------------------------------------


@dataclass
class Direction:
    id: str
    title: str
    why: str = ""
    queries: list[str] = field(default_factory=list)
    status: str = "planned"  # planned | running | done | dropped
    search_left: int = 0
    extract_left: int = 0


class RunControl:
    def __init__(self, cfg: Config, writer: EventWriter):
        self.cfg = cfg
        self.w = writer
        self.directions: dict[str, Direction] = {}
        self.inbox: dict[str, list[dict]] = {}
        self.tasks: set[asyncio.Task] = set()
        self.logger: "GlassboxLogger | None" = None
        self.question = ""  # the user's main question; gives follow-ups their context
        self.spawn_researcher = (
            None  # set by the agent builder: async (dir_id, message) -> None
        )
        self._steer_ids = itertools.count(1)
        self._new_dir_ids = itertools.count(1)
        self.steers = 0

    # directions

    def ensure(
        self, dir_id: str, title: str = "", budget: Budget | None = None
    ) -> Direction:
        if dir_id not in self.directions:
            budget = budget or self.cfg.budget
            self.directions[dir_id] = Direction(
                dir_id,
                title or dir_id,
                search_left=budget.search,
                extract_left=budget.extract,
            )
        return self.directions[dir_id]

    def add_plan(self, directions: list[dict]) -> None:
        for d in directions:
            direction = self.ensure(d["id"], d.get("title", ""))
            direction.why, direction.queries = d.get("why", ""), d.get("queries", [])

    def guard(self, dir_id: str | None, tool: str) -> str | None:
        """None if the tool may run; otherwise 'dropped' or 'budget'. Spends budget when allowed."""
        if not dir_id:
            return None
        direction = self.ensure(dir_id)
        if direction.status == "dropped":
            return "dropped"
        if direction.status == "planned":
            direction.status = "running"
        if tool == "tavily_search":
            if direction.search_left <= 0:
                return "budget"
            direction.search_left -= 1
        elif tool == "tavily_extract":
            if direction.extract_left <= 0:
                return "budget"
            direction.extract_left -= 1
        return None

    def mark_done(self, dir_id: str) -> None:
        direction = self.ensure(dir_id)
        if direction.status != "dropped":
            direction.status = "done"

    # inbox

    def push(self, key: str, steer_id: str, text: str) -> None:
        self.inbox.setdefault(key, []).append({"steer_id": steer_id, "text": text})

    def drain(self, key: str | None, agent: str) -> list[dict]:
        if not key or not self.inbox.get(key):
            return []
        items, self.inbox[key] = self.inbox[key], []
        for item in items:
            self.w.emit(
                "steer.delivered",
                {
                    "steer_id": item["steer_id"],
                    "dir": None if key == "orchestrator" else key,
                    "agent": agent,
                },
                dir=None if key == "orchestrator" else key,
                agent=agent,
            )
        return items

    def has_pending(self, key: str) -> bool:
        return bool(self.inbox.get(key))

    # tasks

    def track(self, coro) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def wait_idle(self) -> None:
        while self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)

    def on_direction_closed(self, dir_id: str) -> None:
        """A researcher ended. If a steer arrived too late for it, resume the direction."""
        if (
            self.has_pending(dir_id)
            and self.directions.get(dir_id, Direction(dir_id, "")).status != "dropped"
        ):
            items = self.drain(dir_id, "system")
            self._resume(
                dir_id, " ".join(i["text"] for i in items), items[0]["steer_id"], []
            )

    # steering

    def steer(
        self,
        action: str,
        dir_id: str,
        text: str | None,
        claims: ClaimStore,
        sources: SourceStore,
    ) -> dict:
        if action == "follow_up":
            # A follow-up question asked on the root ("q") or on a direction: research it as a new direction.
            if not text:
                raise ValueError("a follow-up needs a question")
            if dir_id != "q" and dir_id not in self.directions:
                raise KeyError(f"unknown direction {dir_id}")
            steer_id = f"st{next(self._steer_ids)}"
            self.steers += 1
            return self._follow_up(steer_id, dir_id, text)
        if dir_id not in self.directions:
            raise KeyError(f"unknown direction {dir_id}")
        steer_id = f"st{next(self._steer_ids)}"
        self.steers += 1
        direction = self.directions[dir_id]
        if action == "redirect":
            return self._redirect(steer_id, direction, text)
        if action == "dig_deeper":
            return self._dig(steer_id, direction, text, claims, sources)
        raise ValueError(f"unknown action {action}")

    def _follow_up(self, steer_id: str, parent: str, text: str) -> dict:
        new_dir = f"dn{next(self._new_dir_ids)}"
        self.w.emit(
            "steer.applied",
            {"steer_id": steer_id, "action": "follow_up", "dir": parent, "text": text, "new_dir": new_dir},
            dir=None if parent == "q" else parent,
        )
        new = self.ensure(new_dir, text[:120], Budget(self.cfg.budget.search, self.cfg.budget.extract))
        new.why = "User follow-up" + ("" if parent == "q" else f" on [{parent}]")
        new.status = "running"
        self.w.emit(
            "plan.updated",
            {"added": [{"id": new_dir, "title": new.title, "why": new.why, "queries": [], "from_steer": steer_id, "parent": parent}]},
            dir=new_dir,
        )
        self.w.emit(
            "direction.started",
            {"id": new_dir, "title": new.title, "task_description": f"[{new_dir}] {text}", "adhoc": False},
            dir=new_dir,
        )
        if self.logger:
            self.logger.started_dirs.add(new_dir)
        self._spawn(new_dir, self._follow_up_task(new_dir, parent, text))
        return {"steer_id": steer_id, "new_dir": new_dir}

    def _follow_up_task(self, new_dir: str, parent: str, text: str) -> str:
        """A follow-up is short and refers back ("why is it not split?"): give the researcher what it refers to."""
        lines = [f"[{new_dir}] Follow-up question from the user: {text}"]
        if self.question:
            lines.append(f"It follows up on the user's main research question: \"{self.question}\".")
        if parent != "q" and parent in self.directions:
            p = self.directions[parent]
            lines.append(f"It was asked about the research direction \"{p.title}\"" + (f" ({p.why})" if p.why else "") + ".")
        lines.append(
            "Read the follow-up in that context: resolve words like 'it' or 'still' against the main question. "
            "Search for the subject matter, never for direction ids like [d1] or dn1."
        )
        return "\n".join(lines)

    def _redirect(self, steer_id: str, direction: Direction, text: str | None) -> dict:
        new_dir = f"dn{next(self._new_dir_ids)}" if text else None
        was_running = direction.status == "running"
        left = Budget(
            max(direction.search_left, self.cfg.budget.search),
            max(direction.extract_left, self.cfg.budget.extract),
        )
        self.w.emit(
            "steer.applied",
            {
                "steer_id": steer_id,
                "action": "redirect",
                "dir": direction.id,
                "text": text,
                "new_dir": new_dir,
            },
            dir=direction.id,
        )
        direction.status = "dropped"
        self.push(
            direction.id,
            steer_id,
            "USER STEERING: this direction was dropped by the user. Call finish_direction(reason='dropped_by_user') now.",
        )
        self.push(
            "orchestrator",
            steer_id,
            f"USER STEERING: the user dropped [{direction.id}] {direction.title}. Never delegate it again.",
        )
        if not was_running and self.logger:
            self.logger.finished_dirs.add(direction.id)
            self.logger.finish_reasons[direction.id] = "dropped_by_user"
            self.w.emit(
                "direction.finished",
                {
                    "id": direction.id,
                    "reason": "dropped_by_user",
                    "summary": "",
                    "claim_ids": [],
                },
                dir=direction.id,
                agent="system",
            )
        if new_dir and text:
            new = self.ensure(new_dir, text[:120], left)
            new.why = f"User redirect from [{direction.id}]"
            new.status = "running"
            self.w.emit(
                "plan.updated",
                {
                    "added": [
                        {
                            "id": new_dir,
                            "title": new.title,
                            "why": new.why,
                            "queries": [],
                            "from_steer": steer_id,
                            "from_dir": direction.id,
                        }
                    ]
                },
                dir=new_dir,
            )
            self.w.emit(
                "direction.started",
                {
                    "id": new_dir,
                    "title": new.title,
                    "task_description": f"[{new_dir}] {text}",
                    "adhoc": False,
                },
                dir=new_dir,
            )
            if self.logger:
                self.logger.started_dirs.add(new_dir)
            self._spawn(new_dir, f"[{new_dir}] {text}")
        return {"steer_id": steer_id, "new_dir": new_dir}

    def _dig(
        self,
        steer_id: str,
        direction: Direction,
        text: str | None,
        claims: ClaimStore,
        sources: SourceStore,
    ) -> dict:
        add = self.cfg.dig_budget
        direction.search_left += add.search
        direction.extract_left += add.extract
        focus = [
            c.claim_id
            for c in claims.claims.values()
            if c.dir == direction.id and claims.status(c.claim_id, sources) != "green"
        ]
        self.w.emit(
            "steer.applied",
            {
                "steer_id": steer_id,
                "action": "dig_deeper",
                "dir": direction.id,
                "text": text,
                "budget_added": {"search": add.search, "extract": add.extract},
                "focus_claim_ids": focus,
            },
            dir=direction.id,
        )
        focus_txt = f" Strengthen or refute {', '.join(focus)}:" if focus else ""
        instruction = (
            f"USER STEERING: dig deeper. {text or ''}{focus_txt} look for independent sources AND counter-evidence. "
            f"Record new claims with corroborates/contradicts where they apply. You have {add.search} more searches and {add.extract} more reads."
        ).replace("  ", " ")
        if direction.status == "dropped":
            direction.status = "planned"
        if direction.status in ("running", "planned") and not (
            self.logger and direction.id in self.logger.finished_dirs
        ):
            self.push(direction.id, steer_id, instruction)
        else:
            existing = "\n".join(
                f"- {c.claim_id} ({claims.status(c.claim_id, sources)}): {c.text}"
                for c in claims.claims.values()
                if c.dir == direction.id
            )
            self._resume(direction.id, instruction, steer_id, focus, existing)
        return {"steer_id": steer_id}

    def _resume(
        self,
        dir_id: str,
        instruction: str,
        steer_id: str,
        focus: list[str],
        existing: str = "",
    ) -> None:
        direction = self.ensure(dir_id)
        direction.status = "running"
        if self.logger:
            self.logger.finished_dirs.discard(dir_id)
        self.w.emit(
            "direction.resumed",
            {"id": dir_id, "steer_id": steer_id, "focus_claim_ids": focus},
            dir=dir_id,
        )
        message = f"[{dir_id}] {direction.title}\n\n{instruction}"
        if existing:
            message += f"\n\nClaims already recorded in this direction:\n{existing}"
        self._spawn(dir_id, message)

    def _spawn(self, dir_id: str, message: str) -> None:
        if self.spawn_researcher is None:
            raise RuntimeError("spawn_researcher not configured")
        self.track(self.spawn_researcher(dir_id, message))

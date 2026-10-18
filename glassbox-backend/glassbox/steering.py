"""SteeringMiddleware: delivers queued user instructions right before the agent's next model call."""

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage

from .control import RunControl, direction_of


class SteeringMiddleware(AgentMiddleware):
    def __init__(self, control: RunControl, role: str):
        super().__init__()
        self.control = control
        self.role = role

    @property
    def name(self) -> str:
        return f"SteeringMiddleware[{self.role}]"

    def _pending(self, state: Any) -> dict[str, Any] | None:
        key = "orchestrator" if self.role == "orchestrator" else direction_of(state)
        items = self.control.drain(key, self.role)
        if not items:
            return None
        return {"messages": [HumanMessage(content="\n".join(i["text"] for i in items))]}

    def before_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self._pending(state)

    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self._pending(state)


class ForcePlanMiddleware(AgentMiddleware):
    """Until a plan exists, the orchestrator's model call must be plan_research (no answering from memory)."""

    def __init__(self, control: RunControl):
        super().__init__()
        self.control = control

    @property
    def name(self) -> str:
        return "ForcePlanMiddleware"

    def _request(self, request: Any) -> Any:
        if self.control.directions:
            return request
        return request.override(
            tool_choice={"type": "function", "function": {"name": "plan_research"}}
        )

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        return handler(self._request(request))

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        return await handler(self._request(request))

"""Step 1 checks: list Token Factory models, then run the cookbook agent unchanged with our logger.

uv run python scripts/check_setup.py models
uv run python scripts/check_setup.py cookbook "your question"
"""

import asyncio
import os
import sys
import uuid

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from glassbox.config import Config, make_chat_model  # noqa: E402
from glassbox.events import EventWriter, read_events  # noqa: E402
from glassbox.logger import GlassboxLogger  # noqa: E402


def list_models() -> None:
    cfg = Config()
    response = httpx.get(
        cfg.nebius_base_url.rstrip("/") + "/models",
        headers={"Authorization": f"Bearer {os.environ['NEBIUS_API_KEY']}"},
        timeout=30,
    )
    response.raise_for_status()
    ids = sorted(m["id"] for m in response.json().get("data", []))
    wanted = ("minimax", "nemotron", "beam", "reflection")
    for model_id in ids:
        marker = "  <--" if any(w in model_id.lower() for w in wanted) else ""
        print(model_id + marker)


async def cookbook(question: str) -> None:
    from deepagents import create_deep_agent
    from langchain_tavily import TavilySearch

    cfg = Config()
    run_id = "cookbook-" + uuid.uuid4().hex[:6]
    writer = EventWriter(run_id, cfg.runs_dir / run_id)
    logger = GlassboxLogger(writer)
    agent = create_deep_agent(
        model=make_chat_model(cfg.orchestrator_model, cfg),
        tools=[TavilySearch(max_results=5, search_depth="advanced")],
    )
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": question}]},
        config={"callbacks": [logger]},
    )
    print("Deep research report:\n", result["messages"][-1].content)
    events = read_events(writer.path)
    tools = [e["data"]["name"] for e in events if e["type"] == "tool.started"]
    sub = [
        e for e in events if e["type"] == "tool.started" and e["agent"] == "researcher"
    ]
    print(f"\n{len(events)} events -> {writer.path}")
    print(f"tool calls: {tools}")
    print(
        f"tool calls inside subagents: {len(sub)} (callbacks reach subagents: {'yes' if sub or 'task' not in tools else 'NO'})"
    )


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "models"
    if command == "models":
        list_models()
    else:
        asyncio.run(
            cookbook(
                sys.argv[2]
                if len(sys.argv) > 2
                else "Research GPUs available in the US in 2026 and write a short report."
            )
        )

"""Deterministic stand-ins for the chat model and Tavily, so tests never touch the network."""

import itertools
import re
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult


class ScriptedChatModel(GenericFakeChatModel):
    """GenericFakeChatModel that accepts bind_tools and can be scripted with tool calls."""

    model_name: str = "fake-model"

    def bind_tools(self, tools: Any, **kwargs: Any):
        return self

    @property
    def _llm_type(self) -> str:
        return "scripted-fake"


def call(name: str, args: dict, id: str | None = None) -> dict:
    return {
        "name": name,
        "args": args,
        "id": id or f"call_{name}_{next(_ids)}",
        "type": "tool_call",
    }


_ids = itertools.count()


def ai(*tool_calls: dict, content: str = "", usage: dict | None = None) -> AIMessage:
    return AIMessage(
        content=content,
        tool_calls=list(tool_calls),
        usage_metadata=usage
        or {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120},
    )


def scripted(messages: list[AIMessage]) -> ScriptedChatModel:
    return ScriptedChatModel(messages=iter(messages))


class DirectionScriptedModel(BaseChatModel):
    """Answers from a separate script per direction ([d1], [d2], ...), so parallel researchers don't interleave."""

    scripts: dict[str, list[AIMessage]]
    model_name: str = "fake-researcher"

    def bind_tools(self, tools: Any, **kwargs: Any):
        return self

    @property
    def _llm_type(self) -> str:
        return "direction-scripted-fake"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        key = None
        for m in messages:
            if m.type == "human":
                match = re.match(
                    r"^\s*\[(d\w+)\]", m.content if isinstance(m.content, str) else ""
                )
                key = match.group(1) if match else None
                break
        script = self.scripts.get(key) or []
        message = script.pop(0) if script else AIMessage(content=f"{key} done")
        return ChatResult(generations=[ChatGeneration(message=message)])


class FakeTavily:
    """Mimics TavilyClient.search / .extract with canned pages."""

    def __init__(self, pages: dict[str, dict[str, str]]):
        self.pages = pages  # url -> {"title", "content"}
        self.search_calls: list[str] = []
        self.extract_calls: list[str] = []

    def search(self, query: str, **kwargs: Any) -> dict:
        self.search_calls.append(query)
        return {
            "results": [
                {
                    "url": url,
                    "title": p["title"],
                    "content": p["content"][:200],
                    "score": 0.9 - i * 0.1,
                }
                for i, (url, p) in enumerate(self.pages.items())
            ]
        }

    def extract(self, urls: list[str], **kwargs: Any) -> dict:
        self.extract_calls.extend(urls)
        return {
            "results": [
                {"url": u, "raw_content": self.pages[u]["content"]}
                for u in urls
                if u in self.pages
            ],
            "failed_results": [
                {"url": u, "error": "not found"} for u in urls if u not in self.pages
            ],
        }

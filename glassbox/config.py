import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

DEFAULT_MODEL = "MiniMaxAI/MiniMax-M3"


@dataclass
class Budget:
    search: int = 4
    extract: int = 4


@dataclass
class Config:
    nebius_base_url: str = field(
        default_factory=lambda: os.getenv(
            "NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1"
        )
    )
    orchestrator_model: str = field(
        default_factory=lambda: os.getenv("ORCHESTRATOR_MODEL", DEFAULT_MODEL)
    )
    researcher_model: str = field(
        default_factory=lambda: os.getenv("RESEARCHER_MODEL", DEFAULT_MODEL)
    )
    writer_model: str = field(
        default_factory=lambda: os.getenv("WRITER_MODEL", DEFAULT_MODEL)
    )
    checker_model: str = field(
        default_factory=lambda: (
            os.getenv("CHECKER_MODEL") or os.getenv("WRITER_MODEL", DEFAULT_MODEL)
        )
    )
    runs_dir: Path = field(default_factory=lambda: Path(os.getenv("RUNS_DIR", "runs")))
    budget: Budget = field(default_factory=lambda: Budget(search=5, extract=5))
    dig_budget: Budget = field(default_factory=lambda: Budget(search=3, extract=3))
    max_directions: int = 4
    extract_chars_for_model: int = 6000
    # USD per 1M tokens (input, output); unknown models cost 0 so the stats bar never lies upwards.
    prices: dict[str, tuple[float, float]] = field(default_factory=dict)


def make_chat_model(model: str, cfg: Config | None = None, **kwargs):
    cfg = cfg or Config()
    # Token Factory's default cap is 60 RPM and parallel researchers can hit it: retry 429s with backoff.
    kwargs.setdefault("max_retries", 6)
    kwargs.setdefault("request_timeout", 180)
    return _reasoning_chat_class()(
        model=model, nebius_api_base=cfg.nebius_base_url, **kwargs
    )


_REASONING_CLASS = None


def _reasoning_chat_class():
    """ChatNebius that keeps the `reasoning` field Token Factory returns (langchain-openai drops it)."""
    global _REASONING_CLASS
    if _REASONING_CLASS is not None:
        return _REASONING_CLASS
    import openai
    from langchain_nebius import ChatNebius

    class ChatNebiusWithReasoning(ChatNebius):
        def _create_chat_result(self, response, generation_info=None):
            result = super()._create_chat_result(response, generation_info)
            response_dict = (
                response
                if isinstance(response, dict)
                else (
                    response.model_dump(warnings=False)
                    if isinstance(response, openai.BaseModel)
                    else {}
                )
            )
            for generation, choice in zip(
                result.generations, response_dict.get("choices") or []
            ):
                message = choice.get("message") or {}
                reasoning = message.get("reasoning") or message.get("reasoning_content")
                if reasoning:
                    generation.message.additional_kwargs["reasoning_content"] = (
                        reasoning
                    )
            return result

    _REASONING_CLASS = ChatNebiusWithReasoning
    return _REASONING_CLASS

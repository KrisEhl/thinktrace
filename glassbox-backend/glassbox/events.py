"""Event envelope and the append-only JSONL writer with live fan-out."""

import asyncio
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1


def _now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(k): _jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_jsonable(v) for v in value]
        if hasattr(value, "model_dump"):
            return _jsonable(value.model_dump())
        return str(value)


class EventWriter:
    """Assigns seq, appends one JSON line per event (flushed), and fans out to subscribers."""

    def __init__(self, run_id: str, run_dir: Path):
        self.run_id = run_id
        self.run_dir = run_dir
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.path = run_dir / "events.jsonl"
        self._file = self.path.open("a", encoding="utf-8")
        self._seq = 0
        self._lock = threading.Lock()
        self._subscribers: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self.closed = False

    def emit(
        self,
        type: str,
        data: dict[str, Any] | None = None,
        *,
        span: str | None = None,
        parent_span: str | None = None,
        dir: str | None = None,
        agent: str = "system",
    ) -> dict[str, Any]:
        with self._lock:
            event = {
                "v": SCHEMA_VERSION,
                "seq": self._seq,
                "ts": _now(),
                "run_id": self.run_id,
                "type": type,
                "span": span,
                "parent_span": parent_span,
                "dir": dir,
                "agent": agent,
                "data": _jsonable(data or {}),
            }
            self._seq += 1
            self._file.write(json.dumps(event, ensure_ascii=False) + "\n")
            self._file.flush()
            subscribers = list(self._subscribers)
        for loop, queue in subscribers:
            loop.call_soon_threadsafe(queue.put_nowait, event)
        return event

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        with self._lock:
            self._subscribers.append((asyncio.get_running_loop(), queue))
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers = [
                (loop, q) for loop, q in self._subscribers if q is not queue
            ]

    def close(self) -> None:
        with self._lock:
            if not self.closed:
                self._file.close()
                self.closed = True


def read_events(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]

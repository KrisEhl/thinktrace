"""HTTP server for the web UI: start runs, stream their event log, steer, read sources.

    uv run uvicorn glassbox.server:app --port 8000

Endpoints (the same paths the web dev server replays from runs/ without a backend):
    GET  /health
    GET  /runs                          recorded and live runs
    POST /runs {question}               start a live run
    GET  /runs/{id}/events?from=N       SSE: the log from seq N, then live events until run.finished
    POST /runs/{id}/steer {action, dir, text}
    GET  /runs/{id}/sources/{sid}
"""

import asyncio
import json
import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .agent import GlassboxRun
from .config import Config
from .events import read_events

app = FastAPI(title="glassbox")
RUNS = Config().runs_dir
SAFE = re.compile(r"^[\w.-]+$")
live: dict[str, GlassboxRun] = {}


class CreateRun(BaseModel):
    question: str


class Steer(BaseModel):
    action: str
    dir: str
    text: str | None = None


def _log(run_id: str):
    if not SAFE.match(run_id) or not (RUNS / run_id / "events.jsonl").exists():
        raise HTTPException(404, "unknown run")
    return RUNS / run_id / "events.jsonl"


@app.get("/health")
def health() -> dict:
    return {"ok": True, "mode": "live", "live_runs": len(live)}


@app.get("/runs")
def list_runs() -> list[dict]:
    out = []
    for d in sorted(RUNS.glob("*/events.jsonl")):
        ev = read_events(d)
        started = next((e for e in ev if e["type"] == "run.started"), None)
        out.append(
            {
                "run_id": d.parent.name,
                "question": (started or {}).get("data", {}).get("question", ""),
                "status": "running" if d.parent.name in live else "finished" if any(e["type"] == "run.finished" for e in ev) else "incomplete",
                "started_at": ev[0]["ts"] if ev else None,
            }
        )
    return out


async def _drive(run: GlassboxRun) -> None:
    # Same lifecycle as the CLI: research, wait for steered work and rewrites, then finish.
    try:
        run.start()
        await run.wait_quiet()
        while run.control.tasks or run._rewrites:
            await run.wait_quiet()
        run.close()
    except Exception as exc:  # keep the server up; the log carries the error
        run.writer.emit("run.error", {"where": "server", "message": str(exc)})
        run.close("error")
    finally:
        live.pop(run.run_id, None)


@app.post("/runs")
async def create_run(body: CreateRun) -> dict:
    if not body.question.strip():
        raise HTTPException(400, "empty question")
    run = GlassboxRun(body.question.strip())
    live[run.run_id] = run
    asyncio.create_task(_drive(run))
    return {"run_id": run.run_id}


@app.get("/runs/{run_id}/events")
async def events(run_id: str, request: Request):
    path = _log(run_id)
    frm = int(request.query_params.get("from") or request.headers.get("last-event-id") or 0)
    run = live.get(run_id)
    # Subscribe before reading the file so nothing falls between the replay and the live tail.
    queue = run.writer.subscribe() if run else None

    async def stream():
        last = frm - 1
        try:
            for e in read_events(path):
                if e["seq"] > last:
                    last = e["seq"]
                    yield f"id: {e['seq']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n"
            while queue is not None:
                e = await queue.get()
                if e["seq"] <= last:
                    continue
                last = e["seq"]
                yield f"id: {e['seq']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n"
                if e["type"] == "run.finished":
                    return
        finally:
            if queue is not None and run is not None:
                run.writer.unsubscribe(queue)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/runs/{run_id}/steer")
def steer(run_id: str, body: Steer) -> dict:
    run = live.get(run_id)
    if not run:
        raise HTTPException(409, "This run is not live (recorded or finished), so it cannot be steered.")
    if body.action not in ("redirect", "dig_deeper"):
        raise HTTPException(400, f"unsupported action {body.action}")
    try:
        return run.steer(body.action, body.dir, body.text)
    except (KeyError, ValueError) as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/runs/{run_id}/sources/{sid}")
def source(run_id: str, sid: str) -> dict:
    path = _log(run_id)
    if not SAFE.match(sid):
        raise HTTPException(404, "unknown source")
    meta = next((e["data"] for e in read_events(path) if e["type"] == "source.added" and e["data"].get("source_id") == sid), {})
    f = path.parent / "sources" / f"{sid}.txt"
    text = f.read_text(encoding="utf-8") if f.exists() else None
    return {"source_id": sid, "url": meta.get("url", ""), "title": meta.get("title", sid), "domain": meta.get("domain", ""), "text": text, "read": text is not None}

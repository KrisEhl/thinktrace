"""HTTP server for the web UI: start runs, stream their event log, steer, read sources.

    uv run uvicorn glassbox.server:app --port 8000

Endpoints (the same paths the web dev server replays from runs/ without a backend):
    GET  /health
    GET  /runs                          recorded and live runs
    POST /runs {question}               start a live run
    GET  /runs/{id}/events?from=N&speed=S  SSE: the log from seq N (timed replay at S x speed when S > 0),
                                        then live events until run.finished
    GET  /runs/{id}/events.jsonl        the raw log
    POST /runs/{id}/steer {action, dir, text}   redirect | dig_deeper | follow_up (dir "q" = the question);
                                        404 unknown direction, 409 run not live
    POST /runs/{id}/close               finish a live run now
    GET  /runs/{id}/sources/{sid}

Live runs stay open for steering after the first answer (a steer then rewrites it) and close after
IDLE_CLOSE seconds without a steer. If web/dist exists it is served at /.
"""

import asyncio
import json
import re
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .agent import GlassboxRun
from .config import Config
from .events import read_events
from .scoring import Scorer, event_data

_SCORE_INPUTS = ("claim.recorded", "claim.linked", "source.classified", "source.added")

app = FastAPI(title="glassbox")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
RUNS = Config().runs_dir
SAFE = re.compile(r"^[\w.-]+$")
IDLE_CLOSE = 600  # seconds a finished-looking live run waits for another steer
live: dict[str, GlassboxRun] = {}
last_steer: dict[str, float] = {}
close_now: set[str] = set()


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
                "status": "live" if d.parent.name in live else "finished" if any(e["type"] == "run.finished" for e in ev) else "incomplete",
                "started_at": ev[0]["ts"] if ev else None,
            }
        )
    return out


async def _drive(run: GlassboxRun) -> None:
    # Research, then stay open for steering (a steer after the answer triggers a rewrite);
    # close after IDLE_CLOSE seconds without a steer, or on POST /close.
    try:
        run.start()
        last_steer[run.run_id] = time.monotonic()
        while True:
            await run.wait_quiet()
            if run.run_id in close_now or time.monotonic() - last_steer[run.run_id] > IDLE_CLOSE:
                break
            await asyncio.sleep(1)
        run.close()
    except Exception as exc:  # keep the server up; the log carries the error
        run.writer.emit("run.error", {"where": "server", "message": str(exc)})
        run.close("error")
    finally:
        live.pop(run.run_id, None)
        last_steer.pop(run.run_id, None)
        close_now.discard(run.run_id)


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
    speed = float(request.query_params.get("speed") or 0)
    run = live.get(run_id)
    # Subscribe before reading the file so nothing falls between the replay and the live tail.
    queue = run.writer.subscribe() if run else None

    def scores_event(seq: float, ts: str, data: dict) -> str:
        e = {"v": 1, "seq": seq, "ts": ts, "run_id": run_id, "type": "scores.updated",
             "span": None, "parent_span": None, "dir": None, "agent": "scorer", "data": data}
        return f"data: {json.dumps(e, ensure_ascii=False)}\n\n"

    async def stream():
        last = frm - 1
        prev = None
        logged = read_events(path)
        # Recorded runs from before the scorer existed: score them while replaying, the way a live run is scored,
        # with one update after each burst of new claims / links.
        backfill = run is None and not any(e["type"] == "scores.updated" for e in logged)
        scorer, dirty = Scorer(), False
        try:
            for i, e in enumerate(logged):
                if e["seq"] > last:
                    if speed > 0 and run is None and prev is not None:
                        # Timed replay of a recorded run, gaps capped at 2 s.
                        gap = (_ts(e) - _ts(prev)) / speed
                        await asyncio.sleep(min(max(gap, 0), 2.0))
                    prev = e
                    last = e["seq"]
                    yield f"id: {e['seq']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n"
                if backfill:
                    dirty = scorer.feed(e) or dirty
                    nxt = logged[i + 1] if i + 1 < len(logged) else None
                    if dirty and (nxt is None or nxt["type"] not in _SCORE_INPUTS):
                        dirty = False
                        if e["seq"] >= last:  # not re-sent on a resume
                            yield scores_event(e["seq"] + 0.5, e["ts"], event_data(scorer.compute()))
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


def _ts(e: dict) -> float:
    return datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).timestamp()


@app.get("/runs/{run_id}/events.jsonl")
def events_jsonl(run_id: str):
    return FileResponse(_log(run_id), media_type="application/x-ndjson")


@app.post("/runs/{run_id}/close")
async def close(run_id: str) -> dict:
    if run_id not in live:
        raise HTTPException(409, "run is not live")
    close_now.add(run_id)
    return {"ok": True}


# async: steering spawns researcher tasks, which must run on the server's event loop (not a worker thread).
@app.post("/runs/{run_id}/steer")
async def steer(run_id: str, body: Steer) -> dict:
    run = live.get(run_id)
    if not run:
        raise HTTPException(409, "This run is not live (recorded or finished), so it cannot be steered.")
    if body.action not in ("redirect", "dig_deeper", "follow_up"):
        raise HTTPException(400, f"unsupported action {body.action}")
    if body.dir not in run.control.directions and not (body.action == "follow_up" and body.dir == "q"):
        raise HTTPException(404, f"unknown direction {body.dir}")
    last_steer[run_id] = time.monotonic()
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


# The built UI, when present (npm run build in web/). Mounted last so the API routes win.
_dist = Path(__file__).resolve().parent.parent / "web" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="web")

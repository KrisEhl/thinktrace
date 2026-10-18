"""Command line: run a question, watch the trace, steer while it runs.

    uv run python -m glassbox.cli "Your question"                 # run, print trace + answer, exit
    uv run python -m glassbox.cli -i "Your question"              # stay open for steering after the answer
    uv run python -m glassbox.cli --replay runs/<id> [--speed 4]  # replay a recorded log

While running, type:
    drop d3 [research this instead]
    dig d2 [focus]
    status
    quit
"""

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

from .agent import GlassboxRun
from .events import read_events

DIM, BOLD, RESET = "\033[2m", "\033[1m", "\033[0m"
COLORS = {"d1": "\033[36m", "d2": "\033[35m", "d3": "\033[33m", "d4": "\033[32m"}


def fmt(event: dict) -> str | None:
    t, d, data = event["type"], event.get("dir"), event["data"]
    tag = f"{COLORS.get(d, chr(27) + '[34m')}[{d}]{RESET} " if d else ""
    if t == "run.started":
        return f"{BOLD}? {data['question']}{RESET}  {DIM}{data['models']}{RESET}"
    if t in ("plan.created", "plan.updated"):
        items = data.get("directions") or data.get("added") or []
        return "PLAN\n" + "\n".join(
            f"  [{x['id']}] {x['title']}  {DIM}- {x.get('why', '')}{RESET}"
            for x in items
        )
    if t == "direction.started":
        return f"{tag}▶ {data['title']}"
    if t == "decision":
        return f"{tag}🤔 {data.get('next_action')}: {data.get('reason')}"
    if t == "search.completed":
        if data.get("blocked"):
            return f"{tag}⛔ search blocked ({data['blocked']}): {data.get('query')}"
        return f"{tag}🔎 {data.get('query')}  {DIM}→ {', '.join(r['source_id'] + ' ' + r['domain'] for r in data.get('results', []))}{RESET}"
    if t == "read.completed":
        if data.get("blocked"):
            return f"{tag}⛔ read blocked ({data['blocked']}): {data.get('source_id')}"
        return f"{tag}📖 read {data.get('source_id')} {DIM}({data.get('chars')} chars, ok={data.get('ok')}){RESET}"
    if t == "claim.recorded":
        mark = {"exact": "✓", "fuzzy": "≈", "not_found": "✗"}[data["verified"]]
        rel = (
            f" corroborates {data['corroborates']}" if data.get("corroborates") else ""
        )
        rel += f" contradicts {data['contradicts']}" if data.get("contradicts") else ""
        return f"{tag}📌 {data['claim_id']} {mark} {data['text']}  {DIM}[{data['source_id']} {data.get('domain', '')}]{rel}{RESET}"
    if t == "direction.finished":
        return f"{tag}■ stopped: {BOLD}{data['reason']}{RESET}  {DIM}{data.get('summary', '')}{RESET}"
    if t == "budget.hit":
        return f"{tag}⏱ budget hit on {data['tool']}"
    if t == "steer.applied":
        return f"{BOLD}🎛  STEER {data['action']} {data['dir']}{RESET} {data.get('text') or ''}"
    if t == "steer.delivered":
        return f"{tag}{DIM}(agent received your instruction){RESET}"
    if t == "direction.resumed":
        return f"{tag}↻ resumed"
    if t == "model.thought":
        return f"{tag}{DIM}💭 {' '.join(data['text'].split())[:160]}{RESET}"
    if t == "synthesis.started":
        return f"✍️  writing answer v{data.get('version')} from {data['n_claims']} verified claims…"
    if t == "report.final":
        changed = (
            f"\n{DIM}changed: {data['changed']}{RESET}" if data.get("changed") else ""
        )
        dropped = (
            f"\n{DIM}({len(data['dropped'])} uncited sentences dropped){RESET}"
            if data.get("dropped")
            else ""
        )
        return f"\n{BOLD}ANSWER v{data['version']}{RESET}\n{data['markdown']}{dropped}{changed}\n"
    if t == "run.error":
        return f"{tag}\033[31m! {data['where']}: {data['message'][:300]}{RESET}"
    if t == "run.finished":
        return f"{DIM}done in {data['duration_ms'] / 1000:.0f}s · {json.dumps(data['totals'])}{RESET}"
    return None


async def printer(run: GlassboxRun) -> None:
    queue = run.writer.subscribe()
    try:
        while True:
            event = await queue.get()
            line = fmt(event)
            if line:
                print(line, flush=True)
            if event["type"] == "run.finished":
                return
    finally:
        run.writer.unsubscribe(queue)


async def repl(run: GlassboxRun) -> None:
    while not run.closed:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            return
        parts = line.strip().split(maxsplit=2)
        if not parts:
            continue
        cmd = parts[0].lower()
        try:
            if cmd in ("quit", "exit", "q"):
                return
            if cmd == "status":
                for d in run.control.directions.values():
                    print(
                        f"  [{d.id}] {d.status:8} search left {d.search_left}, read left {d.extract_left}  {d.title}"
                    )
            elif cmd in ("drop", "redirect") and len(parts) >= 2:
                print(
                    run.steer(
                        "redirect", parts[1], parts[2] if len(parts) > 2 else None
                    )
                )
            elif cmd == "dig" and len(parts) >= 2:
                print(
                    run.steer(
                        "dig_deeper", parts[1], parts[2] if len(parts) > 2 else None
                    )
                )
            else:
                print(
                    "commands: drop <dir> [instead…] · dig <dir> [focus…] · status · quit"
                )
        except (KeyError, ValueError) as exc:
            print(f"! {exc}")


async def main_run(question: str, interactive: bool) -> None:
    run = GlassboxRun(question)
    print(f"{DIM}log: {run.writer.path}{RESET}")
    printing = asyncio.create_task(printer(run))
    await asyncio.sleep(0)
    run.start()
    steering = asyncio.create_task(repl(run))
    if interactive:
        await steering
    else:
        await run.wait_quiet()
        # Give steers typed during the run a chance to finish before closing.
        while not steering.done() and (run.control.tasks or run._rewrites):
            await run.wait_quiet()
        steering.cancel()
    await run.wait_quiet()
    run.close()
    await printing


async def replay(run_dir: Path, speed: float) -> None:
    events = read_events(run_dir / "events.jsonl")
    previous = None
    for event in events:
        ts = datetime.fromisoformat(event["ts"].replace("Z", "+00:00"))
        if previous and speed > 0:
            await asyncio.sleep(min((ts - previous).total_seconds() / speed, 2.0))
        previous = ts
        line = fmt(event)
        if line:
            print(line, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(prog="glassbox")
    parser.add_argument("question", nargs="?")
    parser.add_argument(
        "-i",
        "--interactive",
        action="store_true",
        help="stay open for steering after the answer",
    )
    parser.add_argument("--replay", type=Path, help="replay a recorded run directory")
    parser.add_argument("--speed", type=float, default=4.0)
    args = parser.parse_args()
    if args.replay:
        asyncio.run(replay(args.replay, args.speed))
    elif args.question:
        asyncio.run(main_run(args.question, args.interactive))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

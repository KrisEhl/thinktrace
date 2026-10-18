import pytest

from glassbox.events import read_events
from tests.fakes import ai, call
from tests.test_agent import make_run, researcher_scripts


def of(events, type_, **match):
    return [
        e
        for e in events
        if e["type"] == type_
        and all(e.get(k) == v or e["data"].get(k) == v for k, v in match.items())
    ]


@pytest.mark.asyncio
async def test_dropped_direction_is_blocked_in_code_and_instruction_is_delivered(
    tmp_path,
):
    scripts = researcher_scripts()
    scripts["d2"] = [
        ai(call("tavily_search", {"query": "ignored", "reason": "test"})),
        ai(
            call(
                "finish_direction",
                {"reason": "nothing_new", "summary": "", "claim_ids": []},
            )
        ),
        ai(content="d2 stopped"),
    ]
    run, tavily = make_run(tmp_path, ["Density hit 500 Wh/kg [c1]."], scripts=scripts)
    run.control.ensure("d2").status = "dropped"
    run.control.push("d2", "st0", "USER STEERING: dropped")
    await run.run()
    run.close()
    events = read_events(run.writer.path)

    assert "ignored" not in tavily.search_calls  # the guard stopped it before Tavily
    assert of(events, "search.completed", dir="d2")[0]["data"]["blocked"] == "dropped"
    assert (
        of(events, "direction.finished", id="d2")[0]["data"]["reason"]
        == "dropped_by_user"
    )
    assert of(events, "steer.delivered", dir="d2"), (
        "inbox instruction should reach the researcher's model call"
    )


@pytest.mark.asyncio
async def test_dig_deeper_on_finished_direction_resumes_it_and_rewrites_answer(
    tmp_path,
):
    extra = [
        ai(
            call(
                "think",
                {
                    "reflection": "user wants more",
                    "next_action": "search",
                    "reason": "find cost data",
                },
            )
        ),
        ai(call("tavily_search", {"query": "solid state cost per kWh", "reason": "test"})),
        ai(
            call(
                "record_claim",
                {
                    "claim": "costs high (second source)",
                    "quote": "Costs remain high.",
                    "source_id": "s1",
                },
            )
        ),
        ai(
            call(
                "finish_direction",
                {
                    "reason": "enough_evidence",
                    "summary": "cost found",
                    "claim_ids": ["c4"],
                },
            )
        ),
        ai(content="d2 done again"),
    ]
    run, tavily = make_run(
        tmp_path,
        [
            "Density hit 500 Wh/kg [c1][c2].",
            "Density hit 500 Wh/kg [c1][c2]. Costs remain high [c4].",
        ],
        scripts=researcher_scripts(d2_extra=extra),
    )
    await run.run()
    run.steer("dig_deeper", "d2", "focus on cost per kWh")
    await run.wait_quiet()
    run.close()
    events = read_events(run.writer.path)
    t = [e["type"] for e in events]

    steer = of(events, "steer.applied", action="dig_deeper")[0]
    assert steer["data"]["budget_added"] == {"search": 3, "extract": 3}
    assert t.index("steer.applied") < t.index("direction.resumed")
    assert "solid state cost per kWh" in tavily.search_calls
    resumed_searches = of(events, "search.completed", dir="d2")
    assert any(
        e["data"]["query"] == "solid state cost per kWh" for e in resumed_searches
    )

    reports = of(events, "report.final")
    assert [r["data"]["version"] for r in reports] == [1, 2]
    assert reports[1]["data"]["changed"] == ["Costs remain high [c4]."]
    assert run.totals()["steers"] == 1 and run.totals()["restarts"] == 0


@pytest.mark.asyncio
async def test_redirect_drops_direction_and_spawns_new_one(tmp_path):
    scripts = researcher_scripts()
    scripts["dn1"] = [
        ai(
            call(
                "think",
                {
                    "reflection": "new focus",
                    "next_action": "search",
                    "reason": "user asked for safety",
                },
            )
        ),
        ai(call("tavily_search", {"query": "solid state battery safety", "reason": "test"})),
        ai(
            call(
                "finish_direction",
                {"reason": "nothing_new", "summary": "", "claim_ids": []},
            )
        ),
        ai(content="dn1 done"),
    ]
    run, tavily = make_run(
        tmp_path,
        [
            "Density hit 500 Wh/kg [c1][c2]. Costs remain high [c3].",
            "Nothing verified beyond this [c1].",
        ],
        scripts=scripts,
    )
    await run.run()
    result = run.steer("redirect", "d1", "safety and fire risk")
    await run.wait_quiet()
    run.close()
    events = read_events(run.writer.path)

    assert result["new_dir"] == "dn1"
    assert (
        of(events, "direction.finished", id="d1")[-1]["data"]["reason"]
        == "dropped_by_user"
    )
    added = of(events, "plan.updated")[0]["data"]["added"][0]
    assert added["id"] == "dn1" and added["from_dir"] == "d1"
    assert of(events, "search.completed", dir="dn1")
    # d1's claims are excluded from the rewritten answer; nothing verified is left.
    assert of(events, "report.final")[-1]["data"]["markdown"].startswith(
        "No verified claims"
    )


@pytest.mark.asyncio
async def test_follow_up_gets_the_main_question_and_parent_direction(tmp_path):
    run, _ = make_run(tmp_path, ["Berlin is a city-state [c1]."])
    spawned = []
    run.control.spawn_researcher = lambda dir_id, message: _noop(spawned.append((dir_id, message)))
    run.control.ensure("d3", "German reunification: merger into one state").why = "1990 treaty"

    result = run.control.steer("follow_up", "d3", "why is it not split in 2 still", run.ctx.claims, run.ctx.sources)

    dir_id, task = spawned[0]
    assert dir_id == result["new_dir"] == "dn1"
    assert task.startswith("[dn1] Follow-up question from the user: why is it not split in 2 still")
    assert run.question in task  # the main question, so "it" resolves
    assert "German reunification" in task and "1990 treaty" in task
    events = read_events(run.writer.path)
    assert of(events, "plan.updated")[-1]["data"]["added"][0]["parent"] == "d3"


async def _noop(_):
    return None


@pytest.mark.asyncio
async def test_tavily_rate_limit_is_retried_then_succeeds(monkeypatch):
    from glassbox import tools

    monkeypatch.setattr(tools, "RETRY_DELAYS", (0.0, 0.0))
    calls = []

    def flaky(query):
        calls.append(query)
        if len(calls) < 3:
            raise RuntimeError("Your request has been blocked due to excessive requests.")
        return {"results": [query]}

    assert await tools.call_tavily(flaky, "q") == {"results": ["q"]}
    assert len(calls) == 3

    def broken(query):
        raise ValueError("bad api key")

    with pytest.raises(ValueError):  # non-transient errors are not retried
        await tools.call_tavily(broken, "q")


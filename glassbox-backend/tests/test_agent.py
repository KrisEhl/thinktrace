import pytest

from glassbox.agent import GlassboxRun
from glassbox.config import Config
from glassbox.events import read_events
from tests.fakes import DirectionScriptedModel, FakeTavily, ai, call, scripted

PAGES = {
    "https://www.example.com/a": {
        "title": "Example A",
        "content": "Solid-state batteries reached 500 Wh/kg in lab tests in 2026. Costs remain high.",
    },
    "https://news.other.org/b": {
        "title": "Other B",
        "content": "Independent labs confirmed that solid-state batteries reached 500 Wh/kg in 2026.",
    },
}

PLAN = [
    {
        "id": "d1",
        "title": "Energy density",
        "why": "core metric",
        "queries": ["solid state energy density"],
    },
    {
        "id": "d2",
        "title": "Cost",
        "why": "adoption",
        "queries": ["solid state battery cost"],
    },
]


def orchestrator_script():
    return scripted(
        [
            ai(call("plan_research", {"directions": PLAN})),
            ai(
                call(
                    "task",
                    {
                        "description": "[d1] Energy density",
                        "subagent_type": "researcher",
                    },
                ),
                call(
                    "task", {"description": "[d2] Cost", "subagent_type": "researcher"}
                ),
            ),
            ai(content="Research complete."),
        ]
    )


def researcher_scripts(d2_extra=None):
    return {
        "d1": [
            ai(
                call(
                    "think",
                    {
                        "reflection": "nothing yet",
                        "next_action": "search",
                        "reason": "need density figures",
                    },
                )
            ),
            ai(call("tavily_search", {"query": "solid state energy density", "reason": "test"})),
            ai(call("tavily_extract", {"source_id": "s1", "reason": "test"})),
            ai(
                call(
                    "record_claim",
                    {
                        "claim": "500 Wh/kg in lab",
                        "quote": "Solid-state batteries reached 500 Wh/kg in lab tests in 2026.",
                        "source_id": "s1",
                    },
                )
            ),
            ai(call("tavily_extract", {"source_id": "s2", "reason": "test"})),
            ai(
                call(
                    "record_claim",
                    {
                        "claim": "confirmed independently",
                        "quote": "confirmed that solid-state batteries reached 500 Wh/kg",
                        "source_id": "s2",
                        "corroborates": "c1",
                    },
                )
            ),
            ai(
                call(
                    "record_claim",
                    {
                        "claim": "costs high",
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
                        "summary": "500 Wh/kg, two sources",
                        "claim_ids": ["c1", "c2", "c3"],
                    },
                )
            ),
            ai(content="d1: 500 Wh/kg [c1][c2]"),
        ],
        "d2": [
            ai(
                call(
                    "think",
                    {
                        "reflection": "need cost",
                        "next_action": "search",
                        "reason": "cost drives adoption",
                    },
                )
            ),
            ai(call("tavily_search", {"query": "solid state battery cost", "reason": "test"})),
            ai(
                call(
                    "finish_direction",
                    {
                        "reason": "nothing_new",
                        "summary": "nothing useful",
                        "claim_ids": [],
                    },
                )
            ),
            ai(content="d2: nothing"),
        ]
        + (d2_extra or []),
    }


def make_run(tmp_path, writer_text, scripts=None, checker_links=None):
    cfg = Config(runs_dir=tmp_path)
    cfg.budget.search, cfg.budget.extract = 4, 4
    tavily = FakeTavily(PAGES)
    run = GlassboxRun(
        "Are solid-state batteries ready?",
        cfg=cfg,
        run_id="t1",
        tavily=tavily,
        models={
            "orchestrator": orchestrator_script(),
            "researcher": DirectionScriptedModel(
                scripts=scripts or researcher_scripts()
            ),
            "writer": scripted([ai(content=t) for t in writer_text]),
            "checker": scripted(
                [ai(call("Links", {"links": checker_links or []})) for _ in range(5)]
            ),
        },
    )
    return run, tavily


def types(events):
    return [e["type"] for e in events]


@pytest.mark.asyncio
async def test_full_run_emits_semantic_events_with_directions(tmp_path):
    run, tavily = make_run(
        tmp_path,
        [
            "Density hit 500 Wh/kg [c1][c2]. Costs remain high [c3]. Prices will fall soon."
        ],
    )
    await run.run()
    run.close()
    events = read_events(run.writer.path)
    t = types(events)

    assert t[0] == "run.started" and t[-1] == "run.finished"
    assert t.index("plan.created") < t.index("direction.started")
    assert sorted(
        e["data"]["id"] for e in events if e["type"] == "direction.started"
    ) == ["d1", "d2"]

    # Every researcher-level event is attributed to a direction.
    for e in events:
        if e["agent"] == "researcher":
            assert e["dir"] in ("d1", "d2"), e

    # A decision is logged before the search it led to, in the same direction.
    d1 = [e for e in events if e["dir"] == "d1"]
    assert types(d1).index("decision") < types(d1).index("search.started")

    claims = {
        e["data"]["claim_id"]: e["data"]
        for e in events
        if e["type"] == "claim.recorded"
    }
    assert claims["c1"]["verified"] == "exact" and claims["c1"]["span"] is not None
    assert claims["c2"]["verified"] == "exact" and claims["c2"]["corroborates"] == "c1"
    assert claims["c3"]["verified"] == "exact" and claims["c3"]["span"] is not None

    finished = {
        e["data"]["id"]: e["data"]["reason"]
        for e in events
        if e["type"] == "direction.finished"
    }
    assert finished == {"d1": "enough_evidence", "d2": "nothing_new"}

    report = [e for e in events if e["type"] == "report.final"][-1]["data"]
    assert (
        report["markdown"] == "Density hit 500 Wh/kg [c1][c2]. Costs remain high [c3]."
    )
    assert report["dropped"] == ["Prices will fall soon."]
    assert "run.idle" in t
    assert run.totals()["searches"] == 2 and run.totals()["reads"] == 2
    assert (run.run_dir / "sources" / "s1.txt").exists()


@pytest.mark.asyncio
async def test_checker_links_respect_code_rules(tmp_path):
    links = [
        {
            "claim": "c3",
            "relation": "corroborates",
            "target": "c1",
            "reason": "same fact",
        },  # same domain: rejected
        {
            "claim": "c3",
            "relation": "contradicts",
            "target": "c2",
            "reason": "cost vs density",
        },
        {
            "claim": "c9",
            "relation": "corroborates",
            "target": "c1",
            "reason": "unknown id",
        },  # rejected
    ]
    run, _ = make_run(
        tmp_path, ["Density hit 500 Wh/kg [c1][c2]."], checker_links=links
    )
    await run.run()
    run.close()
    events = read_events(run.writer.path)
    linked = [e["data"] for e in events if e["type"] == "claim.linked"]
    assert linked == [
        {
            "claim_id": "c3",
            "relation": "contradicts",
            "target": "c2",
            "by": "checker",
            "reason": "cost vs density",
        }
    ]
    assert run.ctx.claims.status("c2", run.ctx.sources) == "red"
    t = types(events)
    assert t.index("claim.linked") < t.index("report.final")


@pytest.mark.asyncio
async def test_budget_blocks_extra_searches(tmp_path):
    cfg_budget_script = researcher_scripts()
    cfg_budget_script["d2"] = [
        ai(call("tavily_search", {"query": f"q{i}", "reason": "test"})) for i in range(6)
    ] + [
        ai(
            call(
                "finish_direction",
                {"reason": "budget", "summary": "ran out", "claim_ids": []},
            )
        ),
        ai(content="done"),
    ]
    run, tavily = make_run(
        tmp_path, ["Density hit 500 Wh/kg [c1]."], scripts=cfg_budget_script
    )
    await run.run()
    run.close()
    events = read_events(run.writer.path)
    d2_searches = [
        e for e in events if e["type"] == "search.completed" and e["dir"] == "d2"
    ]
    assert sum(1 for e in d2_searches if not e["data"]["blocked"]) == 4
    assert any(e["type"] == "budget.hit" and e["dir"] == "d2" for e in events)


@pytest.mark.asyncio
async def test_orchestrator_that_skips_research_still_gets_a_plan_and_answer(tmp_path):
    cfg = Config(runs_dir=tmp_path)
    scripts = researcher_scripts()
    run = GlassboxRun(
        "Are solid-state batteries ready?",
        cfg=cfg,
        run_id="t_skip",
        tavily=FakeTavily(PAGES),
        models={
            "orchestrator": scripted([ai(content="Yes, they are ready.")]),
            "researcher": DirectionScriptedModel(scripts=scripts),
            "writer": scripted([ai(content="Density hit 500 Wh/kg [c1].")]),
            "checker": scripted([ai(call("Links", {"links": []})) for _ in range(5)]),
        },
    )
    await run.run()
    run.close()
    events = read_events(run.writer.path)
    t = types(events)
    plan = next(e for e in events if e["type"] == "plan.created")
    assert plan["data"]["fallback"] and plan["data"]["directions"][0]["id"] == "d1"
    assert (
        t.index("plan.created")
        < t.index("direction.started")
        < t.index("search.started")
    )
    assert [e["data"]["id"] for e in events if e["type"] == "direction.finished"] == [
        "d1"
    ]
    report = [e for e in events if e["type"] == "report.final"][-1]["data"]
    assert report["cited_claim_ids"] == ["c1"]

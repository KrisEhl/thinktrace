# Glassbox: agent and event logging spec

Owners: **A** (agent, sections 2–3) and **B** (event log, server and steering control, sections 4–7 and 9).
Consumers: **C** (frontend) reads sections 4, 8 and 9.

Goal: a research agent built on the cookbook stack, whose **every step is written to a JSONL event log**. The thinking graph is rebuilt from that log alone, and **the user can steer the agent mid-run** (Redirect, Dig deeper) without restarting. Pitch and demo: [../README.md](../README.md).

---

## 0. Build order: the agent on its own (no GUI, no server)

> **Status 15:15: steps 1–8 are done.** 18 offline tests pass (`uv run pytest`). Verified live with Nemotron 3.5 Super VL and Tavily, including mid-run steering. A real steered run is committed as `runs/sample/`. What changed from the original plan after testing live is listed in [Live findings](#live-findings-1515).

The goal is to have the agent working and logging from the command line before anything else depends on it. Each step ends with something you can run and check. **Don't start the next step until the check passes.**

| # | Build | Check (done when…) | Time |
|---|---|---|---|
| 1 | **Cookbook as-is.** `venv`, install, `.env`. Run the cookbook's `create_deep_agent(model, tools=[TavilySearch])` on one question. | A report with sources prints. Also run `GET /v1/models`: the ids for MiniMax-M3, Nemotron and Beam are known. | 15 min |
| 2 | **Raw logger.** `events.py` (envelope + JSONL writer) and `logger.py`, with only the raw hooks (`llm.*`, `tool.*`, run-tree registry). Attach to the cookbook agent. | `runs/<id>/events.jsonl` has every LLM and tool call. **Subagent calls appear, and their `parent_span` chain reaches a `task` call.** If not, switch to the `astream(subgraphs=True)` fallback now (section 1). | 20 min |
| 3 | **Our tools with stub stores.** `tools.py`: `think`, `tavily_search`, `tavily_extract`, `record_claim`, `finish_direction`, `plan_research`, plus `SourceStore`, `ClaimStore` and `verify.py`. Unit-test `verify.py`. | You can call each tool directly from a Python shell and get back content and an artifact. `pytest tests/test_verify.py` is green. | 30 min |
| 4 | **One researcher, one direction.** `create_agent(RESEARCHER_MODEL, tools, RESEARCHER_PROMPT)`, called directly with `"[d1] <topic>"` and `metadata={"dir": "d1"}`. Budgets are counters in a minimal `RunControl`. | The log shows `decision` → `search.*` → `read.*` → `claim.recorded` (mostly `exact`) → `direction.finished` with a real reason, all with `dir: "d1"`. Tune the prompt until quotes verify. | 30 min |
| 5 | **Orchestrator + parallel researchers.** `create_deep_agent(ORCHESTRATOR_MODEL, tools=[plan_research], subagents=[CompiledSubAgent(researcher)])`. Semantic events in the logger (`plan.created`, `direction.started`, …) and direction attribution. | `plan.created` with 3–4 directions. The `task` calls overlap in time (they run in parallel). Every researcher event has the right `dir`. If the calls don't overlap, try another orchestrator model. | 30 min |
| 6 | **Writer + citation filter.** Beam writes from the `ClaimStore`; `citations.py` drops uncited sentences. `cli.py "question"` prints the answer and the log path. | A full run from the CLI. Every sentence has `[c#]`. Spot-check 3 citations against the source URL by hand. **Commit this log as `runs/sample/`.** | 25 min |
| 7 | **Steering from the CLI.** `RunControl` + `SteeringMiddleware` + tool guard. `cli.py` gets a REPL while the run is going: `drop d3 [new focus]`, `dig d2 [focus]`. | Mid-run `drop` blocks d3's next tool call. `dig` on a finished direction emits `direction.resumed` and new searches. `report.final` v2 lists `changed` sentences. Commit a steered log as well. | 40 min |
| 8 | **Tests with stubs.** `test_logger.py` and `test_steering.py` with a fake model and a fake Tavily client. | `pytest` green, without network access. | 20 min |

About **3.5 hours** if one person does everything. Split across A and B, steps 3 + 4 (A) and steps 2 + 5's logger part (B) run in parallel, so step 6 lands around 16:15.

**The frontend doesn't wait for this.** C builds against the hand-written sample log (section 4), then against the real `runs/sample/` from step 6. The server (section 6) only wraps `run()` and `RunControl` from steps 6–7, so it's a thin layer added afterwards.

**What to cut if time runs short, last item first:**
1. Step 8 tests
2. `model.thought`
3. Fuzzy quote matching (exact only)
4. Resuming a *finished* direction (keep dig deeper on running directions only)

Never cut: steps 2, 4, 5 and 6, and the drop guard.

### Live findings (15:15)

What we learned from live runs, and what changed because of it:

| Finding | Change |
|---|---|
| **Callbacks do reach subagents.** The `parent_span` chain leads to the `task` call, and parallel `task` calls overlap in time. | No fallback needed. |
| **The Nemotron endpoint responds in under 1 second per call**, makes parallel tool calls reliably, and returns its reasoning text in a `reasoning` field. `langchain-openai` drops that field. | `config.py` uses a `ChatNebius` subclass that keeps it as `additional_kwargs.reasoning_content`, which feeds `model.thought` events. |
| The model batches 2–4 searches into one step, with one `think` per step. | The prompt now asks for one `think` per step, not per search. |
| With budget 4 + 4, every direction stopped on `budget`. | Budget raised to 5 + 5. Search results now end with "Budget left: N searches, M reads". The prompt says "budget is a ceiling, not a target". Directions now stop on `enough_evidence` too. |
| 37% of quotes weren't found: some were stitched from fragments with "...", others quoted unread sources from snippets. | Fragments are verified one by one, in order. If the source wasn't read, `record_claim` fetches the page first (`auto_read`, not charged to the read budget). Down to about 20–28%. Grey claims are excluded from the answer. |
| The agent never sets `corroborates`, and claims are compound, so string matching can't find duplicates. | A **fact-checker** step (one structured-output call) links corroborating and contradicting claims before each writer pass. Code rules decide what counts: a corroboration must come from a different domain, and both claims must be verified. Each link emits `claim.linked` with the checker's reason. |
| A whole run takes 40–55 s, with about 250–500k input tokens. | — |

## 1. Stack and setup

| Piece | Choice |
|---|---|
| Agent harness | `deepagents` (0.7.x), the same as the [cookbook](https://dev.nebius.com/cookbook/deep-research-agent-tavily) |
| Models | Token Factory via `langchain-nebius` (`ChatNebius`, subclassed to keep the reasoning text). We currently use `dedicated/GTC-Berlin-2026/Nemotron-3.5-Super-VL-PsBCQo` for all roles. |
| Retrieval | `tavily-python` (`TavilyClient.search` and `.extract`), wrapped in our own tools |
| Budgets | Per-direction counters in `RunControl` (5 searches + 5 reads; +3 + 3 per dig), checked inside our tools, so steering can change them (section 9) |
| Steering | `RunControl` (Python) + a `SteeringMiddleware` (`abefore_model`) that injects user instructions |
| Logging | A LangChain `AsyncCallbackHandler` writing JSONL |
| Server | FastAPI + SSE (`sse-starlette`); not built yet |
| Python | 3.13 via `uv` (the cookbook requires ≥ 3.12) |

Environment (`.env.example`; `.env` is git-ignored):

```
NEBIUS_API_KEY=
NEBIUS_BASE_URL=https://api.tokenfactory.eu-west2.nebius.com/v1/   # our hackathon endpoint
TAVILY_API_KEY=
ORCHESTRATOR_MODEL=dedicated/GTC-Berlin-2026/Nemotron-3.5-Super-VL-PsBCQo
RESEARCHER_MODEL=dedicated/GTC-Berlin-2026/Nemotron-3.5-Super-VL-PsBCQo
WRITER_MODEL=<Beam 1.0 id, once we have it; else the same Nemotron id>
CHECKER_MODEL=        # optional, defaults to WRITER_MODEL
RUNS_DIR=runs
```

**Step 0 (A, by 15:00):** run the cookbook unchanged, with our callback handler attached (`uv run python scripts/check_setup.py cookbook`), and confirm two things:

1. A report with sources comes back.
2. **Callbacks reach the subagents.** `deepagents` calls subagents with `ainvoke` inside the `task` tool, with a fresh config. LangChain should still pass the parent callbacks on through its context variable. Check that the subagent's tool calls appear in the log, and that their `parent_run_id` chain leads up to the `task` tool run.

   If they don't appear, the fallback is `agent.astream(..., stream_mode=["updates", "messages"], subgraphs=True)`. Its namespace tuple (`("tools:<id>",)`) identifies the subagent.

Then test which model ids exist (`GET /v1/models`) and whether the chosen orchestrator model makes parallel tool calls reliably. If MiniMax-M3 struggles, try Nemotron 3.5 Super VL.

## 2. Agent design

```
run(question)
 ├─ Orchestrator  = create_deep_agent(ORCHESTRATOR_MODEL,
 │                    tools=[plan_research],
 │                    subagents=[researcher],                  # a CompiledSubAgent, see below
 │                    middleware=[SteeringMiddleware(role="orchestrator"),
 │                                ToolCallLimitMiddleware(tool_name="task", run_limit=6)])
 │    1. plan_research(directions)          → the plan, 3–4 directions
 │    2. task(description="[d1] …", subagent_type="researcher") ×N in ONE message → run in parallel
 │    3. short wrap-up message (ignored by the writer)
 │
 ├─ Researcher (one per direction)
 │    built by us: researcher_graph = create_agent(RESEARCHER_MODEL,
 │                    tools=[think, tavily_search, tavily_extract, record_claim, finish_direction],
 │                    system_prompt=RESEARCHER_PROMPT,
 │                    middleware=[SteeringMiddleware(role="researcher")])
 │    passed to deepagents as {"name": "researcher", "description": …, "runnable": researcher_graph}
 │    so that RunControl can also start it directly for steering (section 9)
 │    loop: think → search/extract → record_claim… → think → … → finish_direction
 │    final message: the direction summary plus a list of claim ids
 │
 ├─ Fact-checker (one structured-output call, CHECKER_MODEL): links claims that corroborate / contradict
 │    → claim.linked events; code rules: corroboration needs a different domain, both claims verified
 │
 └─ Writer (a plain LLM call outside deepagents, WRITER_MODEL = Beam)
      runs when the orchestrator and all researchers are idle, and again after each steer
      input: the question plus every claim from non-dropped directions (id, text, status, direction)
      output: markdown, with every sentence citing [c#]
      → citation filter → report.final (version n, changed sentences vs n-1)
```

**Which direction am I in?** The researcher's first human message is its task description, which starts with `[d2]`. Tools read it through `runtime: ToolRuntime` (`runtime.state["messages"][0]`), and so does the `SteeringMiddleware`. The same helper, `direction_of(state)`, is used everywhere.

Why the writer is a separate step:

- Python hands it the exact claim list, so citations can only point at real claim ids.
- It gives Beam a clear, real role.

All calls (orchestrator, researchers and writer) share one callback handler, so they all land in the same log.

`deepagents` 0.7.x has **no built-in todo or planning tool**. Its default tools are the filesystem tools (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`), `execute` and `task`. That's why planning is our own `plan_research` tool. The filesystem tools stay enabled; their calls are logged as generic `tool.*` events and shown as "notes" in the trace.

### Prompts (outline)

**Orchestrator:**
- Call `plan_research` first, with 3–4 non-overlapping directions. Give each an id `d1…`, a one-line `why`, and 1–3 starting queries.
- Then delegate every direction in **one message** with several `task` calls. Each `description` must start with its id in brackets: `[d2] …`.
- Don't search yourself.
- Never delegate a direction that a `USER STEERING:` message dropped.

**Researcher:**
- You own exactly one direction.
- Before every search or extract, call `think` with your next action and why.
- Read (extract) only the pages that look worth it, and say why.
- Record each atomic fact with `record_claim`, using an **exact** quote copied from the page text.
  - If a second source says the same thing, record it with `corroborates=<claim_id>`.
  - If it contradicts an earlier claim, use `contradicts=<claim_id>`.
- Stop with `finish_direction` when:
  - you have enough evidence (`enough_evidence`),
  - two steps in a row added nothing new (`nothing_new`),
  - or a tool reports that the budget is used up (`budget`).
- Messages that start with `USER STEERING:` come from the person asking. They override your plan. Follow them immediately.

**Writer:**
- Answer the question using only the claims given.
- Every sentence ends with one or more `[c#]`.
- Name gaps: directions that stopped on `budget` or `nothing_new`, and claims that are single-origin or contradicted.
- Never cite a grey (unverified) claim.

## 3. Tools

All tools use `response_format="content_and_artifact"`. The **content** is the short text the model sees. The **artifact** is the structured data the logger reads from `ToolMessage.artifact` in `on_tool_end`. Tools never write events themselves. That keeps logging in one place (the callback handler), which also knows which direction each call belongs to.

**Steering guard:** researcher tools take `runtime: ToolRuntime`, find their direction with `direction_of(runtime.state)`, and check `RunControl` first:
- **Direction dropped:** don't run. Return the content "USER STEERING: this direction was dropped. Call finish_direction(reason='dropped_by_user') now." and the artifact `{blocked: "dropped"}`.
- **`tavily_search` / `tavily_extract` budget used up:** don't run. Return the content "Budget used up for this direction. Call finish_direction(reason='budget')." and the artifact `{blocked: "budget", limit}`.
- **Otherwise:** decrement the counter and run.

| Tool | Args | Content (model sees) | Artifact (logger reads) |
|---|---|---|---|
| `plan_research` | `directions: list[{id, title, why, queries: list[str]}]` | "Plan recorded. Delegate each direction with `task`; description starts with `[d1]`." | `{directions}` |
| `think` | `reflection: str`, `next_action: "search"\|"read"\|"stop"`, `reason: str` | "ok" | the args |
| `tavily_search` | `query: str` | Numbered results: `[s3] title (domain)` plus snippet | `{query, results: [{source_id, url, title, domain, score}]}` |
| `tavily_extract` | `source_id: str` | The page text, truncated to 6,000 chars | `{source_id, url, chars, ok, error?}` |
| `record_claim` | `claim: str`, `quote: str`, `source_id: str`, `corroborates?: str`, `contradicts?: str` | "c7 recorded, quote verified" or "c7 recorded, quote NOT found in s3; copy it exactly" | `{claim_id, text, quote, source_id, verified: "exact"\|"fuzzy"\|"not_found", span: [start, end]\|null, corroborates, contradicts}` |
| `finish_direction` | `reason: "enough_evidence"\|"nothing_new"\|"budget"\|"dropped_by_user"`, `summary: str`, `claim_ids: list[str]` | "Direction closed." | the args |

### Shared stores (per run, in memory and on disk)

- **SourceStore.**
  - `url → source_id` (`s1, s2, …`), plus title, domain and snippet.
  - The extracted text is saved to `runs/<id>/sources/<source_id>.txt`.
  - Search and extract results are cached by query or URL.
- **ClaimStore.**
  - `claim_id` (`c1, c2, …`, using an asyncio-safe counter) → the claim plus its verification result.
  - The writer and the citation filter read from it.

### Quote verification (`verify.py`)

1. Normalize both texts: collapse whitespace, unify quote characters and dashes, compare case-insensitively.
2. If the quote is found in the extracted text, the result is `exact`, with `span` set to its character range in the **original** text.
3. Otherwise, run `rapidfuzz.fuzz.partial_ratio_alignment`. A score ≥ 95 gives `fuzzy`, with the aligned `span`.
4. Otherwise the result is `not_found` (shown grey).
5. If the source was only searched, never extracted, verify against the Tavily snippet and set `span: null`.

### Citation filter (`citations.py`)

1. Split the writer's markdown into sentences. Headings and list markers are kept as structure.
2. Keep a sentence only if it cites at least one known, non-grey claim id.
3. Emit the filtered markdown, the dropped sentences, and the set of claim ids that were cited.

## 4. Event schema

One JSON object per line in `runs/<run_id>/events.jsonl`. Events are append-only and never rewritten.

### Envelope

```json
{
  "v": 1,
  "seq": 42,
  "ts": "2026-10-18T15:02:11.123Z",
  "run_id": "r_8f3a",
  "type": "search.completed",
  "span": "5c1e…",
  "parent_span": "a07b…",
  "dir": "d2",
  "agent": "researcher",
  "data": { }
}
```

| Field | Meaning |
|---|---|
| `seq` | Monotonic per run, starting at 0. The frontend orders and resumes by it. |
| `span` / `parent_span` | The LangChain `run_id` / `parent_run_id`. Lets you rebuild the call tree. |
| `dir` | The direction id, or `null` for orchestrator-level events. Taken from `metadata["dir"]` if set (researchers started by steering), otherwise found by walking up the run tree to the `task` call (section 5). |
| `agent` | `orchestrator` \| `researcher` \| `checker` \| `writer` \| `system` |

### Types

Semantic events are what the graph is built from. Raw events are always emitted too, as a fallback and for debugging.

| Type | When | `data` |
|---|---|---|
| `run.started` | `run()` begins | `{question, models: {orchestrator, researcher, writer}, budgets}` |
| `plan.created` | `plan_research` ends, or the orchestrator made no plan | `{directions: [{id, title, why, queries}], fallback?: true}` (fallback: one direction, the question itself, agent `system`) |
| `direction.started` | `task` tool starts | `{id, title, task_description, adhoc: bool}` |
| `decision` | `think` starts | `{next_action, reason, reflection}` |
| `search.started` | `tavily_search` starts | `{query}` |
| `search.completed` | `tavily_search` ends | `{query, results: [{source_id, url, title, domain, score}]}` |
| `source.added` | First time a URL is seen | `{source_id, url, title, domain}` |
| `read.started` | `tavily_extract` starts | `{source_id}` |
| `read.completed` | `tavily_extract` ends | `{source_id, url, chars, ok, error?}` |
| `claim.recorded` | `record_claim` ends | `{claim_id, text, quote, source_id, url, domain, verified, span, corroborates, contradicts, corroboration: "agent"\|"auto"\|null, verified_against: "full_text"\|"snippet", auto_read}` |
| `check.started` | The fact-checker begins (before each writer pass) | `{n_claims}` (agent `checker`) |
| `claim.linked` | The fact-checker links two claims, and the link passes the code rules | `{claim_id, relation: "corroborates"\|"contradicts", target, by: "checker", reason}` |
| `direction.finished` | `finish_direction` ends **or** the researcher run ends without it | `{id, reason: "enough_evidence"\|"nothing_new"\|"budget"\|"dropped_by_user"\|"no_reason", summary, claim_ids}` |
| `budget.hit` | A tool returns `artifact.blocked == "budget"` | `{tool, limit}` |
| `steer.applied` | `POST /steer` accepted, written **before** any effect | `{steer_id, action: "redirect"\|"dig_deeper", dir, text, new_dir?, budget_added?}` |
| `plan.updated` | Redirect with a new focus adds a direction | `{added: [{id, title, why, queries, from_steer}]}` |
| `direction.resumed` | Dig deeper on a direction that had already finished | `{id, steer_id, focus_claim_ids}` |
| `steer.delivered` | `SteeringMiddleware` injects the instruction into a model call | `{steer_id, dir, agent}` |
| `model.thought` | `llm.completed` includes reasoning text (`additional_kwargs.reasoning_content` or reasoning content blocks) | `{text}` (shown and labelled "model reasoning") |
| `synthesis.started` | The writer begins | `{n_claims, version}` |
| `report.final` | The citation filter is done (again after each steer) | `{version, markdown, raw_markdown, cited_claim_ids, dropped: [sentence], changed: [sentence], after_steer_ids}` |
| `run.idle` | The writer is done and no researcher is running | `{report_version}` |
| `run.finished` | `POST /close`, or 10 minutes idle (the CLI closes after the first `run.idle`) | `{status: "ok"\|"error", duration_ms, totals: {searches, reads, claims, directions, steers, restarts: 0, input_tokens, output_tokens, cost_usd}}` |
| `run.error` | Any exception | `{where, message}` |
| `llm.started` (raw) | `on_chat_model_start` | `{model, n_messages}` |
| `llm.completed` (raw) | `on_llm_end` | `{model, input_tokens, output_tokens, latency_ms, cost_usd, tool_calls: [name], text_preview}` |
| `tool.started` (raw) | Every `on_tool_start` | `{name, args}` (string args truncated to 2 kB) |
| `tool.completed` (raw) | Every `on_tool_end` | `{name, ok, content_preview}` |

**Ordering guarantee:**
- `decision` and every `*.started` event are written in the start callback, before the tool body runs.
- A `decision` is therefore always in the log before the search it led to.
- `steer.applied` is written before any of its effects, so the replay shows the intervention, then its consequences.

**Example** (`runs/sample/events.jsonl`, hand-written by B for C by 15:15):

```jsonl
{"v":1,"seq":0,"ts":"…","run_id":"sample","type":"run.started","span":null,"parent_span":null,"dir":null,"agent":"system","data":{"question":"…","models":{…},"budgets":{"search":4,"extract":4}}}
{"v":1,"seq":5,"ts":"…","run_id":"sample","type":"plan.created","span":"p1","parent_span":"o1","dir":null,"agent":"orchestrator","data":{"directions":[{"id":"d1","title":"…","why":"…","queries":["…"]}]}}
{"v":1,"seq":9,"ts":"…","run_id":"sample","type":"direction.started","span":"t1","parent_span":"o1","dir":"d1","agent":"orchestrator","data":{"id":"d1","title":"…","task_description":"[d1] …","adhoc":false}}
{"v":1,"seq":12,"ts":"…","run_id":"sample","type":"decision","span":"k1","parent_span":"r1","dir":"d1","agent":"researcher","data":{"next_action":"search","reason":"…","reflection":"…"}}
```

## 5. Callback handler (`logger.py`)

`GlassboxLogger(AsyncCallbackHandler)` holds:

- `runs: dict[run_id, {parent, kind, name, dir, agent, t0}]`: the run tree.
- `writer: EventWriter`: assigns `seq`, appends a line to JSONL (flushed per line) and fans out to SSE subscribers through an `asyncio.Queue` for each subscriber.

Hooks:

| Hook | Does |
|---|---|
| `on_chain_start` | Registers `run_id → parent`; inherits `dir` and `agent` from the parent. No event, to avoid noise. |
| `on_chat_model_start` | Registers the run and emits `llm.started`. The model comes from `metadata["ls_model_name"]`. |
| `on_llm_end` | Emits `llm.completed`, with usage from `generations[0][0].message.usage_metadata` and cost from a price map in config. Emits `model.thought` if reasoning text is present. |
| `on_tool_start` | Registers the run. If `name == "task"`, starts a direction and sets its `dir` (see below). Emits `tool.started` and the matching semantic `*.started` / `decision` event. |
| `on_tool_end` | Reads `output.artifact` (`output` is a `ToolMessage`). Emits `tool.completed` and the matching semantic event. If `name == "task"` and no `direction.finished` was seen for that `dir`, emits one with `reason: "no_reason"`. |
| `on_tool_error`, `on_chain_error`, `on_llm_error` | Emits `run.error` (and `tool.completed` with `ok: false`). |

**Assigning a direction to a run:**

1. If the run's `metadata["dir"]` is set, use it. `RunControl` sets it when it starts a researcher directly for steering.
2. Otherwise, for a `task` call, parse `^\[(d\d+)\]` from `inputs["description"]`.
3. If that fails, fuzzy-match the description against the plan's titles.
4. If that fails, create an ad-hoc `d<n>` (`adhoc: true`).

Every later run inherits `dir` from its parent, so all of a subagent's LLM and tool calls land on the right branch. **This attribution, not the model, decides where nodes appear in the graph.**

`agent` is:
- `researcher` for anything under a `task` run or a steering-started researcher run,
- `writer` for the writer call (set via `metadata={"agent": "writer"}`),
- `orchestrator` otherwise.

`steer.applied`, `plan.updated` and `direction.resumed` are written by `RunControl` straight to the `EventWriter`, with `agent: "system"`, not through callbacks.

## 6. Server (`server.py`)

```
POST /runs                    {question}            -> {run_id}       starts run() as an asyncio task
GET  /runs                                          -> [{run_id, question, status, started_at}]
GET  /runs/{id}/events?from=N                       SSE: replay the file from seq N, then tail live until run.finished
GET  /runs/{id}/events.jsonl                        raw file (download / offline replay)
GET  /runs/{id}/sources/{source_id}                 {source_id, url, title, domain, text, read}   (text is null if the page was never read)
GET  /health                                        {models_ok, tavily_ok}
POST /runs/{id}/steer         {action: "redirect"|"dig_deeper", dir, text?}  -> {steer_id}   (section 9)
POST /runs/{id}/close                               -> emits run.finished
```

- Each SSE `data:` line is exactly one envelope, and the SSE `id:` is `seq`, so the browser resumes on reconnect (`Last-Event-ID`; `?from=` wins if both are given).
- `POST /steer` returns 404 for an unknown direction and 409 if the run isn't live (finished, or only on disk).
- `?speed=2` on a finished run replays with the original timing, scaled. This is the Wi-Fi fallback and the "sample run" for judges.
- CORS is open for the Vite dev server.

## 7. CLI and file layout

```
glassbox/
  config.py        env, model ids, budgets, price map
  prompts.py       orchestrator / researcher / writer prompts
  tools.py         the 6 tools + SourceStore + ClaimStore + direction_of()
  control.py       RunControl: per-direction status, budgets, steer queues, spawn/resume researchers, writer re-runs
  steering.py      SteeringMiddleware (abefore_model)
  verify.py        quote verification
  citations.py     citation filter
  checker.py       fact-checker: links corroborating / contradicting claims (code rules decide what counts)
  events.py        Pydantic envelope + EventWriter (JSONL + fan-out)
  logger.py        GlassboxLogger callback handler
  agent.py         build_orchestrator(), run(question, run_id) incl. writer step
  server.py        FastAPI app
  cli.py           python -m glassbox.cli "question"   -> runs/<id>/events.jsonl, prints the report
                   python -m glassbox.cli --replay runs/<id> [--speed 2]
runs/
  sample/          committed: hand-written log (15:15), later replaced by a real recorded run
tests/
  fakes.py         scripted chat models + fake Tavily
  test_verify.py, test_citations.py, test_claims.py, test_agent.py (logger + full run), test_steering.py
scripts/
  check_setup.py   `models` lists Token Factory models; `cookbook` runs the cookbook agent with our logger
```

`runs/*` is git-ignored except `runs/sample/`.

**Tests (fast, no network):**
- `test_logger.py` runs the agent with a stubbed chat model and a stubbed Tavily client. The stub is a `GenericFakeChatModel` scripted with tool-call `AIMessage`s; subclass it with a no-op `bind_tools`, which the agent requires. It asserts that:
  - the event types appear in a valid order,
  - every researcher event has a `dir`,
  - `decision` comes before its `search.started`.
- `test_steering.py` uses the same stubs. It asserts that:
  - a redirected direction's next tool call is blocked,
  - `steer.applied` comes before `direction.finished(dropped_by_user)`,
  - dig deeper on a finished direction emits `direction.resumed` and new events with the same `dir`,
  - `report.final` version 2 excludes dropped claims.
- The verification and citation tests are table-driven.

## 8. Graph projection (contract for the frontend)

The frontend builds the graph with a pure `apply(graph, event)`. No other state.

| Event | Graph change |
|---|---|
| `run.started` | Question node |
| `plan.created` | One direction node per entry (status `planned`, with `why` and `queries`) |
| `direction.started` | Direction → `running` (create it if ad-hoc) |
| `decision` | Append to the direction's decision trail |
| `search.started` / `search.completed` | Search node under the direction, with result edges to source nodes |
| `source.added` | Source node (grouped by `domain` = one origin) |
| `read.completed` | Mark the source `read` on that direction; traffic +1 |
| `claim.recorded` | Claim node, with an edge to its source. `corroborates` / `contradicts` become edges between claims. |
| `claim.linked` | Adds a `corroborates` / `contradicts` edge between claims (it's the same as setting the field on `claim_id`); show `reason` on hover; recompute evidence status |
| `direction.finished` | Direction → `done`, with a stop badge from `reason`. `dropped_by_user` → greyed and crossed out. |
| `budget.hit` | ⏱ marker on the direction |
| `steer.applied` | Steer marker on the direction plus a trace entry; stats "steered N×" +1 |
| `plan.updated` | New direction node, with a dashed "redirected from" edge from the dropped direction |
| `direction.resumed` | Direction → `running` again (pulses), with a "dig deeper" marker; focus claims highlighted |
| `steer.delivered` | Trace: "agent received your instruction" |
| `model.thought` | Appended to the trail, styled as "model reasoning" |
| `report.final` | Answer panel; sentences in `changed` are highlighted against the previous version |
| `run.idle` | The answer is stable. Steer buttons stay enabled. |
| `llm.completed` / `run.finished` | Stats bar (tokens, cost, time, "0 restarts") |

**Evidence status** (computed by the frontend from the claim group, meaning a claim plus its corroborations):

| Condition | Status |
|---|---|
| `verified == "not_found"` | grey |
| The group has a `contradicts` edge | red |
| ≥ 2 distinct domains in the group | green |
| Otherwise | orange |

## 9. Steering (core)

Steering happens **mid-run**: the user can steer while researchers are working, and again after the first answer. Nothing restarts. Python makes the change at once, and the agent sees the instruction at its next model call.

### RunControl (`control.py`, one per run)

| Field | Content |
|---|---|
| `directions` | `{id: {title, status: planned\|running\|done\|dropped, budget: {search, extract}, tasks: [asyncio.Task]}}` |
| `inbox` | `{"orchestrator" \| dir_id: [pending instruction]}`, drained by `SteeringMiddleware` |
| `writer_version` | The number of the last `report.final` |

The agents and tools are built per run by a factory that closes over the run's `RunControl`, `SourceStore`, `ClaimStore` and `EventWriter`. Nothing is global.

### SteeringMiddleware (`steering.py`)

`abefore_model(state, runtime)` works out its key: `"orchestrator"`, or `direction_of(state)` for a researcher. It pops any pending instructions from `inbox[key]`. If there are some, it:
- emits `steer.delivered`,
- returns `{"messages": [HumanMessage("USER STEERING: …")]}`, so the instruction lands right before the model's next turn.

### Redirect `{action: "redirect", dir, text?}`

1. Emit `steer.applied`.
2. Set `directions[dir].status = "dropped"`. From now on the tool guard blocks every research tool call in that direction (section 3).
3. Queue "USER STEERING: this direction was dropped; call finish_direction(reason='dropped_by_user')" in `inbox[dir]`, and "The user dropped [dX]; never delegate it" in `inbox["orchestrator"]`.
4. If the direction isn't running (planned or done), emit `direction.finished(reason="dropped_by_user")` right away. If it is running, the researcher emits it at its next step.
5. If `text` is given:
   - Create `dN`, emit `plan.updated`, then `direction.started`.
   - Start a researcher directly. Its budget is what the dropped direction had left, or at least the default.

```python
asyncio.create_task(researcher_graph.ainvoke(
    {"messages": [HumanMessage(f"[{dN}] {text}")]},
    config={"callbacks": [logger], "metadata": {"dir": dN, "agent": "researcher"}},
))
```
6. The writer excludes claims from dropped directions.

### Dig deeper `{action: "dig_deeper", dir, text?}`

1. Emit `steer.applied` with `budget_added: {search: 3, extract: 3}`, and raise the direction's budget by that much.
2. Pick the focus claims: claims in `dir` that are orange, red or grey, using the same rule as the frontend (section 8).
3. Build the instruction: "USER STEERING: dig deeper. {text}. Strengthen *or refute* c4, c5: look for independent sources AND counter-evidence. Record with `corroborates` / `contradicts`."
4. Then, depending on the direction's status:
   - **Running or planned:** queue the instruction in `inbox[dir]`.
   - **Done:** emit `direction.resumed`, then start a researcher directly (as above, with `metadata.dir = dir`). It gets `[dir] {title}`, the instruction, and the direction's existing claims as text.

### Run lifecycle and the writer

1. `run()` awaits the orchestrator, then `control.wait_idle()`: no researcher tasks left running.
2. Writer → `report.final(version=1)` → `run.idle`.
3. Any steer that starts work → when idle again → writer → `report.final(version=n+1, changed=[…])` → `run.idle`.
4. The run stays open for steering until `POST /runs/{id}/close` or 10 minutes idle → `run.finished`. The CLI closes after the first `run.idle`.

### Why this is honest

- A drop takes effect at the researcher's next tool call (it's blocked in code), even if the model ignores the instruction.
- A dig deeper adds real budget and real searches, and the log shows each one.
- Nothing already found is thrown away. The writer's diff (`changed`) shows exactly what the steer changed.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Callbacks don't reach subagents | Found in Step 0; switch to `astream(subgraphs=True)` and use the namespace for attribution |
| The model skips `think` / `finish_direction` | Raw tool events still build the graph; `no_reason` stop badge |
| The model makes `task` calls one after another, not in parallel | Prompt for one message with several tool calls; try a different orchestrator model; it still works, just slower |
| Quotes are paraphrased instead of copied → grey | The tool response tells the model the quote was not found; the prompt says "copy exactly"; fuzzy ≥ 95 |
| The model ignores an injected `USER STEERING` message | A drop is enforced by the tool guard anyway. Also append pending instructions to the next tool result's content, as a second channel. |
| The provider rejects a `HumanMessage` injected after tool results | Same fallback: deliver the instruction only via the tool result content |
| A steer arrives while the writer is running | Queue it. The writer re-runs once the new work is idle, and the higher version wins. |
| Beam is slow, and the writer now runs after every steer | Show `synthesis.started` in the UI; fall back to `RESEARCHER_MODEL` behind a flag |
| Tavily rate limits or credits | Cache by query and URL; budgets of 5 + 5 per direction, +3 + 3 per dig; `auto_read` fetches add up to one extract per unread quoted source |
| Token Factory 60 RPM default cap | `max_retries=6` with backoff on 429; a run makes about 40–80 model calls in 40–55 s |
| Wi-Fi | Replay a recorded run (including its steers) through the same SSE endpoint |

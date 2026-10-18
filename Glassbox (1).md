# Glassbox: research you can see and steer

> "Research agents give you an answer. Glassbox lets you watch it think, steer it mid-flight, and check every claim."

Nebius x NVIDIA hackathon, Berlin, 18 Oct 2026. Challenge: **Agentic Deep Research with Token Factory + Tavily**. Deadline **18:30**.

---

## Problem

Deep research agents are black boxes.

1. **"I don't know what it did."** You get a 15-page report, read one line, and can't tell what it looked at, how sure it is, or where a claim came from.
2. **"It took a wrong turn and I found out 15 minutes later."** It chased a direction you didn't care about (defense startups, your old labour-market paper) or took a shortcut ("only 3 of 10 papers apply"). The only fix is re-prompting from scratch.
3. **"It sounds 100% sure about everything."** Uncertainty and contradictions get hidden in confident prose.

## Value added

- **Observability.** A live graph of where the research is going:
  - The question breaks into **dimensions** (Tech, Law, Market) and then **sub-questions** (Vision, Parking).
  - Every node shows its verdict, its confidence and its sources.
- **Steering.** Three actions:
  - **Deactivate** a direction.
  - **Dig deeper** on an uncertain one.
  - **Fix** a wrong assumption.

  Only the affected nodes re-run, never the whole research.
- **Verifiable by construction:**
  - Every claim carries an exact quote checked against its source.
  - Reprinted articles collapse to their real origins.
  - Red nodes escalate to you instead of being hidden.
- **Always one answer, with explicit gaps.** No blocking clarifying questions; unresolved parts are marked "needs your input".
- **Different from subagents.** Subagents split the work, but you can't see them, steer them, or fix one without re-running everything. Here the graph *is* the agent's working memory.

---

## Backend spec

Full version: [docs/superpowers/specs/2026-10-18-glassbox-backend-design.md](docs/superpowers/specs/2026-10-18-glassbox-backend-design.md)

**Stack:** Python 3.11, FastAPI, Server-Sent Events, asyncio, Pydantic. State lives in memory and is dumped to JSON for replay.

### Evidence

- **Web:** Tavily search with page text included; results are cached.
- **Your own context:** pasted text or uploaded docs, split into chunks and retrieved with BM25. Labelled "your doc says".

### Agent loop

Models decide what to do; Python makes the calls.

1. **Plan.** The question is broken into assumptions and dimensions. Each dimension holds sub-question directions with first queries.
2. **Per direction, running concurrently:**
   - Decide: search, read or stop, plus a one-line why.
   - Run the Tavily call.
   - Read and extract claims with exact quotes.
   - Verify the quotes.
3. **Stopping rule.** A direction stops when any of these holds:
   - the model says stop
   - 2 reads in a row add nothing new
   - the budget runs out
   - confidence is high
4. **Synthesize.** The answer must cite claim ids in every sentence. Uncited sentences are dropped.

### Confidence

Deterministic, so the colours can be explained.

| Situation | Confidence |
|---|---|
| 1 independent origin | 0.5 |
| 2 independent origins | 0.75 |
| 3 or more independent origins | 0.9 |
| Quote not verified | 0 (grey) |
| Contradicted | capped at 0.4 |

Colours:

| Confidence | Colour |
|---|---|
| ≥ 0.75 | green |
| 0.5 to 0.75 | orange |
| < 0.5 | red |

### Verification and echo detection

- **Quote verification:**
  - The quote must match the extracted source text exactly.
  - A near-exact fuzzy match (≥ 95% similarity) is accepted as a fallback.
  - The character position is stored so the frontend can jump to the sentence.
- **Echo detection:** sources from the same domain, or with near-duplicate text, count as one origin.

### Steering

| Action | Effect |
|---|---|
| `deactivate` | Cancels the direction and removes its claims from the agent's context. Adds "avoid: X" and re-synthesizes. |
| `dig_deeper` | Adds budget aimed at the weakest claims. |
| `fix` | Marks the assumption as given by the user. Re-runs only the nodes that depend on it ("3 of 11 nodes re-run"). |
| `chat` | Free text, mapped to one of the actions above. |

**Human in the loop:** a node still under 0.5 after one dig, or with an unresolved contradiction, emits `needs_human`. The run never blocks.

### Models (all on Token Factory)

| Role | Model |
|---|---|
| Planner, decider | Nemotron 3.5 Super VL |
| Reader, router | Nemotron 3.5 Lightning |
| Synthesizer | Reflection Beam (unlocks the Reflection credits) |

- Nemotron calls run with thinking off and JSON-schema output.
- Every call is cost-logged.
- Model IDs are checked against `/v1/models` at startup.

### API

```
POST /runs                 {question, context_text?, files?} -> {run_id}
GET  /runs/{id}/events     live event stream (SSE)
GET  /runs/{id}/graph      full snapshot
POST /runs/{id}/steer      {action, node_id?, text?}
GET  /runs/{id}/answer     answer + cited claims with quotes and spans
GET  /sources/{id}         source text + highlight spans (evidence pointer)
GET  /health               model + Tavily availability
```

### Events

| Group | Events |
|---|---|
| Run | `run_started`, `run_finished`, `error` |
| Graph | `assumption_created`, `direction_created`, `source_added`, `claim_added`, `claim_verified`, `confidence_changed`, `verdict_set` |
| Agent | `decision`, `direction_stopped` |
| Steering | `steer_applied`, `stale_marked`, `needs_human` |
| Output | `answer_updated`, `cost_updated` |

**Safety net:** `FAKE_MODE` replays a recorded run. The frontend can start immediately, and the demo survives a Wi-Fi failure.

---

## Frontend spec

- **Layout:**
  - Left: chat. It takes the question, an optional context paste or upload, and steering messages.
  - Right: the live graph.
  - Stats bar: "N sources · steered 2× · 0 restarts · €0.0X".
- **Graph** (react-flow or a force-directed graph), driven entirely by the event stream:
  - Structure: the question at the centre, then dimensions, then sub-questions. Click a node to drill down.
  - Node size = traffic (searches + reads).
  - Colour = confidence. Each node has a verdict badge (yes / no / uncertain) and pulses while running.
  - Deactivated nodes are greyed and crossed out.
  - Stale nodes show a re-running spinner.
  - Red flags show a "needs you" badge.
- **Node panel** (on click):
  - Claims, each with its quote, number of origins and source links.
  - The agent's decisions for that node ("searched X because...").
  - Buttons: **deactivate · dig deeper · fix · accept**.
- **Answer panel:**
  - The final answer, with clickable `[c12]` citations.
  - Clicking a citation opens the source view, with the cursor animating to the exact quote and highlighting it.
- **Trace strip:** a scrolling log of the agent's decisions, showing that it decides rather than follows a script.

---

## Demo (2 minutes, one uncut run)

1. Ask the question. The graph grows.
2. A cluster you don't want gets heavy traffic. **Deactivate** it, and the agent redirects live.
3. An orange node: **dig deeper**. Only that branch re-runs, and it turns green or red with sources.
4. **Fix** an assumption: "3 of 11 nodes re-run".
5. The final answer appears. Click a citation to land on the exact sentence, then show the stats bar.

## Team split

| Owner | Scope |
|---|---|
| A | Agent loop: Token Factory + Tavily, planning, directions, claims, stopping rule |
| B | Graph state, steering API, event stream, quote verification, fake mode |
| C | Frontend: graph, chat, node panel, answer view, video, README |

## Timeline

| Time | Milestone |
|---|---|
| 14:00 | End to end with fake events |
| 16:00 | Real agent running |
| 17:00 | Steering works |
| 17:45 | Polish and record the video |
| 18:15 | Submit |

## Submission checklist

- [ ] Public GitHub repo with a README a judge can run
- [ ] 2-minute video of one uncut run
- [ ] Primary inference on Token Factory; retrieval via Tavily
- [ ] Every claim cited; 3 random citations hold up
- [ ] Trace shows the agent's decisions
- [ ] Submitted on the hackathon platform by 18:30

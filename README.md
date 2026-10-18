# Glassbox: watch your research agent think, and steer it

> "Glassbox turns a research agent's hidden run into a live graph of its thinking, and lets you steer it mid-run: send a direction elsewhere or push it deeper, without starting over, and with every claim still cited."

Nebius x NVIDIA hackathon, Berlin, 18 Oct 2026. Challenge: **Agentic Deep Research with Token Factory + Tavily**. Deadline **18:30**.

---

## 30-second pitch

Research agents make all the calls: what to look into, how deep to go, when to stop. You only see the result, after minutes of invisible work. If it went the wrong way, you start over.

Glassbox runs a research agent built on the Nebius cookbook stack (`deepagents` + Token Factory + Tavily). It logs every step the agent takes as a structured event, and builds a live graph of the agent's thinking from that log:

- **The plan:** the directions it chose to research, and why.
- **Every search and read**, attached to the direction it served.
- **Every decision** to keep going or stop, with the agent's own reason.
- **The claims it extracted**, each tied to a quote found in the source.

While it runs, you can steer it from the graph:

- **Redirect:** cut a direction you don't care about, and optionally name what to research instead. The freed budget goes there.
- **Dig deeper:** push a thin direction for more evidence, including evidence against it.

Only the affected branches re-run. Every sentence in the answer still cites a claim; click it and you land on the passage.

**Watch it think. Steer it. No restart.**

---

## Problem

Deep research agents are black boxes you can't steer.

1. **"I don't know what it did."** You get a long report. You can't tell what it planned, what it looked at, or what it ignored.
2. **"It went the wrong way and I found out at the end."** It spent most of its effort on a direction you didn't care about. The only fix is to re-prompt and wait again.
3. **"It stopped too early on the part I care about."** Did it have enough evidence, give up, or run out of budget? The report sounds the same in all three cases.
4. **"Where did this come from?"** The report reads well, but you can't tell which source supports a sentence, or how thin the evidence is.

## What Glassbox does

| Challenge requirement | How Glassbox meets it | Visible in the graph as |
|---|---|---|
| Plans its searches | The orchestrator calls `plan_research` first: directions, each with a reason and first queries. **You can change the plan while it runs (Redirect).** | Question → direction nodes |
| Reads what it finds | Researchers run Tavily search, choose pages to read with Tavily Extract, and record claims with exact quotes. | Search, source and claim nodes under each direction |
| Decides when it has enough evidence | After each step, the researcher calls `think` with its next action and why. It ends with `finish_direction` and a stop reason: enough evidence, nothing new, or budget. **You can override a stop (Dig deeper).** | Decision trail per direction, stop badge |
| Cites every claim | Every answer sentence cites claim ids. **Uncited sentences are dropped** after generation. | Clickable `[c12]` → highlighted passage |

What sets it apart:

- **Steering without restarting.** Each direction is its own researcher, so a steer only touches that branch:
  - **Redirect** stops a direction immediately and leaves its claims out of the answer. If you name a new focus, a new direction starts with the freed budget.
  - **Dig deeper** raises a direction's budget and targets its weakest claims. It looks for counter-evidence as well as support, so the result can turn green *or* red. If the direction had already stopped, it resumes.
  - The answer is then rewritten, and you see which sentences changed. The stats bar shows "0 restarts".
- **Different from subagents.** Subagents split the work, but you can't see them, steer one, or fix one without re-running everything.
- **The graph is built from the log, not invented by the UI.** One JSONL event log is the single source of truth. The same file drives the live view, the replay and the demo fallback. Every node can be traced back to the event that created it.
- **A decision trail, not just a source list.** You see each search the agent ran and each page it read. You see why it moved on, and why it stopped.
- **Honest evidence status, not fake certainty.** Colour shows how well a claim is *supported*, not whether it is *true*:
  - **Green:** corroborated by 2 or more independent origins
  - **Orange:** a single origin
  - **Red:** contradicted
  - **Grey:** the quote could not be found in the source
- **Gaps stay visible.** A direction that stopped on budget or with thin evidence is flagged, not smoothed over in the answer.
- **Visible thinking, defined honestly.** "Thinking" means the agent's research decisions: the plan, each search/read/stop and the reason the model gave. If the model returns reasoning text, we show it as an extra layer, labelled as such.
- **Steers are events too.** Each steer is written to the same log, so the replay shows exactly when you intervened and what changed afterwards.

## Beyond the cookbook

We started from the [Nebius deep research cookbook](https://dev.nebius.com/cookbook/deep-research-agent-tavily) and kept its stack: `deepagents`, `langchain-nebius`, `langchain-tavily` / `tavily-python`.

| Cookbook | Glassbox |
|---|---|
| Planning, searching and stopping happen inside one `agent.invoke`. To see them, you print the raw JSON state afterwards. | Every step becomes a typed event, streams live and is rendered as a graph. |
| One agent with a search tool. | An orchestrator that plans, plus parallel research subagents. Each subagent is one branch of the graph. |
| You can't change direction while it runs. To change anything, you re-run from scratch. | **Redirect** and **Dig deeper** mid-run; only the affected branches re-run. |
| The agent decides silently when it's done. | Each direction ends with an explicit stop reason, and budgets are enforced in code. |
| Sources are listed at the end of the report. | Each claim carries a quote checked against the page text; each sentence cites claims. |
| No sense of how strong the evidence is. | Evidence status per claim, one of the challenge's suggested directions ("a confidence rating per claim"). |

## What we don't claim

Judges will ask, so we say it first:

- **We show decisions, not hidden reasoning.** The trail is what the agent did and the reason it gave. That reason is generated text, not a window into the model's internals.
- **The agent can skip a `think` call.** Raw tool calls are logged regardless, so the graph never misses a search or a read. A skipped decision just shows up as "no reason given".
- **A cited passage is not proof.** We check that the quote exists in the page text (exact, or a clearly marked near-match). Whether it supports the claim is the model's judgment.
- **Independence is approximate.** Same domain counts as one origin. Syndicated content can still slip through.
- **Corroboration is not truth.** Three sources can repeat the same mistake. That's why single-origin and contradicted claims are shown, never hidden.
- **Digging deeper doesn't buy certainty.** More searching can just as well turn up contradictions. We show whatever it finds.
- **Steering takes effect at the agent's next step.** Python makes the change immediately, but a researcher sees the instruction at its next model call, a few seconds later.

---

## Architecture

```
question
   │
   ▼
Orchestrator (deepagents, Token Factory)
   ├─ plan_research ──► plan.created
   ├─ task ×N (parallel) ──► Researcher subagent per direction
   │      ├─ think            ──► decision
   │      ├─ tavily_search    ──► search.*, source.added
   │      ├─ tavily_extract   ──► read.*
   │      ├─ record_claim     ──► claim.recorded (quote verified)
   │      └─ finish_direction ──► direction.finished
   └─ final answer ──► citation filter ──► report.final
   │
   ▼
GlassboxLogger (LangChain callback handler) ──► runs/<id>/events.jsonl
   │
   ▼
FastAPI: SSE (live tail or replay) + source text + POST /steer
   │                                                  │
   ▼                                                  ▼
Frontend: graph = reduce(events)   ── steer ──►  RunControl (Python)
                                                  ├─ redirect:   cancel direction (tools refuse), spawn new researcher
                                                  ├─ dig deeper: raise budget + inject instruction, or resume researcher
                                                  └─ re-run writer → report.final v2 (changed sentences)
```

Full spec for the agent, the tools and the event log: [docs/agent-and-event-logging.md](docs/agent-and-event-logging.md).

---

## Frontend spec

The frontend reads the event stream and builds the graph with a pure reducer: `graph = events.reduce(apply, empty)`. It has no other state.

- **Layout:**
  - Left: the question input, then the answer panel.
  - Right: the live graph.
  - Bottom: the trace strip and the timeline scrubber.
  - Stats bar: "N searches · N reads · N claims · steered N× · 0 restarts · €0.0X · mm:ss".
- **Graph** (react-flow):
  - Question at the centre, then directions, then searches and sources, then claims.
  - Node size = traffic (searches + reads).
  - Directions pulse while running and show a stop badge when done: ✓ enough · ∅ nothing new · ⏱ budget.
  - Redirected directions are greyed and crossed out. Resumed directions pulse again.
  - Claims are coloured by evidence status.
  - Sources from the same domain are collapsed into one origin.
- **Node panel** (on click):
  - Direction: its "why" from the plan, its decision trail ("searched X because…"), claims and stop reason.
  - Buttons: **Redirect** (with an optional "research instead: …" field) · **Dig deeper** (with an optional focus field).
  - Claim: the quote, the number of origins and source links (our view and the original URL).
- **Answer panel:**
  - The final answer, with clickable `[c12]` citations.
  - Clicking a citation opens the source view, scrolled to the quote and highlighted.
  - After a steer, changed sentences are highlighted against the previous version.
  - The count of dropped uncited sentences is shown.
- **Trace strip:** a scrolling log of decisions, tool calls and steers. Clicking an entry selects its node.
- **Timeline scrubber:** drag to replay the run event by event. This proves the graph is rebuilt from the log.
- **Replay mode:** open any `runs/<id>` (a recorded run, served via the same SSE endpoint). This is also the Wi-Fi fallback.

---

## Demo (2 minutes, one uncut live run)

**Choosing the question:** it should split naturally into 3–4 directions, with **one direction you'd obviously want to cut** and **one that is thin but important**. Rehearse it beforehand so retrieval is reliable and the thin direction really does change when you dig.

| Time | Show | Say |
|---|---|---|
| 0:00 | Ask the question. The plan appears as direction nodes, each with its "why". | "It plans before it searches, and you can see the plan." |
| 0:15 | Directions run in parallel. Searches, sources and claims attach live. Click one direction: its decision trail. | "Every search and read has a reason, and you watch it happen." |
| 0:35 | One direction you don't care about gets heavy traffic. **Redirect** it, naming what to research instead. It greys out and a new direction appears. | "Not what I care about. Cut it, research this instead. No restart." |
| 0:55 | One important direction stopped on a single source (orange, "⏱ budget" or "✓ enough, 1 origin"). Show its stop reason, then **Dig deeper**. Only that branch pulses again. | "It thought one source was enough. I disagree." |
| 1:20 | The branch comes back with new sources: corroborated or contradicted, either is fine. | "More evidence, for or against. Not a button that buys green." |
| 1:35 | The answer is rewritten: the cut direction is gone, and changed sentences are highlighted. Click a citation: the passage is highlighted. | "You steer, and you can see what changed. Every sentence is still cited." |
| 1:55 | Stats bar: searches, reads, steered 2×, 0 restarts, cost. | |

If there's time left after the run, drag the timeline scrubber: "Everything, including our steers, is rebuilt from this one log file."

## Judge Q&A prep

| Question | Answer |
|---|---|
| "How is this different from Perplexity or other deep research tools?" | Their plan and stopping decisions are hidden and final. Ours are visible, and you can steer them mid-run, re-running only what you changed. |
| "Isn't this just re-prompting?" | No. Re-prompting throws away everything. A steer keeps all evidence that isn't affected and re-runs one branch. The stats bar shows 0 restarts. |
| "Doesn't dig deeper just confirm what you want?" | It goes after the weakest claims and searches for counter-evidence too. In the demo, a node can just as well turn red. |
| "Is that really its thinking, or a story it tells afterwards?" | Each decision is a tool call logged when it happens, before the next search runs. It's the reason the model gave at that moment, and we don't claim it shows hidden reasoning. |
| "What if the agent doesn't call `think`?" | Searches and reads are logged from raw tool calls anyway. The graph stays complete; the decision just shows "no reason given". |
| "Isn't confidence just made up?" | We don't show a probability. The colour is a rule you can check: number of independent origins, whether the quote was found, and whether there is a contradiction. |
| "Can the citation still be wrong?" | Yes. The quote's existence is checked mechanically. Whether it supports the claim is a model judgment, and we label it as one. |
| "Why not just use LangSmith?" | LangSmith shows a developer trace of LLM calls. We map the run into research concepts (plan, direction, evidence, stop reason) for the person asking the question. |

## Team split

| Owner | Scope |
|---|---|
| A | Agent: cookbook running on Token Factory, orchestrator + researcher subagent, tools, prompts, budgets, quote verification, citation filter, steering hooks in the agent (cancel flag, budget, instruction injection) |
| B | Event log and control: callback handler, event schema, JSONL writer, RunControl + `POST /steer`, FastAPI (SSE live + replay, sources), CLI, sample logs for C |
| C | Frontend: event reducer, graph, panels, steer buttons, answer diff, scrubber, video, README |

**Contract between B and C:** the event schema in [docs/agent-and-event-logging.md](docs/agent-and-event-logging.md#4-event-schema). B commits a hand-written sample log by 15:15 so C can start before the agent works.

## Timeline

| Time | Milestone |
|---|---|
| 15:00 | Cookbook runs end to end on Token Factory; raw callback log written |
| 15:15 | Event schema frozen (including steer events); hand-written sample `events.jsonl` committed |
| 16:15 | Orchestrator + researchers + tools emit real semantic events; first real log committed |
| 16:30 | GUI renders a recorded log end to end |
| 17:00 | Steering works: Redirect and Dig deeper from the GUI, answer rewritten |
| 17:15 | Live SSE run in the GUI; citations click through |
| 17:45 | Polish and record the video (live run, both steers) |
| 18:15 | Submit |

## Submission checklist

- [ ] Public GitHub repo with a README a judge can run (`.env.example` with `NEBIUS_API_KEY`, `TAVILY_API_KEY`; one command to start)
- [ ] README has a "Beyond the cookbook" section
- [ ] 2-minute video of one uncut **live** run, both steers included (replay is only a Wi-Fi fallback, never the recording)
- [ ] Primary inference on Token Factory; retrieval via Tavily (search + extract)
- [ ] Beam used for real (orchestrator or final writer) and named in the README, for the Reflection credits
- [ ] Every claim cited; 3 random citations hold up, both in our highlighted view and on the original URL
- [ ] Trace shows the agent's decisions, logged as they happen
- [ ] A recorded `runs/<id>` committed as a sample so judges can replay without API keys
- [ ] Submitted on the hackathon platform by 18:30
- [ ] Live demo ready for the 20:00 grand final if we win

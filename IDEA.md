# Glassbox: watch your research agent think, and steer it

> "Glassbox lets you watch a research agent think, then steer it mid-run: cut a direction or push it deeper, without starting over, and with every claim still cited."

Nebius x NVIDIA hackathon, Berlin, 18 Oct 2026. Challenge: **Agentic Deep Research with Token Factory + Tavily**. Deadline **18:30**.

---

## 30-second pitch

Research agents make all the calls: what to look into, how deep to go, when to stop. You only see the result, often after 15 minutes, and if it went the wrong way you start over.

Glassbox shows the research plan as a live graph of directions. Each direction shows how much evidence it has and why the agent stopped. While it runs, you can steer it:

- **Redirect:** cut a direction you don't care about, and its budget moves to the rest.
- **Dig deeper:** push a thin direction for more evidence, including evidence against it.

Only the affected branches re-run. Every sentence in the answer still links to a passage we found in the source.

**You don't have to restart. You steer, and you can see what changed.**

---

## Problem

Deep research agents are hard to steer and hard to check.

1. **"It went the wrong way and I found out at the end."** It spent most of its effort on a direction you didn't care about. The only fix is to re-prompt and wait again.
2. **"It stopped too early on the part I care about."** One source and a confident sentence, while it went deep on things that don't matter to you.
3. **"Where did this come from?"** The report reads well, but you can't tell which source supports a sentence, or how thin the evidence is.

## What Glassbox does

| Challenge requirement | How Glassbox meets it |
|---|---|
| Plans its searches | The question becomes a visible plan: **dimensions → directions**, each with its first queries. You can change the plan while it runs. |
| Reads what it finds | Sources are read and turned into **atomic claims**, each with a supporting passage. |
| Decides when it has enough evidence | Each direction records **why it stopped**. "Enough evidence", "nothing new found" and "budget ran out" look different. You can override a stop with **dig deeper**. |
| Cites every claim | Every answer sentence cites claim ids. **Uncited sentences are dropped.** Clicking a citation jumps to the passage. |

What sets it apart:

- **Steering without restarting.** The graph *is* the agent's working memory, so a steer only changes the affected branches:
  - **Redirect** cancels a direction, drops its claims from the answer and moves its budget to the rest. The planner is told "avoid: X".
  - **Dig deeper** adds budget to one direction and targets its weakest claims. It looks for counter-evidence as well as more support, so the result can turn green *or* red.
  - The answer is then rebuilt, and you see which sentences changed.
- **Different from subagents.** Subagents split the work, but you can't see them, steer one, or fix one without re-running everything.
- **Honest evidence status, not fake certainty.** Colour shows how well a claim is *supported*, not whether it is *true*:
  - **Green:** corroborated by 2 or more independent origins
  - **Orange:** a single origin
  - **Red:** weak or contradicted
  - **Grey:** the passage could not be found in the source
- **Gaps stay visible.** Unresolved or contradicted points are marked "needs your input" instead of being smoothed over. The run never blocks on you.
- **Visible thinking.** The plan, every search/read/stop decision with its one-line reason, and the evidence behind it all appear live in the graph and trace. "Thinking" means the agent's research decisions, not the model's hidden reasoning tokens.

## Beyond the cookbook

We started from the [Nebius deep research cookbook](https://dev.nebius.com/cookbook/deep-research-agent-tavily): `deepagents` + MiniMax-M3 + Tavily, which produces one cited report.

| Cookbook | Glassbox |
|---|---|
| Planning, searching and stopping happen inside one `agent.invoke`. To see them, you print the raw JSON state afterwards. | Every plan step and decision streams live into a graph, each with a one-line reason. |
| You can't change direction while it runs. To change anything, you re-run from scratch. | **Redirect** and **Dig deeper** mid-run; only the affected branches re-run. |
| Sources are listed at the end of the report. | Every sentence cites a claim, and every claim points to a passage found in the source text. Uncited sentences are dropped. |
| No sense of how strong the evidence is. | Evidence status per claim (one of the suggested directions: "a confidence rating per claim"), with echoed sources collapsed. |
| One model does everything. | Planner, parallel researchers and a synthesizer on Token Factory (Nemotron + Reflection Beam). |

We replaced the `deepagents` loop with our own small loop because its steps are hidden inside one call and can't be interrupted or re-run one branch at a time.

## What we don't claim

Judges will ask, so we say it first:

- **A cited passage is not proof.** We check that the passage really exists in the source (exact match, or a clearly marked near-match). Whether it supports the claim is an LLM check, and we label it as one.
- **Independence is approximate.** Same domain or near-duplicate text counts as one origin. Syndicated content can still slip through.
- **Corroboration is not truth.** Three sources can repeat the same mistake. That's why contradictions and single-origin claims are shown, never hidden.
- **Digging deeper doesn't buy certainty.** More searching can just as well turn up contradictions. We show whatever it finds.

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

**Choosing the question:** it should naturally branch into 3–4 directions, with **one direction you'd obviously want to cut** and **one that is thin but important**. Rehearse it beforehand so retrieval is reliable and the thin direction really does change when you dig.

| Time | Show | Say |
|---|---|---|
| 0:00 | Ask the question. The plan appears as dimensions and directions. | "It plans before it searches, and you can see the plan." |
| 0:15 | Branches research live. The trace strip shows decisions. | "Every search, read and stop has a reason." |
| 0:35 | One direction you don't care about gets heavy traffic. **Redirect**: it greys out and its budget moves to the others. | "Not what I care about. Cut it, no restart." |
| 0:55 | One important direction stopped on a single source (orange). Show its stop reason, then **dig deeper**. Only that branch re-runs. | "It thought one source was enough. I disagree." |
| 1:20 | The branch comes back with new sources: corroborated or contradicted, either is fine. | "More evidence, for or against. Not a button that buys green." |
| 1:35 | The answer is rebuilt: the cut direction is gone and the deepened part is rewritten. Click a citation to land on the highlighted passage. | "You steer, and you can see what changed. Every sentence is still cited." |
| 1:55 | Stats bar: sources, steers, 0 restarts, cost. | |

Two steers that clearly work beat four that look rough. Leave **fix** and chat-steering out of the demo unless they're solid.

## Judge Q&A prep

| Question | Answer |
|---|---|
| "How is this different from Perplexity or other deep research tools?" | Their plan and stopping decisions are hidden and final. Ours are visible and you can steer them mid-run, re-running only what you changed. |
| "Is that really its thinking, or a story it tells afterwards?" | It is the decisions that drive the run: each search, read and stop is logged before it executes, with the reason the model gave. We don't claim to show hidden reasoning tokens. |
| "Isn't this just re-prompting?" | No. Re-prompting throws away everything. A steer keeps all evidence that isn't affected and re-runs one branch. The stats bar shows 0 restarts. |
| "Doesn't dig deeper just confirm what you want?" | It goes after the weakest claims and searches for counter-evidence too. In the demo, a node can just as well turn red. |
| "Isn't confidence just made up?" | We don't show a probability. The colour is a rule you can check: number of independent origins, whether the passage was found and whether there is a contradiction. |
| "Can the citation still be wrong?" | Yes. The passage existing is checked mechanically. Whether it supports the claim is an LLM judgment, and we label it as one. |
| "Why a graph?" | It is the agent's working memory: dimensions → directions → claims → answer. That is what makes a targeted re-run possible. |

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

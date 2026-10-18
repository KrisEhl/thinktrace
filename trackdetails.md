# Agentic Deep Research with Token Factory + Tavily

Challenge brief: **Nebius Build Week Hackathon with NVIDIA**, Berlin, 18 Oct 2026.
Run by Tavily and Nebius (lead: Daniel Myers, Nebius DevRel).

**Deadline: 18:30, 18 Oct 2026, on the hackathon platform.**

---

## 1. What the track asks

A question goes in, and a **sourced, verifiable answer** comes out.

The agent must:
1. **Plan** its searches.
2. **Read** what it finds.
3. **Decide** when it has enough evidence.
4. **Cite** every claim.

It is not enough to build a chatbot with a search tool. The agent has to show that it makes research decisions on its own, and that every claim in the answer traces back to a real source.

## 2. Rules and constraints

| Area | Requirement |
|---|---|
| Inference | Any model on **Nebius Token Factory**. Using **Reflection Beam** also qualifies the team for the Reflection credits. |
| Retrieval | **Tavily** for web search |
| Starting point | The official cookbook: [dev.nebius.com/cookbook/deep-research-agent-tavily](https://dev.nebius.com/cookbook/deep-research-agent-tavily) |
| Code | Public GitHub repo |
| Docs | A README that a judge can follow to run the project |
| Video | 2 minutes, showing one complete run |
| Deadline | 18:30, submitted on the hackathon platform |

## 3. How it is judged

The judges run three concrete checks:

| Check | What it means in practice |
|---|---|
| **3 random citations hold up** | A judge clicks any 3 citations in the answer. Each must open a real source that actually says what the claim says. One bad citation hurts badly, so unverifiable claims should never reach the answer. |
| **One complete run, no cuts** | The video shows a single run from question to answer, without editing. Speed, stability and a graceful failure path matter. |
| **The trace shows the agent deciding** | The judge must see the agent choose what to search, what to read and when to stop, with reasons. A fixed pipeline (always search 5, always read 3) will score poorly. |

## 4. Prizes

| | Prize |
|---|---|
| Challenge winner | $1k Nebius AI Cloud, $1k Token Factory, **$10k Reflection AI credits**, 30k Tavily credits |
| Grand final | The winner also demos at the **20:00 grand final**, for an extra $10k Cloud, $10k Token Factory and $10k Reflection credits |
| Side awards | Hugging Face and other partners give awards across all challenges |

The same project can also go to the **Nebius x NVIDIA Global AI Hackathon** on Devpost, which closes 30 Oct at 10:00 PT. Prizes there are $20k / $10k / $6k, plus $3k for Best Use of Tavily. Requirements: Token Factory or Nebius Cloud, at least one NVIDIA open model, a public open-source repo, a README, and a video under 3 minutes.

## 5. The starter: the official cookbook

Repo: [nebius/token-factory-cookbook](https://github.com/nebius/token-factory-cookbook), path `agents/langchain/deep-agent-example-1`.

| Part | What it uses |
|---|---|
| Agent framework | `deepagents`: planning loop, a virtual file system for notes, sub-agents |
| Model | `MiniMaxAI/MiniMax-M3` through `ChatNebius` (`langchain-nebius`) |
| Search | `TavilySearch(max_results=5, search_depth="advanced")` from `langchain-tavily` |
| Env vars | `NEBIUS_API_KEY`, `TAVILY_API_KEY` |

Core calls:

```python
tavily_search = TavilySearch(max_results=5, search_depth="advanced")
model = ChatNebius(model="MiniMaxAI/MiniMax-M3")
agent = create_deep_agent(model=model, tools=[tavily_search])
result = agent.invoke({"messages": [{"role": "user", "content": question}]})
print(result["messages"][-1].content)
```

**Baseline numbers:** about 6 model calls and $0.07 per run. It produces a report of about 20k characters in under 90 seconds.

**What the baseline does not give you**, which is where the judging pushes:
- Its citations are not checked against the source text.
- Its decisions are only visible by dumping the raw agent state.
- It runs once, start to finish, with no way to see or correct it mid-run.

## 6. Tools available

### Nebius Token Factory

- OpenAI-compatible API. Base URL: `https://api.tokenfactory.nebius.com/v1/`, with `Authorization: Bearer $NEBIUS_API_KEY`.
- Keys: [tokenfactory.nebius.com](https://tokenfactory.nebius.com). New accounts get $1 of trial credit; the Nebius AI Builder Program ([dev.nebius.com/builders](https://dev.nebius.com/builders)) gives more.
- List the live model IDs before relying on any of them:

```bash
curl -s "https://api.tokenfactory.nebius.com/v1/models?verbose=true" -H "Authorization: Bearer $NEBIUS_API_KEY"
```

- Relevant models: NVIDIA Nemotron 3.5 (Lightning, Super VL), Nemotron 3 Super / Ultra, Reflection Beam (501B open-weight model, live since 16 Oct), MiniMax-M3.
- Nemotron with structured output: turn thinking off with `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` and use `response_format` JSON schema. With thinking on, JSON output is unreliable.
- Default rate limit is about 60 requests per minute, so batch and use backoff.

### Tavily

- Keys: [app.tavily.com](https://app.tavily.com) (`tvly-...`). The free tier gives 1,000 credits a month.

| Endpoint | Cost | Notes |
|---|---|---|
| Search | 1 credit (basic), 2 (advanced) | `include_raw_content=True` returns page text with the results, which saves separate Extract calls |
| Extract | 1 credit per 5 URLs | Full page text for chosen URLs |
| Research | 4-250 credits | Tavily's own research agent. Avoid it: it is expensive, and it hides the decisions the judges want to see. |

- Useful search parameters: `max_results`, `search_depth`, `topic="news"`, `time_range`, `include_raw_content`.

## 7. What this means for any submission

1. **Verify citations in code, not by trust.** Store the exact quote and check it against the fetched source text before a claim can be cited.
2. **Make decisions explicit.** Log every search, read and stop with a one-line reason, and show that log in the UI and the video.
3. **Have a real stopping rule.** For example: stop when new reads add nothing, when the budget runs out, or when enough independent sources agree.
4. **Count independent sources.** Ten reprints of one press release are one source, not ten.
5. **Plan the uncut run.** Pick a question that finishes in about a minute, cap the budget, and have a recorded fallback in case the Wi-Fi drops. Be open about it in the README if you use the fallback.
6. **Use Beam somewhere meaningful,** for example in final synthesis, to qualify for the Reflection credits.
7. **Make the README runnable:** keys, one install command, one run command, and a health check.

---

## 8. Our proposal (draft, open for discussion)

Working name: **Glassbox**, "research you can see and steer". Nothing here is final.

**Idea.** Deep research agents are black boxes: you can't see what they did, you can't correct a wrong turn without restarting, and they sound equally sure about everything. We propose an agent whose working memory is a **live research graph** that the user can watch and steer.

**Proposed features, mapped to the judging**

| Judging check | Proposed feature |
|---|---|
| 3 citations hold up | Every claim has an exact quote, verified against the source (with a fuzzy fallback). Clicking a citation jumps to the exact sentence. Unverified claims are never cited. |
| One uncut run | Steering mid-run: **deactivate** a direction, **dig deeper** on a weak one, **fix** a wrong assumption. Only the affected nodes re-run, with no restarts. |
| Trace shows decisions | Each step emits a decision event (search / read / stop, plus why), shown live in a trace strip. |

**Possible flow**
1. A planner splits the question into dimensions (Tech, Law, Market...) and sub-questions.
2. Each sub-question runs as its own loop: decide, search with Tavily, read, extract claims with quotes, verify.
3. Confidence comes from the number of independent sources, so the node colours can be explained.
4. A synthesizer writes the answer. Every sentence cites claim ids, and uncited sentences are dropped.
5. Weak or contradicted nodes get flagged "needs your input" rather than hidden.

**Possible models:** Nemotron 3.5 Super VL for planning and decisions, Lightning for reading, Beam for synthesis. All of this is to be confirmed against `/v1/models`.

**Possible stack:** Python, FastAPI, Server-Sent Events, with a graph UI on the frontend.

More detail on the proposal: [IDEA.md](IDEA.md).

## 9. Open questions for the team

- Which demo question finishes reliably in about a minute and shows steering well?
- Graph UI, or a simpler trace and answer view, given the time left?
- Do we support uploaded user documents, or web only?
- Which model IDs are actually live on Token Factory today?

## 10. Submission checklist

- [ ] Public GitHub repo
- [ ] README a judge can run (keys, install, run, health check)
- [ ] 2-minute video of one uncut run
- [ ] Inference on Token Factory; retrieval through Tavily
- [ ] Every claim cited; any 3 random citations hold up
- [ ] Trace visibly shows the agent's decisions
- [ ] Submitted on the hackathon platform by 18:30

## 11. Links

- Challenge starter: https://dev.nebius.com/cookbook/deep-research-agent-tavily
- Token Factory cookbook: https://github.com/nebius/token-factory-cookbook
- Token Factory docs: https://docs.tokenfactory.nebius.com
- Tavily docs, credits and limits: https://docs.tavily.com/documentation/api-credits.md
- Tavily joins Nebius: https://www.tavily.com/blog/tavily-is-joining-nebius
- Devpost global hackathon rules: https://nebiusglobalaihackathon.devpost.com/rules
- Event: https://luma.com/big-gtc-hack

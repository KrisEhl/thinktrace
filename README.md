# Search Shooter

**Type a question. Break the answer.**

Search Shooter is a deep research agent that you play. It runs on **Nebius Token Factory** for reasoning and uses **Tavily** for live web search and page extraction.

1. You ask a question. The agent **plans** sub-questions, then runs a tool loop in which it decides on its own when to **search**, which pages to **read** in full, and when it has **enough evidence**.
2. Every step falls into the game as a **destructible pixel level**. The plan, each search with its results, and each page read become solid text that a stick figure can stand on, run across and shoot to pieces.
3. The cited draft lands last. Each claim is a block of text with its source ids and the **verbatim quote** that supports it.
4. **Shoot a claim apart** and an **adversarial fact-checker** goes after it. It picks the angle most likely to break the claim, runs a fresh Tavily search and rules on it:
   - **UPHELD**: the block turns to gold steel and can no longer be destroyed.
   - **WEAKENED**: the block shatters and is replaced by the corrected claim.
   - **REFUTED**: the block shatters.
5. Press **R** for the verified report. Every citation links to its source, and every quote has a *jump to quote* link (a [text fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments)) that scrolls the source page to the exact sentence. You can export the run, including the full decision trace, as Markdown or JSON.

## Why the citations hold up

- The writer has to copy a **verbatim quote** for each claim. The server then looks for that quote in the text Tavily actually fetched (exact match first, then a fuzzy match on 85% of the words). If the quote isn't there, the claim is flagged in the game and in the report, and its confidence drops one level.
- The fact-checker's evidence quotes go through the same check.
- `NEBIUS_CHECKER_MODEL` lets a **different model** judge the draft, so the writer doesn't grade its own work. Reflection AI's Beam is a good fit for this role.

## Why the trace shows decisions, not a script

The research loop uses native tool calling (`web_search`, `read_pages`, `finish_research`), and every call has to include a `reason`. The **AGENT TRACE** panel (press **T**) streams everything live over SSE: the plan, the model's reasoning (when the model exposes it), each search with its *why*, which pages it chose to read, when it stopped and what it is still unsure about, every attack angle the fact-checker tried, and each verdict. Budgets (6 searches, 8 page reads, 10 steps) force the model to choose instead of crawling everything.

## Run it

Requires **Node.js 21.7 or newer**. There are no dependencies to install.

```bash
cp .env.example .env      # add NEBIUS_API_KEY and TAVILY_API_KEY
npm run check             # optional: verifies both keys and the model ids
npm start                 # open http://localhost:3000
```

Without keys, the app starts in **offline demo mode**: a scripted replay built on real Wikipedia text (`agent/demo-sources.json`). Its quotes still go through the same verifier, and one of its claims is deliberately breakable. Add `?demo=1` to the URL to force demo mode even when keys are set.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEBIUS_API_KEY` | | Token Factory key |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` | OpenAI-compatible endpoint |
| `NEBIUS_MODEL` | `MiniMaxAI/MiniMax-M3` | Planner, researcher and writer |
| `NEBIUS_CHECKER_MODEL` | same as `NEBIUS_MODEL` | Adversarial fact-checker (try Beam). `npm run check` lists the Beam ids in your catalog |
| `TAVILY_API_KEY` | | Tavily key |
| `PORT` | `3000` | HTTP port |

## Controls

| Input | Action |
| --- | --- |
| `A` / `D` | run |
| `W` / `Space` | jump; press again in the air to flip, hold to fly with the jetpack |
| `S` | drop through text |
| Mouse / click | aim / shoot |
| Right-click | grenade |
| `1`-`4` / wheel | blaster, shotgun, minigun, rocket |
| `T` / `R` / `N` / `Esc` | trace / report / new search / pause |

## How it's built

```
server.js            zero-dependency HTTP server, SSE streams, run store, exports
agent/research.js    planner -> tool loop (search/read/finish) -> writer -> quote verification
agent/factcheck.js   attacker (picks the angle + query) -> Tavily -> judge
agent/sources.js     source registry, verbatim-quote verifier, text-fragment links
agent/llm.js         Token Factory client: tool calls, <think> stripping, robust JSON parsing, JSON retries
agent/tavily.js      Tavily /search and /extract
agent/demo.js        offline replay
public/js/world.js   destructible pixel terrain (solid mask + region ownership per pixel)
public/js/layout.js  agent events -> stamped text cards
public/js/main.js    game loop, physics, weapons, camera, SSE wiring
public/js/ui.js      HUD, trace panel, report
```

Every card is drawn into a scratch canvas and copied into the world. Strong pixels become solid terrain, and faint anti-aliased edges are kept for display only. Each pixel records which card or claim it belongs to. Explosions carve circles out of the mask and turn the removed pixels into debris. Once a claim loses about 22% of its pixels, the fact-checker is triggered.

API:

- `GET /api/research?q=…`: SSE stream of agent events
- `GET /api/challenge?run=…&claim=C3`: SSE stream of the fact-check
- `GET /api/run/:id`: JSON with the answer, claims, sources and trace
- `GET /api/run/:id.md`: the same as Markdown

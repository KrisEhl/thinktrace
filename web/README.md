# Glassbox web (SPIKE, throwaway until promoted)

Graph-first frontend for Glassbox. It reads the backend's event log (docs/agent-and-event-logging.md) through a
translator (`src/api/glassbox.ts`), so the same UI shows live runs, recorded runs and mock scenarios.

```bash
cd web && npm install
npm run dev                                       # http://localhost:5173
#   ?run=sample&speed=4   replay a recorded run from ../runs (served by a dev plugin, no backend, no API keys)
#   ?mode=mock            in-browser mock scenarios + Playground tab
GLASSBOX_API=http://localhost:8000 npm run dev    # proxy to the live backend: ask a question, steer it
npm test                                          # translator + reducer against ../runs/sample
```

The run picker under the chat box switches between live, recorded runs and mock scenarios.
The Tavily / Token Factory keys belong to the backend (repo-root `.env`, gitignored). The frontend never sees them.

## Backend -> UI translation (src/api/glassbox.ts)

| Backend event | UI |
|---|---|
| `run.started`, `plan.created`, `plan.updated` | question node, direction nodes (title, why, first queries; `from_dir` for redirects) |
| `decision` (think) | its reason is attached to the searches and reads that follow it ("no reason given" if none) |
| `search.completed`, `read.started` | decision cards in the direction's activity layer; search results link to source cards |
| `source.added` | source (origin = domain); page text is fetched on demand from `/runs/{id}/sources/{sid}` |
| `claim.recorded`, `claim.linked` | claim cards; evidence status per claim group: grey not found, red contradicted, green 2+ domains, orange otherwise |
| `direction.finished`, `budget.hit`, `direction.resumed` | stop badge (✓ enough, ∅ nothing new, ⏱ budget, ✕ dropped); "needs you" when it stopped without corroborated evidence |
| `steer.applied`, `steer.delivered` | chat log entries pinned to the steered direction (sticky notes) |
| `check.started`, `synthesis.started`, `report.final` | chat progress lines; answer split into cited sentences, version, changed and dropped sentences |
| `run.finished` | stats bar totals |

Steering: Deactivate = backend `redirect`, Dig deeper = `dig_deeper`. Fix and chat follow-ups exist only in the mock for now.

## What the spike shows

- **Layers (semantic zoom).** One layer at a time, centred on `focusId`:
  1. question -> dimensions (-> sub-questions as small outer nodes)
  2. dimension -> sub-questions
  3. direction -> *what the agent is doing*: decisions (search/read/stop + why) -> sources -> claims
  Double-click a node, press "Zoom in", or scroll-zoom past 1.9x with a node selected to go in; zoom out far or use the breadcrumb to go up.
- **Chat as sticky notes.** The left rail is the permanent log. Each question is also pinned to the node it was asked on (folded tab / unfolded sticky). A follow-up asked while a node is selected pins there and grows a branch from it.
- **Trace back.** answer `[c3]` -> claim -> exact quote -> source text scrolled to and highlighted at `claim.span`, with origin/echo info.
- **What is used.** Every claim/source shows `used in answer | pending | not used: <reason>` (deactivated direction, quote not verified, not cited). Dock tab "Ledger" lists origins -> sources -> claims.
- **Flexible layout.** Chat rail, right dock and trace strip are resizable/collapsible; widths persist.
- Steering buttons (deactivate / dig deeper / fix / accept) call the real `steer` endpoint; the mock reacts. Deeper steering behaviour is deferred on purpose.

## Playing with the mock

- Pick a scenario in the chat box before pressing Run: *Vendor due diligence* (10 nodes) or *Market scan* (24 nodes, deeper levels, seeded chat notes, echoes, a contradiction, an unverifiable quote).
- Chat answers from the claims already in the graph (try "summarise", "how sure are we", "how many sources", or a topic that exists, e.g. "WMS integration"). Anything it has no evidence for opens a new branch with an invented but traceable claim.
- **Play** tab (mock only): add a branch, add evidence, contradict, mark stale, flag needs-you on the selected node, or skip to the end of the run.

## Backend contract

The UI follows the backend's own contract (docs/agent-and-event-logging.md, sections 4 and 6): `POST /runs`,
`GET /runs`, SSE `GET /runs/{id}/events` (replays from seq 0, then tails), `GET /runs/{id}/sources/{sid}`,
`POST /runs/{id}/steer {action: redirect|dig_deeper, dir, text?}`, `GET /health`. The dev plugin in `vite.config.ts`
serves the read-only part of it from `../runs` and answers writes with 409.

## Known spike gaps

- No context paste/upload UI yet (`context_text` is supported by the client).
- Follow-up branches deeper than the visible layer are only reachable by drilling in.
- `fix` uses `window.prompt`; no assumptions view yet (`assumption_created` is stored, not shown).
- A direction's activity layer gets dense on real runs (d2 in the sample has ~30 decisions and 20 claims).
- Tests cover the translator on `runs/sample`; the UI is checked by driving it in headless Chromium.

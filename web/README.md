# Glassbox web (SPIKE, throwaway until promoted)

Graph-first frontend for Glassbox. Runs today against an in-browser mock; wiring the real backend is a one-line env change.

```bash
cd web && npm install
npm run dev                         # mock backend, http://localhost:5173  (?speed=4 plays the run 4x faster)
VITE_API_URL=http://localhost:8000 npm run dev   # real backend
```

The Tavily / Token Factory keys belong to the backend (repo-root `.env`, gitignored). The frontend never sees them.

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

## Backend contract (what the UI calls)

All in `src/api/types.ts` (`Transport`), HTTP implementation in `src/api/http.ts`.

| Call | Notes |
|---|---|
| `POST /runs {question, context_text?}` -> `{run_id}` | |
| `GET /runs/{id}/events` (SSE) | One JSON `GlassboxEvent` per `data:` line. **Must replay the full history from the start on connect** (the UI builds all state from events), then stream live. |
| `GET /runs/{id}/graph` -> `GraphSnapshot` | Used for `?run=<id>` reload. |
| `POST /runs/{id}/steer {action, node_id?, text?}` | `action`: `deactivate | dig_deeper | fix | accept | chat`. `chat` = a follow-up; the backend emits the user + agent `message` events itself, pinned to `node_id`. |
| `GET /sources/{id}` -> `Source` | Source text + id; claims carry `span`. |
| `GET /health` | |

Events (payloads in `types.ts`): `run_started, run_finished, error, assumption_created, direction_created, source_added, claim_added, claim_verified, confidence_changed, verdict_set, decision, direction_stopped, steer_applied, stale_marked, needs_human, message, answer_updated, cost_updated`.

Frontend asks of the backend (the spec did not say these):
1. `direction_created` for question, dimension and direction nodes (`kind`, `parent_id`, `label`). Root id is `"q"` in the mock; any id works if `parent_id: null` marks the root, but then `focusId` initialisation needs the id from `run_started` (TODO).
2. `Decision.source_id` on `read` decisions (and ideally on a search decision for each result it yields). Without it the activity layer guesses which decision produced which source.
3. Parent (dimension) confidence is rolled up client-side as the mean of its verified children; send `confidence_changed` with a `node_id` to override.
4. New message events: `{type:"message", message:{id, role, text, node_id, claim_ids?, pending?}}`; re-send the same `id` to update a pending message.
5. `Source.origin_id` is what collapses reprints; the UI shows "N sources share it".

## Known spike gaps

- No context paste/upload UI yet (`context_text` is supported by the client).
- Follow-up branches deeper than the visible layer are only reachable by drilling in.
- `fix` uses `window.prompt`; no assumptions view yet (`assumption_created` is stored, not shown).
- No tests; verified by driving the mock run in headless Chromium (no console errors).

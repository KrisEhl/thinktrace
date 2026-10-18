# Glassbox backend

Deep-research agent with a steerable, auditable event log. Python, runs on Nebius Token Factory + Tavily.
This folder is the backend only; it has no dependency on the Search Shooter Node app next to it.

## Run

```bash
cd glassbox-backend
cp .env.example .env            # NEBIUS_API_KEY, TAVILY_API_KEY (+ model ids)
uv run pytest -q                # unit tests, no keys needed
uv run uvicorn glassbox.server:app --port 8000
uv run python -m glassbox.cli "Your question"          # CLI with live trace
uv run python -m glassbox.scoring runs/<id>            # confidence statistics for a recorded run
```

## HTTP API (`glassbox/server.py`)

- `POST /runs {question}` start a live run; `GET /runs` list runs
- `GET /runs/{id}/events?from=N&speed=S` SSE: the event log, then live events until `run.finished`
- `POST /runs/{id}/steer {action, dir, text}`: `redirect` | `dig_deeper` | `follow_up` (dir `q` = the question)
- `POST /runs/{id}/close`, `GET /runs/{id}/events.jsonl`, `GET /runs/{id}/sources/{sid}`, `GET /health`

## How it works

- **Plan**: 3-4 research directions, one per reading of the question (no clarifying question up front; the user
  drops directions at runtime), each with a source strategy (`glassbox/prompts.py`).
- **Research**: one researcher per direction, every search / read with a required reason, every fact recorded as a
  claim with a verbatim quote that is checked against the page (`verify.py`), plus its date, kind
  (stable / event / volatile) and value/unit.
- **Fact-check**: code proposes candidate claim pairs; the LLM judges them in small batches (same fact /
  contradicts) and classifies unrated source domains (`checker.py`).
- **Confidence** (`scoring.py`, deterministic): source reliability (Lin et al. 2023 expert ratings, else source kind;
  unrated sources are ordinary evidence) x quote factor x recency; one origin per publisher; noisy-OR support;
  contradictions as competing hypotheses; per-direction source mix, blindspot flag and, for changing quantities, a
  trimmed-mean estimate with trend and 30-day band. Published live as `scores.updated` events.
- **Writer**: answers the question as asked, from dated claims (oldest first), with weight of evidence rather than
  false balance.

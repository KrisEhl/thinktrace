// Model leaderboard: how well each research model holds up. Every run and every
// fact-check verdict is attributed to the model that wrote the claims; the
// fact-checker stays one fixed model so all research models face the same judge.
// Stored in DATA_DIR/models.json.
import { jsonStore } from './store.js';

const store = jsonStore('models');
const stats = store.map;

const blank = () => ({
  runs: 0,
  failed: 0,
  claims: 0,
  quotesVerified: 0,
  searches: 0,
  reads: 0,
  durationMs: 0,
  challenged: 0,
  upheld: 0,
  weakened: 0,
  refuted: 0,
});

function entry(model) {
  if (!stats.has(model)) stats.set(model, blank());
  return stats.get(model);
}

export function recordRun(run) {
  const e = entry(run.model);
  e.runs += 1;
  e.claims += run.claims.length;
  e.quotesVerified += run.claims.filter((c) => c.quoteVerified).length;
  e.searches += run.trace.filter((t) => t.type === 'search').length;
  e.reads += run.sources.list.filter((s) => s.read).length;
  e.durationMs += Date.now() - run.startedAt;
  e.updatedAt = new Date().toISOString();
  store.save();
}

export function recordFailure(run) {
  const e = entry(run.model);
  e.failed += 1;
  e.updatedAt = new Date().toISOString();
  store.save();
}

export function recordVerdict(run, verdict) {
  if (!['upheld', 'weakened', 'refuted'].includes(verdict)) return;
  const e = entry(run.model);
  e.challenged += 1;
  e[verdict] += 1;
  e.updatedAt = new Date().toISOString();
  store.save();
}

// Trust score (0-100): 60% how often its claims survive a fact-check (weakened
// counts half), 40% how often its quotes are really in the source. Both use
// Laplace smoothing (+1/+2) so a single lucky run doesn't top the table.
export function modelStandings() {
  const rows = [...stats.entries()]
    .filter(([, e]) => e.runs > 0)
    .map(([model, e]) => {
      const survival = (e.upheld + 0.5 * e.weakened + 1) / (e.challenged + 2);
      const quoteAccuracy = (e.quotesVerified + 1) / (e.claims + 2);
      return {
        model,
        runs: e.runs,
        failed: e.failed,
        claims: e.claims,
        quoteAccuracy: e.claims ? e.quotesVerified / e.claims : null,
        challenged: e.challenged,
        upheld: e.upheld,
        weakened: e.weakened,
        refuted: e.refuted,
        survival: e.challenged ? (e.upheld + 0.5 * e.weakened) / e.challenged : null,
        refutedRate: e.challenged ? e.refuted / e.challenged : null,
        reliability: e.runs / (e.runs + e.failed),
        avgSeconds: Math.round(e.durationMs / e.runs / 1000),
        avgReads: Math.round((e.reads / e.runs) * 10) / 10,
        trust: Math.round(100 * (0.6 * survival + 0.4 * quoteAccuracy)),
      };
    })
    .sort((a, b) => b.trust - a.trust || b.runs - a.runs);
  rows.forEach((r, i) => (r.rank = i + 1));
  // The model players should hunt: most refuted per challenge (min. 3 checks).
  const prey = rows.filter((r) => r.challenged >= 3).sort((a, b) => b.refutedRate - a.refutedRate)[0];
  return { models: rows, easiestPrey: prey?.model ?? null };
}

// Global leaderboard: players earn points when the fact-checker refutes a claim
// they shot. Points are awarded server-side from the verdict, so clients can't
// fake them. Stored in DATA_DIR/leaderboard.json.
import { jsonStore } from './store.js';

export const POINTS = { refuted: 100 };

const store = jsonStore('leaderboard');
const board = store.map;

export const validPlayerId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);

export function cleanName(name) {
  return (
    String(name ?? '')
      .replace(/[^\p{L}\p{N} _.'-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20) || 'Anonymous Worm'
  );
}

// Credit a verdict to a player. Returns { awarded, total } or null if nothing scored.
export function award(player, verdict, { claim, question }) {
  const awarded = POINTS[verdict] ?? 0;
  if (!player || !awarded) return null;
  const entry = board.get(player.id) ?? { name: player.name, points: 0, refuted: 0 };
  entry.name = player.name;
  entry.points += awarded;
  if (verdict === 'refuted') entry.refuted += 1;
  entry.lastTakedown = { claim: String(claim).slice(0, 160), question: String(question).slice(0, 160), at: new Date().toISOString() };
  entry.updatedAt = entry.lastTakedown.at;
  board.set(player.id, entry);
  store.save();
  return { awarded, total: entry.points };
}

const ranked = () => [...board.entries()].sort(([, a], [, b]) => b.points - a.points || (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''));

export function standings(playerId, limit = 20) {
  const all = ranked();
  const view = ([id, e], i) => ({
    rank: i + 1,
    name: e.name,
    points: e.points,
    refuted: e.refuted,
    lastTakedown: e.lastTakedown?.claim ?? '',
    you: id === playerId,
    sample: Boolean(e.seed),
  });
  const index = all.findIndex(([id]) => id === playerId);
  return {
    pointsPerRefute: POINTS.refuted,
    players: all.length,
    top: all.slice(0, limit).map(view),
    you: index === -1 ? null : view(all[index], index),
  };
}

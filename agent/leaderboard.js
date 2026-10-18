// Global leaderboard: players earn points when the fact-checker refutes a claim
// they shot. Points are awarded server-side from the verdict, so clients can't
// fake them. Stored as JSON on disk (LEADERBOARD_FILE, default data/leaderboard.json).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POINTS = { refuted: 100 };

const FILE = resolve(process.env.LEADERBOARD_FILE || fileURLToPath(new URL('../data/leaderboard.json', import.meta.url)));
const board = load();
let saveTimer;

function load() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

// Debounced atomic write (tmp file + rename) so a crash never leaves half a file.
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(`${FILE}.tmp`, JSON.stringify(Object.fromEntries(board), null, 1));
    renameSync(`${FILE}.tmp`, FILE);
  }, 200);
}

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
  save();
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
  });
  const index = all.findIndex(([id]) => id === playerId);
  return {
    pointsPerRefute: POINTS.refuted,
    players: all.length,
    top: all.slice(0, limit).map(view),
    you: index === -1 ? null : view(all[index], index),
  };
}

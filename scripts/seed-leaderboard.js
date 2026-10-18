// Seed both leaderboards with demo data so they don't start empty.
//
//   npm run seed            add sample players and models (keeps real entries)
//   npm run seed -- --clear remove all sample entries again
//
// Sample entries are flagged `seed: true` and shown with a SAMPLE tag. The model
// stats are invented, not measured: a model's sample row is replaced by real
// data the first time that model is actually played. Writes to DATA_DIR
// (default ./data). Restart the server afterwards: it reads the files at startup.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)));
const clear = process.argv.includes('--clear');

const read = (name) => {
  try {
    return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
  } catch {
    return {};
  }
};
const write = (name, data) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${name}.json`), JSON.stringify(data, null, 1));
};
const daysAgo = (d, h = 0) => new Date(Date.now() - (d * 24 + h) * 3600e3).toISOString();

// Players. Every "last takedown" is a well-known myth, so the claim really is false.
const PLAYERS = [
  ['Citation Needed', 1900, 'Humans only use 10 percent of their brains.', 'How much of the brain do humans actually use?'],
  ['Reviewer #2', 1600, 'The Great Wall of China is visible from the Moon with the naked eye.', 'Can you see the Great Wall of China from space?'],
  ['Hallucination Hunter', 1400, 'Albert Einstein failed mathematics in school.', 'How good was Einstein at math as a student?'],
  ['Wormageddon', 1200, 'Vikings wore horned helmets in battle.', 'What did Viking helmets look like?'],
  ['Null Hypothesis', 1000, 'Sugar makes children hyperactive.', 'Does sugar cause hyperactivity in kids?'],
  ['Ctrl+F', 800, 'Goldfish have a three-second memory.', 'How long is a goldfish memory?'],
  ['Dr. Sources', 700, 'Napoleon Bonaparte was unusually short for his time.', 'How tall was Napoleon?'],
  ['TL;DR', 500, 'Bulls are enraged by the colour red.', 'Why do bulls charge at the matador cape?'],
  ['Peer Pressure', 400, 'Lightning never strikes the same place twice.', 'Can lightning strike the same place twice?'],
  ['Footnote Fanatic', 300, 'Cracking your knuckles causes arthritis.', 'Does cracking knuckles cause arthritis?'],
  ['Anonymous Worm', 200, 'Bats are blind.', 'Can bats see?'],
  ['Fresh Recruit', 100, 'Chameleons change colour mainly to camouflage themselves.', 'Why do chameleons change colour?'],
];

// Models: real catalog ids with invented, plausible-looking stats.
// [id, runs, failed, claims, quotesVerified, challenged, upheld, weakened, refuted, avg seconds, avg reads]
const MODELS = [
  ['reflection/beam', 14, 0, 82, 77, 31, 21, 7, 3, 52, 4.6],
  ['moonshotai/Kimi-K3', 11, 1, 66, 61, 24, 15, 6, 3, 64, 5.1],
  ['deepseek-ai/DeepSeek-V4-Pro', 12, 0, 71, 63, 27, 15, 8, 4, 71, 4.8],
  ['zai-org/GLM-5.3', 9, 1, 52, 45, 20, 11, 5, 4, 48, 4.2],
  ['Qwen/Qwen3.5-397B-A17B', 10, 0, 58, 49, 22, 12, 5, 5, 45, 3.9],
  ['nvidia/Nemotron-3.5-Super-VL', 13, 1, 74, 60, 29, 14, 8, 7, 39, 4.1],
  ['openai/gpt-oss-120b', 10, 2, 55, 44, 23, 10, 6, 7, 33, 3.6],
  ['MiniMaxAI/MiniMax-M3', 8, 0, 46, 36, 18, 8, 4, 6, 41, 3.8],
  ['google/gemma-3-27b-it', 7, 2, 38, 24, 16, 5, 4, 7, 27, 2.9],
  ['nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', 9, 3, 47, 27, 21, 6, 4, 11, 22, 2.7],
];

const board = read('leaderboard');
const models = read('models');
const stripSeeds = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => !v.seed));

if (clear) {
  write('leaderboard', stripSeeds(board));
  write('models', stripSeeds(models));
  console.log(`Removed sample entries from ${DIR}. Restart the server to see the change.`);
  process.exit(0);
}

PLAYERS.forEach(([name, points, claim, question], i) => {
  const at = daysAgo(i % 4, i * 3);
  board[`seed-player-${String(i + 1).padStart(2, '0')}`] = {
    name,
    points,
    refuted: points / 100,
    lastTakedown: { claim, question, at },
    updatedAt: at,
    seed: true,
  };
});

let skipped = 0;
for (const [id, runs, failed, claims, quotesVerified, challenged, upheld, weakened, refuted, secs, reads] of MODELS) {
  if (models[id] && !models[id].seed) {
    skipped++; // never overwrite measured data
    continue;
  }
  models[id] = {
    runs,
    failed,
    claims,
    quotesVerified,
    searches: Math.round(runs * 3.4),
    reads: Math.round(runs * reads),
    durationMs: runs * secs * 1000,
    challenged,
    upheld,
    weakened,
    refuted,
    updatedAt: daysAgo(1),
    seed: true,
  };
}

write('leaderboard', board);
write('models', models);
console.log(
  `Seeded ${PLAYERS.length} sample players and ${MODELS.length - skipped} sample models into ${DIR}` +
    (skipped ? ` (${skipped} models already have real data and were left alone)` : '') +
    '.\nRestart the server to load them. Remove them with: npm run seed -- --clear',
);

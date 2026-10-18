// Tiny JSON-on-disk store shared by the player leaderboard and model stats.
// Files live in DATA_DIR (default ./data). Writes are debounced and atomic
// (tmp file + rename) so a crash never leaves half a file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)));

export function jsonStore(name) {
  const file = join(DIR, `${name}.json`);
  let map;
  try {
    map = new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))));
  } catch {
    map = new Map();
  }
  let timer;
  return {
    map,
    save() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(map), null, 1));
        renameSync(`${file}.tmp`, file);
      }, 200);
    },
  };
}

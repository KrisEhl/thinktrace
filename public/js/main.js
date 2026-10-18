// Search Shooter: the research agent builds the level, you break it.
import { World } from './world.js';
import { Layout, COLORS, FONTS } from './layout.js';
import { Player, Projectile, Grenade, Particles, WEAPONS } from './entities.js';
import * as ui from './ui.js';
import { SCALE, K, DEVICE_PX } from './scale.js';

const CLAIM_BREAK = 0.78; // fraction of a claim's pixels left when the fact-checker gets called
const EXAMPLES = [
  'Is Reflection AI Beam 1.0 really open weights, and how big is it?',
  'What caused the 2024 CrowdStrike outage and how many machines were hit?',
  'Does intermittent fasting beat calorie restriction for weight loss?',
  'Which European cities have banned short-term rentals and since when?',
];

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let vw = 0;
let vh = 0;
function resize() {
  vw = Math.ceil(innerWidth / SCALE);
  vh = Math.ceil(innerHeight / SCALE);
  canvas.width = vw;
  canvas.height = vh;
  // Exact CSS size so every world pixel maps to DEVICE_PX device pixels.
  canvas.style.width = `${(vw * DEVICE_PX) / (devicePixelRatio || 1)}px`;
  canvas.style.height = `${(vh * DEVICE_PX) / (devicePixelRatio || 1)}px`;
  ctx.imageSmoothingEnabled = false;
}
resize();
addEventListener('resize', resize);

const config = await fetch('/api/config').then((r) => r.json());
const fontsReady = Promise.all([
  document.fonts.load(FONTS.big),
  document.fonts.load(FONTS.head),
  document.fonts.load(FONTS.body),
]);

// ---------- player identity (for the global leaderboard) ----------
const player = (() => {
  let id = localStorage.getItem('ss.player');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('ss.player', id);
  }
  return { id, name: localStorage.getItem('ss.name') ?? '' };
})();
const $name = document.getElementById('player-name');
$name.value = player.name;
$name.addEventListener('input', () => {
  player.name = $name.value.trim().slice(0, 20);
  localStorage.setItem('ss.name', player.name);
});

async function fetchStandings() {
  return fetch(`/api/leaderboard?player=${encodeURIComponent(player.id)}`).then((r) => r.json());
}
fetchStandings().then((d) => (document.getElementById('points-per-refute').textContent = d.pointsPerRefute)).catch(() => {});

async function openLeaderboard() {
  const overlay = document.getElementById('leaderboard');
  overlay.hidden = false;
  if (game) paused = true;
  document.getElementById('leaderboard-body').innerHTML = '<h2>🏆 LEADERBOARD</h2><p>Loading…</p>';
  try {
    ui.renderLeaderboard(await fetchStandings(), { demo });
  } catch {
    document.getElementById('leaderboard-body').innerHTML = '<h2>🏆 LEADERBOARD</h2><p>Could not load the leaderboard.</p>';
  }
}

// ---------- start screen ----------
const $q = document.getElementById('question');
const params = new URLSearchParams(location.search);
const forceDemo = params.get('demo') === '1';
const demo = !config.live || forceDemo;
document.getElementById('mode').innerHTML = demo
  ? `<span class="demo">OFFLINE DEMO</span>: ${config.live ? 'replaying a recorded-style run' : 'no API keys found, replaying a scripted run on real Wikipedia text'}.<br/>Set NEBIUS_API_KEY + TAVILY_API_KEY for live research.`
  : `<span class="live">LIVE</span>: ${ui.esc(config.model)} on Nebius Token Factory · Tavily search${config.checkerModel !== config.model ? ` · checker ${ui.esc(config.checkerModel)}` : ''}`;
if (demo) {
  $q.value = config.demoQuestion;
  $q.readOnly = true;
} else {
  $q.value = params.get('q') ?? '';
  const ex = document.getElementById('examples');
  for (const e of EXAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.onclick = () => ($q.value = e);
    ex.append(b);
  }
}
$q.focus();

document.getElementById('ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $q.value.trim();
  if (!q) return;
  document.getElementById('start').hidden = true;
  await fontsReady;
  start(q);
});

// ---------- game state ----------
let game = null;
const input = { left: false, right: false, jump: false, down: false, fire: false, mx: 0, my: 0 };
let paused = false;

// Screen width left for the level when the trace panel is docked on the right.
function playWidth() {
  const tr = document.getElementById('trace');
  return tr.hidden ? vw : Math.max(240, vw - Math.ceil((tr.offsetWidth + 24) / SCALE));
}

function start(question) {
  document.getElementById('hud').hidden = false;
  ui.toggleTrace(innerWidth > 900);
  // Wide enough for six graph columns; the camera scrolls sideways when needed.
  const W = Math.round(Math.max(playWidth(), 1600 * K));
  const world = new World(W, Math.round(3600 * K));
  const layout = new Layout(world);
  const hero = layout.centered('hero', [
    { text: 'QUESTION', font: 'head', color: COLORS.dim, after: 6 },
    { text: question, font: 'big', color: COLORS.hero },
  ], { accent: '#ffffff' });
  world.floorY = layout.bottom + 70 * K;
  game = {
    question,
    world,
    layout,
    player: new Player(W / 2, -30),
    cam: { x: 0, y: -60, shake: 0 },
    projectiles: [],
    grenades: [],
    particles: new Particles(),
    fx: [], // explosion flashes and comic words
    weapon: 0,
    cooldown: 0,
    grenadeCooldown: 0,
    claims: new Map(), // claimId -> { claim, region, col, note }
    pendingReasons: new Map(),
    nodes: { hero, plan: null, decision: null, answer: null },
    searchNodes: new Map(), // searchId -> { region, col }
    sourceSearch: new Map(), // sourceId -> searchId that first found it
    pageNodes: new Map(), // sourceId -> page region
    status: 'Booting agent',
    busy: true,
    runId: null,
    report: null,
    t: 0,
  };
  connectResearch(question);
  fetchStandings()
    .then((d) => {
      game.points = Math.max(game.points ?? 0, d.you?.points ?? 0);
      ui.setPoints(game.points);
    })
    .catch(() => {});
  last = performance.now();
  requestAnimationFrame(frame);
}

// ---------- server events ----------
const EVENTS = ['run', 'status', 'plan', 'thinking', 'thought', 'search', 'results', 'read', 'page', 'read_failed', 'tool_error', 'decision', 'claim', 'report', 'challenge', 'attack', 'attack_results', 'verdict', 'points', 'done', 'fail'];

function listen(url, onEvent) {
  const es = new EventSource(url);
  let finished = false;
  for (const type of EVENTS) {
    es.addEventListener(type, (e) => {
      const data = JSON.parse(e.data);
      if (type === 'done' || type === 'fail') {
        finished = true;
        es.close();
      }
      onEvent(type, data);
    });
  }
  es.onerror = () => {
    es.close();
    if (!finished) onEvent('fail', { message: 'Lost connection to the agent.' });
  };
  return es;
}

function connectResearch(question) {
  const who = `&player=${encodeURIComponent(player.id)}&name=${encodeURIComponent(player.name)}`;
  const url = `/api/research?q=${encodeURIComponent(question)}${forceDemo ? '&demo=1' : ''}${who}`;
  listen(url, (type, d) => {
    ui.trace(type, d);
    onResearchEvent(type, d);
  });
}

function settleFloor() {
  game.world.floorY = game.layout.bottom + 60 * K;
}

function onResearchEvent(type, d) {
  const { layout } = game;
  switch (type) {
    case 'run':
      game.runId = d.runId;
      game.mode = d.mode;
      game.model = d.model;
      break;
    case 'status':
      game.status = d.text;
      break;
    case 'plan':
      game.nodes.plan = layout.centered('plan', [
        { text: 'PLAN', font: 'head', color: COLORS.plan, after: 6 },
        ...d.subquestions.map((q, i) => ({ text: `${i + 1}. ${q}` })),
        ...(d.strategy ? [{ space: 3 }, { text: `strategy: ${d.strategy}`, color: COLORS.dim, max: 3 }] : []),
      ], { accent: COLORS.plan, parents: [game.nodes.hero] });
      game.status = 'Plan ready, searching';
      break;
    case 'search':
      game.pendingReasons.set(d.searchId, d.reason);
      game.status = `Searching: ${d.query}`;
      break;
    case 'results': {
      for (const r of d.results) if (!game.sourceSearch.has(r.id)) game.sourceSearch.set(r.id, d.searchId);
      const col = layout.slot(game.searchNodes.size);
      const region = layout.inColumn('search', [
        { text: `SEARCH #${d.searchId}`, font: 'head', color: COLORS.search, after: 5 },
        { text: `"${d.query}"`, color: '#ffffff', max: 2 },
        { text: `why: ${game.pendingReasons.get(d.searchId) ?? ''}`, color: COLORS.dim, max: 3, after: 6 },
        ...d.results.flatMap((r) => [
          { text: `[${r.id}] ${r.title}`, color: COLORS.link, max: 1, after: 0 },
          { text: r.domain, color: COLORS.dim, after: 4 },
        ]),
      ], col, { accent: COLORS.search, parents: [game.nodes.plan ?? game.nodes.hero] });
      if (region) game.searchNodes.set(d.searchId, { region, col });
      break;
    }
    case 'read':
      game.status = `Reading ${d.ids.map((i) => `[${i}]`).join(' ')}`;
      break;
    case 'page': {
      // Hang the page under the search that found it, chained below earlier reads.
      const branch = game.searchNodes.get(game.sourceSearch.get(d.id)) ?? [...game.searchNodes.values()].at(-1);
      const col = branch?.col ?? layout.slot(0);
      const region = layout.inColumn('page', [
        { text: `READ [${d.id}]`, font: 'head', color: COLORS.read, after: 5 },
        { text: d.title, color: COLORS.link, max: 2, after: 0 },
        { text: d.domain, color: COLORS.dim, after: 5 },
        { text: d.excerpt, max: 5 },
      ], col, { accent: COLORS.read, parents: [layout.colLast[col] ?? game.nodes.plan] });
      if (region) game.pageNodes.set(d.id, region);
      break;
    }
    case 'decision':
      game.nodes.decision = layout.centered('decision', [
        { text: d.enough ? 'ENOUGH EVIDENCE' : 'OUT OF BUDGET', font: 'head', color: COLORS.decision, after: 6 },
        { text: d.reason, max: 4 },
        ...(d.gaps ? [{ text: `still uncertain: ${d.gaps}`, color: COLORS.dim, max: 3 }] : []),
      ], { accent: COLORS.decision, parents: layout.leaves.length ? layout.leaves : [game.nodes.plan] });
      break;
    case 'report':
      buildReport(d);
      break;
    case 'done':
      game.busy = false;
      game.status = 'Shoot the claims. Break the answer.';
      break;
    case 'fail':
      game.busy = false;
      game.status = `Agent error: ${d.message}`;
      ui.toast(`AGENT ERROR<br/>${ui.esc(d.message)}`, 'var(--refuted)');
      break;
  }
  settleFloor();
}

function claimRows(claim) {
  const color = COLORS[claim.confidence] ?? COLORS.text;
  return [
    { text: `${claim.id}  ${claim.confidence.toUpperCase()} CONFIDENCE  ${claim.sources.map((s) => `[${s}]`).join('')}`, font: 'head', color, after: 6 },
    { text: claim.text, color: '#ffffff', max: 4 },
    { text: `"${claim.quote}"${claim.quoteVerified ? '' : '  (quote not found in source)'}`, color: COLORS.dim, max: 3 },
  ];
}

// The node a citation should point at: the page if the agent read it, else the search that found it.
function sourceNode(id) {
  return game.pageNodes.get(id) ?? game.searchNodes.get(game.sourceSearch.get(id))?.region ?? null;
}

function buildReport(d) {
  const { layout } = game;
  game.report = d;
  game.nodes.answer = layout.centered('answer', [
    { text: 'DRAFT ANSWER', font: 'head', color: '#ffffff', after: 6 },
    { text: d.title, font: 'head', color: COLORS.search, after: 6 },
    { text: d.answer, max: 6, after: 6 },
    { text: 'Shoot a claim apart to send the fact-checker after it. Claims that survive turn to steel. Hover a claim to see its sources.', color: COLORS.dim },
  ], { accent: '#ffffff', parents: [game.nodes.decision ?? layout.leaves.at(-1) ?? game.nodes.plan] });
  d.claims.forEach((claim, i) => {
    const col = layout.slot(i);
    const accent = COLORS[claim.confidence];
    const region = layout.inColumn('claim', claimRows(claim), col, { accent, data: { claimId: claim.id }, parents: [game.nodes.answer] });
    if (!region) return;
    for (const id of new Set(claim.sources)) {
      const node = sourceNode(id);
      if (node) layout.link(node, region, accent, 'cite');
    }
    game.claims.set(claim.id, { claim, region, col, note: '' });
  });
  document.getElementById('btn-report').disabled = false;
  ui.toast('THE DRAFT HAS LANDED<br/>Break the claims below', COLORS.search);
}

// A fact-check becomes its own node under the claim it attacks.
function addCheckNode(entry, d) {
  const region = game.layout.inColumn('check', [
    { text: `FACT-CHECK ${entry.claim.id}`, font: 'head', color: '#ff6b6b', after: 5 },
    ...(entry.angle ? [{ text: `angle: ${entry.angle}`, color: COLORS.dim, max: 3 }] : []),
    { text: `"${d.query}"`, color: '#ffffff', max: 2, after: 5 },
    ...d.results.map((r) => ({ text: `[${r.id}] ${r.title}`, color: COLORS.link, max: 1, after: 0 })),
  ], entry.col, { accent: '#ff6b6b', parents: [entry.region] });
  if (region) {
    for (const r of d.results) if (!game.pageNodes.has(r.id) && !game.sourceSearch.has(r.id)) game.pageNodes.set(r.id, region);
    entry.checkNode = region;
  }
  settleFloor();
}

function challenge(entry) {
  const { claim } = entry;
  claim.status = 'checking';
  entry.region.locked = true;
  entry.note = 'FACT-CHECKER DEPLOYED';
  ui.toast(`${claim.id} CHALLENGED<br/>The fact-checker is hunting for counter-evidence`, '#ff6b6b');
  listen(`/api/challenge?run=${game.runId}&claim=${claim.id}`, (type, d) => {
    ui.trace(type, d);
    if (type === 'attack') {
      entry.note = `CHECKING: "${d.query}"`;
      entry.angle = d.angle;
    }
    if (type === 'attack_results') {
      entry.note = `READING ${d.results.length} RESULTS`;
      addCheckNode(entry, d);
    }
    if (type === 'verdict') applyVerdict(entry, d);
    if (type === 'points') {
      // Parallel fact-checks can report out of order; totals only ever grow.
      game.points = Math.max(game.points ?? 0, d.total);
      ui.setPoints(game.points);
      setTimeout(() => ui.toast(`+${d.awarded} POINTS<br/>${d.total} total on the leaderboard`, '#ffd23f'), 600);
    }
    if (type === 'fail') {
      claim.status = 'standing';
      entry.region.locked = false;
      entry.note = '';
      ui.toast(`CHECK FAILED<br/>${ui.esc(d.message)}`, 'var(--refuted)');
    }
  });
}

function applyVerdict(entry, v) {
  const { claim } = entry;
  const { layout, particles } = game;
  claim.status = v.verdict;
  claim.check = v;
  entry.note = '';
  const old = entry.region;
  const r = old.rect;
  const debris = (x, y, cr, cg, cb) => {
    if (Math.random() < 0.3 / (K * K)) {
      const a = Math.atan2(y - (r.y + r.h / 2), x - (r.x + r.w / 2));
      particles.add(x, y, Math.cos(a) * (60 + Math.random() * 160), Math.sin(a) * 120 - 120 * Math.random(), `rgb(${cr},${cg},${cb})`, 1.6);
    }
  };
  const header = { upheld: 'UPHELD', weakened: 'WEAKENED', refuted: 'REFUTED' }[v.verdict];
  const color = COLORS[v.verdict];
  const ev = v.evidence.map((e) => `[${e.source}]`).join('');
  if (v.verdict === 'upheld') {
    entry.region = layout.replace(old, 'claim', [
      { text: `${claim.id}  ${header}  ${ev}`, font: 'head', color, after: 6 },
      { text: claim.text, color: '#cfd8ff', max: 4 },
      { text: v.reasoning, color: COLORS.dim, max: 3 },
    ], { accent: color, locked: true, data: { claimId: claim.id } });
    particles.burst(r.x + r.w / 2, r.y + r.h / 2, 80, [color, '#ffffff'], 220, 0.8);
    ui.toast(`${claim.id} UPHELD<br/>It survived the fact-check`, color);
  } else {
    entry.region = layout.replace(old, 'verdict', [
      { text: `${claim.id}  ${header}  ${ev}`, font: 'head', color, after: 6 },
      { text: v.correctedClaim ? `corrected: ${v.correctedClaim}` : v.reasoning, color: '#ffffff', max: 4 },
      ...(v.correctedClaim ? [{ text: v.reasoning, color: COLORS.dim, max: 3 }] : []),
    ], { accent: color, onPixel: debris, data: { claimId: claim.id } });
    game.cam.shake = 10;
    particles.burst(r.x + r.w / 2, r.y + r.h / 2, 120, [color, '#ffffff', '#ffcc4d'], 300, 0.9);
    ui.toast(`${claim.id} ${header}<br/>${ui.esc(v.reasoning.slice(0, 120))}`, color);
  }
  const all = [...game.claims.values()];
  if (all.every((c) => !['standing', 'checking'].includes(c.claim.status))) {
    setTimeout(() => ui.toast('EVERY CLAIM TESTED<br/>Press R for the verified report', '#ffffff'), 1500);
  }
}

// ---------- combat ----------
const WORDS = ['BOOM!', 'POW!', 'BIFF!', 'WHAM!', 'KABOOM!'];

function splash(x, y, n = 18) {
  for (let i = 0; i < n; i++) {
    game.particles.add(x + (Math.random() - 0.5) * 6 * K, y, (Math.random() - 0.5) * 90 * K, -(60 + Math.random() * 140) * K, Math.random() < 0.5 ? '#9fd8ff' : '#e8f6ff', 0.8 + Math.random() * 0.5, Math.round(1.5 * K));
  }
}
function explode(x, y, radius) {
  const { world, particles } = game;
  const hits = world.carve(x, y, radius, (px, py, r, g, b) => {
    if (Math.random() < 0.45 / (K * K)) {
      const a = Math.atan2(py - y, px - x) + (Math.random() - 0.5);
      const s = 40 + Math.random() * 120 + radius * 4;
      particles.add(px, py, Math.cos(a) * s, Math.sin(a) * s - 60, `rgb(${r},${g},${b})`, 0.8 + Math.random());
    }
  });
  particles.burst(x, y, Math.min(40, 4 + radius * 2), ['#ffffff', '#ffe066', '#ff9f43'], 40 + radius * 8, 0.25);
  game.fx.push({ x, y, r: radius, t: 0, word: radius >= 10 * K ? WORDS[Math.floor(Math.random() * WORDS.length)] : null });
  for (let i = 0; i < Math.min(12, radius / K); i++) {
    // smoke puffs drifting up
    particles.add(x + (Math.random() - 0.5) * radius, y + (Math.random() - 0.5) * radius, (Math.random() - 0.5) * 20 * K, -(10 + Math.random() * 25) * K, Math.random() < 0.5 ? '#6b6478' : '#4d4757', 1 + Math.random(), Math.round(3 * K), false);
  }
  game.cam.shake = Math.max(game.cam.shake, radius * 0.35);
  for (const region of hits.keys()) {
    if (region.kind !== 'claim') continue;
    const entry = game.claims.get(region.data.claimId);
    if (entry?.claim.status === 'standing' && region.alive / region.total < CLAIM_BREAK) challenge(entry);
  }
  const p = game.player;
  const dx = p.cx - x;
  const dy = p.y + 8 - y;
  const d = Math.hypot(dx, dy);
  if (radius > 10 * K && d < radius * 2.2) {
    p.vx += (dx / (d || 1)) * 220 * K;
    p.vy += ((dy / (d || 1)) * 260 - 80) * K;
  }
}

function fire(dt) {
  const { player, cam } = game;
  game.cooldown -= dt;
  game.grenadeCooldown -= dt;
  const tx = input.mx / SCALE + cam.x;
  const ty = input.my / SCALE + cam.y;
  player.aim = Math.atan2(ty - player.gunY, tx - player.cx);
  player.face = Math.cos(player.aim) >= 0 ? 1 : -1;
  const ox = player.cx + Math.cos(player.aim) * 8 * K;
  const oy = player.gunY + Math.sin(player.aim) * 8 * K;
  if (input.fire && game.cooldown <= 0) {
    const w = WEAPONS[game.weapon];
    game.cooldown = 1 / w.rate;
    for (let i = 0; i < w.pellets; i++) {
      const a = player.aim + (Math.random() - 0.5) * 2 * w.spread;
      const s = w.speed * (w.pellets > 1 ? 0.85 + Math.random() * 0.3 : 1);
      game.projectiles.push(new Projectile(ox, oy, Math.cos(a) * s, Math.sin(a) * s, w));
    }
    game.particles.burst(ox, oy, 3, [w.color, '#ffffff'], 60, 0.08);
    if (w.rocket || w.pellets > 1) player.vx -= Math.cos(player.aim) * 60 * K;
  }
  if (input.grenade && game.grenadeCooldown <= 0) {
    input.grenade = false;
    game.grenadeCooldown = 0.45;
    game.grenades.push(new Grenade(ox, oy, Math.cos(player.aim) * 320 * K + player.vx * 0.5, (Math.sin(player.aim) * 320 - 60) * K));
  }
}

function update(dt) {
  const { world, player, particles } = game;
  game.t += dt;
  player.update(dt, input, world);
  fire(dt);

  for (const p of game.projectiles) {
    const steps = Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2);
    for (let i = 0; i < steps && p.life > 0; i++) {
      p.x += (p.vx * dt) / steps;
      p.y += (p.vy * dt) / steps;
      if (p.y >= world.floorY) {
        splash(p.x, world.floorY, 8);
        p.life = 0;
      } else if (world.isSolid(p.x, p.y)) {
        explode(p.x, p.y, p.weapon.radius);
        p.life = 0;
      }
    }
    p.life -= dt;
    if (p.weapon.rocket && Math.random() < 0.8) particles.add(p.x, p.y, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, Math.random() < 0.3 ? '#ffb347' : '#8d8799', 0.5, Math.round(2 * K), false);
    if (p.x < -50 || p.x > world.w + 50 || p.y < game.cam.y - 400 || p.y > world.floorY + 50) p.life = 0;
  }
  game.projectiles = game.projectiles.filter((p) => p.life > 0);

  for (const g of game.grenades) {
    g.update(dt, world);
    if (g.sunk) {
      splash(g.x, world.floorY, 10);
      g.fuse = 0;
    } else if (g.fuse <= 0) explode(g.x, g.y, g.radius);
  }
  game.grenades = game.grenades.filter((g) => g.fuse > 0);
  for (const f of game.fx) f.t += dt;
  game.fx = game.fx.filter((f) => f.t < 0.9);
  particles.update(dt, world);

  // Camera: follow the player, peek toward the cursor.
  const cam = game.cam;
  const pw = playWidth();
  const tx = player.cx - pw / 2 + (input.mx / SCALE - pw / 2) * 0.2;
  const ty = player.y - vh * 0.45 + (input.my / SCALE - vh / 2) * 0.2;
  cam.x += (tx - cam.x) * Math.min(1, dt * 6);
  cam.y += (ty - cam.y) * Math.min(1, dt * 6);
  cam.x = world.w <= pw ? (world.w - pw) / 2 : Math.max(0, Math.min(world.w - pw, cam.x));
  cam.y = Math.max(-80, Math.min(world.floorY + 50 - vh, cam.y));
  cam.shake *= Math.pow(0.002, dt);

  // Into the water: splash, then back to the last solid ground.
  if (player.y + player.h * 0.6 > world.floorY) {
    splash(player.cx, world.floorY, 30);
    const safe = player.safe.y < world.floorY - player.h ? player.safe : { x: world.w / 2, y: -40 * K };
    Object.assign(player, { x: safe.x, y: safe.y - 4 * K, vx: 0, vy: 0 });
    ui.toast('SPLASH!<br/>Back to dry land', '#6ec6ff');
  }
}

// ---------- rendering ----------
const SKY = (() => {
  const r = (n) => {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    stars: Array.from({ length: 140 }, (_, i) => ({ x: r(i), y: r(i + 500), s: r(i + 900) < 0.15 ? 2 : 1, tw: r(i + 1300) * 6 })),
    clouds: Array.from({ length: 7 }, (_, i) => ({ x: r(i + 2000), y: 0.08 + r(i + 2100) * 0.4, w: 40 + r(i + 2200) * 70, speed: 3 + r(i + 2300) * 6 })),
  };
})();

// Worms-style backdrop: dusk gradient, twinkling stars, drifting clouds, parallax hills.
function drawSky(sx, sy) {
  const g = ctx.createLinearGradient(0, 0, 0, vh);
  g.addColorStop(0, '#0e1230');
  g.addColorStop(0.55, '#2a2a5c');
  g.addColorStop(1, '#5a3d6e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, vw, vh);
  for (const st of SKY.stars) {
    ctx.globalAlpha = 0.4 + 0.4 * Math.sin(game.t * 1.5 + st.tw);
    ctx.fillStyle = '#ffffff';
    const x = (((st.x * vw * 1.5 - sx * 0.05) % vw) + vw) % vw;
    ctx.fillRect(Math.round(x), Math.round(st.y * vh * 0.7), st.s * K * 0.5 + 0.5, st.s * K * 0.5 + 0.5);
  }
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#d8d0ff';
  for (const c of SKY.clouds) {
    const w = c.w * K;
    const span = vw + w * 2;
    const x = ((((c.x * span + game.t * c.speed * K - sx * 0.15) % span) + span) % span) - w;
    const y = c.y * vh;
    for (let k = 0; k < 4; k++) ctx.fillRect(Math.round(x + k * w * 0.18), Math.round(y - k * 3 * K * (k % 2)), Math.round(w * (1 - k * 0.18)), Math.round(8 * K));
  }
  ctx.globalAlpha = 1;
  hills(sx * 0.12, vh * 0.72, 46 * K, '#231f47', 1);
  hills(sx * 0.25, vh * 0.82, 34 * K, '#1a1636', 2);
}

function hills(offset, base, amp, color, seed) {
  ctx.fillStyle = color;
  const step = Math.max(2, Math.round(2 * K));
  for (let x = 0; x < vw; x += step) {
    const u = (x + offset) / (60 * K);
    const h = Math.sin(u + seed) * 0.6 + Math.sin(u * 2.3 + seed * 3) * 0.3 + Math.sin(u * 5.1) * 0.1;
    const top = Math.round(base - amp * (0.5 + h / 2));
    ctx.fillRect(x, top, step, vh - top);
  }
}

// Animated water at the bottom of the level, with the agent's status written on it.
function drawWater(fy, sx) {
  if (fy > vh + 10) return;
  const t = game.t;
  const layers = [
    ['#1d3f78', 0, 1.4],
    ['#2a5aa0', 4 * K, 1],
    ['#3a78c2', 9 * K, 0.7],
  ];
  for (const [color, dy, speed] of layers) {
    ctx.fillStyle = color;
    const step = Math.max(2, Math.round(2 * K));
    for (let x = 0; x < vw; x += step) {
      const wave = Math.sin((x + sx) / (14 * K) + t * 2 * speed) * 2.5 * K + Math.sin((x + sx) / (5 * K) - t * 3 * speed) * K;
      const top = Math.round(fy + dy + wave);
      ctx.fillRect(x, top, step, vh - top + 4);
    }
  }
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#cfeaff';
  for (let x = ((-sx * 1.2 + t * 20 * K) % (24 * K)) - 24 * K; x < vw; x += 24 * K) {
    ctx.fillRect(Math.round(x), Math.round(fy + 2 * K + Math.sin(x * 0.1 + t * 3) * 2 * K), Math.round(6 * K), Math.max(1, Math.round(K / 2)));
  }
  ctx.globalAlpha = 1;
  ctx.font = FONTS.head;
  ctx.textBaseline = 'top';
  const label = game.busy ? `~ ${game.status} ~` : '~ END OF RESULTS ~';
  const tw = ctx.measureText(label).width;
  outlined(label, Math.max(4, playWidth() / 2 - tw / 2), fy - 16 * K, game.busy ? "#ffe066" : "#cfe3ff");
}

function outlined(text, x, y, color, maxW) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, Math.round(2.5 * K));
  ctx.strokeStyle = '#120c1e';
  ctx.strokeText(text, x, y, maxW);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y, maxW);
}

function nameTag(text, cx, y, color) {
  ctx.font = `${Math.round(6 * K)}px "Press Start 2P"`;
  ctx.textBaseline = 'bottom';
  const tw = ctx.measureText(text).width;
  outlined(text, Math.round(cx - tw / 2), Math.round(y), color);
  ctx.textBaseline = 'top';
}

// Missiles with smoke, Worms-style grenades with a fuse countdown, and bullets.
function drawProjectiles(sx, sy) {
  for (const p of game.projectiles) {
    const x = p.x - sx;
    const y = p.y - sy;
    if (p.weapon.rocket) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(p.vy, p.vx));
      ctx.scale(K, K);
      ctx.fillStyle = '#c9ccd6';
      ctx.fillRect(-5, -1.5, 7, 3);
      ctx.fillStyle = '#e63946';
      ctx.fillRect(2, -1.5, 2, 3);
      ctx.fillRect(-6, -2.5, 2, 5);
      ctx.restore();
    } else {
      ctx.fillStyle = p.weapon.color;
      ctx.fillRect(Math.round(x - K / 2), Math.round(y - K / 2), Math.max(2, Math.round(1.5 * K)), Math.max(2, Math.round(1.5 * K)));
    }
  }
  for (const g of game.grenades) {
    const x = g.x - sx;
    const y = g.y - sy;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(K, K);
    ctx.fillStyle = '#3f7a36';
    ctx.beginPath();
    ctx.ellipse(0, 0, 2.6, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#26491f';
    ctx.fillRect(-2.6, -0.4, 5.2, 0.8);
    ctx.fillStyle = '#9aa0ab';
    ctx.fillRect(-1, -4.2, 2, 1.4);
    ctx.restore();
    nameTag(String(Math.max(1, Math.ceil(g.fuse))), x, y - 6 * K, g.fuse < 0.6 ? '#ff4d6d' : '#ffffff');
  }
}

// Explosion flash rings and comic words.
function drawFx(sx, sy) {
  for (const f of game.fx) {
    const x = f.x - sx;
    const y = f.y - sy;
    if (f.t < 0.25) {
      const k = f.t / 0.25;
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = k < 0.3 ? '#ffffff' : k < 0.6 ? '#ffe066' : '#ff9f43';
      ctx.beginPath();
      ctx.arc(x, y, f.r * (0.7 + k * 0.9), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (f.word) {
      const pop = Math.min(1, f.t / 0.12);
      const size = Math.round(10 * K * (0.6 + 0.6 * pop));
      ctx.font = `${size}px "Press Start 2P"`;
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = f.t > 0.6 ? 1 - (f.t - 0.6) / 0.3 : 1;
      const tw = ctx.measureText(f.word).width;
      outlined(f.word, x - tw / 2, y - f.r - 8 * K - f.t * 20 * K, '#ffd23f');
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'top';
    }
  }
}

// Flow edges are elbow connectors from a parent's bottom to a child's top;
// citation edges are dashed curves from a claim up to the sources it cites.
function drawEdges(layout, sx, sy, now, hover, lit) {
  ctx.lineWidth = 1;
  for (const e of layout.edges) {
    const a = e.from.rect;
    const b = e.to.rect;
    if (Math.max(a.y + a.h, b.y + b.h) - sy < 0 || Math.min(a.y, b.y) - sy > vh) continue;
    const grow = Math.min(1, (now - e.born) / 500);
    const ax = Math.round(a.x + a.w / 2 - sx) + 0.5;
    const ay = Math.round(a.y + a.h - sy);
    const bx = Math.round(b.x + b.w / 2 - sx) + 0.5;
    const by = Math.round(b.y - sy);
    ctx.strokeStyle = e.color;
    if (e.kind === 'cite') {
      const on = hover && e.to === hover;
      if (on) lit.add(e.from);
      ctx.globalAlpha = (on ? 0.95 : 0.13) * grow;
      ctx.setLineDash([4 * K, 3 * K]);
      ctx.lineDashOffset = on ? -game.t * 30 * K : 0;
      const bend = Math.min(140 * K, (by - ay) / 2);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.bezierCurveTo(bx, by - bend, ax, ay + bend, ax, ay);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const my = Math.round(by - Math.min((by - ay) / 2, layout.gap / 2)) + 0.5;
      ctx.globalAlpha = 0.85 * grow;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax, my);
      ctx.lineTo(bx, my);
      ctx.lineTo(bx, by - 3 * K);
      ctx.lineWidth = Math.max(2, 2 * K);
      ctx.strokeStyle = '#120c1e';
      ctx.stroke();
      ctx.lineWidth = Math.max(1, K);
      ctx.strokeStyle = e.color;
      ctx.stroke();
      // arrowhead
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.moveTo(bx - 3 * K, by - 4 * K);
      ctx.lineTo(bx + 3 * K, by - 4 * K);
      ctx.lineTo(bx, by);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function render() {
  const { world, cam } = game;
  const sx = Math.round(cam.x + (Math.random() - 0.5) * cam.shake);
  const sy = Math.round(cam.y + (Math.random() - 0.5) * cam.shake);
  const view = { x: sx, y: sy };

  drawSky(sx, sy);

  const now = performance.now();
  // Hovering a claim lights up its citation lines and the source nodes they reach.
  const mxw = input.mx / SCALE + sx;
  const myw = input.my / SCALE + sy;
  let hover = null;
  for (const e of game.claims.values()) {
    const r = e.region.rect;
    if (mxw >= r.x && mxw <= r.x + r.w && myw >= r.y && myw <= r.y + r.h) hover = e.region;
  }
  const lit = new Set();
  drawEdges(game.layout, sx, sy, now, hover, lit);

  // card frames (decor, not solid)
  for (const region of world.decor) {
    const r = region.rect;
    if (r.y - sy > vh || r.y + r.h - sy < 0) continue;
    const x = r.x - sx;
    const y = r.y - sy;
    const { accent, born } = region.decor;
    const fresh = Math.max(0, 1 - (now - born) / 700);
    const entry = region.kind === 'claim' || region.kind === 'verdict' ? game.claims.get(region.data.claimId) : null;
    const checking = entry?.claim.status === 'checking';
    // Translucent backing panel so the text reads against the sky; lines pass faintly behind it.
    ctx.fillStyle = checking ? 'rgba(60, 14, 30, 0.72)' : 'rgba(12, 10, 32, 0.72)';
    ctx.fillRect(x, y, r.w, r.h);
    ctx.globalAlpha = checking ? 0.6 + 0.4 * Math.sin(game.t * 10) : lit.has(region) ? 1 : 0.4 + fresh * 0.6;
    ctx.strokeStyle = checking ? '#ff6b6b' : accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, r.w - 1, r.h - 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = checking ? '#ff6b6b' : accent;
    ctx.fillRect(x, y, Math.max(2, K), r.h);
    if (region.kind === 'claim' && entry?.claim.status === 'standing' && region.alive < region.total) {
      // integrity bar: empties toward the break point
      const hp = Math.max(0, (region.alive / region.total - CLAIM_BREAK) / (1 - CLAIM_BREAK));
      ctx.fillStyle = '#00000080';
      ctx.fillRect(x + r.w - 54, y + 4, 48, 4);
      ctx.fillStyle = hp > 0.5 ? COLORS.high : hp > 0.25 ? COLORS.medium : COLORS.refuted;
      ctx.fillRect(x + r.w - 54, y + 4, Math.ceil(48 * hp), 4);
    }
    if (region.locked && entry?.claim.status === 'upheld') {
      // a glint sweeping across the steel
      const gx = x + ((game.t * 120 * K) % (r.w + 80 * K)) - 40 * K;
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.max(x, gx), y, Math.max(0, Math.min(8 * K, x + r.w - gx)), r.h);
      ctx.globalAlpha = 1;
    }
  }

  // terrain
  const cx0 = Math.max(0, sx);
  const cy0 = Math.max(0, sy);
  const cw = Math.min(world.w, sx + vw) - cx0;
  const ch = Math.min(world.h, sy + vh) - cy0;
  if (cw > 0 && ch > 0) ctx.drawImage(world.canvas, cx0, cy0, cw, ch, cx0 - sx, cy0 - sy, cw, ch);

  // claim notes while the fact-checker works
  ctx.font = FONTS.head;
  ctx.textBaseline = 'top';
  for (const entry of game.claims.values()) {
    if (!entry.note) continue;
    const r = entry.region.rect;
    const text = entry.note.length > 60 ? `${entry.note.slice(0, 59)}…` : entry.note;
    const w = Math.min(r.w - 8, ctx.measureText(text).width + 8);
    ctx.fillStyle = '#000000d0';
    ctx.fillRect(r.x + r.w - w - 4 - sx, r.y - 7 - sy, w, 12);
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText(text, r.x + r.w - w - sx, r.y - 5 - sy, w - 8);
  }

  drawProjectiles(sx, sy);
  drawWater(world.floorY - sy, sx);
  game.particles.draw(ctx, view);
  game.player.draw(ctx, view, game.t);
  nameTag('YOU', game.player.cx - sx, game.player.y - sy - 6 * K, '#ff8fb1');
  drawFx(sx, sy);

  // crosshair
  const mx = Math.round(input.mx / SCALE);
  const my = Math.round(input.my / SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(mx - 4, my, 3, 1);
  ctx.fillRect(mx + 2, my, 3, 1);
  ctx.fillRect(mx, my - 4, 1, 3);
  ctx.fillRect(mx, my + 2, 1, 3);
}

let last = 0;
let hudTimer = 0;
function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  if (!paused) update(dt);
  render();
  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.1;
    const counts = { total: game.claims.size, standing: 0, checking: 0, upheld: 0, weakened: 0, refuted: 0 };
    for (const { claim } of game.claims.values()) counts[claim.status]++;
    ui.setScore(game.world.percent, counts);
    ui.setStatus(game.status, game.busy || counts.checking > 0);
    ui.setWeapons(WEAPONS, game.weapon, game.player.fuel);
  }
  requestAnimationFrame(frame);
}

// Back to the start screen. The page reload also closes the agent streams,
// which aborts any research still running on the server.
function newSearch() {
  location.href = location.pathname + (forceDemo ? '?demo=1' : '');
}

// ---------- input ----------
const KEYS = {
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  KeyW: 'jump', ArrowUp: 'jump', Space: 'jump', KeyS: 'down', ArrowDown: 'down',
};

function openReport() {
  if (!game) return;
  ui.renderReport({
    report: game.report,
    claims: [...game.claims.values()].map((e) => e.claim),
    runId: game.runId,
    question: game.question,
    mode: game.mode,
    model: game.model,
  });
  document.getElementById('report').hidden = false;
  document.getElementById('pause').hidden = true;
  paused = true;
}

function closeOverlays() {
  document.getElementById('report').hidden = true;
  document.getElementById('leaderboard').hidden = true;
  document.getElementById('pause').hidden = true;
  paused = false;
}

addEventListener('keydown', (e) => {
  if (!game || e.target.tagName === 'INPUT') return;
  if (KEYS[e.code]) {
    input[KEYS[e.code]] = true;
    e.preventDefault();
  }
  if (e.code === 'Escape') {
    if (paused) closeOverlays();
    else {
      paused = true;
      document.getElementById('pause').hidden = false;
    }
  }
  if (/^Digit[1-4]$/.test(e.code)) game.weapon = Number(e.code.slice(5)) - 1;
  if (e.code === 'KeyT') ui.toggleTrace();
  if (e.code === 'KeyN') newSearch();
  if (e.code === 'KeyL') {
    if (document.getElementById('leaderboard').hidden) openLeaderboard();
    else closeOverlays();
  }
  if (e.code === 'KeyR') {
    if (document.getElementById('report').hidden) openReport();
    else closeOverlays();
  }
});
addEventListener('keyup', (e) => {
  if (KEYS[e.code]) input[KEYS[e.code]] = false;
});
addEventListener('blur', () => Object.assign(input, { left: false, right: false, jump: false, down: false, fire: false }));
canvas.addEventListener('mousemove', (e) => {
  input.mx = e.clientX;
  input.my = e.clientY;
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) input.fire = true;
  if (e.button === 2) input.grenade = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) input.fire = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  if (!game) return;
  game.weapon = (game.weapon + (e.deltaY > 0 ? 1 : -1) + WEAPONS.length) % WEAPONS.length;
});

document.getElementById('btn-new').onclick = newSearch;
document.getElementById('btn-leaderboard').onclick = openLeaderboard;
document.getElementById('btn-leaderboard-start').onclick = openLeaderboard;
document.querySelector('[data-close="leaderboard"]').onclick = () => {
  if (game) closeOverlays();
  else document.getElementById('leaderboard').hidden = true;
};
document.getElementById('btn-trace').onclick = () => ui.toggleTrace();
document.getElementById('report').addEventListener('click', (e) => {
  if (e.target.dataset?.action === 'new') newSearch();
});
document.getElementById('btn-report').onclick = openReport;
document.querySelector('[data-close="report"]').onclick = closeOverlays;
document.getElementById('pause').addEventListener('click', (e) => {
  const action = e.target.dataset?.action;
  if (action === 'resume') closeOverlays();
  if (action === 'report') openReport();
  if (action === 'new') newSearch();
});

// Debug handle for automated testing from the console.
window.searchShooter = { get game() { return game; }, input, explode: (x, y, r) => explode(x, y, r), step: (dt, n = 1) => { for (let i = 0; i < n; i++) update(dt); render(); } };

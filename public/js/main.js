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
  const W = Math.round(Math.max(480 * K, Math.min(playWidth(), 1100 * K)));
  const world = new World(W, Math.round(Math.max(9000, 6000 * K)));
  const layout = new Layout(world);
  layout.place('hero', [
    { text: 'QUESTION', font: 'head', color: COLORS.dim, after: 6 },
    { text: question, font: 'big', color: COLORS.hero },
  ], { full: true, accent: '#ffffff' });
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
    weapon: 0,
    cooldown: 0,
    grenadeCooldown: 0,
    claims: new Map(), // claimId -> { claim, region, note }
    pendingReasons: new Map(),
    status: 'Booting agent',
    busy: true,
    runId: null,
    report: null,
    t: 0,
  };
  connectResearch(question);
  last = performance.now();
  requestAnimationFrame(frame);
}

// ---------- server events ----------
const EVENTS = ['run', 'status', 'plan', 'thinking', 'thought', 'search', 'results', 'read', 'page', 'read_failed', 'tool_error', 'decision', 'claim', 'report', 'challenge', 'attack', 'attack_results', 'verdict', 'done', 'fail'];

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
  const url = `/api/research?q=${encodeURIComponent(question)}${forceDemo ? '&demo=1' : ''}`;
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
      layout.place('plan', [
        { text: 'PLAN', font: 'head', color: COLORS.plan, after: 6 },
        ...d.subquestions.map((q, i) => ({ text: `${i + 1}. ${q}` })),
        ...(d.strategy ? [{ space: 3 }, { text: `strategy: ${d.strategy}`, color: COLORS.dim, max: 3 }] : []),
      ], { full: true, accent: COLORS.plan });
      game.status = 'Plan ready, searching';
      break;
    case 'search':
      game.pendingReasons.set(d.searchId, d.reason);
      game.status = `Searching: ${d.query}`;
      break;
    case 'results':
      layout.place('search', [
        { text: `SEARCH #${d.searchId}`, font: 'head', color: COLORS.search, after: 5 },
        { text: `"${d.query}"`, color: '#ffffff', max: 2 },
        { text: `why: ${game.pendingReasons.get(d.searchId) ?? ''}`, color: COLORS.dim, max: 2, after: 6 },
        ...d.results.flatMap((r) => [
          { text: `[${r.id}] ${r.title}`, color: COLORS.link, max: 2, after: 0 },
          { text: r.domain, color: COLORS.dim, after: 0 },
          { text: r.snippet, max: 2, after: 6 },
        ]),
      ], { accent: COLORS.search });
      break;
    case 'read':
      game.status = `Reading ${d.ids.map((i) => `[${i}]`).join(' ')}`;
      break;
    case 'page':
      layout.place('page', [
        { text: `READ [${d.id}]`, font: 'head', color: COLORS.read, after: 5 },
        { text: d.title, color: COLORS.link, max: 2, after: 0 },
        { text: d.domain, color: COLORS.dim, after: 5 },
        { text: d.excerpt, max: 7 },
      ], { accent: COLORS.read });
      break;
    case 'decision':
      layout.place('decision', [
        { text: d.enough ? 'ENOUGH EVIDENCE' : 'OUT OF BUDGET', font: 'head', color: COLORS.decision, after: 6 },
        { text: d.reason, max: 4 },
        ...(d.gaps ? [{ text: `still uncertain: ${d.gaps}`, color: COLORS.dim, max: 3 }] : []),
      ], { full: true, accent: COLORS.decision });
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

function buildReport(d) {
  const { layout } = game;
  game.report = d;
  layout.place('answer', [
    { text: 'DRAFT ANSWER', font: 'head', color: '#ffffff', after: 6 },
    { text: d.title, font: 'head', color: COLORS.search, after: 6 },
    { text: d.answer, max: 6, after: 6 },
    { text: 'Shoot a claim apart to send the fact-checker after it. Claims that survive turn to steel.', color: COLORS.dim },
  ], { full: true, accent: '#ffffff' });
  for (const claim of d.claims) {
    const region = layout.place('claim', claimRows(claim), { accent: COLORS[claim.confidence], data: { claimId: claim.id } });
    if (!region) continue;
    game.claims.set(claim.id, { claim, region, note: '' });
  }
  document.getElementById('btn-report').disabled = false;
  ui.toast('THE DRAFT HAS LANDED<br/>Break the claims below', COLORS.search);
}

function challenge(entry) {
  const { claim } = entry;
  claim.status = 'checking';
  entry.region.locked = true;
  entry.note = 'FACT-CHECKER DEPLOYED';
  ui.toast(`${claim.id} CHALLENGED<br/>The fact-checker is hunting for counter-evidence`, '#ff6b6b');
  listen(`/api/challenge?run=${game.runId}&claim=${claim.id}`, (type, d) => {
    ui.trace(type, d);
    if (type === 'attack') entry.note = `CHECKING: "${d.query}"`;
    if (type === 'attack_results') entry.note = `READING ${d.results.length} RESULTS`;
    if (type === 'verdict') applyVerdict(entry, d);
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
  if (radius > 10 && d < radius * 2.2) {
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
      if (world.isSolid(p.x, p.y)) {
        explode(p.x, p.y, p.weapon.radius);
        p.life = 0;
      }
    }
    p.life -= dt;
    if (p.weapon.rocket && Math.random() < 0.8) particles.add(p.x, p.y, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, Math.random() < 0.5 ? '#ffb347' : '#8a90a6', 0.4, 1, false);
    if (p.x < -50 || p.x > world.w + 50 || p.y < game.cam.y - 400 || p.y > world.floorY + 50) p.life = 0;
  }
  game.projectiles = game.projectiles.filter((p) => p.life > 0);

  for (const g of game.grenades) {
    g.update(dt, world);
    if (g.fuse <= 0) explode(g.x, g.y, g.radius);
  }
  game.grenades = game.grenades.filter((g) => g.fuse > 0);
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

  if (player.y > world.floorY + 200) {
    player.y = world.floorY - 40;
    player.vy = 0;
  }
}

// ---------- rendering ----------
function render() {
  const { world, cam } = game;
  const sx = Math.round(cam.x + (Math.random() - 0.5) * cam.shake);
  const sy = Math.round(cam.y + (Math.random() - 0.5) * cam.shake);
  const view = { x: sx, y: sy };

  ctx.fillStyle = '#0a0c12';
  ctx.fillRect(0, 0, vw, vh);
  // the "page"
  ctx.fillStyle = '#0f121b';
  ctx.fillRect(-sx, -sy - 200, world.w, world.floorY + 200);
  ctx.fillStyle = '#151a27';
  const gx = ((-sx % 16) + 16) % 16;
  const gy = ((-sy % 16) + 16) % 16;
  for (let x = gx; x < vw; x += 16) ctx.fillRect(x, 0, 1, vh);
  for (let y = gy; y < vh; y += 16) ctx.fillRect(0, y, vw, 1);

  // card frames (decor, not solid)
  const now = performance.now();
  for (const region of world.decor) {
    const r = region.rect;
    if (r.y - sy > vh || r.y + r.h - sy < 0) continue;
    const x = r.x - sx;
    const y = r.y - sy;
    const { accent, born } = region.decor;
    const fresh = Math.max(0, 1 - (now - born) / 700);
    const entry = region.kind === 'claim' || region.kind === 'verdict' ? game.claims.get(region.data.claimId) : null;
    const checking = entry?.claim.status === 'checking';
    ctx.fillStyle = checking ? '#ff6b6b14' : '#ffffff08';
    ctx.fillRect(x, y, r.w, r.h);
    ctx.globalAlpha = checking ? 0.6 + 0.4 * Math.sin(game.t * 10) : 0.35 + fresh * 0.65;
    ctx.strokeStyle = checking ? '#ff6b6b' : accent;
    ctx.strokeRect(x + 0.5, y + 0.5, r.w - 1, r.h - 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = checking ? '#ff6b6b' : accent;
    ctx.fillRect(x, y, 2, r.h);
    if (region.kind === 'claim' && entry?.claim.status === 'standing' && region.alive < region.total) {
      // integrity bar: empties toward the break point
      const hp = Math.max(0, (region.alive / region.total - CLAIM_BREAK) / (1 - CLAIM_BREAK));
      ctx.fillStyle = '#00000080';
      ctx.fillRect(x + r.w - 54, y + 4, 48, 4);
      ctx.fillStyle = hp > 0.5 ? COLORS.high : hp > 0.25 ? COLORS.medium : COLORS.refuted;
      ctx.fillRect(x + r.w - 54, y + 4, Math.ceil(48 * hp), 4);
    }
    if (region.locked && entry?.claim.status === 'upheld') {
      ctx.globalAlpha = 0.15 + 0.1 * Math.sin(game.t * 3);
      ctx.fillStyle = COLORS.upheld;
      ctx.fillRect(x, y, r.w, r.h);
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

  // loading floor under the newest content
  const fy = world.floorY - sy;
  if (fy < vh + 10) {
    ctx.fillStyle = '#07080c';
    ctx.fillRect(-sx, fy, world.w, vh - fy + 20);
    ctx.fillStyle = game.busy ? COLORS.search : '#3a4058';
    for (let x = -sx; x < world.w - sx; x += 8) ctx.fillRect(x + ((game.busy ? game.t * 30 : 0) % 8), fy, 4, 2);
    ctx.fillStyle = game.busy ? COLORS.search : COLORS.dim;
    const label = game.busy ? `▼ ${game.status}` : '▲ END OF RESULTS';
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, Math.max(4, world.w / 2 - tw / 2 - sx), fy + 10, vw - 8);
  }

  for (const g of game.grenades) {
    ctx.fillStyle = g.fuse < 0.5 && Math.floor(game.t * 16) % 2 ? '#ff4d6d' : '#9ef07c';
    ctx.fillRect(Math.round(g.x - sx) - 1, Math.round(g.y - sy) - 1, 3, 3);
  }
  for (const p of game.projectiles) {
    ctx.fillStyle = p.weapon.color;
    const sz = p.weapon.rocket ? 3 : 2;
    ctx.fillRect(Math.round(p.x - sx) - 1, Math.round(p.y - sy) - 1, sz, sz);
  }
  game.particles.draw(ctx, view);
  game.player.draw(ctx, view, game.t);

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

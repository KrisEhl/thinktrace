// Turns agent events into level geometry: every card is stamped into the
// destructible world as solid pixel text you can stand on and shoot.
import { K } from './scale.js';

// Sizes grow with K so text keeps its on-screen size but gains resolution.
export const FONTS = {
  big: `${Math.round(24 * K)}px VT323`,
  head: `${Math.round(8 * K)}px "Press Start 2P"`,
  body: `${Math.round(12 * K)}px VT323`,
};
const LINE = { big: Math.round(20 * K), head: Math.round(12 * K), body: Math.round(11 * K) };

export const COLORS = {
  plan: '#b4f06c',
  search: '#ffcc4d',
  read: '#6ee7ff',
  decision: '#c792ff',
  hero: '#ffffff',
  text: '#d8dbe6',
  dim: '#8a90a6',
  link: '#8fb3ff',
  high: '#6ee7a0',
  medium: '#ffd166',
  low: '#ff8f6b',
  upheld: '#ffd700',
  weakened: '#ff9f43',
  refuted: '#ff4d6d',
};

const measureCtx = document.createElement('canvas').getContext('2d');

function wrap(text, font, maxW) {
  measureCtx.font = font;
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measureCtx.measureText(next).width <= maxW || !line) {
        line = next;
        // Hard-break absurdly long tokens (URLs).
        while (measureCtx.measureText(line).width > maxW && line.length > 4) {
          let cut = line.length - 1;
          while (cut > 1 && measureCtx.measureText(line.slice(0, cut)).width > maxW) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// Graph layout. The level reads top-down like a flow chart:
//   question -> plan -> searches fanning out side by side -> pages read under
//   the search that found them -> decision -> answer -> claims -> fact-checks.
// Nodes are stamped as destructible text; `edges` are drawn between them as
// non-solid connector lines (flow edges) and citation lines (claim -> source).
export class Layout {
  constructor(world) {
    this.world = world;
    this.m = Math.round(14 * K);
    this.pad = Math.round(7 * K);
    this.gap = Math.round(30 * K); // between layers
    this.stackGap = Math.round(16 * K); // between nodes in one column
    this.colGap = Math.round(22 * K);
    this.nodeW = Math.round(230 * K);
    this.wideW = Math.min(world.w - 2 * this.m, Math.round(620 * K));
    this.ncol = Math.max(1, Math.floor((world.w - 2 * this.m + this.colGap) / (this.nodeW + this.colGap)));
    const span = this.ncol * this.nodeW + (this.ncol - 1) * this.colGap;
    this.left = Math.round((world.w - span) / 2);
    // Fill columns from the middle outward so a few searches still look balanced.
    const mid = (this.ncol - 1) / 2;
    this.order = [...Array(this.ncol).keys()].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
    this.y = 0;
    this.edges = [];
    this.resetColumns();
  }

  resetColumns() {
    this.rowTop = null;
    this.colBottom = Array(this.ncol).fill(null);
    this.colLast = Array(this.ncol).fill(null);
  }

  get bottom() {
    return Math.max(this.y, ...this.colBottom.map((b) => b ?? 0));
  }

  slot(i) {
    return this.order[i % this.ncol];
  }

  // rows: [{ text, font: 'head'|'body'|'big', color, max: maxLines }]
  build(rows, width, maxH = Infinity) {
    const lines = [];
    let y = 0;
    for (const row of rows) {
      if (row.space) {
        y += row.space;
        continue;
      }
      const font = FONTS[row.font ?? 'body'];
      let wrapped = wrap(row.text, font, width - (row.indent ?? 0));
      if (row.max && wrapped.length > row.max) {
        wrapped = wrapped.slice(0, row.max);
        wrapped[wrapped.length - 1] += '…';
      }
      for (const text of wrapped) {
        if (y + LINE[row.font ?? 'body'] > maxH) return { lines, h: y };
        lines.push({ text, font, color: row.color ?? COLORS.text, x: row.indent ?? 0, y });
        y += LINE[row.font ?? 'body'];
      }
      y += row.after ?? 2;
    }
    return { lines, h: y };
  }

  paint(region, lines) {
    this.world.stamp(region, (ctx) => {
      for (const l of lines) {
        ctx.font = l.font;
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, this.pad + l.x, this.pad + l.y);
      }
    });
  }

  node(kind, rows, x, y, width, { accent = COLORS.text, data = {}, tag, parents = [] } = {}) {
    const { lines, h } = this.build(rows, width - 2 * this.pad);
    const rect = { x, y, w: width, h: Math.ceil(h + 2 * this.pad) };
    if (rect.y + rect.h > this.world.h - 80 * K) return null;
    const region = this.world.addRegion(kind, rect, data);
    region.decor = { accent, tag, born: performance.now() };
    this.world.decor.push(region);
    this.paint(region, lines);
    for (const parent of parents) if (parent) this.link(parent, region, accent);
    return region;
  }

  link(from, to, color, kind = 'flow') {
    this.edges.push({ from, to, color, kind, born: performance.now() });
  }

  // A full-width-ish node centred under everything placed so far. Ends the current column row.
  centered(kind, rows, opts = {}) {
    const width = opts.width ?? this.wideW;
    const y = this.bottom + this.gap;
    const region = this.node(kind, rows, Math.round((this.world.w - width) / 2), y, width, opts);
    if (region) this.y = region.rect.y + region.rect.h;
    this.resetColumns();
    return region;
  }

  // A node in column `col`, stacked under whatever that column already holds.
  inColumn(kind, rows, col, opts = {}) {
    if (this.rowTop == null) this.rowTop = this.y + this.gap;
    const y = this.colBottom[col] == null ? this.rowTop : this.colBottom[col] + this.stackGap;
    const x = this.left + col * (this.nodeW + this.colGap);
    const region = this.node(kind, rows, x, y, this.nodeW, opts);
    if (region) {
      this.colBottom[col] = region.rect.y + region.rect.h;
      this.colLast[col] = region;
    }
    return region;
  }

  // Last node of every column in use (the leaves a following centred node joins).
  get leaves() {
    return this.colLast.filter(Boolean);
  }

  // Swap a region's content in place (used when a claim gets its verdict).
  replace(old, kind, rows, { accent, data = {}, tag, locked = false, onPixel } = {}) {
    const w = this.world;
    w.clearRegion(old, onPixel, Boolean(onPixel));
    old.dead = true;
    const { lines } = this.build(rows, old.rect.w - 2 * this.pad, old.rect.h - 2 * this.pad);
    const region = w.addRegion(kind, { ...old.rect }, data);
    region.decor = { accent, tag, born: performance.now() };
    region.locked = locked;
    w.decor[w.decor.indexOf(old)] = region;
    for (const e of this.edges) {
      if (e.from === old) e.from = region;
      if (e.to === old) e.to = region;
    }
    this.paint(region, lines);
    return region;
  }
}

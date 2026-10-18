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

export class Layout {
  constructor(world) {
    this.world = world;
    this.m = Math.round(14 * K);
    this.pad = Math.round(7 * K);
    this.gap = Math.round(18 * K);
    this.cols = world.w >= 620 * K ? 2 : 1;
    this.colW = Math.floor((world.w - this.m * (this.cols + 1)) / this.cols);
    this.colY = Array(this.cols).fill(0);
    this.y = 0;
  }

  get bottom() {
    return Math.max(this.y, ...this.colY);
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

  place(kind, rows, { full = false, accent = COLORS.text, data = {}, tag } = {}) {
    const width = full ? this.world.w - 2 * this.m : this.colW;
    const { lines, h } = this.build(rows, width - 2 * this.pad);
    const cardH = Math.ceil(h + 2 * this.pad);
    let x;
    let y;
    if (full) {
      y = this.bottom + this.gap;
      x = this.m;
      this.y = y + cardH;
      this.colY.fill(this.y);
    } else {
      let c = 0;
      for (let i = 1; i < this.cols; i++) if (this.colY[i] < this.colY[c]) c = i;
      y = Math.max(this.colY[c], this.y) + this.gap;
      x = this.m + c * (this.colW + this.m);
      this.colY[c] = y + cardH;
    }
    if (y + cardH > this.world.h - 80) return null;
    const rect = { x, y, w: width, h: cardH };
    const region = this.world.addRegion(kind, rect, data);
    region.decor = { accent, tag, born: performance.now() };
    this.world.decor.push(region);
    this.paint(region, lines);
    return region;
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
    this.paint(region, lines);
    return region;
  }
}

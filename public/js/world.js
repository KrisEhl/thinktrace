// Destructible pixel terrain. Everything the agent finds is stamped in here as
// solid pixels; weapons carve them back out. Each pixel remembers which region
// (card, claim, ...) it belongs to so damage can be attributed.

const SOLID_ALPHA = 110;

export class World {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.scratch = document.createElement('canvas');
    this.sctx = this.scratch.getContext('2d', { willReadFrequently: true });
    this.solid = new Uint8Array(width * height);
    this.region = new Uint16Array(width * height);
    this.regions = [null];
    this.decor = [];
    this.totalSolid = 0;
    this.destroyed = 0;
    this.floorY = height; // water line below the newest content
    this.burn = 2; // width of the scorched ring around blast holes
  }

  addRegion(kind, rect, data = {}) {
    const r = { id: this.regions.length, kind, rect, data, total: 0, alive: 0, locked: false };
    this.regions.push(r);
    return r;
  }

  isSolid(x, y) {
    x |= 0;
    y |= 0;
    if (y >= this.floorY) return true;
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return false;
    return this.solid[y * this.w + x] === 1;
  }

  // `water`: whether the water line counts as solid (it does for projectiles, not for the player).
  rowSolid(x0, x1, y, water = true) {
    y |= 0;
    if (water && y >= this.floorY) return true;
    if (y < 0 || y >= this.h) return false;
    const base = y * this.w;
    for (let x = Math.max(0, x0 | 0); x <= Math.min(this.w - 1, x1 | 0); x++) if (this.solid[base + x]) return true;
    return false;
  }

  // Draw with `draw(ctx)` into a rect-sized scratch canvas, then copy it into the
  // world. Strong pixels become solid terrain; faint anti-aliased edges are display only.
  stamp(region, draw) {
    const { x, y } = region.rect;
    const w = Math.min(region.rect.w, this.w - x);
    const h = Math.min(region.rect.h, this.h - y);
    if (w <= 0 || h <= 0) return;
    this.scratch.width = w;
    this.scratch.height = h;
    this.sctx.imageSmoothingEnabled = false;
    this.sctx.textBaseline = 'top';
    draw(this.sctx, w, h);
    const src = this.sctx.getImageData(0, 0, w, h).data;
    const img = this.ctx.getImageData(x, y, w, h);
    const dst = img.data;
    let count = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const p = (j * w + i) * 4;
        const a = src[p + 3];
        if (!a || a < dst[p + 3]) continue;
        const k = (y + j) * this.w + (x + i);
        this.region[k] = region.id;
        dst[p] = src[p];
        dst[p + 1] = src[p + 1];
        dst[p + 2] = src[p + 2];
        // Keep the font's anti-aliasing for display; only strong pixels are solid.
        dst[p + 3] = a >= SOLID_ALPHA ? 255 : a;
        if (a >= SOLID_ALPHA && !this.solid[k]) {
          this.solid[k] = 1;
          count++;
        }
      }
    }
    this.ctx.putImageData(img, x, y);
    region.total += count;
    region.alive += count;
    this.totalSolid += count;
  }

  // Remove a circle of terrain and scorch a ring around it. Returns per-region hit counts.
  carve(cx, cy, r, onPixel) {
    const rb = r + this.burn;
    const x0 = Math.max(0, Math.floor(cx - rb));
    const y0 = Math.max(0, Math.floor(cy - rb));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + rb));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + rb));
    const hits = new Map();
    if (x1 < x0 || y1 < y0) return hits;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const img = this.ctx.getImageData(x0, y0, bw, bh);
    const d = img.data;
    const r2 = r * r;
    const rb2 = rb * rb;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > rb2) continue;
        const k = y * this.w + x;
        const p = ((y - y0) * bw + (x - x0)) * 4;
        if (!d[p + 3]) continue;
        const reg = this.regions[this.region[k]];
        if (reg?.locked) continue;
        if (dist2 > r2) {
          // Scorched edge: blend toward burnt earth (repeated hits converge, never go black).
          d[p] = d[p] * 0.55 + 40 * 0.45;
          d[p + 1] = d[p + 1] * 0.55 + 24 * 0.45;
          d[p + 2] = d[p + 2] * 0.55 + 18 * 0.45;
          continue;
        }
        d[p + 3] = 0;
        if (!this.solid[k]) continue; // soft edge pixel: just erase it
        onPixel?.(x, y, d[p], d[p + 1], d[p + 2]);
        this.solid[k] = 0;
        this.destroyed++;
        if (reg) {
          reg.alive--;
          hits.set(reg, (hits.get(reg) ?? 0) + 1);
        }
      }
    }
    this.ctx.putImageData(img, x0, y0);
    return hits;
  }

  // Remove every pixel of a region. `onPixel` lets the caller spawn debris.
  // `count` decides whether the pixels count as player destruction.
  clearRegion(region, onPixel, count = true) {
    const { x, y } = region.rect;
    const w = Math.min(region.rect.w, this.w - x);
    const h = Math.min(region.rect.h, this.h - y);
    const img = this.ctx.getImageData(x, y, w, h);
    const d = img.data;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = (y + j) * this.w + (x + i);
        const p = (j * w + i) * 4;
        if (!d[p + 3] || this.region[k] !== region.id) continue;
        d[p + 3] = 0;
        if (!this.solid[k]) continue;
        onPixel?.(x + i, y + j, d[p], d[p + 1], d[p + 2]);
        this.solid[k] = 0;
        if (count) this.destroyed++;
      }
    }
    this.ctx.putImageData(img, x, y);
    if (!count) {
      // Pixels that vanish without being "destroyed" leave the score denominator.
      this.totalSolid -= region.alive;
    }
    region.alive = 0;
  }

  get percent() {
    return this.totalSolid ? (this.destroyed / this.totalSolid) * 100 : 0;
  }
}

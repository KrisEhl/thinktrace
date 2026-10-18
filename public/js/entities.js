// Stick figure, weapons, projectiles and debris.
import { K } from './scale.js';

const GRAVITY = 900 * K;
const DEBRIS = Math.max(1, Math.round(K * 0.75)); // debris particle size in world pixels

export const WEAPONS = [
  { name: 'HANDGUN', rate: 9, speed: 520 * K, radius: 4 * K, spread: 0.02, pellets: 1, color: '#ffe066' },
  { name: 'SHOTGUN', rate: 1.8, speed: 480 * K, radius: 3.5 * K, spread: 0.22, pellets: 7, color: '#ffb347' },
  { name: 'UZI', rate: 22, speed: 600 * K, radius: 2.5 * K, spread: 0.08, pellets: 1, color: '#9ef0ff' },
  { name: 'BAZOOKA', rate: 1.4, speed: 280 * K, radius: 16 * K, spread: 0, pellets: 1, color: '#ff6b6b', rocket: true },
];

// A pink worm. Text is the world: every line is a one-way platform you can run
// through, land on from above, and drop through with S.
export class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.w = Math.round(7 * K);
    this.h = Math.round(16 * K);
    this.vx = 0;
    this.vy = 0;
    this.face = 1;
    this.grounded = false;
    this.jumps = 0;
    this.flip = 0;
    this.fuel = 1;
    this.dropTimer = 0;
    this.runPhase = 0;
    this.jumpHeld = false;
    this.aim = 0;
    this.safe = { x, y }; // last spot with ground underfoot, for respawning after a splash
  }

  get cx() {
    return this.x + this.w / 2;
  }

  get gunY() {
    return this.y + 9 * K;
  }

  // Solid text directly under the feet? The water line does not count.
  footing(world, y) {
    return world.rowSolid(this.x, this.x + this.w - 1, y, false);
  }

  update(dt, input, world) {
    const accel = (this.grounded ? 1400 : 900) * K;
    const max = 125 * K;
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir) this.vx += dir * accel * dt;
    else {
      this.vx *= Math.pow(this.grounded ? 0.0005 : 0.2, dt);
      if (Math.abs(this.vx) < 2) this.vx = 0;
    }
    this.vx = Math.max(-max, Math.min(max, this.vx));

    // Jump, double jump (with flip), then hold to fly the jet pack.
    if (input.jump && !this.jumpHeld) {
      if (this.grounded) {
        this.vy = -290 * K;
        this.jumps = 1;
      } else if (this.jumps < 2) {
        this.vy = -270 * K;
        this.jumps = 2;
        this.flip = 1;
      }
    }
    if (input.jump && this.jumpHeld && this.jumps >= 2 && this.fuel > 0 && this.vy > -60 * K) {
      this.vy -= 1700 * K * dt;
      this.vy = Math.max(this.vy, -150 * K);
      this.fuel -= dt * 0.6;
      this.flying = true;
    } else this.flying = false;
    this.jumpHeld = input.jump;

    if (input.down && this.grounded) this.dropTimer = 0.22;
    this.dropTimer = Math.max(0, this.dropTimer - dt);
    if (this.flip > 0) this.flip = Math.max(0, this.flip - dt * 2.6);

    // Horizontal: text never blocks sideways. Step up small bumps while walking.
    this.x = Math.max(0, Math.min(world.w - this.w, this.x + this.vx * dt));
    if (this.grounded) {
      for (let k = 0; k < 4 * K && this.footing(world, Math.floor(this.y) + this.h - 1); k++) this.y -= 1;
    }

    // Vertical: land on the first solid row below the feet while falling.
    // No gravity while standing: integrating it every frame made the figure bob by a pixel.
    if (this.grounded && this.vy >= 0 && this.dropTimer <= 0) this.vy = 0;
    else this.vy = Math.min(this.vy + GRAVITY * dt, 520 * K);
    let ny = this.y + this.vy * dt;
    if (this.vy > 0 && this.dropTimer <= 0) {
      for (let yy = Math.floor(this.y); yy < Math.floor(ny); yy++) {
        if (this.footing(world, yy + this.h)) {
          ny = yy;
          this.vy = 0;
          break;
        }
      }
    }
    this.y = ny;

    this.grounded = this.vy >= 0 && this.dropTimer <= 0 && this.footing(world, Math.floor(this.y) + this.h);
    if (this.grounded) {
      this.vy = 0;
      this.jumps = 0;
      this.fuel = Math.min(1, this.fuel + dt * 1.5);
      this.y = Math.floor(this.y);
      this.safe = { x: this.x, y: this.y };
    } else if (this.jumps === 0) {
      this.jumps = 1; // walked off a ledge: one air jump left
    }
    if (this.grounded && this.vx) this.runPhase += (Math.abs(this.vx) / K) * dt * 0.12;
  }

  draw(ctx, cam, t) {
    const x = Math.round(this.cx - cam.x);
    const y = Math.round(this.y - cam.y);
    const f = this.face;
    ctx.save();
    ctx.translate(x, y + this.h / 2);
    if (this.flip > 0) ctx.rotate(f * (1 - this.flip) * Math.PI * 2);
    ctx.translate(0, -this.h / 2);
    ctx.scale(K, K); // drawn in a 7x16 box
    const bob = this.grounded && this.vx ? Math.abs(Math.sin(this.runPhase * Math.PI)) * 0.8 : 0;
    ctx.translate(0, -bob);
    // jet pack flame
    if (this.flying) {
      ctx.fillStyle = (t * 20) % 2 < 1 ? '#ffb347' : '#ff6b6b';
      ctx.fillRect(-f * 3 - 1, 11, 2, 3 + ((t * 30) % 3));
    }
    // body: a capsule with a lighter belly
    ctx.fillStyle = '#f49ab0';
    ctx.strokeStyle = '#8f3f5a';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.roundRect(-3.2, 1.5, 6.4, 14.5 + bob, 3.2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fbc6d3';
    ctx.fillRect(f > 0 ? 0.6 : -2.4, 8, 1.8, 7);
    // headband with tails flying behind
    ctx.fillStyle = '#e63946';
    ctx.fillRect(-3.2, 3, 6.4, 1.2);
    ctx.fillRect(-f * 3.2 - (f > 0 ? 2 : 0), 3.2, 2, 0.8);
    ctx.fillRect(-f * 4.6 - (f > 0 ? 1.4 : 0), 4, 1.4, 0.8);
    // eyes looking at the cursor
    const ex = Math.cos(this.aim) * 0.5;
    const ey = Math.sin(this.aim) * 0.5;
    for (const ox of [0.2, 2.2]) {
      const cx = f * ox;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx, 6.2, 1.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(cx + ex, 6.2 + ey, 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // bazooka along the aim
    const ax = Math.cos(this.aim);
    const ay = Math.sin(this.aim);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#3d4a25';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(-ax * 2, 9 - ay * 2);
    ctx.lineTo(ax * 7, 9 + ay * 7);
    ctx.stroke();
    ctx.strokeStyle = '#6b7f3e';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }
}

export class Projectile {
  constructor(x, y, vx, vy, weapon) {
    Object.assign(this, { x, y, vx, vy, weapon, life: 2.5, trail: [] });
  }
}

export class Grenade {
  constructor(x, y, vx, vy) {
    Object.assign(this, { x, y, vx, vy, fuse: 1.6, radius: 22 * K });
  }

  update(dt, world) {
    this.fuse -= dt;
    if (this.y >= world.floorY) {
      this.sunk = true; // fizzles in the water
      return;
    }
    this.vy += GRAVITY * dt;
    const nx = this.x + this.vx * dt;
    const ny = this.y + this.vy * dt;
    if (world.isSolid(nx, this.y)) this.vx *= -0.5;
    else this.x = nx;
    if (world.isSolid(this.x, ny)) {
      this.vy *= -0.45;
      this.vx *= 0.8;
    } else this.y = ny;
    if (this.x < 0 || this.x > world.w) this.vx *= -1;
    this.x = Math.max(0, Math.min(world.w - 1, this.x));
  }
}

export class Particles {
  constructor(max = 2500) {
    this.max = max;
    this.list = [];
  }

  add(x, y, vx, vy, color, life = 1.2, size = DEBRIS, gravity = true) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({ x, y, vx, vy, color, life, max: life, size, gravity });
  }

  burst(x, y, n, colors, speed = 140, life = 0.6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.add(x, y, Math.cos(a) * s * K, Math.sin(a) * s * K, colors[i % colors.length], life * (0.5 + Math.random()), DEBRIS, false);
    }
  }

  update(dt, world) {
    for (const p of this.list) {
      p.life -= dt;
      if (p.gravity) p.vy += GRAVITY * 0.8 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.gravity && p.y >= world.floorY) p.life = 0; // sinks
      // Debris settles on terrain and bounces a little.
      if (p.gravity && p.vy > 0 && world.isSolid(p.x, p.y + 1)) {
        p.vy *= -0.25;
        p.vx *= 0.6;
      }
    }
    this.list = this.list.filter((p) => p.life > 0);
  }

  draw(ctx, cam) {
    for (const p of this.list) {
      ctx.globalAlpha = Math.min(1, (p.life / p.max) * 2);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x - cam.x), Math.round(p.y - cam.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }
}

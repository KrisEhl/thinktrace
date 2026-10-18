// Stick figure, weapons, projectiles and debris.
import { K } from './scale.js';

const GRAVITY = 900 * K;
const DEBRIS = Math.max(1, Math.round(K * 0.75)); // debris particle size in world pixels

export const WEAPONS = [
  { name: 'BLASTER', rate: 9, speed: 520 * K, radius: 4 * K, spread: 0.02, pellets: 1, color: '#ffe066' },
  { name: 'SHOTGUN', rate: 1.8, speed: 480 * K, radius: 3.5 * K, spread: 0.22, pellets: 7, color: '#ffb347' },
  { name: 'MINIGUN', rate: 22, speed: 600 * K, radius: 2.5 * K, spread: 0.08, pellets: 1, color: '#9ef0ff' },
  { name: 'ROCKET', rate: 1.4, speed: 280 * K, radius: 16 * K, spread: 0, pellets: 1, color: '#ff6b6b', rocket: true },
];

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
  }

  get cx() {
    return this.x + this.w / 2;
  }

  get gunY() {
    return this.y + 6 * K;
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

    // Jump, double jump (with flip), then hold to fly.
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

    // Horizontal: text is one-way platforms, so walls never block. Step up small bumps.
    this.x = Math.max(0, Math.min(world.w - this.w, this.x + this.vx * dt));
    if (this.grounded) {
      for (let k = 0; k < 4 * K && world.rowSolid(this.x, this.x + this.w - 1, Math.floor(this.y) + this.h - 1); k++) this.y -= 1;
    }

    // Vertical: land on the first solid row below the feet while falling.
    // No gravity while standing: integrating it every frame made the figure bob by a pixel.
    if (this.grounded && this.vy >= 0 && this.dropTimer <= 0) this.vy = 0;
    else this.vy = Math.min(this.vy + GRAVITY * dt, 520 * K);
    let ny = this.y + this.vy * dt;
    if (this.vy > 0 && this.dropTimer <= 0) {
      for (let yy = Math.floor(this.y); yy < Math.floor(ny); yy++) {
        if (world.rowSolid(this.x, this.x + this.w - 1, yy + this.h)) {
          ny = yy;
          this.vy = 0;
          break;
        }
      }
    }
    this.y = ny;

    this.grounded =
      this.vy >= 0 && this.dropTimer <= 0 && world.rowSolid(this.x, this.x + this.w - 1, Math.floor(this.y) + this.h);
    if (this.grounded) {
      this.vy = 0;
      this.jumps = 0;
      this.fuel = Math.min(1, this.fuel + dt * 1.5);
      this.y = Math.floor(this.y);
    } else if (this.jumps === 0) {
      this.jumps = 1; // walked off a ledge: one air jump left
    }
    this.runPhase += (Math.abs(this.vx) / K) * dt * 0.12;
  }

  draw(ctx, cam, t) {
    const x = Math.round(this.cx - cam.x);
    const y = Math.round(this.y - cam.y);
    ctx.save();
    ctx.translate(x, y + this.h / 2);
    if (this.flip > 0) ctx.rotate(this.face * (1 - this.flip) * Math.PI * 2);
    ctx.translate(0, -this.h / 2);
    ctx.scale(K, K); // figure is drawn in 7x16 units
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 1;
    // head
    ctx.beginPath();
    ctx.arc(0, 2.5, 2.5, 0, Math.PI * 2);
    ctx.fill();
    // body
    ctx.fillRect(-0.5, 5, 1, 6);
    // legs
    const moving = this.grounded && Math.abs(this.vx) > 10;
    const s = moving ? Math.sin(this.runPhase * Math.PI) * 3 : this.grounded ? 1.5 : 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 11);
    ctx.lineTo(-s, 16);
    ctx.moveTo(0, 11);
    ctx.lineTo(s, 16);
    ctx.stroke();
    // arm + gun toward the cursor
    const ax = Math.cos(this.aim);
    const ay = Math.sin(this.aim);
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(ax * 5, 6 + ay * 5);
    ctx.stroke();
    ctx.strokeStyle = '#9aa3b8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax * 4, 6 + ay * 4);
    ctx.lineTo(ax * 8, 6 + ay * 8);
    ctx.stroke();
    // jetpack flame
    if (this.flying) {
      ctx.fillStyle = (t * 20) % 2 < 1 ? '#ffb347' : '#ff6b6b';
      ctx.fillRect(-this.face * 2 - 1, 12, 2, 3 + ((t * 30) % 3));
    }
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

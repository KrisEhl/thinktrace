import type { Claim } from "../api/types";
import type { RunState } from "./reducer";
import { ageDays, claimWeight, type Role } from "./credibility";

// Mini forecast for a volatile quantity (a price) from dated observations.
//   weights: source quality x quote check x independence x recency half-life (credibility.ts)
//   now:     weighted mean after trimming 10% of the weight at each tail (trimmed-mean aggregation, Halawi et al. 2024)
//   trend:   weighted least-squares line over time, so recent observations dominate
//   band:    weighted residual spread, widening with the square root of the horizon

export interface Obs {
  claim_id: string;
  t: number; // days relative to now (negative = past)
  value: number;
  w: number;
  role?: Role;
}

export interface Forecast {
  unit: string;
  obs: Obs[];
  now: { mid: number; lo: number; hi: number };
  slopePerDay: number;
  proj: { t: number; mid: number; lo: number; hi: number }[];
  nEff: number; // effective number of observations, (sum w)^2 / sum w^2
  newestDays: number;
}

const TRIM = 0.1;

function trimmedMean(xs: { value: number; w: number }[]) {
  const sorted = [...xs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((a, x) => a + x.w, 0);
  let lo = total * TRIM, hi = total * (1 - TRIM), acc = 0, sum = 0, wsum = 0;
  for (const x of sorted) {
    // the share of this observation's weight that lies inside [lo, hi]
    const inside = Math.max(0, Math.min(acc + x.w, hi) - Math.max(acc, lo));
    sum += inside * x.value;
    wsum += inside;
    acc += x.w;
  }
  return wsum ? sum / wsum : NaN;
}

export function forecast(st: RunState, claims: Claim[], horizon = 30, now = Date.now()): Forecast | null {
  const obs: Obs[] = claims
    .filter((c) => c.value !== undefined && c.observed_at)
    .map((c) => {
      const { weight, profile } = claimWeight(st, c, { now });
      return { claim_id: c.id, t: -(ageDays(c, now) as number), value: c.value as number, w: weight, role: profile?.role };
    })
    .filter((o) => o.w > 0);
  if (obs.length < 3) return null;

  const W = obs.reduce((a, o) => a + o.w, 0);
  const mt = obs.reduce((a, o) => a + o.w * o.t, 0) / W;
  const mv = obs.reduce((a, o) => a + o.w * o.value, 0) / W;
  const sxx = obs.reduce((a, o) => a + o.w * (o.t - mt) ** 2, 0);
  const slope = sxx > 0 ? obs.reduce((a, o) => a + o.w * (o.t - mt) * (o.value - mv), 0) / sxx : 0;
  const sigma = Math.sqrt(obs.reduce((a, o) => a + o.w * (o.value - (mv + slope * (o.t - mt))) ** 2, 0) / W);

  const level = trimmedMean(obs);
  const band = (t: number) => sigma * Math.sqrt(1 + t / 14);
  const proj = Array.from({ length: horizon + 1 }, (_, t) => {
    const mid = level + slope * t;
    return { t, mid, lo: mid - band(t), hi: mid + band(t) };
  });
  return {
    unit: claims.find((c) => c.unit)?.unit ?? "",
    obs,
    now: { mid: level, lo: level - sigma, hi: level + sigma },
    slopePerDay: slope,
    proj,
    nEff: W ** 2 / obs.reduce((a, o) => a + o.w ** 2, 0),
    newestDays: Math.min(...obs.map((o) => -o.t)),
  };
}

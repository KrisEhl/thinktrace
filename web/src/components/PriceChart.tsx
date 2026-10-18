import type { Claim } from "../api/types";
import { useStore } from "../state/store";
import { forecast } from "../state/forecast";
import { roleLabel, type Role } from "../state/credibility";

// Dated observations of one volatile quantity, the weighted "now" range and a 30-day projection band.
// One y axis; dot area = evidence weight; MSRP-style reference values from other readings drawn as labelled rules.

const WINDOW = 120; // days of history on the plot
const W = 340, H = 190, PAD = { l: 44, r: 10, t: 10, b: 22 };
const ROLE_COLOR: Record<Role, string> = { rated: "var(--green)", institution: "var(--accent)", party: "var(--orange)", unrated: "var(--grey)" };
const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

export function PriceChart({ claims, refs = [] }: { claims: Claim[]; refs?: { label: string; value: number }[] }) {
  const run = useStore((s) => s.run);
  const openClaim = useStore((s) => s.openClaim);
  const f = forecast(run, claims);
  if (!f) return null;

  // Show the window that carries the weight; older observations have decayed to ~0 and are left off the plot.
  const t0 = Math.max(Math.min(...f.obs.map((o) => o.t)), -WINDOW), t1 = f.proj[f.proj.length - 1].t;
  const shown = f.obs.filter((o) => o.t >= t0);
  const hidden = f.obs.length - shown.length;
  const vals = [...shown.map((o) => o.value), ...f.proj.flatMap((p) => [p.lo, p.hi]), ...refs.map((r) => r.value)];
  const v0 = Math.min(...vals) * 0.95, v1 = Math.max(...vals) * 1.03;
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - ((v - v0) / (v1 - v0)) * (H - PAD.t - PAD.b);
  const wMax = Math.max(...shown.map((o) => o.w));
  const band = `M${f.proj.map((p) => `${x(p.t)},${y(p.hi)}`).join("L")}L${[...f.proj].reverse().map((p) => `${x(p.t)},${y(p.lo)}`).join("L")}Z`;
  const ticks = [v0, (v0 + v1) / 2, v1].map((v) => Math.round(v / 100) * 100);
  const roles = [...new Set(f.obs.map((o) => o.role).filter(Boolean))] as Role[];
  const p30 = f.proj[f.proj.length - 1];

  return (
    <div className="pricechart">
      <div className="hero">
        <b>{money(f.now.mid)}</b> <span className="muted">now ({money(f.now.lo)}–{money(f.now.hi)})</span>
        <div className="muted">
          30-day projection {money(p30.lo)}–{money(p30.hi)} · trend {f.slopePerDay >= 0 ? "+" : "−"}{money(Math.abs(f.slopePerDay) * 30)}/month · effective n {f.nEff.toFixed(1)} · newest {Math.round(f.newestDays)} d old
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Price observations over time with a 30-day projection">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.l - 4} y={y(v) + 3} textAnchor="end" className="axis">{money(v)}</text>
          </g>
        ))}
        <line x1={x(0)} x2={x(0)} y1={PAD.t} y2={H - PAD.b} className="today" />
        <text x={x(0) - 3} y={PAD.t + 8} textAnchor="end" className="axis">today</text>
        <text x={PAD.l} y={H - 8} className="axis">{Math.round(-t0)} d ago</text>
        <text x={W - PAD.r} y={H - 8} textAnchor="end" className="axis">+{t1} d</text>
        {refs.map((r) => (
          <g key={r.label}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(r.value)} y2={y(r.value)} className="ref" />
            <text x={PAD.l + 4} y={y(r.value) - 4} className="axis">{r.label} {money(r.value)}</text>
          </g>
        ))}
        <path d={band} className="band" />
        <line x1={x(0)} y1={y(f.proj[0].mid)} x2={x(t1)} y2={y(p30.mid)} className="projline" />
        {[...shown].sort((a, b) => a.w - b.w).map((o) => (
          <circle
            key={o.claim_id}
            cx={x(o.t)}
            cy={y(o.value)}
            r={4 + 6 * Math.sqrt(o.w / wMax)}
            fill={ROLE_COLOR[o.role ?? "unrated"]}
            fillOpacity={0.25 + 0.75 * (o.w / wMax)}
            className="obs"
            onClick={() => openClaim(o.claim_id)}
          >
            <title>{`${money(o.value)} · ${Math.round(-o.t)} days ago · weight ${o.w.toFixed(3)} (${roleLabel[o.role ?? "unrated"]})`}</title>
          </circle>
        ))}
      </svg>
      <div className="muted legend-row">
        {roles.map((r) => (
          <span key={r}><i className="dot" style={{ background: ROLE_COLOR[r] }} /> {roleLabel[r]}</span>
        ))}
        {hidden > 0 && <span>· {hidden} older observation(s) off the plot (weight ≈ 0)</span>}
        <span>· dot size and opacity = evidence weight (quality × quote check × independence × 14-day half-life)</span>
      </div>
    </div>
  );
}

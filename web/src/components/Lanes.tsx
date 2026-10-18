import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { claimNumber, claimTone, directionsUnder, laneItems, nodeConfidence, nodeTone, toneLabel, type LaneItem } from "../state/selectors";
import { profile, roleLabel, sourceMix } from "../state/credibility";
import type { RunState } from "../state/reducer";

// Vertical lanes: one column per research direction, its activity flowing down in arrival order.
// Every reading of the question runs in parallel; drop a whole lane while it runs.

const short = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

export function Lanes() {
  const run = useStore((s) => s.run);
  const focusId = useStore((s) => s.ui.focusId);
  const dirs = directionsUnder(run, focusId);
  if (!dirs.length) return <div className="empty"><p className="muted">No research directions here yet.</p></div>;
  return (
    <div className="lanes">
      {dirs.map((d) => (
        <Lane key={d.id} id={d.id} />
      ))}
    </div>
  );
}

function Lane({ id }: { id: string }) {
  const run = useStore((s) => s.run);
  const selected = useStore((s) => s.ui.selectedId === id);
  const { select, steer } = useStore.getState();
  const n = run.nodes[id];
  const items = laneItems(run, id);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the newest card while the lane grows, unless you scrolled up to read.
  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  if (!n) return null;
  const tone = nodeTone(run, id);
  const conf = nodeConfidence(run, id);
  const dead = n.status === "deactivated";
  const live = n.status === "running" || n.status === "stale";
  const mix = sourceMix(run, items.flatMap((x) => (x.kind === "claim" ? [x.c] : [])));
  const parent = n.parent_id ? run.nodes[n.parent_id] : undefined;

  return (
    <section className={`lane ${dead ? "dead" : ""} ${selected ? "sel" : ""}`}>
      <header className="lane-head" onClick={() => select(id)}>
        {parent && parent.kind !== "question" && <div className="lane-parent">{short(parent.label, 34)} ›</div>}
        <div className="lane-title">
          <span className={`dot ${tone}`} title={toneLabel[tone]} /> {short(n.label, 40)}
        </div>
        <div className="lane-meta muted">
          {dead ? "✕ dropped" : live ? "● live" : n.status === "done" ? "✓ done" : "waiting"}
          {conf !== undefined && ` · ${conf.toFixed(2)}`}
          {` · ${items.filter((x) => x.kind === "claim").length} claims`}
        </div>
        {mix.total > 0 && (
          <div className="mixbar" title={mix.shares.map((x) => `${roleLabel[x.role]} ${Math.round(x.share * 100)}%`).join(" · ")}>
            {mix.shares.map((x) => (
              <span key={x.role} className={`role-${x.role}`} style={{ flexBasis: `${x.share * 100}%` }} />
            ))}
          </div>
        )}
        <div className="lane-actions" onClick={(e) => e.stopPropagation()}>
          <button disabled={dead} onClick={() => void steer("deactivate", { node_id: id })} title="Drop this direction">Drop</button>
          <button disabled={dead} onClick={() => void steer("dig_deeper", { node_id: id })}>Dig deeper</button>
        </div>
      </header>
      <div
        className="lane-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.map((x) => (
          <Card key={x.key} item={x} run={run} />
        ))}
        {run.stop_reasons[id] && <div className="card stop">■ stopped: {short(run.stop_reasons[id], 160)}</div>}
        {live && <div className="lane-live">▼ working…</div>}
      </div>
    </section>
  );
}

function Card({ item, run }: { item: LaneItem; run: RunState }) {
  const { openSource } = useStore.getState();
  if (item.kind === "decision") {
    const d = item.d;
    if (d.action === "stop") return null; // the stop reason closes the lane
    const src = d.source_id ? run.sources[d.source_id] : undefined;
    return (
      <div className={`card dec ${d.action}`} title={`because ${d.why}`}>
        <span className="card-kind">{d.action === "search" ? "SEARCH" : "READ"}</span>{" "}
        {d.action === "search" ? `“${short(d.query ?? "", 70)}”` : src ? <a onClick={() => openSource(src.id)}>{src.domain}</a> : short(d.why, 70)}
      </div>
    );
  }
  if (item.kind === "message") {
    const m = item.m;
    return <div className={`card msg ${m.role}`}>{m.role === "user" ? "You: " : "Agent: "}{short(m.text, 140)}</div>;
  }
  const c = item.c;
  const src = run.sources[c.source_id];
  const p = src ? profile(run, src) : undefined;
  return (
    <div className={`card claim tone-${claimTone(c)}`} onClick={() => openSource(c.source_id, c.id)}>
      <div>
        <b className="cite">[c{claimNumber(c.id)}]</b> {c.value !== undefined && <b>{c.unit === "USD" ? `$${c.value.toLocaleString("en-US")}` : c.value} </b>}
        {short(c.text, 120)}
      </div>
      <div className="muted card-foot">
        {src?.domain}
        {p && <span className={`chip role-${p.role}`}>{roleLabel[p.role]} {p.quality.toFixed(2)}</span>}
        {c.observed_at && <span> · {c.observed_at}</span>}
        {c.verified === false && <span> · quote not found</span>}
      </div>
    </div>
  );
}

import { useStore } from "../state/store";
import { decisionsOfNode } from "../state/selectors";

export function StatsBar() {
  const run = useStore((s) => s.run);
  const { railOpen, dockOpen, traceOpen, notice } = useStore((s) => s.ui);
  const { set } = useStore.getState();
  const sources = Math.max(Object.keys(run.sources).length, run.cost.sources);
  const nodes = Object.values(run.nodes);
  const needs = Object.keys(run.needs_human).length;
  return (
    <header className="stats">
      <b className="brand">Glassbox</b>
      <span className={`chip st-${run.status}`}>{run.status}</span>
      <span>
        {sources} sources · steered {run.cost.steers}× · {run.cost.restarts} restarts · €{run.cost.eur.toFixed(2)}
      </span>
      {needs > 0 && <span className="chip warn">{needs} need you</span>}
      {nodes.some((n) => n.status === "stale") && <span className="chip warn">{nodes.filter((n) => n.status === "stale").length} of {nodes.filter((n) => n.kind === "direction").length} directions re-running</span>}
      {notice && (
        <span className="chip warn notice" title={notice} onClick={() => set({ notice: null })}>
          {notice.slice(0, 90)} ✕
        </span>
      )}
      <span className="spacer" />
      <button onClick={() => set({ railOpen: !railOpen })} className={railOpen ? "on" : ""}>Chat</button>
      <button onClick={() => set({ traceOpen: !traceOpen })} className={traceOpen ? "on" : ""}>Trace</button>
      <button onClick={() => set({ dockOpen: !dockOpen })} className={dockOpen ? "on" : ""}>Panel</button>
    </header>
  );
}

export function TraceStrip() {
  const run = useStore((s) => s.run);
  const open = useStore((s) => s.ui.traceOpen);
  const { reveal } = useStore.getState();
  if (!open) return null;
  const last = run.decisions.slice(-40).reverse();
  void decisionsOfNode;
  return (
    <div className="trace">
      <div className="pane-title">Agent decisions (newest first)</div>
      <div className="trace-lines">
        {last.length === 0 && <span className="muted">Nothing yet.</span>}
        {last.map((d) => (
          <div key={d.id} className={`trace-line ${d.action}`} onClick={() => reveal(d.node_id)}>
            <span className="t-node">{run.nodes[d.node_id]?.label}</span>
            <span className="t-act">{d.action}</span>
            {d.query && <span className="t-q">“{d.query}”</span>}
            <span className="t-why">because {d.why}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

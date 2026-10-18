import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useStore } from "../state/store";
import { claimNumber, claimTone, claimUsage, nodeConfidence, nodeTone, notes, toneLabel } from "../state/selectors";
import { gbSize } from "../graph/layout";

const verdictGlyph = { yes: "✓", no: "✕", uncertain: "?" } as const;

const centerHandle = { left: "50%", top: "50%", opacity: 0, pointerEvents: "none" as const, width: 1, height: 1 };

/** Question / dimension / direction node. Colour = confidence, size = traffic, tabs = pinned chat notes. */
export function GbNode({ data }: NodeProps) {
  const id = (data as { id: string }).id;
  const selected = useStore((s) => s.ui.selectedId === id);
  const n = useStore((s) => s.run.nodes[id]);
  const tone = useStore((s) => nodeTone(s.run, id));
  const conf = useStore((s) => nodeConfidence(s.run, id));
  const flash = useStore((s) => s.run.seq - (s.run.recently_changed[id] ?? -99) < 6);
  const needs = useStore((s) => s.run.needs_human[id]);
  const stale = n?.status === "stale";
  const allNotes = useStore((s) => s.run.messages);
  const openNotes = useStore((s) => s.ui.openNotes);
  const toggle = useStore((s) => s.toggleNote);
  const focusId = useStore((s) => s.ui.focusId);
  const run = useStore((s) => s.run);
  if (!n) return null;

  const size = gbSize(n);
  const mine = notes(run).filter((x) => x.user.node_id === id);
  void allNotes;

  return (
    <div
      className={`gb tone-${tone} ${selected ? "sel" : ""} ${flash ? "flash" : ""} ${n.status === "running" ? "pulse" : ""} ${n.status === "deactivated" ? "dead" : ""} ${id === focusId ? "focus" : ""} kind-${n.kind}`}
      style={{ width: size, height: size }}
      title={`${n.label} · ${toneLabel[tone]}${conf !== undefined ? ` · confidence ${conf.toFixed(2)}` : ""}`}
    >
      <Handle type="target" position={Position.Top} style={centerHandle} />
      <Handle type="source" position={Position.Top} style={centerHandle} />
      <div className="gb-inner">
        {n.verdict && <span className="verdict">{verdictGlyph[n.verdict]}</span>}
        {conf !== undefined && n.kind !== "question" && <span className="conf">{conf.toFixed(2)}</span>}
        {stale && <span className="spin" aria-label="re-running" />}
      </div>
      <div className="gb-label">{n.label}</div>
      {needs && <span className="badge-needs">needs you</span>}

      {mine.length > 0 && (
        <div className="notes">
          {mine.map(({ n: num, user, agent }) => {
            const open = !!openNotes[user.id];
            return (
              <div key={user.id} className="note-wrap">
                {open ? (
                  <div className="sticky nodrag nowheel" onClick={() => toggle(user.id)}>
                    <b>
                      {circled(num)} {user.text}
                    </b>
                    <p>{agent ? agent.text : "…"}</p>
                    <span className="fold">▾ fold</span>
                  </div>
                ) : (
                  <button className={`tab nodrag ${agent?.pending ? "pending" : ""}`} onClick={() => toggle(user.id)} title={user.text}>
                    {circled(num)}
                    {agent?.pending || !agent ? " …" : ""}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const circled = (n: number) => "①②③④⑤⑥⑦⑧⑨⑩"[n - 1] ?? `${n}.`;

const lanes = (
  <>
    <Handle type="target" position={Position.Left} className="h-side" />
    <Handle type="source" position={Position.Right} className="h-side" />
  </>
);

export function DecisionNode({ data }: NodeProps) {
  const id = (data as { id: string }).id;
  const d = useStore((s) => s.run.decisions.find((x) => x.id === id));
  const latest = useStore((s) => s.run.decisions[s.run.decisions.length - 1]?.id === id);
  if (!d) return null;
  return (
    <div className={`act decision ${d.action} ${latest ? "latest" : ""}`}>
      {lanes}
      <div className="act-head">{d.action.toUpperCase()}</div>
      {d.query && <div className="act-q">“{d.query}”</div>}
      <div className="act-why">because {d.why}</div>
    </div>
  );
}

export function SourceNode({ data }: NodeProps) {
  const id = (data as { id: string }).id;
  const s = useStore((st) => st.run.sources[id]);
  const openSource = useStore((st) => st.openSource);
  const same = useStore((st) => Object.values(st.run.sources).filter((x) => s && x.origin_id === s.origin_id).length);
  if (!s) return null;
  return (
    <div className="act source" onClick={() => openSource(s.id)}>
      {lanes}
      <div className="act-head">{s.domain}</div>
      <div className="act-q">{s.title}</div>
      <div className="act-why">
        origin <code>{s.origin_id}</code>
        {same > 1 && <span className="echo"> · {same} sources share it</span>}
      </div>
    </div>
  );
}

export function ClaimNode({ data }: NodeProps) {
  const id = (data as { id: string }).id;
  const c = useStore((s) => s.run.claims[id]);
  const run = useStore((s) => s.run);
  const usage = c ? claimUsage(run, c) : null;
  const openClaim = useStore((s) => s.openClaim);
  const hl = useStore((s) => s.ui.highlightClaim === id);
  if (!c || !usage) return null;
  const tone = claimTone(c);
  return (
    <div className={`act claim tone-${tone} ${hl ? "hl" : ""} use-${usage.state}`} onClick={() => openClaim(c.id)}>
      {lanes}
      <div className="act-head">
        [c{claimNumber(c.id)}] {c.verified === null ? "checking quote…" : c.verified ? "quote verified ✓" : "quote NOT found ✕"}
      </div>
      <div className="act-q">{c.text}</div>
      <div className="act-why">
        {c.origin_ids.length} independent origin{c.origin_ids.length === 1 ? "" : "s"} · {usage.state === "used" ? "used in answer" : usage.state === "pending" ? "answer pending" : `unused: ${usage.reason}`}
      </div>
    </div>
  );
}

export const nodeTypes = { gb: GbNode, decision: DecisionNode, source: SourceNode, claim: ClaimNode };

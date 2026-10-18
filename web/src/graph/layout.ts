import type { Edge, Node } from "@xyflow/react";
import type { GraphNode } from "../api/types";
import type { RunState } from "../state/reducer";
import { children, claimsOfNode, decisionsOfNode } from "../state/selectors";

// Layers: the graph shows ONE layer at a time, centred on `focusId`.
//   focus = question / dimension -> radial: focus in the middle, its children on a ring, grandchildren outside.
//   focus = direction            -> activity layer: what the agent did (decisions) -> what it read (sources) -> what it concluded (claims).

export const gbSize = (n: GraphNode) =>
  n.kind === "question" ? 112 : n.kind === "dimension" ? 88 : 54 + Math.min(n.traffic, 10) * 3.5;

export type LayerResult = { nodes: Node[]; edges: Edge[] };

const edge = (id: string, source: string, target: string, extra: Partial<Edge> = {}): Edge => ({
  id,
  source,
  target,
  type: "default",
  ...extra,
});

function radial(st: RunState, focusId: string): LayerResult {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const put = (n: GraphNode, cx: number, cy: number, depth: number) => {
    const size = gbSize(n);
    nodes.push({
      id: n.id,
      type: "gb",
      position: { x: cx - size / 2, y: cy - size / 2 },
      data: { id: n.id, size, depth },
      draggable: true,
    });
  };
  const focus = st.nodes[focusId];
  if (!focus) return { nodes, edges };
  put(focus, 0, 0, 0);

  const kids = children(st, focusId);
  const R1 = Math.max(230, kids.length * 70);
  const R2 = R1 + 190;
  kids.forEach((k, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / kids.length;
    put(k, R1 * Math.cos(a), R1 * Math.sin(a), 1);
    edges.push(edge(`${focusId}>${k.id}`, focusId, k.id, { className: k.status === "deactivated" ? "off" : k.status === "running" ? "live" : "" }));
    const grand = children(st, k.id);
    const sector = (2 * Math.PI) / Math.max(kids.length, 1);
    const spread = Math.min(sector * 0.85, 1.5);
    grand.forEach((g, j) => {
      const ga = grand.length === 1 ? a : a + (j - (grand.length - 1) / 2) * (spread / (grand.length - 1));
      put(g, R2 * Math.cos(ga), R2 * Math.sin(ga), 2);
      edges.push(edge(`${k.id}>${g.id}`, k.id, g.id, { className: g.status === "deactivated" ? "off" : g.status === "running" ? "live" : "" }));
    });
  });
  return { nodes, edges };
}

const COL = { decision: 0, source: 310, claim: 610 };
const ROW = 112;

function activity(st: RunState, focusId: string): LayerResult {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const focus = st.nodes[focusId];
  if (!focus) return { nodes, edges };
  const size = gbSize(focus);
  nodes.push({
    id: focus.id,
    type: "gb",
    position: { x: COL.decision + 90 - size / 2, y: -150 },
    data: { id: focus.id, size, depth: 0 },
  });

  const decisions = decisionsOfNode(st, focusId);
  const claims = claimsOfNode(st, focusId);
  const srcIds = [...new Set(claims.map((c) => c.source_id))];
  // A decision "produced" a source if it names it; otherwise match the k-th search/read decision with the k-th source
  // (spike heuristic; the backend should set Decision.source_id so this becomes exact).
  const working = decisions.map((d, i) => ({ d, i })).filter(({ d }) => d.action !== "stop");
  const rowOfSource: Record<string, number> = {};
  const producer: Record<string, string> = {};
  srcIds.forEach((sid, k) => {
    const named = decisions.findIndex((d) => d.source_id === sid);
    const idx = named >= 0 ? named : working[k]?.i ?? decisions.length + k;
    rowOfSource[sid] = idx;
    if (decisions[idx]) producer[sid] = decisions[idx].id;
  });

  decisions.forEach((d, i) => {
    nodes.push({ id: `dec:${d.id}`, type: "decision", position: { x: COL.decision, y: i * ROW }, data: { id: d.id } });
    edges.push(edge(`e-dec-${i}`, i === 0 ? focusId : `dec:${decisions[i - 1].id}`, `dec:${d.id}`, { className: "chain" }));
  });

  const claimIdx: Record<string, number> = {};
  srcIds.forEach((sid) => {
    nodes.push({ id: `src:${sid}`, type: "source", position: { x: COL.source, y: rowOfSource[sid] * ROW }, data: { id: sid } });
    if (producer[sid]) edges.push(edge(`e-ds-${sid}`, `dec:${producer[sid]}`, `src:${sid}`));
  });
  claims.forEach((c) => {
    const k = (claimIdx[c.source_id] = (claimIdx[c.source_id] ?? -1) + 1);
    nodes.push({
      id: `clm:${c.id}`,
      type: "claim",
      position: { x: COL.claim, y: rowOfSource[c.source_id] * ROW + k * 96 },
      data: { id: c.id },
    });
    edges.push(edge(`e-sc-${c.id}`, `src:${c.source_id}`, `clm:${c.id}`));
  });
  // Follow-up branches grown from this direction sit to the right and can be drilled into.
  children(st, focusId).forEach((k, i) => {
    const ks = gbSize(k);
    nodes.push({
      id: k.id,
      type: "gb",
      position: { x: COL.claim + 350, y: i * ROW + 20 - ks / 2 + 40 },
      data: { id: k.id, size: ks, depth: 1 },
    });
    edges.push(edge(`e-br-${k.id}`, focusId, k.id, { className: "branch" }));
  });
  return { nodes, edges };
}

export function layoutLayer(st: RunState, focusId: string, _selectedId?: string | null): LayerResult {
  const focus = st.nodes[focusId];
  if (!focus) return { nodes: [], edges: [] };
  return focus.kind === "direction" ? activity(st, focusId) : radial(st, focusId);
}

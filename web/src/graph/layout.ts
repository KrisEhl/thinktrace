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
  // Show the sources that matter here: those with claims, plus those the agent chose to read.
  const srcIds = [...new Set([...claims.map((c) => c.source_id), ...decisions.filter((d) => d.action === "read" && d.source_id).map((d) => d.source_id!)])].filter(
    (sid) => st.sources[sid],
  );
  // Which decision brought a source in: the read that named it, else the first search that returned it,
  // else (mock data without results) the k-th search/read decision.
  const working = decisions.map((d, i) => ({ d, i })).filter(({ d }) => d.action !== "stop");
  const producerIdx = (sid: string, k: number) => {
    const read = decisions.findIndex((d) => d.action === "read" && d.source_id === sid);
    const search = decisions.findIndex((d) => d.action === "search" && d.results?.includes(sid));
    if (search >= 0 && (read < 0 || search < read)) return search;
    if (read >= 0) return read;
    return decisions.some((d) => d.results) ? -1 : (working[k]?.i ?? -1);
  };

  decisions.forEach((d, i) => {
    nodes.push({ id: `dec:${d.id}`, type: "decision", position: { x: COL.decision, y: i * ROW }, data: { id: d.id } });
    edges.push(edge(`e-dec-${i}`, i === 0 ? focusId : `dec:${decisions[i - 1].id}`, `dec:${d.id}`, { className: "chain" }));
  });

  // Rows: each source sits at its producer's row or the next free slot below; claims likewise next to their source.
  const rowOfSource: Record<string, number> = {};
  let nextSrc = 0;
  const ordered = srcIds.map((sid, k) => ({ sid, p: producerIdx(sid, k) })).sort((a, b) => (a.p < 0 ? 1e9 : a.p) - (b.p < 0 ? 1e9 : b.p));
  ordered.forEach(({ sid, p }) => {
    const want = p >= 0 ? p * ROW : nextSrc;
    const y = Math.max(want, nextSrc);
    rowOfSource[sid] = y;
    nextSrc = y + 92;
    nodes.push({ id: `src:${sid}`, type: "source", position: { x: COL.source, y }, data: { id: sid } });
    const search = decisions.filter((d) => d.action === "search" && d.results?.includes(sid)).slice(0, 1);
    const reads = decisions.filter((d) => d.action === "read" && d.source_id === sid);
    for (const d of [...search, ...reads]) edges.push(edge(`e-ds-${d.id}-${sid}`, `dec:${d.id}`, `src:${sid}`, { className: d.action === "read" ? "read" : "" }));
    if (!search.length && !reads.length && p >= 0) edges.push(edge(`e-ds-${sid}`, `dec:${decisions[p].id}`, `src:${sid}`));
  });

  let nextClaim = 0;
  const bySource = [...claims].sort((a, b) => (rowOfSource[a.source_id] ?? 0) - (rowOfSource[b.source_id] ?? 0));
  bySource.forEach((c) => {
    const y = Math.max(rowOfSource[c.source_id] ?? 0, nextClaim);
    nextClaim = y + 100;
    nodes.push({ id: `clm:${c.id}`, type: "claim", position: { x: COL.claim, y }, data: { id: c.id } });
    if (rowOfSource[c.source_id] !== undefined) edges.push(edge(`e-sc-${c.id}`, `src:${c.source_id}`, `clm:${c.id}`));
  });
  // Corroborate / contradict links between claims of this direction.
  const here = new Set(claims.map((c) => c.id));
  claims.forEach((c) =>
    (c.links ?? []).forEach((l, i) => {
      if (here.has(l.target)) edges.push(edge(`e-cl-${c.id}-${i}`, `clm:${c.id}`, `clm:${l.target}`, { className: l.relation }));
    }),
  );
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

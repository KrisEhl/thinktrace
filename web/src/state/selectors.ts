import type { Claim, Decision, GraphNode, Message, Source } from "../api/types";
import type { RunState } from "./reducer";

export const children = (st: RunState, id: string) => Object.values(st.nodes).filter((n) => n.parent_id === id);

export const descendantDirections = (st: RunState, id: string): GraphNode[] =>
  children(st, id).flatMap((c) => (c.kind === "direction" ? [c] : descendantDirections(st, c.id)));

export function nodeConfidence(st: RunState, id: string): number | undefined {
  const n = st.nodes[id];
  if (!n) return undefined;
  if (n.confidence !== undefined) return n.confidence;
  const xs = descendantDirections(st, id)
    .filter((d) => d.status !== "deactivated" && d.confidence !== undefined && d.confidence > 0) // 0 = unverified, not evidence against
    .map((d) => d.confidence as number);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

export type Tone = "green" | "orange" | "red" | "grey" | "off";

export function nodeTone(st: RunState, id: string): Tone {
  const n = st.nodes[id];
  if (!n) return "grey";
  if (n.status === "deactivated") return "off";
  const c = nodeConfidence(st, id);
  if (c === undefined || c === 0) return "grey";
  if (c >= 0.75) return "green";
  if (c >= 0.5) return "orange";
  return "red";
}

/**
 * Continuous confidence colour: red (not confident) -> orange -> yellow -> green (confident).
 * Backend confidences sit between 0.4 and 0.9, so that range spans the whole gradient.
 * Undefined or 0 (not verified yet) returns undefined so callers keep the grey.
 */
export function confColor(c: number | undefined): string | undefined {
  if (c === undefined || c === 0) return undefined;
  const t = Math.min(1, Math.max(0, (c - 0.4) / 0.5));
  return `hsl(${Math.round(4 + t * 136)} 62% ${Math.round(44 - t * 6)}%)`;
}

export const toneLabel: Record<Tone, string> = {
  green: "well supported",
  orange: "partly supported",
  red: "weak or contested",
  grey: "not verified yet",
  off: "deactivated",
};

export const claimTone = (c: Claim): Tone =>
  c.verified === false || c.confidence === 0 ? "grey" : c.confidence >= 0.75 ? "green" : c.confidence >= 0.5 ? "orange" : "red";

/** Is the claim feeding the answer, and if not, why? Powers the "what is used" tracking. */
export type Usage = { state: "used" | "pending" | "unused"; reason: string };

export function claimUsage(st: RunState, c: Claim): Usage {
  const node = st.nodes[c.node_id];
  if (node?.status === "deactivated") return { state: "unused", reason: "its direction was deactivated" };
  if (c.verified === false) return { state: "unused", reason: "the quote could not be verified in the source" };
  const cited = st.answer.some((s) => s.claim_ids.includes(c.id));
  if (cited) return { state: "used", reason: "cited in the answer" };
  if (st.status === "running" && st.answer.length === 0) return { state: "pending", reason: "answer not written yet" };
  return { state: "unused", reason: "not cited in the answer" };
}

export const claimsOfNode = (st: RunState, node_id: string) => Object.values(st.claims).filter((c) => c.node_id === node_id);
export const claimsOfSource = (st: RunState, source_id: string) => Object.values(st.claims).filter((c) => c.source_id === source_id);
export const decisionsOfNode = (st: RunState, node_id: string) => st.decisions.filter((d) => d.node_id === node_id);

export function sourceUsage(st: RunState, s: Source) {
  const cs = claimsOfSource(st, s.id);
  const usages = cs.map((c) => claimUsage(st, c).state);
  const used = usages.filter((u) => u === "used").length;
  const state: Usage["state"] = used > 0 ? "used" : usages.includes("pending") ? "pending" : "unused";
  return { claims: cs, used, state };
}

export function originGroups(st: RunState) {
  const g: Record<string, Source[]> = {};
  for (const s of Object.values(st.sources)) (g[s.origin_id] ??= []).push(s);
  return g;
}

/** Notes: each user message with the agent reply that follows it on the same node. */
export function notes(st: RunState) {
  const out: { n: number; user: (typeof st.messages)[number]; agent?: (typeof st.messages)[number] }[] = [];
  st.messages.forEach((m, i) => {
    if (m.role !== "user") return;
    const agent = st.messages.slice(i + 1).find((x) => x.role === "agent" && x.node_id === m.node_id);
    out.push({ n: out.length + 1, user: m, agent });
  });
  return out;
}

export const answerSentencesCiting = (st: RunState, claim_id: string) =>
  st.answer.map((s, i) => ({ s, i })).filter(({ s }) => s.claim_ids.includes(claim_id));

export const claimNumber = (id: string) => id.replace(/^c/, "");

/** All directions at or under a node, depth first (follow-up branches sit right after their parent). */
export const directionsUnder = (st: RunState, id: string): GraphNode[] => {
  const n = st.nodes[id];
  const here = n?.kind === "direction" ? [n] : [];
  return [...here, ...children(st, id).flatMap((c) => directionsUnder(st, c.id))];
};

export type LaneItem =
  | { kind: "decision"; key: string; d: Decision }
  | { kind: "claim"; key: string; c: Claim }
  | { kind: "message"; key: string; m: Message };

/** One direction's activity in arrival order: what it searched and read, what it concluded, and what you told it. */
export function laneItems(st: RunState, node_id: string): LaneItem[] {
  const items: (LaneItem & { at: number })[] = [
    ...st.decisions.filter((d) => d.node_id === node_id).map((d, i) => ({ kind: "decision" as const, key: `dec:${d.id}`, d, at: st.arrived[`dec:${d.id}`] ?? i })),
    ...claimsOfNode(st, node_id).map((c, i) => ({ kind: "claim" as const, key: `clm:${c.id}`, c, at: st.arrived[`clm:${c.id}`] ?? i + 0.5 })),
    ...st.messages.filter((m) => m.node_id === node_id && node_id !== "q").map((m, i) => ({ kind: "message" as const, key: `msg:${m.id}`, m, at: st.arrived[`msg:${m.id}`] ?? i })),
  ];
  return items.sort((a, b) => a.at - b.at);
}

export type SentenceImpact = "weakened" | "unsupported";

/**
 * Reverse trace of one source: the claims quoted from it, the answer sentences citing those claims, and a
 * client-side "what if I reject it" preview. A sentence becomes unsupported when every claim it cites is lost
 * (quoted from this source, or already failed its quote check); weakened when some cited claims survive.
 */
export function rejectImpact(st: RunState, source_id: string) {
  const claims = claimsOfSource(st, source_id);
  const lost = new Set(claims.map((c) => c.id));
  const byIndex: (SentenceImpact | undefined)[] = [];
  const sentences = st.answer.flatMap((s, i) => {
    const hit = s.claim_ids.filter((id) => lost.has(id));
    if (!hit.length) return [];
    const left = s.claim_ids.filter((id) => !lost.has(id) && st.claims[id]?.verified !== false);
    const state: SentenceImpact = left.length ? "weakened" : "unsupported";
    byIndex[i] = state;
    return [{ s, i, lost: hit, left, state }];
  });
  const perNode: Record<string, number> = {};
  for (const c of claims) perNode[c.node_id] = (perNode[c.node_id] ?? 0) + 1;
  const directions = Object.entries(perNode).map(([node_id, n]) => ({ node_id, lost: n, total: claimsOfNode(st, node_id).length }));
  // Claims from other sources that corroborate a lost one: the finding survives, though not cited by that sentence.
  const backups = claims.flatMap((c) =>
    Object.values(st.claims)
      .filter((o) => !lost.has(o.id) && [...(c.links ?? []).filter((l) => l.target === o.id), ...(o.links ?? []).filter((l) => l.target === c.id)].some((l) => l.relation === "corroborates"))
      .map((o) => ({ lost: c.id, backup: o.id })),
  );
  const source = st.sources[source_id];
  const echoes = source ? Object.values(st.sources).filter((s) => s.origin_id === source.origin_id && s.id !== source_id) : [];
  return { source, claims, sentences, byIndex, directions, backups, echoes };
}

/**
 * Provenance chain of one claim, from the answer down to the plan:
 * answer sentences -> claim -> quote -> source -> read / search decision (+ the agent's reason) -> direction -> plan reason.
 */
export function provenance(st: RunState, claim_id: string) {
  const claim = st.claims[claim_id];
  if (!claim) return null;
  const decs = decisionsOfNode(st, claim.node_id);
  const read = decs.find((d) => d.action === "read" && d.source_id === claim.source_id);
  const search = decs.find((d) => d.action === "search" && d.results?.includes(claim.source_id));
  const incoming = Object.values(st.claims).flatMap((o) =>
    (o.links ?? []).filter((l) => l.target === claim.id).map((l) => ({ ...l, other: o.id })),
  );
  const outgoing = (claim.links ?? []).map((l) => ({ ...l, other: l.target }));
  return {
    claim,
    node: st.nodes[claim.node_id],
    source: st.sources[claim.source_id],
    read,
    search,
    sentences: answerSentencesCiting(st, claim_id),
    links: [...outgoing, ...incoming],
    usage: claimUsage(st, claim),
    /** React Flow ids of the path in the direction's activity layer. */
    path: [claim.node_id, search && `dec:${search.id}`, read && `dec:${read.id}`, `src:${claim.source_id}`, `clm:${claim.id}`].filter(Boolean) as string[],
  };
}

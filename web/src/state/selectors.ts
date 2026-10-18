import type { Claim, GraphNode, Source } from "../api/types";
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

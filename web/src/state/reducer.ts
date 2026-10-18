import type {
  AnswerSentence,
  Assumption,
  Claim,
  Cost,
  Decision,
  GlassboxEvent,
  GraphNode,
  GraphSnapshot,
  Message,
  Source,
} from "../api/types";

// Pure event -> state function. The same reducer rebuilds state from a snapshot or from a live stream,
// so "replay a recorded run" and "live run" go through identical code.

export interface RunState {
  run_id: string | null;
  question: string;
  status: "idle" | "running" | "finished" | "error";
  error?: string;
  assumptions: Assumption[];
  nodes: Record<string, GraphNode>;
  sources: Record<string, Source>;
  claims: Record<string, Claim>;
  decisions: Decision[];
  messages: Message[];
  answer: AnswerSentence[];
  answer_meta: { version: number; changed: string[]; dropped: string[] };
  cost: Cost;
  needs_human: Record<string, string>; // node_id -> reason
  stop_reasons: Record<string, string>;
  recently_changed: Record<string, number>; // node_id -> event seq, drives the "what changed" cue
  arrived: Record<string, number>; // "dec:<id>" / "clm:<id>" / "msg:<id>" -> event seq it arrived at, orders the lanes view
  seq: number;
}

export const emptyRun = (): RunState => ({
  run_id: null,
  question: "",
  status: "idle",
  assumptions: [],
  nodes: {},
  sources: {},
  claims: {},
  decisions: [],
  messages: [],
  answer: [],
  answer_meta: { version: 0, changed: [], dropped: [] },
  cost: { sources: 0, steers: 0, restarts: 0, eur: 0 },
  needs_human: {},
  stop_reasons: {},
  recently_changed: {},
  arrived: {},
  seq: 0,
});

export function fromSnapshot(s: GraphSnapshot): RunState {
  const by = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
  return {
    ...emptyRun(),
    run_id: s.run_id,
    question: s.question,
    status: s.status,
    assumptions: s.assumptions,
    nodes: by(s.nodes),
    sources: by(s.sources),
    claims: by(s.claims),
    decisions: s.decisions,
    messages: s.messages,
    answer: s.answer,
    cost: s.cost,
  };
}

const touch = (st: RunState, ...ids: (string | undefined)[]) => {
  const next = { ...st.recently_changed };
  for (const id of ids) if (id) next[id] = st.seq;
  return next;
};

export function applyEvent(prev: RunState, e: GlassboxEvent): RunState {
  const st: RunState = { ...prev, seq: prev.seq + 1 };
  switch (e.type) {
    case "run_started":
      return { ...emptyRun(), run_id: e.run_id, question: e.question, status: "running", seq: st.seq };
    case "run_finished":
      return { ...st, status: "finished" };
    case "error":
      return { ...st, status: "error", error: e.message };
    case "assumption_created":
      return { ...st, assumptions: [...st.assumptions, e.assumption] };
    case "direction_created":
      return { ...st, nodes: { ...st.nodes, [e.node.id]: e.node }, recently_changed: touch(st, e.node.id) };
    case "source_added":
      return { ...st, sources: { ...st.sources, [e.source.id]: e.source } };
    case "claim_added": {
      const n = st.nodes[e.claim.node_id];
      return {
        ...st,
        claims: { ...st.claims, [e.claim.id]: e.claim },
        arrived: { ...st.arrived, [`clm:${e.claim.id}`]: st.seq },
        nodes: n ? { ...st.nodes, [n.id]: { ...n } } : st.nodes,
        recently_changed: touch(st, e.claim.node_id),
      };
    }
    case "claim_verified": {
      const c = st.claims[e.claim_id];
      if (!c) return st;
      return { ...st, claims: { ...st.claims, [c.id]: { ...c, verified: e.verified, span: e.span } } };
    }
    case "confidence_changed": {
      let next = st;
      if (e.claim_id && st.claims[e.claim_id]) {
        const c = st.claims[e.claim_id];
        next = {
          ...next,
          claims: { ...next.claims, [c.id]: { ...c, confidence: e.confidence, origin_ids: e.origin_ids ?? c.origin_ids } },
        };
      }
      if (e.node_id && st.nodes[e.node_id]) {
        next = {
          ...next,
          nodes: { ...next.nodes, [e.node_id]: { ...st.nodes[e.node_id], confidence: e.confidence } },
          recently_changed: touch(next, e.node_id),
        };
      }
      return next;
    }
    case "verdict_set":
      return {
        ...st,
        nodes: { ...st.nodes, [e.node_id]: { ...st.nodes[e.node_id], verdict: e.verdict, status: "done" } },
        recently_changed: touch(st, e.node_id),
      };
    case "decision": {
      const n = st.nodes[e.decision.node_id];
      const nodes = n
        ? {
            ...st.nodes,
            [n.id]: {
              ...n,
              status: n.status === "deactivated" ? n.status : ("running" as const),
              traffic: n.traffic + (e.decision.action === "stop" ? 0 : 1),
            },
          }
        : st.nodes;
      return {
        ...st,
        nodes,
        decisions: [...st.decisions, e.decision],
        arrived: { ...st.arrived, [`dec:${e.decision.id}`]: st.seq },
        recently_changed: touch(st, e.decision.node_id),
      };
    }
    case "direction_stopped": {
      const n = st.nodes[e.node_id];
      return {
        ...st,
        nodes: n && n.status !== "deactivated" ? { ...st.nodes, [n.id]: { ...n, status: "done" } } : st.nodes,
        stop_reasons: { ...st.stop_reasons, [e.node_id]: e.reason },
        recently_changed: touch(st, e.node_id),
      };
    }
    case "steer_applied": {
      const n = e.node_id ? st.nodes[e.node_id] : undefined;
      let nodes = st.nodes;
      if (n && e.action === "deactivate") nodes = { ...nodes, [n.id]: { ...n, status: "deactivated" } };
      return {
        ...st,
        nodes,
        cost: { ...st.cost, steers: st.cost.steers + 1 },
        recently_changed: touch(st, e.node_id),
      };
    }
    case "stale_marked": {
      const nodes = { ...st.nodes };
      for (const id of e.node_ids) if (nodes[id]) nodes[id] = { ...nodes[id], status: "stale" };
      return { ...st, nodes, recently_changed: touch(st, ...e.node_ids) };
    }
    case "needs_human": {
      const n = st.nodes[e.node_id];
      return {
        ...st,
        nodes: n ? { ...st.nodes, [n.id]: { ...n, needs_human: true } } : st.nodes,
        needs_human: { ...st.needs_human, [e.node_id]: e.reason },
        recently_changed: touch(st, e.node_id),
      };
    }
    case "message": {
      const exists = st.messages.some((m) => m.id === e.message.id);
      const messages = exists ? st.messages.map((m) => (m.id === e.message.id ? e.message : m)) : [...st.messages, e.message];
      const arrived = exists ? st.arrived : { ...st.arrived, [`msg:${e.message.id}`]: st.seq };
      return { ...st, messages, arrived, recently_changed: touch(st, e.message.node_id) };
    }
    case "answer_updated":
      return {
        ...st,
        answer: e.answer,
        answer_meta: { version: e.version ?? st.answer_meta.version + 1, changed: e.changed ?? [], dropped: e.dropped ?? [] },
      };
    case "node_patch": {
      const n = st.nodes[e.node_id];
      if (!n) return st;
      return { ...st, nodes: { ...st.nodes, [n.id]: { ...n, ...e.patch } }, recently_changed: touch(st, n.id) };
    }
    case "cost_updated":
      return { ...st, cost: e.cost };
  }
}

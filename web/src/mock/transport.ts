import type { CreateRunRequest, GlassboxEvent, GraphSnapshot, Source, SteerRequest, Transport } from "../api/types";
import { applyEvent, emptyRun, type RunState } from "../state/reducer";
import { scriptedRun, SOURCES, type Step } from "./fixture";

// In-browser stand-in for the backend. Same Transport interface, same event stream, so the UI cannot tell the difference.
// `speed` > 1 plays faster (handy while developing).

const toSnapshot = (st: RunState): GraphSnapshot => ({
  run_id: st.run_id ?? "",
  question: st.question,
  status: st.status === "idle" ? "running" : st.status,
  assumptions: st.assumptions,
  nodes: Object.values(st.nodes),
  sources: Object.values(st.sources),
  claims: Object.values(st.claims),
  decisions: st.decisions,
  messages: st.messages,
  answer: st.answer,
  cost: st.cost,
});

export function mockTransport(speed = 1): Transport {
  let state = emptyRun();
  let log: GlassboxEvent[] = [];
  const listeners = new Set<(e: GlassboxEvent) => void>();
  let timers: number[] = [];
  let mid = 100;
  let did = 1000;

  const emit = (e: GlassboxEvent) => {
    log.push(e);
    state = applyEvent(state, e);
    listeners.forEach((l) => l(e));
  };

  /** Play steps with cumulative delays, returns total duration. */
  const play = (steps: Step[], offset = 0) => {
    let t = offset;
    for (const [d, e] of steps) {
      t += d / speed;
      timers.push(window.setTimeout(() => emit(e), t));
    }
    return t;
  };

  const dec = (node_id: string, action: "search" | "read" | "stop", why: string, extra: object = {}) =>
    ({ type: "decision", decision: { id: `dec${did++}`, node_id, action, why, ts: Date.now(), ...extra } }) as GlassboxEvent;

  const childrenOf = (id: string) => Object.values(state.nodes).filter((n) => n.parent_id === id);
  const descendants = (id: string): string[] => childrenOf(id).flatMap((c) => [c.id, ...descendants(c.id)]);

  const refreshAnswer = () => {
    // Sentences that cite only claims from deactivated nodes are dropped; others stay.
    const dead = (cid: string) => state.nodes[state.claims[cid]?.node_id]?.status === "deactivated";
    const answer = state.answer.filter((s) => s.claim_ids.length === 0 || s.claim_ids.some((c) => !dead(c)));
    emit({ type: "answer_updated", answer });
  };

  // Canned "dig deeper" outcomes so the demo path is meaningful.
  const dig: Record<string, Step[]> = {
    "m-cust": [
      [400, dec("m-cust", "search", "Only the vendor lists customers. Look for a customer case study.", { query: "Acme Robotics customer case study parcel carrier" })],
      [700, { type: "source_added", source: { id: "s12", origin_id: "o-carrier", domain: "parcel-carrier.example", title: "Carrier press release", url: "https://parcel-carrier.example/s12", origin: "web", text: "Press release. We have rolled out Acme PickBot X2 robots at our Hamburg hub since January." } }],
      [400, { type: "claim_added", claim: { id: "c13", node_id: "m-cust", source_id: "s12", text: "A parcel carrier confirms a PickBot X2 rollout in Hamburg.", quote: "rolled out Acme PickBot X2 robots at our Hamburg hub", verified: null, span: null, confidence: 0, origin_ids: ["o-carrier"] } }],
      [300, { type: "claim_verified", claim_id: "c13", verified: true, span: [23, 75] }],
      [200, { type: "confidence_changed", claim_id: "c13", confidence: 0.75, origin_ids: ["o-acme", "o-carrier"] }],
      [300, { type: "confidence_changed", node_id: "m-cust", confidence: 0.75 }],
      [200, { type: "verdict_set", node_id: "m-cust", verdict: "yes" }],
      [100, { type: "direction_stopped", node_id: "m-cust", reason: "A customer independently confirms a deployment." }],
    ],
    "l-liab": [
      [400, dec("l-liab", "search", "No source states the figure. Search commercial registers and insurer statements.", { query: "Acme Robotics GmbH Betriebshaftpflicht" })],
      [900, dec("l-liab", "stop", "Nothing found after a second pass. Handing this to the user.", {})],
      [200, { type: "needs_human", node_id: "l-liab", reason: "Still no source after digging. Ask the vendor for an insurance certificate." }],
    ],
  };

  return {
    async createRun(_req: CreateRunRequest) {
      timers.forEach(clearTimeout);
      timers = [];
      state = emptyRun();
      log = [];
      const run_id = `run-${Date.now().toString(36)}`;
      play(scriptedRun(run_id));
      return { run_id };
    },

    subscribe(_run_id, onEvent, onClose) {
      log.forEach(onEvent); // late subscribers catch up first
      listeners.add(onEvent);
      void onClose;
      return () => listeners.delete(onEvent);
    },

    async getGraph() {
      return toSnapshot(state);
    },

    async steer(_run_id, req: SteerRequest) {
      const { action, node_id, text } = req;
      const node = node_id ? state.nodes[node_id] : undefined;
      if (action === "chat") {
        const target = node_id ?? "q";
        const um = ++mid;
        emit({ type: "message", message: { id: `m${um}`, role: "user", text: text ?? "", node_id: target } });
        const am = ++mid;
        emit({ type: "message", message: { id: `m${am}`, role: "agent", text: "Looking into that…", node_id: target, pending: true } });
        const nid = `x${am}`;
        play(
          [
            [600, { type: "direction_created", node: { id: nid, kind: "direction", parent_id: target, label: (text ?? "follow-up").slice(0, 28), status: "running", traffic: 0 } }],
            [500, dec(nid, "search", `Follow-up asked on "${node?.label ?? "the question"}": search for it directly.`, { query: text })],
            [900, dec(nid, "stop", "Stopped: no concrete evidence in this spike.", {})],
            [200, { type: "confidence_changed", node_id: nid, confidence: 0.3 }],
            [200, { type: "verdict_set", node_id: nid, verdict: "uncertain" }],
            [100, { type: "direction_stopped", node_id: nid, reason: "Spike mock: no evidence collected." }],
            [100, { type: "message", message: { id: `m${am}`, role: "agent", text: "I opened a new branch for this but the mock has no evidence for it. With the real backend this is where claims would appear.", node_id: target } }],
          ],
          0,
        );
        return;
      }
      if (!node) return;
      emit({ type: "steer_applied", action, node_id, text });
      if (action === "deactivate") {
        descendants(node.id).forEach((id) => emit({ type: "steer_applied", action, node_id: id }));
        refreshAnswer();
      } else if (action === "dig_deeper") {
        play(dig[node.id] ?? [[400, dec(node.id, "stop", "Nothing more to find in this mock.", {})]]);
      } else if (action === "fix") {
        const stale = [node.id, ...(node.parent_id ? childrenOf(node.parent_id).map((n) => n.id) : [])].filter((v, i, a) => a.indexOf(v) === i);
        emit({ type: "stale_marked", node_ids: stale });
        play(
          stale.flatMap((id, i): Step[] => [
            [i === 0 ? 1200 : 500, dec(id, "search", `Re-running with the corrected assumption${text ? `: "${text}"` : ""}.`, {})],
            [400, { type: "verdict_set", node_id: id, verdict: state.nodes[id]?.verdict ?? "uncertain" }],
          ]),
        );
      }
    },

    async getSource(id): Promise<Source> {
      const s = state.sources[id] ?? SOURCES.find((x) => x.id === id);
      if (!s) throw new Error("unknown source");
      return s;
    },

    async health() {
      return { ok: true, models: ["mock"], tavily: false };
    },
  };
}

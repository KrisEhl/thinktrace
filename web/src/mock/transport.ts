import type { CreateRunRequest, GlassboxEvent, GraphSnapshot, SimOp, Source, SteerRequest, Transport } from "../api/types";
import { applyEvent, emptyRun, type RunState } from "../state/reducer";
import { children } from "../state/selectors";
import { SCENARIOS, scriptedRun, SOURCES, type Step } from "./fixture";
import { gpuRun } from "./gpu";
import { marketRun } from "./market";
import { compose, labelFrom, research } from "./sim";

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

const confFor = (n: number) => (n >= 3 ? 0.9 : n === 2 ? 0.75 : n === 1 ? 0.5 : 0);

export function mockTransport(speed = 1): Transport {
  let state = emptyRun();
  let log: GlassboxEvent[] = [];
  const listeners = new Set<(e: GlassboxEvent) => void>();
  let pending: { timer: number; due: number; e: GlassboxEvent }[] = [];
  let mid = 100;
  let did = 1000;
  let evn = 1;

  const emit = (e: GlassboxEvent) => {
    log.push(e);
    state = applyEvent(state, e);
    listeners.forEach((l) => l(e));
  };

  /** Play steps with cumulative delays after `offset`; returns the time (ms from now) of the last step. */
  const play = (steps: Step[], offset = 0) => {
    let t = offset;
    for (const [d, e] of steps) {
      t += d / speed;
      const entry = { timer: 0, due: performance.now() + t, e };
      entry.timer = window.setTimeout(() => {
        pending = pending.filter((p) => p !== entry);
        emit(e);
      }, t);
      pending.push(entry);
    }
    return t;
  };

  const flush = () => {
    const rest = [...pending].sort((a, b) => a.due - b.due);
    pending = [];
    rest.forEach((p) => {
      clearTimeout(p.timer);
      emit(p.e);
    });
  };

  const dec = (node_id: string, action: "search" | "read" | "stop", why: string, extra: object = {}) =>
    ({ type: "decision", decision: { id: `dec${did++}`, node_id, action, why, ts: Date.now(), ...extra } }) as GlassboxEvent;

  const descendants = (id: string): string[] => children(state, id).flatMap((c) => [c.id, ...descendants(c.id)]);
  const originsOf = (node_id: string) => [...new Set(Object.values(state.claims).filter((c) => c.node_id === node_id && c.verified).flatMap((c) => c.origin_ids))];

  const refreshAnswer = () => {
    // Sentences that cite only claims from deactivated nodes are dropped; others stay.
    const dead = (cid: string) => state.nodes[state.claims[cid]?.node_id]?.status === "deactivated";
    emit({ type: "answer_updated", answer: state.answer.filter((s) => s.claim_ids.length === 0 || s.claim_ids.some((c) => !dead(c))) });
  };

  const newMessageId = () => `m${++mid}`;

  /** Chat: answer from the graph, and open a researched branch when nothing relevant exists. */
  const chat = (node_id: string, text: string) => {
    const reply = compose(state, node_id, text);
    emit({ type: "message", message: { id: newMessageId(), role: "user", text, node_id } });
    const aid = newMessageId();
    if (!reply.branch) {
      play([[500, { type: "message", message: { id: aid, role: "agent", text: reply.text, node_id, claim_ids: reply.claim_ids } }]]);
      return;
    }
    emit({ type: "message", message: { id: aid, role: "agent", text: reply.text, node_id, claim_ids: reply.claim_ids, pending: true } });
    const r = research(node_id, labelFrom(text), text.replace(/[?.!]+$/, ""));
    const end = play(r.steps);
    const label = labelFrom(text);
    play([[0, { type: "message", message: { id: aid, role: "agent", node_id, claim_ids: r.claim_ids, text: `${reply.claim_ids.length ? reply.text + " " : ""}Branch “${label}” is done: ${r.claim_ids.length} claim(s) from ${r.claim_ids.length} source(s). Click a citation to check the quote. (Mock data: invented to exercise the UI.)` } }]], end + 200);
  };

  const simulate = (op: SimOp, node_id?: string) => {
    if (op === "skip_to_end") return flush();
    const node = node_id ? state.nodes[node_id] : undefined;
    const id = node_id ?? "q";
    const n = evn++;
    if (op === "add_branch") {
      const r = research(id, `Side question ${n}`, `side question ${n} on ${node?.label ?? "the topic"}`);
      play(r.steps);
    } else if (op === "add_evidence" && node) {
      const origins = [...originsOf(id), `o-ev${n}`];
      const text = `Additional corroboration for ${node.label}. A new independent report confirms the picture.`;
      const quote = "A new independent report confirms the picture.";
      const i = text.indexOf(quote);
      const src: Source = { id: `sev${n}`, origin_id: `o-ev${n}`, domain: `extra-evidence-${n}.example`, title: `Extra evidence ${n}`, url: `https://extra-evidence-${n}.example/`, origin: "web", text };
      play([
        [300, dec(id, "search", "Dig deeper: look for another independent source.", { query: `${node.label} independent report` })],
        [400, { type: "source_added", source: src }],
        [250, { type: "claim_added", claim: { id: `cev${n}`, node_id: id, source_id: src.id, text: `A new independent source corroborates “${node.label}”.`, quote, verified: null, span: null, confidence: 0, origin_ids: origins } }],
        [250, { type: "claim_verified", claim_id: `cev${n}`, verified: true, span: [i, i + quote.length] }],
        [200, { type: "confidence_changed", claim_id: `cev${n}`, confidence: confFor(origins.length), origin_ids: origins }],
        [250, { type: "confidence_changed", node_id: id, confidence: confFor(origins.length) }],
        [150, { type: "verdict_set", node_id: id, verdict: "yes" }],
      ]);
    } else if (op === "contradict" && node) {
      const text = `A conflicting report disputes the picture for ${node.label}. Another source reaches the opposite conclusion.`;
      const quote = "Another source reaches the opposite conclusion.";
      const i = text.indexOf(quote);
      const src: Source = { id: `scx${n}`, origin_id: `o-cx${n}`, domain: `dissent-${n}.example`, title: `Dissenting report ${n}`, url: `https://dissent-${n}.example/`, origin: "web", text };
      play([
        [300, dec(id, "search", "Check for disagreement before settling.", { query: `${node.label} criticism` })],
        [400, { type: "source_added", source: src }],
        [250, { type: "claim_added", claim: { id: `ccx${n}`, node_id: id, source_id: src.id, text: `A conflicting report disputes “${node.label}”.`, quote, verified: null, span: null, confidence: 0, origin_ids: [src.origin_id] } }],
        [250, { type: "claim_verified", claim_id: `ccx${n}`, verified: true, span: [i, i + quote.length] }],
        [200, { type: "confidence_changed", claim_id: `ccx${n}`, confidence: 0.4, origin_ids: [src.origin_id] }],
        [250, { type: "confidence_changed", node_id: id, confidence: 0.4 }],
        [150, { type: "verdict_set", node_id: id, verdict: "uncertain" }],
        [150, { type: "needs_human", node_id: id, reason: "A new source contradicts the earlier ones. Which should win?" }],
      ]);
    } else if (op === "mark_stale" && node) {
      const ids = [id, ...descendants(id)];
      emit({ type: "stale_marked", node_ids: ids });
      play(ids.flatMap((x, k): Step[] => [[k === 0 ? 1500 : 350, dec(x, "search", "Re-running after an upstream change.", {})], [300, { type: "verdict_set", node_id: x, verdict: state.nodes[x]?.verdict ?? "uncertain" }]]));
    } else if (op === "needs_you") {
      emit({ type: "needs_human", node_id: id, reason: "Marked by you: I should not decide this alone." });
    }
  };

  // Canned "dig deeper" outcomes for the vendor scenario so its demo path is meaningful.
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
    scenarios: SCENARIOS,
    simulate,

    async createRun(req: CreateRunRequest) {
      pending.forEach((p) => clearTimeout(p.timer));
      pending = [];
      state = emptyRun();
      log = [];
      const run_id = `run-${Date.now().toString(36)}`;
      play(req.scenario === "market" ? marketRun(run_id) : req.scenario === "gpu" ? gpuRun(run_id) : scriptedRun(run_id));
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
      if (action === "chat") return chat(node_id ?? "q", text ?? "");
      const node = node_id ? state.nodes[node_id] : undefined;
      if (!node) return;
      emit({ type: "steer_applied", action, node_id, text });
      if (action === "deactivate") {
        descendants(node.id).forEach((id) => emit({ type: "steer_applied", action, node_id: id }));
        refreshAnswer();
      } else if (action === "dig_deeper") {
        play(dig[node.id] ?? []);
        if (!dig[node.id]) simulate("add_evidence", node.id);
      } else if (action === "fix") {
        const stale = [node.id, ...(node.parent_id ? children(state, node.parent_id).map((n) => n.id) : [])].filter((v, i, a) => a.indexOf(v) === i);
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

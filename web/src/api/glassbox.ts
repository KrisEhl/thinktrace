import type { AnswerSentence, Claim, ClaimLink, Decision, GlassboxEvent, GraphNode, StopReason } from "./types";

// Translates the backend's envelope events (docs/agent-and-event-logging.md, section 4) into the UI's event model.
// Stateful: evidence status depends on claim groups, so the translator tracks claims and links as they arrive.
// One translator per stream; feed events in seq order.

export interface Envelope {
  v: number;
  seq: number;
  ts: string;
  run_id: string;
  type: string;
  span: string | null;
  parent_span: string | null;
  dir: string | null;
  agent: string;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const ROOT = "q";

const short = (s: string, n = 34) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export const STOP_LABEL: Record<StopReason, string> = {
  enough_evidence: "enough evidence",
  nothing_new: "nothing new",
  budget: "budget used up",
  dropped_by_user: "dropped by you",
  no_reason: "ended without a stop reason",
};

/** Split the writer's markdown into sentences, keeping the [c#] ids each one cites. */
export function splitAnswer(markdown: string): AnswerSentence[] {
  const out: AnswerSentence[] = [];
  for (const raw of markdown.split(/\n+/)) {
    const line = raw.replace(/^\s*(#+|[-*]|\d+\.)\s+/, "").trim();
    if (!line) continue;
    // A sentence ends at . ! ? optionally followed by citations, then whitespace and a capital / quote / digit.
    const parts = line.split(/(?<=[.!?](?:\s*\[[a-z]+\d+\])*)\s+(?=["“(A-Z0-9])/);
    for (const p of parts) {
      const claim_ids = [...p.matchAll(/\[(c\d+)\]/g)].map((m) => m[1]);
      const text = p.replace(/\s*\[c\d+\]/g, "").replace(/\s+([.,;:])/g, "$1").trim();
      if (text) out.push({ text, claim_ids: [...new Set(claim_ids)] });
    }
  }
  return out;
}

export class Translator {
  private claims = new Map<string, Claim>();
  private domains = new Map<string, string>(); // source_id -> domain
  private lastWhy = new Map<string, { reason: string; reflection?: string } | null>();
  private needs = new Set<string>(); // dir:reason already emitted
  private reportVersion = 0;
  private sourcesSeen = 0;
  private steers = 0;
  private question = "";

  /** Translate one envelope into zero or more UI events. */
  apply(e: Envelope): GlassboxEvent[] {
    const d = e.data ?? {};
    const dir = e.dir ?? undefined;
    const ts = Date.parse(e.ts) || Date.now();
    const out: GlassboxEvent[] = [];
    const decision = (dec: Omit<Decision, "id" | "ts">) =>
      out.push({ type: "decision", decision: { id: `ev${e.seq}`, ts, ...dec } });

    switch (e.type) {
      case "run.started":
        this.question = d.question ?? "";
        out.push({ type: "run_started", run_id: e.run_id, question: this.question });
        out.push({ type: "direction_created", node: node(ROOT, "question", null, this.question, { title: this.question }) });
        out.push({ type: "message", message: { id: "m-question", role: "user", text: this.question, node_id: ROOT } });
        break;

      case "plan.created":
      case "plan.updated":
        for (const x of (d.directions ?? d.added ?? []) as { id: string; title: string; why?: string; queries?: string[]; from_dir?: string; parent?: string }[]) {
          out.push({
            type: "direction_created",
            // A follow-up grows from the node it was asked on.
            node: node(x.id, "direction", x.parent ?? ROOT, x.title, { title: x.title, why: x.why, queries: x.queries, from_dir: x.from_dir }),
          });
        }
        if (d.fallback) out.push({ type: "message", message: { id: `m-plan-${e.seq}`, role: "agent", text: "The agent made no plan, so the system started the question as a single direction.", node_id: ROOT } });
        break;

      case "direction.started":
        if (d.adhoc) out.push({ type: "direction_created", node: node(d.id, "direction", ROOT, d.title ?? d.id, { title: d.title }) });
        out.push({ type: "node_patch", node_id: d.id ?? dir, patch: { status: "running" } });
        break;

      case "direction.resumed":
        out.push({ type: "node_patch", node_id: d.id ?? dir, patch: { status: "running", stop: undefined } });
        break;

      case "decision":
        // `think`: its reason is attached to the searches / reads that follow it.
        if (dir) this.lastWhy.set(dir, { reason: d.reason ?? "", reflection: d.reflection });
        if (dir && d.next_action === "stop") decision({ node_id: dir, action: "stop", why: d.reason ?? "decided to stop", reflection: d.reflection });
        break;

      case "search.completed": {
        if (!dir) break;
        const why = this.lastWhy.get(dir);
        decision({
          node_id: dir,
          action: "search",
          query: d.query,
          results: (d.results ?? []).map((r: { source_id: string }) => r.source_id),
          why: d.blocked ? `blocked (${d.blocked})` : why?.reason || "no reason given",
          reflection: why?.reflection,
        });
        break;
      }

      case "read.started": {
        if (!dir) break;
        const why = this.lastWhy.get(dir);
        decision({ node_id: dir, action: "read", source_id: d.source_id, why: why?.reason || "no reason given", reflection: why?.reflection });
        break;
      }

      case "source.added":
        this.sourcesSeen++;
        this.domains.set(d.source_id, d.domain);
        out.push({
          type: "source_added",
          source: { id: d.source_id, url: d.url, title: d.title ?? d.url, domain: d.domain, origin_id: d.domain, text: "", origin: "web" },
        });
        break;

      case "claim.recorded": {
        if (!this.domains.has(d.source_id) && d.domain) {
          this.domains.set(d.source_id, d.domain);
          out.push({ type: "source_added", source: { id: d.source_id, url: d.url, title: d.url, domain: d.domain, origin_id: d.domain, text: "", origin: "web" } });
        }
        const links: ClaimLink[] = [];
        if (d.corroborates) links.push({ relation: "corroborates", target: d.corroborates, by: "agent" });
        if (d.contradicts) links.push({ relation: "contradicts", target: d.contradicts, by: "agent" });
        const c: Claim = {
          id: d.claim_id,
          node_id: dir ?? ROOT,
          text: d.text,
          quote: d.quote,
          source_id: d.source_id,
          span: d.span ?? null,
          verified: d.verified !== "not_found",
          match: d.verified,
          verified_against: d.verified_against,
          confidence: 0,
          origin_ids: [],
          links,
        };
        this.claims.set(c.id, c);
        out.push(...this.restatus());
        break;
      }

      case "claim.linked": {
        const c = this.claims.get(d.claim_id);
        if (!c) break;
        c.links = [...(c.links ?? []), { relation: d.relation, target: d.target, by: d.by ?? "checker", reason: d.reason }];
        out.push(...this.restatus());
        break;
      }

      case "direction.finished": {
        const id: string = d.id ?? dir;
        const reason: StopReason = d.reason ?? "no_reason";
        decision({ node_id: id, action: "stop", why: `${STOP_LABEL[reason] ?? reason}${d.summary ? `: ${d.summary}` : ""}` });
        out.push({ type: "direction_stopped", node_id: id, reason: `${STOP_LABEL[reason] ?? reason}${d.summary ? `. ${d.summary}` : ""}` });
        out.push({ type: "node_patch", node_id: id, patch: { status: reason === "dropped_by_user" ? "deactivated" : "done", stop: reason } });
        if (reason === "budget" || reason === "nothing_new" || reason === "no_reason") {
          const mine = [...this.claims.values()].filter((c) => c.node_id === id);
          const strong = mine.filter((c) => c.confidence >= 0.75).length;
          if (strong === 0) out.push(...this.flag(id, mine.length ? "Stopped with only single-origin or unverified evidence." : "Stopped without recording any claim."));
        }
        break;
      }

      case "budget.hit":
        if (dir) out.push({ type: "node_patch", node_id: dir, patch: { budget_hit: true } });
        break;

      case "steer.applied":
        // A steer is the user's input, so it also lands in the chat log and as a sticky note on that direction.
        this.steers++;
        out.push({ type: "steer_applied", action: d.action === "redirect" ? "redirect" : d.action === "follow_up" ? "chat" : "dig_deeper", node_id: d.dir, text: d.text ?? undefined });
        out.push({
          type: "message",
          message: {
            id: `m-steer-${d.steer_id ?? e.seq}`,
            role: "user",
            node_id: d.dir ?? ROOT,
            text:
              d.action === "follow_up"
                ? d.text ?? ""
                : d.action === "redirect"
                  ? `Redirect ${d.dir}${d.text ? `, research instead: ${d.text}` : ""}`
                  : `Dig deeper on ${d.dir}${d.text ? `: ${d.text}` : ""}`,
          },
        });
        if (d.action === "follow_up" && d.new_dir)
          out.push({ type: "message", message: { id: `m-fu-${d.steer_id ?? e.seq}`, role: "agent", node_id: d.dir ?? ROOT, text: `Researching this as a new direction (${d.new_dir}); the answer is rewritten when it finishes.` } });
        break;

      case "steer.delivered":
        out.push({ type: "message", message: { id: `m-steer-ack-${d.steer_id ?? e.seq}`, role: "agent", node_id: d.dir ?? dir ?? ROOT, text: `The ${e.agent} received your instruction (${d.steer_id}).` } });
        break;

      case "check.started":
        out.push({ type: "message", message: { id: `m-check-${e.seq}`, role: "agent", text: `Fact-checking ${d.n_claims} claims for corroboration and contradictions…`, node_id: ROOT, pending: true } });
        break;

      case "synthesis.started":
        out.push({ type: "message", message: { id: `m-report-${d.version ?? this.reportVersion + 1}`, role: "agent", text: `Writing answer v${d.version ?? this.reportVersion + 1} from ${d.n_claims} verified claims…`, node_id: ROOT, pending: true } });
        break;

      case "report.final": {
        this.reportVersion = d.version ?? this.reportVersion + 1;
        const answer = splitAnswer(d.markdown ?? "");
        out.push({ type: "answer_updated", answer, version: this.reportVersion, changed: d.changed ?? [], dropped: d.dropped ?? [] });
        const cited: string[] = d.cited_claim_ids ?? [];
        out.push({
          type: "message",
          message: {
            id: `m-report-${this.reportVersion}`,
            role: "agent",
            node_id: ROOT,
            text: `Answer v${this.reportVersion} · ${cited.length} claims cited${d.dropped?.length ? ` · ${d.dropped.length} uncited sentences dropped` : ""}${d.changed?.length ? ` · ${d.changed.length} changed since v${this.reportVersion - 1}` : ""}`,
            answer,
          },
        });
        break;
      }

      case "run.error":
        out.push({ type: "message", message: { id: `m-err-${e.seq}`, role: "agent", text: `⚠ Error in ${d.where}: ${String(d.message ?? "").slice(0, 200)}`, node_id: dir ?? ROOT } });
        break;

      case "run.finished": {
        const t = d.totals ?? {};
        out.push({ type: "cost_updated", cost: { sources: this.sourcesSeen, steers: t.steers ?? this.steers, restarts: t.restarts ?? 0, eur: t.cost_usd ?? 0 } });
        out.push({ type: "run_finished" });
        break;
      }
    }
    return out;
  }

  private flag(node_id: string, reason: string): GlassboxEvent[] {
    const key = `${node_id}:${reason}`;
    if (this.needs.has(key)) return [];
    this.needs.add(key);
    return [{ type: "needs_human", node_id, reason }];
  }

  /**
   * Evidence status per claim group (spec section 8): grey if the quote was not found, red if the group has a
   * contradiction, green if 2+ distinct domains back it, orange otherwise. Shown as a confidence number so the
   * existing colour scale applies: grey 0, red 0.4, orange 0.5, green 0.75 (0.9 with 3+ domains).
   */
  private restatus(): GlassboxEvent[] {
    const out: GlassboxEvent[] = [];
    const claims = [...this.claims.values()];
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      const p = parent.get(x) ?? x;
      if (p === x) return x;
      const r = find(p);
      parent.set(x, r);
      return r;
    };
    const contradicted = new Set<string>();
    for (const c of claims) {
      for (const l of c.links ?? []) {
        if (!this.claims.has(l.target)) continue;
        if (l.relation === "corroborates") parent.set(find(c.id), find(l.target));
        else {
          contradicted.add(c.id);
          contradicted.add(l.target);
        }
      }
    }
    const groups = new Map<string, Claim[]>();
    for (const c of claims) {
      const r = find(c.id);
      groups.set(r, [...(groups.get(r) ?? []), c]);
    }
    const touchedDirs = new Set<string>();
    for (const c of claims) {
      const group = groups.get(find(c.id)) ?? [c];
      const doms = [...new Set(group.filter((g) => g.match !== "not_found").map((g) => this.domains.get(g.source_id) ?? g.source_id))];
      const red = group.some((g) => contradicted.has(g.id));
      const conf = c.match === "not_found" ? 0 : red ? 0.4 : doms.length >= 3 ? 0.9 : doms.length === 2 ? 0.75 : 0.5;
      const prev = (c as Claim & { _sent?: string })._sent;
      const sig = `${conf}|${doms.join(",")}|${(c.links ?? []).length}`;
      if (prev !== sig) {
        (c as Claim & { _sent?: string })._sent = sig;
        c.confidence = conf;
        c.origin_ids = doms.length ? doms : [this.domains.get(c.source_id) ?? c.source_id];
        out.push({ type: "claim_added", claim: { ...c } });
        touchedDirs.add(c.node_id);
        if (red) out.push(...this.flag(c.node_id, "Claims in this direction contradict each other."));
      }
    }
    for (const id of touchedDirs) {
      const xs = claims.filter((c) => c.node_id === id && c.confidence > 0).map((c) => c.confidence);
      const any = claims.some((c) => c.node_id === id);
      const conf = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : any ? 0 : undefined;
      if (conf !== undefined) out.push({ type: "confidence_changed", node_id: id, confidence: Math.round(conf * 100) / 100 });
    }
    return out;
  }
}

function node(id: string, kind: GraphNode["kind"], parent_id: string | null, title: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, parent_id, label: short(title), status: "idle", traffic: 0, ...extra };
}

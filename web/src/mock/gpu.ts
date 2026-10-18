import type { Claim, GlassboxEvent, GraphNode, Source } from "../api/types";
import { applyEvent, emptyRun } from "../state/reducer";
import { registerMockRatings } from "../state/credibility";
import { forecast } from "../state/forecast";
import type { Step } from "./fixture";

// SYNTHETIC scenario for the time projection: "What does an RTX 5090 cost?" fanned out over its readings
// (launch MSRP, new retail now, used market). All outlets are *.example and all prices after launch are invented.

export const GPU_QUESTION = "What is the price of an RTX 5090? (synthetic data)";

registerMockRatings({
  "techwire.example": 0.88,
  "dailytech-reprint.example": 0.62,
  "pricetracker.example": 0.8,
  "megastore.example": 0.72,
  "pcshop.example": 0.7,
  "gpudirect.example": 0.68,
  "resale-market.example": 0.6,
});

type Obs = [daysAgo: number, value: number, domain: string, verified?: boolean];

const READINGS: { id: string; label: string; why: string; kind: Claim["kind"]; obs: Obs[]; text: (v: number, d: string) => string }[] = [
  {
    id: "r-msrp", label: "Launch list price (MSRP)", kind: "stable",
    why: "The official price is the anchor everyone quotes.",
    obs: [[640, 1999, "nvidia-newsroom.example"], [640, 1999, "techwire.example"], [639, 1999, "dailytech-reprint.example"], [200, 1999, "techwire.example"]],
    text: (v, d) => (d.startsWith("nvidia") ? `Nvidia lists the RTX 5090 Founders Edition at $${v.toLocaleString("en-US")}.` : `The RTX 5090 carries a $${v.toLocaleString("en-US")} list price from Nvidia.`),
  },
  {
    id: "r-retail", label: "New retail price now", kind: "volatile",
    why: "What a buyer actually pays today; can differ a lot from the list price.",
    obs: [
      [600, 3899, "megastore.example"], [580, 3599, "pcshop.example"], [540, 3299, "pricetracker.example"], [480, 2999, "gpudirect.example"],
      [420, 2799, "megastore.example"], [360, 2699, "pcshop.example"], [300, 2649, "pricetracker.example"], [240, 2749, "megastore.example"],
      [180, 2899, "gpudirect.example"], [120, 2999, "pcshop.example"], [75, 3099, "pricetracker.example"], [45, 3149, "megastore.example"],
      [30, 3199, "pcshop.example"], [14, 3249, "gpudirect.example"], [10, 2199, "hwforum.example", false], [7, 3299, "pricetracker.example"], [3, 3279, "megastore.example"],
    ],
    text: (v, d) => `The cheapest new RTX 5090 at ${d.replace(".example", "")} was $${v.toLocaleString("en-US")}.`,
  },
  {
    id: "r-used", label: "Used market", kind: "volatile",
    why: "Second-hand prices bound what a patient buyer pays.",
    obs: [[90, 2600, "resale-market.example"], [40, 2650, "resale-market.example"], [12, 2700, "resale-market.example"], [5, 2720, "hwforum.example"]],
    text: (v) => `Used RTX 5090 cards sold for about $${v.toLocaleString("en-US")}.`,
  },
];

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

export function gpuRun(run_id: string): Step[] {
  const steps: Step[] = [];
  const at = (ms: number, e: GlassboxEvent) => steps.push([ms, e]);
  let sid = 1, cid = 1, did = 1;
  const origins: Record<string, string> = { "dailytech-reprint.example": "techwire.example" }; // the reprint copies techwire

  at(100, { type: "run_started", run_id, question: GPU_QUESTION });
  at(150, { type: "message", message: { id: "m1", role: "user", text: GPU_QUESTION, node_id: "q" } });
  at(200, { type: "assumption_created", assumption: { id: "a1", text: "No reading is asked up front: every plausible meaning of 'price' gets its own direction; drop the ones you don't need.", fixed_by_user: false } });
  at(150, { type: "direction_created", node: { id: "q", kind: "question", parent_id: null, label: "RTX 5090 price?", status: "idle", traffic: 0 } });
  for (const r of READINGS) {
    const n: GraphNode = { id: r.id, kind: "direction", parent_id: "q", label: r.label, title: r.label, why: r.why, status: "running", traffic: 0 };
    at(200, { type: "direction_created", node: n });
  }

  // Interleave the readings so they look concurrent.
  const queues = READINGS.map((r) =>
    r.obs.map(([ago, value, domain, verified = true]) => {
      const s: Source = {
        id: `s${sid++}`, domain, url: `https://${domain}/${sid}`, origin: "web", origin_id: origins[domain] ?? domain,
        title: `${r.label} (${iso(ago)})`, text: `Snapshot from ${iso(ago)}. ${r.text(value, domain)} Prices change daily.`,
      };
      const quote = r.text(value, domain);
      const i = s.text.indexOf(quote);
      const c: Claim = {
        id: `c${cid++}`, node_id: r.id, source_id: s.id, text: quote, quote, verified: null, span: null, confidence: 0, origin_ids: [s.origin_id],
        value, unit: "USD", observed_at: iso(ago), kind: r.kind,
      };
      const ev: Step[] = [
        [70, { type: "decision", decision: { id: `dec${did++}`, node_id: r.id, action: "search", why: `Find a dated observation for "${r.label}".`, query: `RTX 5090 ${r.label.toLowerCase()}`, results: [s.id], ts: Date.now() } }],
        [60, { type: "source_added", source: s }],
        [60, { type: "claim_added", claim: c }],
        [80, { type: "claim_verified", claim_id: c.id, verified, span: verified ? [i, i + quote.length] : null }],
        [40, { type: "confidence_changed", claim_id: c.id, confidence: verified ? 0.5 : 0, origin_ids: c.origin_ids }],
      ];
      return ev;
    }),
  );
  while (queues.some((q) => q.length)) for (const q of queues) q.shift()?.forEach(([ms, e]) => at(ms, e));
  for (const r of READINGS) {
    at(40, { type: "confidence_changed", node_id: r.id, confidence: r.kind === "stable" ? 0.9 : r.id === "r-retail" ? 0.75 : 0.5 });
    at(80, { type: "direction_stopped", node_id: r.id, reason: r.kind === "stable" ? "Official figure found and corroborated." : "Enough recent observations for a dated estimate." });
    at(40, { type: "node_patch", node_id: r.id, patch: { status: "done", stop: "enough_evidence" } });
  }

  // The writer leads with the reading that answers "what does it cost" today, using the computed forecast.
  const st = steps.map((s) => s[1]).reduce(applyEvent, emptyRun());
  const claimsOf = (id: string) => Object.values(st.claims).filter((c) => c.node_id === id);
  const fmt = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  const recent = (id: string, n: number) => [...claimsOf(id)].filter((c) => c.verified).sort((a, b) => b.observed_at!.localeCompare(a.observed_at!)).slice(0, n).map((c) => c.id);
  const retail = forecast(st, claimsOf("r-retail"));
  const used = forecast(st, claimsOf("r-used"));
  const answer: { text: string; claim_ids: string[] }[] = [];
  if (retail) {
    const p30 = retail.proj[retail.proj.length - 1];
    answer.push({ text: `A new RTX 5090 costs about ${fmt(retail.now.lo)}–${fmt(retail.now.hi)} at retail right now (weighted estimate ${fmt(retail.now.mid)}, newest listing ${Math.round(retail.newestDays)} days old).`, claim_ids: recent("r-retail", 3) });
    answer.push({ text: `That is well above the ${fmt(1999)} launch MSRP, which is official and widely repeated but not what buyers pay.`, claim_ids: recent("r-msrp", 2) });
    answer.push({ text: `Mini forecast: prices are trending ${retail.slopePerDay >= 0 ? "up" : "down"} about ${fmt(Math.abs(retail.slopePerDay) * 30)} a month; in 30 days expect ${fmt(p30.lo)}–${fmt(p30.hi)}.`, claim_ids: recent("r-retail", 2) });
  }
  if (used) answer.push({ text: `Used cards sell for about ${fmt(used.now.mid)}.`, claim_ids: recent("r-used", 2) });
  answer.push({ text: "A forum post claiming a $2,199 new card could not be verified and is left out.", claim_ids: [] });
  at(300, { type: "answer_updated", answer });
  at(100, { type: "cost_updated", cost: { sources: sid - 1, steers: 0, restarts: 0, eur: 0.02 } });
  at(150, { type: "run_finished" });
  return steps;
}

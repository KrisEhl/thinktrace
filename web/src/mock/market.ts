import type { Claim, GlassboxEvent, GraphNode, Source } from "../api/types";
import type { Step } from "./fixture";

// Bigger synthetic scenario: 5 dimensions, ~18 directions, a few sub-directions, echoes, a contradiction,
// an unverifiable quote and needs_human cases. Everything is invented; domains are *.example.

export const MARKET_QUESTION = "Should a mid-size German retailer deploy autonomous warehouse robots in 2027?";

interface Dir {
  id: string;
  label: string;
  finding: string;
  origins: number; // independent origins; 0 = quote that cannot be verified
  echo?: boolean; // a reprint that collapses into the first origin
  contra?: string; // a conflicting statement from another origin
  sub?: Dir[];
}
interface Dim {
  id: string;
  label: string;
  dirs: Dir[];
}

const DIMS: Dim[] = [
  {
    id: "d-cost", label: "Cost & ROI",
    dirs: [
      { id: "c-capex", label: "Upfront cost", finding: "A 40-robot picking installation costs about EUR 2.1M including integration.", origins: 3 },
      { id: "c-opex", label: "Running cost", finding: "Maintenance and software licences add roughly 11% of capex per year.", origins: 2, echo: true },
      { id: "c-payback", label: "Payback period", finding: "Reported payback periods range from 22 to 40 months depending on shift patterns.", origins: 1 },
      { id: "c-fin", label: "Leasing", finding: "Robots-as-a-service contracts remove most upfront cost but lock in five-year terms.", origins: 2 },
    ],
  },
  {
    id: "d-tech", label: "Technology",
    dirs: [
      { id: "t-acc", label: "Pick accuracy", finding: "Leading systems exceed 98% accuracy on mixed SKUs in benchmark trials.", origins: 3 },
      {
        id: "t-fleet", label: "Fleet scaling", finding: "Throughput gains flatten above about 60 robots per aisle block.", origins: 2,
        sub: [{ id: "t-aisle", label: "Narrow aisles", finding: "Aisles under 2.4 m wide cut robot throughput by about a third.", origins: 1 }],
      },
      { id: "t-wms", label: "WMS integration", finding: "Integration with common warehouse management systems takes 8 to 14 weeks.", origins: 1, contra: "One vendor quotes 4 weeks for the same integration." },
      { id: "t-dmg", label: "Damaged goods", finding: "Robots misclassify damaged packaging in 12% of cases.", origins: 0 },
    ],
  },
  {
    id: "d-reg", label: "Regulation & safety",
    dirs: [
      { id: "r-ce", label: "Machinery regulation", finding: "New autonomous mobile robots must meet the EU Machinery Regulation from 2027.", origins: 2 },
      { id: "r-iso", label: "ISO 3691-4", finding: "ISO 3691-4 covers driverless industrial trucks and is the usual compliance baseline.", origins: 3 },
      { id: "r-gdpr", label: "Camera data (GDPR)", finding: "Camera footage of staff counts as personal data and needs a works agreement.", origins: 2 },
    ],
  },
  {
    id: "d-lab", label: "Workforce",
    dirs: [
      { id: "l-works", label: "Works council", finding: "In Germany the works council has co-determination rights over monitoring technology.", origins: 2 },
      { id: "l-jobs", label: "Jobs impact", finding: "Operators report redeployment, not layoffs, for about 70% of picking staff.", origins: 1 },
      { id: "l-skills", label: "Training", finding: "Technician training for robot fleets takes about six weeks.", origins: 1, echo: true },
    ],
  },
  {
    id: "d-mkt", label: "Vendors & market",
    dirs: [
      { id: "m-vend", label: "Vendor landscape", finding: "At least nine vendors sell goods-to-person robots in Germany.", origins: 2 },
      { id: "m-fail", label: "Vendor failure risk", finding: "Two early autonomous picking startups were acquired or wound down since 2024.", origins: 2 },
      { id: "m-ref", label: "Reference customers", finding: "Only one German retailer above EUR 500M revenue has published a full rollout.", origins: 1 },
    ],
  },
];

const INTROS = [
  "Overview of warehouse automation economics in the German market.",
  "Summary of a recent industry survey on goods-to-person systems.",
  "Notes from an operations roundtable with logistics managers.",
  "Technical briefing for warehouse and facility managers.",
];
const OUTROS = [
  "Figures vary with site layout and shift model.",
  "The authors recommend validating numbers on site before committing.",
  "Details are available from the publisher on request.",
  "Sample sizes were small, so treat averages with care.",
];
const SITES = ["industry-weekly", "logistics-lab", "retail-tech-review", "ops-forum", "vendor-docs", "standards-body", "trade-assoc", "analyst-notes"];

const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = <T,>(xs: T[], s: string) => xs[hash(s) % xs.length];
const confFor = (origins: number) => (origins >= 3 ? 0.9 : origins === 2 ? 0.75 : origins === 1 ? 0.5 : 0);

export function marketRun(run_id: string): Step[] {
  let sid = 100, cid = 100, did = 5000;
  const steps: Step[] = [];
  const at = (ms: number, e: GlassboxEvent) => steps.push([ms, e]);

  const nodeEvent = (n: GraphNode) => at(n.kind === "dimension" ? 260 : 120, { type: "direction_created", node: n });

  at(100, { type: "run_started", run_id, question: MARKET_QUESTION });
  at(150, { type: "message", message: { id: "m1", role: "user", text: MARKET_QUESTION, node_id: "q" } });
  at(300, { type: "assumption_created", assumption: { id: "a1", text: "The retailer runs one central warehouse of ~20,000 pallet places.", fixed_by_user: false } });
  at(150, { type: "assumption_created", assumption: { id: "a2", text: "Deployment is in 2027, so the EU Machinery Regulation applies.", fixed_by_user: false } });
  at(150, { type: "assumption_created", assumption: { id: "a3", text: "No union-free greenfield option: a works council exists.", fixed_by_user: false } });
  nodeEvent({ id: "q", kind: "question", parent_id: null, label: "Deploy warehouse robots?", status: "idle", traffic: 0 });

  const flat: { dir: Dir; parent: string }[] = [];
  for (const dim of DIMS) {
    nodeEvent({ id: dim.id, kind: "dimension", parent_id: "q", label: dim.label, status: "idle", traffic: 0 });
    const walk = (d: Dir, parent: string) => {
      nodeEvent({ id: d.id, kind: "direction", parent_id: parent, label: d.label, status: "idle", traffic: 0 });
      flat.push({ dir: d, parent });
      d.sub?.forEach((s) => walk(s, d.id));
    };
    dim.dirs.forEach((d) => walk(d, dim.id));
  }

  const claimsByDir: Record<string, Claim[]> = {};
  const needs: { id: string; label: string; reason: string }[] = [];

  // Each direction becomes a list of "units"; units are interleaved round-robin so directions look concurrent.
  const unitsOf = (d: Dir): Step[][] => {
    const units: Step[][] = [];
    const claims: Claim[] = (claimsByDir[d.id] = []);
    const decision = (action: "search" | "read" | "stop", why: string, extra: object = {}): Step => [
      60, { type: "decision", decision: { id: `dec${did++}`, node_id: d.id, action, why, ts: Date.now(), ...extra } },
    ];
    const addSource = (domain: string, title: string, origin_id: string, text: string): [Step, Source] => {
      const s: Source = { id: `s${sid++}`, domain, title, origin_id, text, url: `https://${domain}/${sid}`, origin: "web" };
      return [[90, { type: "source_added", source: s }], s];
    };
    const addClaim = (s: Source, text: string, quote: string, conf: number, origin_ids: string[], verified: boolean): Step[] => {
      const i = s.text.indexOf(quote);
      const c: Claim = { id: `c${cid++}`, node_id: d.id, source_id: s.id, text, quote, verified: null, span: null, confidence: 0, origin_ids };
      claims.push({ ...c, verified, confidence: conf, span: verified && i >= 0 ? [i, i + quote.length] : null });
      return [
        [90, { type: "claim_added", claim: c }],
        [110, { type: "claim_verified", claim_id: c.id, verified, span: verified && i >= 0 ? [i, i + quote.length] : null }],
        [80, { type: "confidence_changed", claim_id: c.id, confidence: conf, origin_ids }],
      ];
    };

    const topic = d.label.toLowerCase();
    units.push([decision("search", `Start with the basics on ${topic}.`, { query: `${topic} warehouse robots Germany` })]);
    const origins: string[] = [];
    const n = Math.max(d.origins, 1);
    for (let i = 0; i < n; i++) {
      const origin = `o-${d.id}-${i}`;
      const unverified = d.origins === 0;
      const domain = `${SITES[(hash(d.id) + i * 3) % SITES.length]}.example`;
      const text = `${pick(INTROS, d.id + i)} ${unverified ? "The vendor did not publish a figure for this." : d.finding} ${pick(OUTROS, d.id + "o" + i)}`;
      const [srcStep, src] = addSource(domain, `${d.label}: ${pick(["report", "briefing", "survey notes", "analysis"], d.id + i)}`, origin, text);
      if (!unverified) origins.push(origin);
      const u: Step[] = [];
      if (i > 0) u.push(decision("search", `${i === 1 ? "One origin so far" : "Two origins agree"}. Look for another independent source.`, { query: `${topic} independent evidence` }));
      else u.push(decision("read", "Read the first result in full.", { source_id: src.id }));
      u.push(srcStep, ...addClaim(src, d.finding.replace(/\.$/, "") + ".", d.finding, confFor(origins.length), [...origins], !unverified));
      if (i === 0 && d.echo) {
        const [echoStep, echoSrc] = addSource(`repost-${hash(d.id) % 90}.example`, `${d.label} (repost)`, origin, `According to another outlet: ${d.finding} We did not verify this independently.`);
        u.push(decision("read", "A second hit says the same thing: check whether it is independent.", { source_id: echoSrc.id }), echoStep, ...addClaim(echoSrc, "A repost repeats the same figure (same origin).", d.finding, confFor(origins.length), [...origins], true));
      }
      units.push(u);
    }
    let finalConf = confFor(origins.length);
    if (d.contra) {
      const origin = `o-${d.id}-x`;
      const [step, src] = addSource(`${SITES[(hash(d.id) + 5) % SITES.length]}.example`, `${d.label}: dissenting view`, origin, `${pick(INTROS, d.id + "x")} ${d.contra} ${pick(OUTROS, d.id + "ox")}`);
      units.push([decision("search", "The numbers vary a lot. Look for a dissenting source.", { query: `${topic} faster than` }), step, ...addClaim(src, d.contra, d.contra, 0.4, [origin], true)]);
      finalConf = 0.4;
      needs.push({ id: d.id, label: d.label, reason: "Sources contradict each other and I cannot tell which holds." });
    }
    if (d.origins === 0) needs.push({ id: d.id, label: d.label, reason: "The quoted figure does not appear in the source text." });

    const fin: Step[] = [];
    if (d.origins >= 3) fin.push(decision("stop", "Three independent origins; confidence is high.", {}));
    else if (d.origins >= 1 && !d.contra) fin.push(decision("stop", "No more distinct sources found within budget.", {}));
    fin.push(
      [80, { type: "confidence_changed", node_id: d.id, confidence: finalConf }],
      [80, { type: "verdict_set", node_id: d.id, verdict: finalConf >= 0.75 ? "yes" : "uncertain" }],
      [60, { type: "direction_stopped", node_id: d.id, reason: d.contra ? "Contradiction left open for the user." : d.origins === 0 ? "Quote could not be verified." : "Stopping rule met." }],
    );
    const need = needs.find((x) => x.id === d.id);
    if (need) fin.push([80, { type: "needs_human", node_id: d.id, reason: need.reason }]);
    units.push(fin);
    return units;
  };

  const queues = flat.map(({ dir }) => unitsOf(dir));
  while (queues.some((q) => q.length)) {
    for (const q of queues) {
      const u = q.shift();
      if (!u) continue;
      u.forEach(([ms, e], i) => at(i === 0 ? ms + 70 : ms, e));
    }
  }

  // Answer: one sentence per dimension from its strongest verified claim, plus an explicit gap per needs_human node.
  const answer: { text: string; claim_ids: string[] }[] = [];
  for (const dim of DIMS) {
    const all = dim.dirs.flatMap((d) => [d, ...(d.sub ?? [])]).flatMap((d) => claimsByDir[d.id] ?? []).filter((c) => c.verified && c.confidence >= 0.5);
    const best = [...all].sort((a, b) => b.confidence - a.confidence).slice(0, 2);
    if (best.length) answer.push({ text: `${dim.label}: ${best.map((c) => c.text.replace(/\.$/, "")).join("; ")}.`, claim_ids: best.map((c) => c.id) });
  }
  for (const n of needs) answer.push({ text: `Needs your input: ${n.label}. ${n.reason}`, claim_ids: [] });
  at(500, { type: "answer_updated", answer });

  const cites = (dimId: string) => (DIMS.find((x) => x.id === dimId)!.dirs.flatMap((d) => claimsByDir[d.id] ?? []).filter((c) => c.confidence >= 0.75).slice(0, 2).map((c) => c.id));
  at(150, { type: "message", message: { id: "m2", role: "agent", text: "Overall: feasible and likely worthwhile if payback holds, but three points need you: WMS integration time (sources disagree), the damaged-goods error rate (unverified), and payback (single source).", node_id: "q", claim_ids: [...cites("d-cost"), ...cites("d-tech")] } });
  at(250, { type: "message", message: { id: "m3", role: "user", text: "How firm is the cost picture?", node_id: "d-cost" } });
  at(200, { type: "message", message: { id: "m4", role: "agent", text: "Upfront cost has three independent origins and is solid. Payback rests on one source, so I would not rely on it yet. Try 'dig deeper' on it.", node_id: "d-cost", claim_ids: cites("d-cost") } });
  at(250, { type: "message", message: { id: "m5", role: "user", text: "Anything that could block us legally?", node_id: "d-reg" } });
  at(200, { type: "message", message: { id: "m6", role: "agent", text: "Nothing blocking, but camera footage of staff needs a works agreement, and the Machinery Regulation applies from 2027.", node_id: "d-reg", claim_ids: cites("d-reg") } });
  const total = Object.values(claimsByDir).reduce((a, b) => a + b.length, 0);
  at(200, { type: "cost_updated", cost: { sources: sid - 100, steers: 0, restarts: 0, eur: Math.round(total * 0.4) / 100 } });
  at(250, { type: "run_finished" });
  return steps;
}

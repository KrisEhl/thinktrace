import type { Claim, Decision, GlassboxEvent, GraphNode, Source } from "../api/types";

// A scripted, fictional run ("Acme Robotics" does not exist; every domain is *.example).
// It exercises every state the UI must show: green / orange / red / grey nodes, an echo that collapses to
// one origin, a contradiction, an unverifiable quote, and needs_human.

export const QUESTION = "Is Acme Robotics a safe vendor for warehouse picking robots in Germany?";

const src = (id: string, origin_id: string, domain: string, title: string, text: string): Source => ({
  id,
  origin_id,
  domain,
  title,
  url: `https://${domain}/${id}`,
  text,
  origin: "web",
});

export const SOURCES: Source[] = [
  src("s1", "o-acme", "acme-robotics.example", "PickBot X2 product page",
    "PickBot X2 overview. Acme Robotics builds autonomous picking robots for mixed-SKU warehouses. In independent trials the PickBot X2 reaches 99.2% pick accuracy on mixed SKUs. Deployment takes about two weeks per aisle."),
  src("s2", "o-acme", "logistics-weekly.example", "Acme's new robot, reviewed",
    "Our review of Acme's latest release. According to the vendor, the PickBot X2 reaches 99.2% pick accuracy on mixed SKUs. We did not run our own tests."),
  src("s3", "o-bench", "robotbench.example", "Warehouse picking benchmark 2025",
    "Benchmark methodology: 4,000 mixed picks across 12 SKU families. Results: the PickBot X2 scored 98.7% accuracy, second among six tested systems. Throughput averaged 640 picks per hour."),
  src("s4", "o-acme", "acme-robotics.example", "Safety and compliance",
    "Compliance. The PickBot X2 is certified to ISO 10218-1 for industrial robot safety. Certificates are available on request."),
  src("s5", "o-registry", "cert-register.example", "Certificate register: Acme Robotics",
    "Register entry. Holder: Acme Robotics GmbH. Standard: ISO 10218-1. Status: valid until 2028-03. Issued by an accredited notified body."),
  src("s6", "o-acme", "acme-robotics.example", "Privacy policy",
    "Data handling. Camera footage is processed on-device and deleted after 24 hours. No footage leaves the customer site on the standard tier."),
  src("s7", "o-forum", "warehouse-ops-forum.example", "Thread: PickBot cloud tier footage?",
    "Several operators on the cloud tier report that footage is kept up to 30 days on Acme's servers. One asked support and got the same answer."),
  src("s8", "o-newswire", "startup-news.example", "Acme raises Series A",
    "Berlin-based Acme Robotics closed a EUR 12M Series A in 2024. The round was led by Northwind Ventures."),
  src("s9", "o-registry2", "handelsregister.example", "Company filing: Acme Robotics GmbH",
    "Filing note. Acme Robotics GmbH registered a capital increase of EUR 12M in autumn 2024 following a Series A financing round."),
  src("s10", "o-investor", "northwind-ventures.example", "Portfolio: Acme Robotics",
    "Portfolio update. We are proud to have led Acme Robotics' EUR 12M Series A. The company is growing its team in Berlin and Munich."),
  src("s11", "o-acme", "acme-robotics.example", "Customers",
    "Our customers include three logistics operators in Germany, among them a top-5 parcel carrier."),
];

const claim = (
  id: string, node_id: string, source_id: string, text: string, quote: string, confidence: number, origin_ids: string[],
  verified: boolean | null = true,
): Claim => {
  const s = SOURCES.find((x) => x.id === source_id)!;
  const i = s.text.indexOf(quote);
  return {
    id, node_id, source_id, text, quote, confidence, origin_ids, verified,
    span: verified && i >= 0 ? [i, i + quote.length] : null,
  };
};

export const CLAIMS: Record<string, Claim> = {
  c1: claim("c1", "t-vision", "s1", "PickBot X2 reaches 99.2% pick accuracy in independent trials.", "the PickBot X2 reaches 99.2% pick accuracy on mixed SKUs", 0.5, ["o-acme"]),
  c2: claim("c2", "t-vision", "s2", "Review repeats the 99.2% figure (vendor-sourced).", "the PickBot X2 reaches 99.2% pick accuracy on mixed SKUs", 0.5, ["o-acme"]),
  c3: claim("c3", "t-vision", "s3", "An independent benchmark measured 98.7% accuracy on 4,000 picks.", "the PickBot X2 scored 98.7% accuracy, second among six tested systems", 0.75, ["o-acme", "o-bench"]),
  c4: claim("c4", "t-safety", "s4", "Vendor states ISO 10218-1 certification.", "certified to ISO 10218-1 for industrial robot safety", 0.5, ["o-acme"]),
  c5: claim("c5", "t-safety", "s5", "Certificate register shows ISO 10218-1 valid until 2028-03.", "Standard: ISO 10218-1. Status: valid until 2028-03", 0.75, ["o-acme", "o-registry"]),
  c6: claim("c6", "l-gdpr", "s6", "Vendor says footage is deleted after 24 hours.", "Camera footage is processed on-device and deleted after 24 hours", 0.5, ["o-acme"]),
  c7: claim("c7", "l-gdpr", "s7", "Operators report 30-day retention on the cloud tier.", "footage is kept up to 30 days on Acme's servers", 0.4, ["o-forum"]),
  c8: claim("c8", "l-liab", "s1", "Acme carries EUR 5M liability insurance.", "carries EUR 5M liability insurance", 0, ["o-acme"], false),
  c9: claim("c9", "m-fund", "s8", "Acme closed a EUR 12M Series A in 2024.", "closed a EUR 12M Series A in 2024", 0.5, ["o-newswire"]),
  c10: claim("c10", "m-fund", "s9", "Company filing shows a EUR 12M capital increase in 2024.", "registered a capital increase of EUR 12M in autumn 2024", 0.75, ["o-newswire", "o-registry2"]),
  c11: claim("c11", "m-fund", "s10", "The lead investor confirms it led the EUR 12M round.", "led Acme Robotics' EUR 12M Series A", 0.9, ["o-newswire", "o-registry2", "o-investor"]),
  c12: claim("c12", "m-cust", "s11", "Acme lists three logistics customers in Germany.", "three logistics operators in Germany", 0.5, ["o-acme"]),
};

const node = (id: string, kind: GraphNode["kind"], parent_id: string | null, label: string): GraphNode => ({
  id, kind, parent_id, label, status: "idle", traffic: 0,
});

export const NODES: GraphNode[] = [
  node("q", "question", null, "Is Acme a safe vendor?"),
  node("d-tech", "dimension", "q", "Technology"),
  node("d-law", "dimension", "q", "Law & compliance"),
  node("d-mkt", "dimension", "q", "Market & finance"),
  node("t-vision", "direction", "d-tech", "Picking accuracy"),
  node("t-safety", "direction", "d-tech", "Safety certification"),
  node("l-gdpr", "direction", "d-law", "GDPR / data retention"),
  node("l-liab", "direction", "d-law", "Liability insurance"),
  node("m-fund", "direction", "d-mkt", "Funding"),
  node("m-cust", "direction", "d-mkt", "Customers"),
];

let did = 0;
const dec = (node_id: string, action: Decision["action"], why: string, extra: Partial<Decision> = {}): GlassboxEvent => ({
  type: "decision",
  decision: { id: `dec${++did}`, node_id, action, why, ts: Date.now(), ...extra },
});

/** [delay in ms after the previous event, event] */
export type Step = [number, GlassboxEvent];

export function scriptedRun(run_id: string): Step[] {
  const s: Step[] = [];
  const at = (ms: number, e: GlassboxEvent) => s.push([ms, e]);
  const claimAdd = (id: string, ms = 500) => {
    const c = CLAIMS[id];
    at(ms, { type: "claim_added", claim: { ...c, verified: null, span: null, confidence: 0 } });
    at(350, { type: "claim_verified", claim_id: id, verified: c.verified ?? false, span: c.span });
    at(250, { type: "confidence_changed", claim_id: id, confidence: c.confidence, origin_ids: c.origin_ids });
  };
  const srcAdd = (id: string, ms = 500) => at(ms, { type: "source_added", source: SOURCES.find((x) => x.id === id)! });

  at(100, { type: "run_started", run_id, question: QUESTION });
  at(200, {
    type: "message",
    message: { id: "m1", role: "user", text: QUESTION, node_id: "q" },
  });
  at(500, { type: "assumption_created", assumption: { id: "a1", text: "The robots would be deployed in Germany (EU law applies).", fixed_by_user: false } });
  at(200, { type: "assumption_created", assumption: { id: "a2", text: "'Safe' covers technical, legal and financial risk.", fixed_by_user: false } });
  for (const n of NODES) {
    at(n.kind === "dimension" ? 500 : 280, { type: "direction_created", node: n });
  }

  // technology
  at(600, dec("t-vision", "search", "Start with the vendor's accuracy claim, then look for independent tests.", { query: "PickBot X2 pick accuracy independent trial" }));
  srcAdd("s1"); claimAdd("c1");
  at(600, dec("t-vision", "read", "Review article may add an independent view.", { source_id: "s2" }));
  srcAdd("s2", 300); claimAdd("c2");
  at(500, dec("t-vision", "search", "s2 repeats the vendor's number (same origin). Need a third party.", { query: "warehouse picking benchmark 2025 PickBot" }));
  srcAdd("s3"); claimAdd("c3");
  at(400, { type: "confidence_changed", node_id: "t-vision", confidence: 0.75 });
  at(300, { type: "verdict_set", node_id: "t-vision", verdict: "yes" });
  at(300, { type: "direction_stopped", node_id: "t-vision", reason: "Two independent origins agree; confidence is high enough." });

  at(500, dec("t-safety", "read", "Vendor safety page names the standard.", { source_id: "s4" }));
  srcAdd("s4", 300); claimAdd("c4");
  at(500, dec("t-safety", "search", "Vendor says certified. Check the register.", { query: "ISO 10218-1 certificate register Acme Robotics GmbH" }));
  srcAdd("s5"); claimAdd("c5");
  at(400, { type: "confidence_changed", node_id: "t-safety", confidence: 0.75 });
  at(300, { type: "verdict_set", node_id: "t-safety", verdict: "yes" });
  at(200, { type: "direction_stopped", node_id: "t-safety", reason: "Register confirms the certificate." });

  // law
  at(600, dec("l-gdpr", "read", "Privacy policy first.", { source_id: "s6" }));
  srcAdd("s6", 300); claimAdd("c6");
  at(500, dec("l-gdpr", "search", "Policy is the vendor's own word. Look for customer reports.", { query: "PickBot cloud tier footage retention" }));
  srcAdd("s7"); claimAdd("c7");
  at(400, { type: "confidence_changed", node_id: "l-gdpr", confidence: 0.4 });
  at(300, { type: "verdict_set", node_id: "l-gdpr", verdict: "uncertain" });
  at(200, { type: "needs_human", node_id: "l-gdpr", reason: "Vendor says 24h, operators say 30 days. Unresolved contradiction." });

  at(500, dec("l-liab", "search", "Look for insurance cover.", { query: "Acme Robotics liability insurance" }));
  at(300, dec("l-liab", "read", "Product page mentions cover; extract the figure.", { source_id: "s1" }));
  claimAdd("c8");
  at(400, { type: "confidence_changed", node_id: "l-liab", confidence: 0 });
  at(300, { type: "verdict_set", node_id: "l-liab", verdict: "uncertain" });
  at(200, { type: "needs_human", node_id: "l-liab", reason: "The quoted figure does not appear in any source I could read." });

  // market
  at(500, dec("m-fund", "search", "Check funding news.", { query: "Acme Robotics Series A" }));
  srcAdd("s8"); claimAdd("c9");
  at(500, dec("m-fund", "search", "One news source. Check the company register.", { query: "Acme Robotics GmbH Handelsregister Kapitalerhöhung" }));
  srcAdd("s9"); claimAdd("c10");
  at(500, dec("m-fund", "read", "Lead investor's own post is a third origin.", { source_id: "s10" }));
  srcAdd("s10", 300); claimAdd("c11");
  at(400, { type: "confidence_changed", node_id: "m-fund", confidence: 0.9 });
  at(300, { type: "verdict_set", node_id: "m-fund", verdict: "yes" });
  at(200, { type: "direction_stopped", node_id: "m-fund", reason: "Three independent origins." });

  at(500, dec("m-cust", "read", "Customer page.", { source_id: "s11" }));
  srcAdd("s11", 300); claimAdd("c12");
  at(300, dec("m-cust", "stop", "No independent reference found within budget.", {}));
  at(300, { type: "confidence_changed", node_id: "m-cust", confidence: 0.5 });
  at(300, { type: "verdict_set", node_id: "m-cust", verdict: "uncertain" });
  at(200, { type: "direction_stopped", node_id: "m-cust", reason: "Budget used; one origin only." });

  const answer = [
    { text: "Acme's PickBot X2 looks technically credible: an independent benchmark measured 98.7% accuracy and the vendor's own 99.2% figure is in line with it.", claim_ids: ["c1", "c3"] },
    { text: "Safety certification to ISO 10218-1 is confirmed by the certificate register.", claim_ids: ["c4", "c5"] },
    { text: "Funding is solid: a EUR 12M Series A is confirmed by three independent origins.", claim_ids: ["c9", "c10", "c11"] },
    { text: "Customer references are thin: three German logistics operators, from the vendor alone.", claim_ids: ["c12"] },
    { text: "Data protection is unresolved: the vendor says footage is deleted after 24 hours, but operators report up to 30 days.", claim_ids: ["c6", "c7"] },
    { text: "Needs your input: liability insurance could not be verified.", claim_ids: [] },
  ];
  at(700, { type: "answer_updated", answer });
  at(200, { type: "message", message: { id: "m2", role: "agent", text: "Short answer: probably yes on technology and funding, with two open points for you (data retention and liability insurance). Details in the answer panel.", node_id: "q", claim_ids: ["c3", "c5", "c11"] } });
  at(200, { type: "cost_updated", cost: { sources: 11, steers: 0, restarts: 0, eur: 0.04 } });
  at(300, { type: "run_finished" });
  return s;
}

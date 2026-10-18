import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEvent, emptyRun } from "../../state/reducer";
import { claimUsage, provenance, rejectImpact } from "../../state/selectors";
import { layoutLayer } from "../../graph/layout";
import { claimWeight, profile, recency, sourceMix } from "../../state/credibility";
import { forecast } from "../../state/forecast";
import { gpuRun } from "../../mock/gpu";
import { splitAnswer, Translator, type Envelope } from "../glassbox";

// Replays the committed real run (runs/sample: fusion question, 1 redirect + 1 dig deeper) through translator + reducer.
const envelopes: Envelope[] = readFileSync(new URL("../../../../runs/sample/events.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const build = () => {
  const t = new Translator();
  return envelopes.flatMap((e) => t.apply(e)).reduce(applyEvent, emptyRun());
};

describe("translator on runs/sample", () => {
  const st = build();
  const count = (type: string) => envelopes.filter((e) => e.type === type).length;

  it("builds question -> directions, including the redirect", () => {
    const dirs = Object.values(st.nodes).filter((n) => n.kind === "direction");
    expect(st.nodes.q.kind).toBe("question");
    expect(dirs.map((d) => d.id).sort()).toEqual(["d1", "d2", "d3", "d4", "dn1"]);
    expect(dirs.every((d) => d.parent_id === "q")).toBe(true);
    expect(st.nodes.d1.status).toBe("deactivated");
    expect(st.nodes.d1.stop).toBe("dropped_by_user");
    expect(st.nodes.dn1.from_dir).toBe("d1");
  });

  it("keeps every claim on a known direction and source", () => {
    expect(Object.keys(st.claims)).toHaveLength(count("claim.recorded"));
    for (const c of Object.values(st.claims)) {
      expect(st.nodes[c.node_id]).toBeDefined();
      expect(st.sources[c.source_id]).toBeDefined();
      if (c.match === "not_found") expect(c.confidence).toBe(0);
      else expect([0.4, 0.5, 0.75, 0.9]).toContain(c.confidence);
    }
  });

  it("turns every search and read into a decision with a reason slot", () => {
    const by = (a: string) => st.decisions.filter((d) => d.action === a).length;
    expect(by("search")).toBe(count("search.completed"));
    expect(by("read")).toBe(count("read.started"));
    expect(st.decisions.every((d) => d.why.length > 0)).toBe(true);
  });

  it("answer v2 cites only known claims, and steers are counted", () => {
    expect(st.answer_meta.version).toBe(2);
    expect(st.answer.length).toBeGreaterThan(3);
    const cited = st.answer.flatMap((s) => s.claim_ids);
    expect(cited.length).toBeGreaterThan(5);
    for (const id of cited) expect(st.claims[id]).toBeDefined();
    expect(st.cost.steers).toBe(2);
    expect(st.status).toBe("finished");
    expect(Object.values(st.claims).some((c) => claimUsage(st, c).state === "used")).toBe(true);
  });

  it("posts each answer version into the chat log with its sentences and citations", () => {
    const posted = st.messages.filter((m) => m.answer);
    expect(posted.map((m) => m.id)).toEqual(["m-report-1", "m-report-2"]);
    expect(posted[1].answer).toEqual(st.answer);
  });

  it("puts the steers in the chat log, pinned to their direction", () => {
    const steers = st.messages.filter((m) => m.id.startsWith("m-steer-") && m.role === "user");
    expect(steers.map((m) => m.node_id).sort()).toEqual(["d1", "d2"]);
  });
});

describe("provenance chain on runs/sample", () => {
  const st = (() => {
    const t = new Translator();
    return envelopes.flatMap((e) => t.apply(e)).reduce(applyEvent, emptyRun());
  })();
  const cited = [...new Set(st.answer.flatMap((s) => s.claim_ids))];

  it("every cited claim traces back to its sentence, source, search and direction", () => {
    let withSearch = 0;
    for (const id of cited) {
      const p = provenance(st, id)!;
      expect(p.sentences.length).toBeGreaterThan(0);
      expect(p.source).toBeDefined();
      expect(p.node?.kind).toBe("direction");
      if (p.search) {
        withSearch++;
        expect(p.search.results).toContain(p.claim.source_id);
      }
    }
    // Most cited claims come from a search in their own direction; the rest were read directly.
    expect(withSearch / cited.length).toBeGreaterThan(0.5);
  });

  it("folds the activity layer down to the traced path", () => {
    const id = cited[0];
    const dir = st.claims[id].node_id;
    const full = layoutLayer(st, dir, { claim_id: null, only: true }).nodes.length;
    const folded = layoutLayer(st, dir, { claim_id: id, only: true });
    expect(folded.nodes.length).toBeLessThan(full);
    expect(folded.nodes.length).toBeLessThanOrEqual(6 + (st.claims[id].links?.length ?? 0) + 4);
    expect(folded.nodes.some((n) => n.id === `clm:${id}` && n.className === "on-path")).toBe(true);
    const root = layoutLayer(st, "q", { claim_id: id, only: true });
    expect(root.nodes.find((n) => n.id === dir)?.className).toBe("on-path");
    const dimmed = layoutLayer(st, dir, { claim_id: id, only: false });
    expect(dimmed.nodes.length).toBe(full);
    expect(dimmed.nodes.filter((n) => n.className === "dim").length).toBeGreaterThan(0);
  });
});

describe("reverse trace on runs/sample", () => {
  const st = build();
  // The source the answer leans on most.
  const cites = (sid: string) => st.answer.filter((s) => s.claim_ids.some((id) => st.claims[id]?.source_id === sid)).length;
  const sid = Object.keys(st.sources).sort((a, b) => cites(b) - cites(a))[0];

  it("lists the claims and answer sentences that depend on a source", () => {
    const im = rejectImpact(st, sid);
    expect(im.claims.length).toBeGreaterThan(0);
    expect(im.claims.every((c) => c.source_id === sid)).toBe(true);
    expect(im.sentences.length).toBe(cites(sid));
    for (const x of im.sentences) expect(x.lost.length).toBeGreaterThan(0);
    expect(im.directions.reduce((n, d) => n + d.lost, 0)).toBe(im.claims.length);
  });

  it("previews rejection: a sentence is unsupported only when no other supported claim backs it", () => {
    const im = rejectImpact(st, sid);
    for (const x of im.sentences) {
      const others = x.s.claim_ids.filter((id) => st.claims[id]?.source_id !== sid && st.claims[id]?.verified !== false);
      expect(x.state).toBe(others.length ? "weakened" : "unsupported");
      expect(x.left).toEqual(others);
    }
    expect(im.byIndex.filter(Boolean).length).toBe(im.sentences.length);
  });

  it("marks the rejected source and its claims in the graph", () => {
    const im = rejectImpact(st, sid);
    const dir = im.directions[0].node_id;
    const layer = layoutLayer(st, dir, { claim_id: null, only: true, reject: sid });
    expect(layer.nodes.find((n) => n.id === `src:${sid}`)?.className).toContain("rejected");
    for (const c of im.claims.filter((c) => c.node_id === dir)) expect(layer.nodes.find((n) => n.id === `clm:${c.id}`)?.className).toContain("rejected");
    const root = layoutLayer(st, "q", { claim_id: null, only: true, reject: sid });
    expect(root.nodes.find((n) => n.id === dir)?.className).toContain("hit");
  });
});

describe("source credibility on runs/sample", () => {
  const st = build();
  const byDomain = (d: string) => Object.values(st.sources).find((s) => s.domain === d)!;

  it("uses the expert rating where it exists, heuristics elsewhere", () => {
    expect(profile(st, byDomain("nature.com"))).toMatchObject({ role: "rated" });
    expect(profile(st, byDomain("nature.com")).quality).toBeGreaterThan(0.9);
    expect(profile(st, byDomain("cfs.energy")).role).toBe("party");
    expect(profile(st, byDomain("helionenergy.com")).role).toBe("party");
    const all = Object.values(st.sources).map((s) => profile(st, s).role);
    expect(all.filter((r) => r === "rated").length).toBeGreaterThan(5);
  });

  it("weighs claims by quality, quote and independence, and reports the source mix", () => {
    for (const c of Object.values(st.claims)) {
      const w = claimWeight(st, c).weight;
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      if (c.verified === false) expect(w).toBe(0);
    }
    const mix = sourceMix(st, Object.values(st.claims));
    expect(mix.shares.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1);
    expect(recency(14, "volatile")).toBeCloseTo(0.5);
  });
});

describe("RTX 5090 synthetic scenario: time projection", () => {
  const st = gpuRun("t").map((s) => s[1]).reduce(applyEvent, emptyRun());
  const of = (id: string) => Object.values(st.claims).filter((c) => c.node_id === id);

  it("estimates today's retail price from recent observations, not the MSRP or old launch spikes", () => {
    const f = forecast(st, of("r-retail"))!;
    expect(f.now.mid).toBeGreaterThan(3150);
    expect(f.now.mid).toBeLessThan(3350);
    expect(f.slopePerDay).toBeGreaterThan(0);
    expect(f.obs.find((o) => o.value === 2199)).toBeUndefined(); // unverified forum post carries no weight
    expect(f.proj).toHaveLength(31);
    expect(f.proj[30].hi - f.proj[30].lo).toBeGreaterThan(f.proj[0].hi - f.proj[0].lo);
  });

  it("answers the asked reading first and counts the reprint once", () => {
    expect(st.answer[0].text).toMatch(/costs about \$3,\d{3}/);
    const reprint = Object.values(st.sources).find((s) => s.domain === "dailytech-reprint.example")!;
    expect(reprint.origin_id).toBe("techwire.example");
  });
});

describe("splitAnswer", () => {
  it("splits sentences and keeps their citations", () => {
    const s = splitAnswer("CFS targets the early 2030s [c1][c49]. Helion aims for 2028 [c3], though disputed [c4].\n\n## Gaps\n- Sector variation stopped on budget [d3].");
    expect(s.map((x) => x.claim_ids)).toEqual([["c1", "c49"], ["c3", "c4"], [], []]);
    expect(s[0].text).toBe("CFS targets the early 2030s.");
  });
});

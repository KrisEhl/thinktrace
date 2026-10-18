import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEvent, emptyRun } from "../../state/reducer";
import { claimUsage } from "../../state/selectors";
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

  it("puts the steers in the chat log, pinned to their direction", () => {
    const steers = st.messages.filter((m) => m.id.startsWith("m-steer-") && m.role === "user");
    expect(steers.map((m) => m.node_id).sort()).toEqual(["d1", "d2"]);
  });
});

describe("splitAnswer", () => {
  it("splits sentences and keeps their citations", () => {
    const s = splitAnswer("CFS targets the early 2030s [c1][c49]. Helion aims for 2028 [c3], though disputed [c4].\n\n## Gaps\n- Sector variation stopped on budget [d3].");
    expect(s.map((x) => x.claim_ids)).toEqual([["c1", "c49"], ["c3", "c4"], [], []]);
    expect(s[0].text).toBe("CFS targets the early 2030s.");
  });
});

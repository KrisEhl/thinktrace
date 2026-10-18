import ratingsCsv from "../data/domain_pc1.csv?raw";
import type { Claim, Source } from "../api/types";
import type { RunState } from "./reducer";

// Source credibility, media-science style: who is speaking (role) and how good their track record is (quality).
// Quality comes from the Lin et al. 2023 "wisdom of experts" ensemble (PNAS Nexus, doi:10.1093/pnasnexus/pgad286),
// the first principal component of six expert news-domain rating sets, 11,520 domains, scaled 0..1.
// Source: github.com/hauselin/domain-quality-ratings (data/domain_pc1.csv).
// Domains it does not cover fall back to heuristics, and every profile says which basis it used.

const PC1 = new Map(
  ratingsCsv
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [d, v] = l.split(",");
      return [d.trim(), Number(v)] as const;
    }),
);

/** Mock scenarios use *.example domains; they register invented ratings here, shown as "mock rating". */
const MOCK = new Map<string, number>();
export const registerMockRatings = (r: Record<string, number>) => Object.entries(r).forEach(([d, v]) => MOCK.set(d, v));

export type Role ="rated" | "institution" | "party" | "unrated";

export const roleLabel: Record<Role, string> = {
  rated: "rated outlet",
  institution: "institution",
  party: "interested party",
  unrated: "unrated",
};

export interface Profile {
  domain: string;
  role: Role;
  quality: number; // 0..1
  basis: string;
}

const bare = (d: string) => d.toLowerCase().replace(/^www\./, "");

function rated(domain: string): [string, number] | null {
  const parts = bare(domain).split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts.slice(i).join(".");
    const v = PC1.get(k);
    if (v !== undefined) return [k, v];
  }
  return null;
}

const INSTITUTION = /\.(gov|edu|int|mil)(\.[a-z]{2})?$|\.(ac|gov|gc)\.[a-z]{2}$|(^|\.)europa\.eu$|(^|\.)(arxiv|doi|ncbi\.nlm\.nih|pubmed|ssrn)\.(org|gov|com)$/;
// Capitalised sentence starters that are not brands.
const COMMON = new Set(["inside", "world", "global", "energy", "news", "open", "this", "these", "their", "with", "from", "power", "research", "science", "future"]);

/** Registrable name of a domain: "blog.cfs.energy" -> "cfs", "www.helionenergy.com" -> "helionenergy". */
function stemOf(domain: string) {
  const labels = bare(domain).split(".");
  const sld = labels.length >= 3 && /^(co|com|org|ac|gov)$/.test(labels[labels.length - 2]) ? labels.length - 3 : labels.length - 2;
  return labels[sld]?.replace(/-/g, "") ?? "";
}

/**
 * An interested party is a source reporting on itself (a company on its own roadmap, an advocacy group on its own
 * campaign): a "primary definer" in media-studies terms. Heuristic: the claims quoted from it name the domain's owner,
 * either as whole words ("4 Day Week" -> 4dayweek) or as a capitalised brand the domain starts with (Helion -> helionenergy).
 */
function isParty(domain: string, claimTexts: string[]): boolean {
  const stem = stemOf(domain);
  if (stem.length < 3) return false;
  const text = claimTexts.join(" ");
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++)
    for (let n = 1; n <= 3 && i + n <= words.length; n++) if (words.slice(i, i + n).join("") === stem) return true;
  const brands = (text.match(/\b(?:[A-Z][a-z]{3,}|[A-Z]{3,})\b/g) ?? []).map((b) => b.toLowerCase()).filter((b) => !COMMON.has(b));
  return brands.some((b) => stem.startsWith(b));
}

export function profile(st: RunState, s: Source): Profile {
  const mock = MOCK.get(bare(s.domain));
  if (mock !== undefined) return { domain: s.domain, role: "rated", quality: mock, basis: `mock rating ${mock.toFixed(2)} (synthetic scenario)` };
  const r = rated(s.domain);
  // Decide per domain, not per page, so one outlet gets one role.
  const about = Object.values(st.claims).filter((c) => st.sources[c.source_id]?.domain === s.domain).map((c) => c.text);
  if (r) {
    // A well-rated outlet stays rated even when it writes about itself; quality is its track record.
    return { domain: s.domain, role: "rated", quality: r[1], basis: `expert rating ${r[1].toFixed(2)} (Lin et al. 2023, ${r[0]})` };
  }
  if (INSTITUTION.test(bare(s.domain))) return { domain: s.domain, role: "institution", quality: 0.8, basis: "public institution or scholarly index (domain rule)" };
  if (isParty(s.domain, about)) return { domain: s.domain, role: "party", quality: 0.4, basis: "reports on itself: informative about its own plans, not independent evidence" };
  return { domain: s.domain, role: "unrated", quality: 0.5, basis: "not in the expert rating set" };
}

/** How sure we are the quote is really in the source ("sourceable"). */
export const quoteFactor = (c: Claim) =>
  c.verified === false || c.match === "not_found" ? 0 : c.verified === null ? 0.5 : c.verified_against === "snippet" ? 0.5 : c.match === "fuzzy" ? 0.8 : 1;

/** Half-life in days by kind of claim: prices move in weeks, events in months, settled facts in years. */
export const HALF_LIFE = { volatile: 14, event: 90, stable: 5 * 365 } as const;
export const recency = (ageDays: number | undefined, kind: keyof typeof HALF_LIFE = "event") =>
  ageDays === undefined ? 1 : Math.pow(2, -Math.max(0, ageDays) / HALF_LIFE[kind]);

/**
 * Weight of one claim = quality x quote factor x independence x recency.
 * Independence: sources sharing an origin count once together (copies are not corroboration, Dong et al. VLDB 2009).
 */
export const ageDays = (c: Claim, now = Date.now()) => (c.observed_at ? (now - Date.parse(c.observed_at)) / 86_400_000 : undefined);

export function claimWeight(st: RunState, c: Claim, opts: { now?: number } = {}) {
  const s = st.sources[c.source_id];
  if (!s) return { weight: 0, profile: undefined };
  const p = profile(st, s);
  const copies = Object.values(st.sources).filter((x) => x.origin_id === s.origin_id).length || 1;
  const weight = p.quality * quoteFactor(c) * (1 / copies) * recency(ageDays(c, opts.now), c.kind);
  return { weight, profile: p };
}

/**
 * Source mix behind a set of claims: share of evidence weight per role, plus a blindspot flag when one kind of
 * voice carries most of it (Ground News flags stories covered mostly by one side; here the sides are roles).
 */
export function sourceMix(st: RunState, claims: Claim[]) {
  const by: Record<Role, number> = { rated: 0, institution: 0, party: 0, unrated: 0 };
  let total = 0;
  for (const c of claims) {
    const { weight, profile: p } = claimWeight(st, c);
    if (!p || weight === 0) continue;
    by[p.role] += weight;
    total += weight;
  }
  const shares = (Object.keys(by) as Role[]).map((role) => ({ role, share: total ? by[role] / total : 0 })).filter((x) => x.share > 0);
  const top = [...shares].sort((a, b) => b.share - a.share)[0];
  const blindspot = claims.length >= 3 && top && top.share >= 0.8 && top.role !== "rated" ? top.role : null;
  return { shares, total, blindspot };
}

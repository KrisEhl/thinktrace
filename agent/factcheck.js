// Adversarial fact-checker. Triggered when the player shoots a claim apart:
// it searches for evidence that would break the claim, then rules on it.
import { chatJson } from './llm.js';
import * as tavily from './tavily.js';
import { getConfig } from './config.js';
import { clip, verifyQuote, fragmentLink } from './sources.js';

const ATTACKER = `You are a skeptical fact-checker whose job is to BREAK a claim from a research draft.
Think about how it could be wrong: outdated numbers, a different date in another source, missing qualifiers, a single-source claim, a misread quote.
Propose ONE web search most likely to surface contradicting or more precise evidence.
Reply with JSON only: {"angle": "how the claim might be wrong", "query": "search query"}`;

const JUDGE = `You are the judge in a fact-check. Decide whether the claim survives, using ONLY the evidence given.
- "upheld": the evidence supports the claim as written.
- "weakened": partly right, but needs a qualifier or correction (give corrected_claim).
- "refuted": the evidence contradicts it.
Cite evidence by source id with a VERBATIM quote from that source's text.
Reply with JSON only:
{"verdict": "upheld|weakened|refuted", "reasoning": "2-3 sentences", "corrected_claim": "... or empty",
 "evidence": [{"source": 7, "quote": "...", "stance": "supports|contradicts"}]}`;

export function challengeVerdict(run, claim, j, emit) {
  const { sources } = run;
  const verdict = ['upheld', 'weakened', 'refuted'].includes(j?.verdict) ? j.verdict : 'weakened';
  const evidence = (j?.evidence ?? [])
    .map((e) => {
      const s = sources.get(e.source);
      if (!s) return null;
      const ok = verifyQuote(e.quote, s.text || s.snippet);
      return {
        source: s.id,
        quote: clip(e.quote, 300),
        stance: e.stance === 'contradicts' ? 'contradicts' : 'supports',
        quoteVerified: ok,
        link: ok ? fragmentLink(s.url, e.quote) : s.url,
      };
    })
    .filter(Boolean)
    .slice(0, 4);
  claim.status = verdict;
  claim.check = {
    verdict,
    reasoning: clip(j?.reasoning, 600),
    correctedClaim: verdict === 'weakened' ? clip(j?.corrected_claim, 400) : '',
    evidence,
  };
  emit('verdict', {
    claimId: claim.id,
    ...claim.check,
    sourceInfo: evidence.map((e) => sources.public(sources.get(e.source))),
  });
  return claim;
}

export async function challengeClaim(run, claim, emit, signal) {
  const { sources } = run;
  const model = getConfig().checkerModel;
  claim.status = 'checking';
  const cited = claim.sources.map((id) => sources.get(id)).filter(Boolean);
  emit('challenge', { claimId: claim.id, text: claim.text });

  const { json: a = {}, response: attack } = await chatJson({
    model,
    messages: [
      { role: 'system', content: ATTACKER },
      {
        role: 'user',
        content: `Original question: ${run.question}\nClaim: ${claim.text}\nSupporting quote: "${claim.quote}"\nCited: ${cited.map((s) => `${s.title} (${s.domain})`).join('; ')}`,
      },
    ],
    maxTokens: 4000,
    attempts: 2,
    accept: (j) => typeof j.query === 'string' && j.query.trim(),
    signal,
  });
  const query = clip(a.query || `${claim.text} contradicting evidence`, 200);
  emit('attack', { claimId: claim.id, angle: clip(a.angle, 300), query, thinking: clip(attack.reasoning, 400) });

  const results = await tavily.search(query, { maxResults: 5, signal });
  const found = results.map((r) => sources.add(r, `check-${claim.id}`));
  emit('attack_results', { claimId: claim.id, query, results: found.map((s) => sources.public(s)) });

  const evidence = [...new Map([...cited, ...found].map((s) => [s.id, s])).values()]
    .map((s) => `[${s.id}] ${s.title} (${s.domain})\n${clip(s.text || s.snippet, s.text ? 2500 : 600)}`)
    .join('\n\n=====\n\n');
  const { json: verdict, response: judged, error } = await chatJson({
    model,
    messages: [
      { role: 'system', content: JUDGE },
      { role: 'user', content: `Claim: ${claim.text}\n\nEvidence:\n\n${evidence}` },
    ],
    maxTokens: 8000,
    temperature: 0.1,
    accept: (j) => ['upheld', 'weakened', 'refuted'].includes(j.verdict),
    onRetry: (attempt, why) => emit('thinking', { step: `check ${claim.id}`, text: `Judge reply unusable (${why}), retrying` }),
    signal,
  });
  if (judged?.reasoning) emit('thinking', { step: `check ${claim.id}`, text: clip(judged.reasoning, 400) });
  if (!verdict) throw new Error(`The fact-checker could not reach a verdict: ${error.message}`);
  return challengeVerdict(run, claim, verdict, emit);
}

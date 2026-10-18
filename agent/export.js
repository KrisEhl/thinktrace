// Markdown export of a finished run: answer, claims with verdicts, sources, decision trace.
const VERDICT = { upheld: 'UPHELD', weakened: 'WEAKENED', refuted: 'REFUTED', standing: 'not challenged', checking: 'checking' };

export function toMarkdown(run) {
  const src = new Map(run.sources.map((s) => [s.id, s]));
  const cite = (ids) => ids.map((id) => `[[${id}]](${src.get(id)?.url})`).join(' ');
  const out = [];
  out.push(`# ${run.report?.title ?? run.question}`, '');
  out.push(`**Question:** ${run.question}  `, `**Model:** ${run.model} · **Checker:** ${run.checkerModel} · **Mode:** ${run.mode}`, '');
  if (run.report?.answer) out.push(run.report.answer, '');
  out.push('## Claims', '');
  for (const c of run.claims) {
    out.push(`### ${c.id} · ${c.confidence} confidence · ${VERDICT[c.status] ?? c.status}`);
    out.push(`${c.text} ${cite(c.sources)}`, '');
    out.push(`> "${c.quote}"${c.link ? ` ([jump to quote](${c.link}))` : ''} ${c.quoteVerified ? `(quote found in source: ${c.quoteVerified})` : '(quote NOT found in fetched text)'}`, '');
    if (c.check) {
      out.push(`**Fact-check:** ${c.check.reasoning}`);
      if (c.check.correctedClaim) out.push(`**Corrected:** ${c.check.correctedClaim}`);
      for (const e of c.check.evidence) out.push(`- ${e.stance} [${e.source}]: "${e.quote}" ([link](${e.link}))`);
      out.push('');
    }
  }
  if (run.report?.openQuestions?.length) {
    out.push('## Open questions', '', ...run.report.openQuestions.map((q) => `- ${q}`), '');
  }
  out.push('## Sources', '');
  for (const s of run.sources) out.push(`${s.id}. [${s.title}](${s.url})${s.read ? ' (read in full)' : ''}`);
  out.push('', '## Agent trace', '');
  for (const e of run.trace) {
    const line =
      {
        plan: () => `plan: ${e.subquestions?.join(' | ')}`,
        search: () => `search "${e.query}" because ${e.reason}`,
        results: () => `results: ${e.results?.map((r) => `[${r.id}] ${r.domain}`).join(', ')}`,
        read: () => `read ${e.ids?.map((i) => `[${i}]`).join(' ')} because ${e.reason}`,
        decision: () => `decision: ${e.enough ? 'enough evidence' : 'stopped'}: ${e.reason}`,
        thought: () => `thought: ${e.text}`,
        thinking: () => `thinking: ${e.text}`,
        challenge: () => `player challenged ${e.claimId}`,
        attack: () => `fact-checker attacks ${e.claimId}: ${e.angle} -> "${e.query}"`,
        verdict: () => `verdict ${e.claimId}: ${e.verdict}`,
      }[e.type]?.() ?? null;
    if (line) out.push(`- \`${(e.t / 1000).toFixed(1)}s\` ${line}`);
  }
  return out.join('\n');
}

// The research agent: plan -> tool loop (search / read / finish) -> cited draft.
// Every step is emitted as an event so the game can turn it into level geometry
// and the trace panel can show *why* the agent did what it did.
import { chat, chatJson, parseJson } from './llm.js';
import * as tavily from './tavily.js';
import { clip, verifyQuote, fragmentLink, lowerConfidence, CONFIDENCE } from './sources.js';

const MAX_STEPS = 10;
const MAX_SEARCHES = 6;
const MAX_READS = 8;

const today = () => new Date().toISOString().slice(0, 10);

const PLANNER = `You are the planner of a web research agent. Today is ${today()}.
Break the user's question into 2-4 concrete sub-questions that, answered together, settle it.
Note what kind of sources would be most trustworthy (primary sources, official docs, peer-reviewed, reputable press).
Reply with JSON only: {"subquestions": ["..."], "strategy": "one or two sentences"}`;

const researcher = (plan) => `You are a meticulous web research agent. Today is ${today()}.
You gather evidence with tools, then stop when the evidence is sufficient. A separate writer drafts the answer from what you collected.

Plan:
${plan.subquestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}
Strategy: ${plan.strategy}

Rules:
- Use web_search with focused queries. Every tool call needs a short "reason" that references what you learned so far.
- Snippets are not enough: use read_pages on the most promising source ids before relying on them.
- Prefer primary and independent sources. Look for disagreement between sources and resolve it.
- Budget: at most ${MAX_SEARCHES} searches and ${MAX_READS} page reads. You may call several tools in one turn.
- Call finish_research once each sub-question is covered by read sources, or when more searching would not change the answer.`;

const WRITER = `You write the final answer of a research agent. Use ONLY the evidence provided; never use outside knowledge.
Write 4-7 atomic, checkable claims that together answer the question. Each claim must:
- cite the source ids that support it,
- include "quote": a sentence copied VERBATIM from the cited source text that supports the claim (copy characters exactly),
- carry a confidence: "high" (several independent sources agree), "medium" (one good source), "low" (weak, indirect or conflicting).
Mention conflicts between sources inside the relevant claim.
Reply with JSON only:
{"title": "short title", "answer": "2-3 sentence direct answer",
 "claims": [{"text": "...", "sources": [1,2], "quote": "...", "confidence": "high|medium|low"}],
 "open_questions": ["..."]}`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web (Tavily). Returns titles, URLs and snippets, each tagged with a source id like [3].',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A focused search query' },
          reason: { type: 'string', description: 'Why this search, given what you know so far' },
        },
        required: ['query', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_pages',
      description: 'Read the full text of up to 3 already-found sources, by source id.',
      parameters: {
        type: 'object',
        properties: {
          source_ids: { type: 'array', items: { type: 'integer' }, description: 'Source ids from search results' },
          reason: { type: 'string', description: 'Why these pages' },
        },
        required: ['source_ids', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_research',
      description: 'Stop researching and hand the evidence to the writer.',
      parameters: {
        type: 'object',
        properties: {
          enough_because: { type: 'string', description: 'Why the evidence is sufficient' },
          remaining_gaps: { type: 'string', description: 'What is still uncertain' },
        },
        required: ['enough_because'],
      },
    },
  },
];

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

// Fallback for models that answer with a JSON action in plain text instead of native tool calls.
function textToolCalls(content) {
  const j = parseJson(content);
  if (!j) return [];
  const name = j.tool || j.action || j.name;
  if (!TOOLS.some((t) => t.function.name === name)) return [];
  return [{ id: null, function: { name, arguments: j.arguments ?? j.args ?? j } }];
}

export async function runResearch(run, emit, signal) {
  const { question, sources } = run;
  let searches = 0;
  let reads = 0;

  // 1. Plan
  emit('status', { phase: 'planning', text: 'Planning the research' });
  const retryNote = (what) => (attempt, why) => emit('thinking', { step: what, text: `${what} reply unusable (${why}), retrying (${attempt + 1})` });
  const { json: p = {}, response: planned } = await chatJson({
    messages: [
      { role: 'system', content: PLANNER },
      { role: 'user', content: question },
    ],
    maxTokens: 4000,
    attempts: 2,
    accept: (j) => Array.isArray(j.subquestions) && j.subquestions.length > 0,
    onRetry: retryNote('Planner'),
    signal,
  });
  const plan = {
    subquestions: (Array.isArray(p.subquestions) ? p.subquestions : [question]).slice(0, 4).map((q) => clip(q, 200)),
    strategy: clip(p.strategy || '', 300),
  };
  run.plan = plan;
  emit('plan', { ...plan, thinking: clip(planned.reasoning, 600), model: planned.model });

  // 2. Tool loop
  emit('status', { phase: 'researching', text: 'Searching the web' });
  const messages = [
    { role: 'system', content: researcher(plan) },
    { role: 'user', content: `Research question: ${question}` },
  ];

  const exec = async (name, args) => {
    if (name === 'web_search') {
      const query = clip(args.query || question, 200);
      if (searches >= MAX_SEARCHES) return 'Search budget exhausted. Read pages or call finish_research.';
      searches++;
      const searchId = searches;
      emit('search', { searchId, query, reason: clip(args.reason, 300) });
      const results = await tavily.search(query, { signal });
      const found = results.map((r) => sources.add(r, searchId));
      emit('results', { searchId, query, results: found.map((s) => sources.public(s)) });
      if (!found.length) return 'No results.';
      return found
        .map((s) => `[${s.id}] ${s.title} (${s.domain})${s.read ? ' [already read]' : ''}\n${clip(s.snippet, 300)}`)
        .join('\n\n');
    }

    if (name === 'read_pages') {
      const ids = (Array.isArray(args.source_ids) ? args.source_ids : [args.source_ids])
        .map(Number)
        .filter((id) => sources.get(id));
      const wanted = [...new Set(ids)].filter((id) => !sources.get(id).read).slice(0, 3);
      if (!wanted.length) return 'Those ids are unknown or already read. Use ids from search results.';
      if (reads >= MAX_READS) return 'Read budget exhausted. Call finish_research.';
      const batch = wanted.slice(0, MAX_READS - reads);
      reads += batch.length;
      emit('read', { ids: batch, reason: clip(args.reason, 300) });
      const { results, failed } = await tavily.extract(
        batch.map((id) => sources.get(id).url),
        { signal },
      );
      const out = [];
      for (const r of results) {
        const src = sources.byUrl.get(String(r.url).split('#')[0]) ?? batch.map((id) => sources.get(id)).find((s) => s.url === r.url);
        if (!src || !r.text) continue;
        src.text = r.text.slice(0, 15000);
        src.read = true;
        emit('page', { id: src.id, title: src.title, url: src.url, domain: src.domain, excerpt: clip(src.text, 900) });
        out.push(`[${src.id}] ${src.title}\n${clip(src.text, 3500)}`);
      }
      const missed = batch.filter((id) => !sources.get(id).read);
      if (missed.length || failed.length) emit('read_failed', { ids: missed });
      if (missed.length) out.push(`Could not read: ${missed.map((id) => `[${id}]`).join(', ')}`);
      return out.join('\n\n---\n\n') || 'Nothing could be extracted.';
    }

    if (name === 'finish_research') {
      emit('decision', {
        enough: true,
        reason: clip(args.enough_because, 400),
        gaps: clip(args.remaining_gaps, 300),
        searches,
        reads,
      });
      return 'OK';
    }
    return `Unknown tool ${name}`;
  };

  let finished = false;
  let nudged = false;
  for (let step = 1; step <= MAX_STEPS && !finished; step++) {
    if (signal?.aborted) throw new Error('aborted');
    const r = await chat({ messages, tools: TOOLS, maxTokens: 8000, signal });
    if (r.reasoning) emit('thinking', { step, text: clip(r.reasoning, 500) });

    const native = r.toolCalls.length > 0;
    const calls = native ? r.toolCalls : textToolCalls(r.content);
    if (r.content && calls.length) emit('thought', { step, text: clip(r.content, 400) });

    if (!calls.length) {
      if (searches === 0 && !nudged) {
        nudged = true;
        messages.push({ role: 'assistant', content: r.content || '' });
        messages.push({ role: 'user', content: 'Use the web_search tool now. Do not answer from memory.' });
        continue;
      }
      emit('decision', { enough: true, reason: clip(r.content || 'Model stopped calling tools.', 400), searches, reads });
      finished = true;
      break;
    }

    const outputs = await Promise.all(
      calls.map(async (tc) => {
        const name = tc.function?.name;
        if (name === 'finish_research') finished = true;
        try {
          return await exec(name, parseArgs(tc.function?.arguments));
        } catch (err) {
          if (signal?.aborted) throw err;
          emit('tool_error', { tool: name, message: clip(err.message, 200) });
          return `Tool error: ${err.message}`;
        }
      }),
    );

    if (native) {
      messages.push({ role: 'assistant', content: r.message.content ?? '', tool_calls: r.toolCalls });
      calls.forEach((tc, i) => messages.push({ role: 'tool', tool_call_id: tc.id, content: outputs[i] }));
    } else {
      messages.push({ role: 'assistant', content: r.content });
      messages.push({ role: 'user', content: `Tool results:\n${outputs.join('\n\n')}` });
    }
  }
  if (!finished) emit('decision', { enough: false, reason: 'Step budget reached, writing with what we have.', searches, reads });

  // 3. Write
  emit('status', { phase: 'writing', text: 'Drafting a cited answer' });
  const evidence = sources.list
    .filter((s) => s.read || s.snippet)
    .sort((a, b) => Number(b.read) - Number(a.read))
    .slice(0, 14)
    .map((s) => `[${s.id}] ${s.title}\nURL: ${s.url}\n${s.read ? 'TEXT' : 'SNIPPET'}: ${clip(s.text || s.snippet, s.read ? 4500 : 500)}`)
    .join('\n\n=====\n\n');
  const { json: draft, response: written, error } = await chatJson({
    messages: [
      { role: 'system', content: WRITER },
      { role: 'user', content: `Question: ${question}\n\nEvidence:\n\n${evidence}` },
    ],
    maxTokens: 12000,
    temperature: 0.2,
    accept: (j) => Array.isArray(j.claims) && j.claims.some((c) => c?.text),
    onRetry: retryNote('Writer'),
    signal,
  });
  if (written?.reasoning) emit('thinking', { step: 'write', text: clip(written.reasoning, 500) });
  if (!draft) throw new Error(`The writer could not produce claims: ${error.message}`);
  return finalizeReport(run, draft, emit);
}

// Check every claim's quote against the text we actually fetched, then publish the draft.
export function finalizeReport(run, draft, emit) {
  const { sources } = run;
  run.claims = draft.claims.filter((c) => c?.text).slice(0, 8).map((c, i) => {
    const ids = (Array.isArray(c.sources) ? c.sources : [c.sources]).map(Number).filter((id) => sources.get(id));
    let verified = false;
    let quoteSource = null;
    for (const id of ids) {
      const s = sources.get(id);
      verified = verifyQuote(c.quote, s.text || s.snippet);
      if (verified) {
        quoteSource = id;
        break;
      }
    }
    let confidence = CONFIDENCE.includes(c.confidence) ? c.confidence : 'medium';
    if (!ids.length || !verified) confidence = lowerConfidence(confidence);
    const link = quoteSource ? fragmentLink(sources.get(quoteSource).url, c.quote) : null;
    return {
      id: `C${i + 1}`,
      text: clip(c.text, 400),
      sources: ids,
      quote: clip(c.quote, 400),
      quoteSource,
      quoteVerified: verified,
      link,
      confidence,
      status: 'standing',
    };
  });
  run.report = {
    title: clip(draft.title || run.question, 120),
    answer: clip(draft.answer || '', 700),
    openQuestions: (draft.open_questions ?? []).slice(0, 4).map((q) => clip(q, 200)),
  };
  for (const claim of run.claims) {
    emit('claim', { ...claim, sourceInfo: claim.sources.map((id) => sources.public(sources.get(id))) });
  }
  emit('report', { ...run.report, claims: run.claims, sources: sources.list.map((s) => sources.public(s)) });
  return run;
}

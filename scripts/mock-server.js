// Offline stand-in for Nebius Token Factory and Tavily, for development without
// burning credits or hitting rate limits. It speaks the same HTTP APIs, so the
// real agent code (planner, tool loop, writer, fact-checker, retries) runs unchanged.
//
// Content is generated deterministically from the question and URLs: page text
// contains the snippet and quote sentences verbatim, so citation checks pass,
// while different pages report slightly different numbers to give the
// fact-checker something to argue about.
//
//   node scripts/mock-server.js            # standalone on :4010
//   npm run mock                           # mock + app together (scripts/dev-mock.js)
//
// Env: MOCK_PORT (4010), MOCK_LATENCY ms (700), MOCK_FAIL_RATE 0..1 (0): share of
// JSON replies that get cut off with finish_reason "length" to exercise retries.
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const LATENCY = Number(process.env.MOCK_LATENCY ?? 700);
const FAIL_RATE = Number(process.env.MOCK_FAIL_RATE ?? 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => sleep(ms * (0.5 + Math.random()));

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed) {
  let a = hash(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STOP = new Set('what when where which who whom whose why how does did do is are was were the and for with that this from into than then have has had about over many much more most really there their they them its it'.split(' '));
const keywords = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
const topicOf = (text) => keywords(text).slice(0, 4).join(' ') || 'the topic';
const slug = (text) => keywords(text).slice(0, 5).join('-') || 'topic';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const ORGS = ['the National Statistics Office', 'Stanford University', 'the European Commission', 'Reuters', 'the World Health Organization', 'MIT Technology Review', 'the OECD', 'Nature'];
const SITES = ['mock-news.example', 'mock-journal.example', 'mock-gov.example', 'mock-wiki.example', 'mock-blog.example'];

// A page about `topic`, varied by `seed` (the URL). Sentences end with ". " so they split cleanly.
function pageSentences(topic, seed) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const year = 2015 + Math.floor(r() * 10);
  const n = 10 + Math.floor(r() * 80);
  const T = cap(topic);
  return [
    `${T} was first documented in ${year}, according to ${pick(ORGS)}.`,
    `Researchers at ${pick(ORGS)} estimate that ${topic} affects about ${n} percent of cases.`,
    `A ${year + 2} review by ${pick(ORGS)} found the evidence on ${topic} to be mixed.`,
    `Critics argue that most claims about ${topic} rely on a single study.`,
    `The official figure for ${topic} was revised to ${n + Math.floor(r() * 9) - 4} percent in ${year + 3}.`,
    `${pick(ORGS)} reported that interest in ${topic} doubled between ${year} and ${year + 4}.`,
    `Independent analysts at ${pick(ORGS)} could not reproduce the original ${topic} figures.`,
  ];
}

// ---------- Tavily ----------
function searchResults(query) {
  const topic = topicOf(query);
  const r = rng(query);
  const count = 4 + Math.floor(r() * 2);
  return Array.from({ length: count }, (_, i) => {
    const site = SITES[(hash(query) + i) % SITES.length];
    const url = `https://${site}/${slug(query)}-${i + 1}`;
    const sentences = pageSentences(topic, url);
    return {
      url,
      title: `${cap(topic)}: ${['an overview', 'new figures', 'what the data says', 'a critical look', 'FAQ'][i % 5]}`,
      content: sentences.slice(0, 2).join(' '),
      score: Math.round((0.9 - i * 0.1) * 100) / 100,
    };
  });
}

function extractPage(url) {
  // The topic is recoverable from the slug: words joined by "-" before the index.
  const topic = url.split('/').pop().replace(/-\d+$/, '').replace(/-/g, ' ');
  return pageSentences(topic, url).join('\n\n');
}

// ---------- LLM ----------
const toolCall = (name, args) => ({
  id: `call_${Math.random().toString(36).slice(2, 10)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function plannerReply(question) {
  const topic = topicOf(question);
  return {
    reasoning: `The user asks: "${question}". I'll split it into what is known, what the primary figures are, and where sources disagree.`,
    content: JSON.stringify({
      subquestions: [`What is known about ${topic}?`, `What do primary sources report about ${topic}?`, `Where do sources disagree on ${topic}?`],
      strategy: 'Start broad, read the most authoritative pages, then look for a dissenting source.',
    }),
  };
}

// Decide the next research step from the conversation so far, like a real model would.
function researcherReply(messages) {
  const question = messages.find((m) => m.role === 'user')?.content.replace(/^Research question:\s*/, '') ?? '';
  const topic = topicOf(question);
  const step = messages.filter((m) => m.role === 'assistant').length;
  const toolTexts = messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const searchIds = (text) => [...text.matchAll(/^\[(\d+)\] .*\((mock[^)]*)\)/gm)].map((m) => Number(m[1]));
  const lastSearch = [...toolTexts].reverse().find((t) => searchIds(t).length) ?? '';

  if (step === 0) {
    return {
      reasoning: `Nothing gathered yet. Start with a broad search on ${topic}.`,
      content: 'Starting with a broad search.',
      tool_calls: [toolCall('web_search', { query: `${topic} overview`, reason: 'Get the lay of the land before narrowing down.' })],
    };
  }
  if (step === 1) {
    const ids = searchIds(lastSearch).slice(0, 2);
    return {
      reasoning: `Results [${ids.join('], [')}] look authoritative. Read them, and in parallel look for primary figures.`,
      content: '',
      tool_calls: [
        toolCall('read_pages', { source_ids: ids, reason: 'Top results; need the full text, not snippets.' }),
        toolCall('web_search', { query: `${topic} official figures statistics`, reason: 'The overview pages cite figures; find the primary numbers.' }),
      ],
    };
  }
  if (step === 2) {
    const id = searchIds(lastSearch)[0];
    return {
      reasoning: `The second search surfaced [${id}]. Read it to cross-check the numbers.`,
      content: 'Cross-checking the figures with an independent page.',
      tool_calls: [toolCall('read_pages', { source_ids: [id], reason: 'Independent source to confirm or contradict the first figures.' })],
    };
  }
  return {
    reasoning: 'Three pages read; the figures differ slightly between sources, which the writer should flag.',
    content: '',
    tool_calls: [
      toolCall('finish_research', {
        enough_because: 'Every sub-question is covered by at least one read source, and an independent page was used to cross-check the figures.',
        remaining_gaps: 'Sources report slightly different percentages.',
      }),
    ],
  };
}

function evidenceBlocks(text) {
  return text
    .split('\n\n=====\n\n')
    .map((block) => {
      const id = Number(block.match(/\[(\d+)\]/)?.[1]);
      const body = block.split(/\n(?:TEXT|SNIPPET): /)[1] ?? '';
      const sentences = body.split(/(?<=\.)\s+/).filter((s) => s.length > 30);
      return { id, sentences };
    })
    .filter((b) => b.id && b.sentences.length);
}

function writerReply(messages) {
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  const question = user.match(/^Question: (.*)$/m)?.[1] ?? 'the question';
  const blocks = evidenceBlocks(user);
  const claims = [];
  for (let i = 0; claims.length < 5 && i < 12 && blocks.length; i++) {
    const b = blocks[i % blocks.length];
    const sentence = b.sentences[(i * 2 + 1) % b.sentences.length];
    if (claims.some((c) => c.quote === sentence)) continue;
    const other = blocks[(i + 1) % blocks.length];
    // Every fifth claim gets a paraphrased quote, so the "quote not found" path is visible too.
    const quote = claims.length === 3 ? sentence.replace(/^(\w+) /, '$1 reportedly ') : sentence;
    claims.push({
      text: sentence.replace(/\.$/, ''),
      sources: [...new Set([b.id, other.id])],
      quote,
      confidence: ['high', 'medium', 'high', 'low', 'medium'][claims.length],
    });
  }
  return {
    reasoning: `I have ${blocks.length} sources. Turn their key sentences into atomic claims with verbatim quotes.`,
    content: JSON.stringify({
      title: cap(topicOf(question)),
      answer: `The sources broadly agree on the basics of ${topicOf(question)}, but report different figures and note that much of the evidence rests on few studies.`,
      claims,
      open_questions: ['Which of the differing figures is the most recent official one?'],
    }),
  };
}

function attackerReply(messages) {
  const claim = messages.find((m) => m.role === 'user')?.content.match(/^Claim: (.*)$/m)?.[1] ?? '';
  return {
    reasoning: 'Numbers like this are often revised. Search for a correction or a dissenting figure.',
    content: JSON.stringify({ angle: 'The figure may be outdated or from a single study.', query: `${topicOf(claim)} revised figure criticism` }),
  };
}

function judgeReply(messages) {
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  const claim = user.match(/^Claim: (.*)$/m)?.[1] ?? '';
  const blocks = user
    .slice(user.indexOf('\n['))
    .split('\n\n=====\n\n')
    .map((b) => b.trim())
    .map((b) => ({ id: Number(b.match(/\[(\d+)\]/)?.[1]), sentences: b.split('\n').slice(1).join(' ').split(/(?<=\.)\s+/).filter((s) => s.length > 30) }))
    .filter((b) => b.id && b.sentences.length);
  const verdict = ['upheld', 'weakened', 'refuted'][hash(claim) % 3];
  const support = blocks[0];
  const counter = blocks.at(-1);
  return {
    reasoning: `Compare the claim against the cited source and the new results. Verdict: ${verdict}.`,
    content: JSON.stringify({
      verdict,
      reasoning: {
        upheld: 'The cited source and an independent result agree with the claim as written.',
        weakened: 'The claim holds in part, but a newer source reports a different figure.',
        refuted: 'The new results contradict the claim and the original figure could not be reproduced.',
      }[verdict],
      corrected_claim: verdict === 'weakened' ? `${claim} (other sources report a revised figure)` : '',
      evidence: [
        support && { source: support.id, quote: support.sentences[0], stance: 'supports' },
        verdict !== 'upheld' && counter && { source: counter.id, quote: counter.sentences.at(-1), stance: 'contradicts' },
      ].filter(Boolean),
    }),
  };
}

function llmReply(body) {
  const system = body.messages?.[0]?.content ?? '';
  if (body.tools) return researcherReply(body.messages);
  if (system.includes('planner')) return plannerReply(body.messages.find((m) => m.role === 'user')?.content ?? '');
  if (system.includes('final answer')) return writerReply(body.messages);
  if (system.includes('BREAK')) return attackerReply(body.messages);
  if (system.includes('judge')) return judgeReply(body.messages);
  return { content: 'pong' };
}

// ---------- HTTP ----------
export function startMock(port = Number(process.env.MOCK_PORT ?? 4010)) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    const path = req.url.split('?')[0].replace(/\/+$/, '');

    if (path.endsWith('/models')) return send(200, { data: [{ id: 'mock/fake-llm' }, { id: 'reflection/beam' }] });

    if (path.endsWith('/chat/completions')) {
      await jitter(LATENCY);
      const reply = llmReply(body);
      const truncate = !body.tools && !body.response_format && Math.random() < FAIL_RATE;
      const content = truncate ? reply.content.slice(0, Math.floor(reply.content.length / 3)) : reply.content;
      console.log(`[mock llm] ${body.tools ? 'researcher' : (body.messages?.[0]?.content ?? '').slice(0, 40).replace(/\n/g, ' ')}${truncate ? ' (cut off)' : ''}`);
      return send(200, {
        model: body.model,
        choices: [
          {
            finish_reason: truncate ? 'length' : reply.tool_calls ? 'tool_calls' : 'stop',
            message: { role: 'assistant', content, reasoning_content: reply.reasoning ?? '', tool_calls: reply.tool_calls },
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    if (path.endsWith('/search')) {
      await jitter(LATENCY / 2);
      console.log(`[mock tavily] search "${body.query}"`);
      return send(200, { results: searchResults(body.query) });
    }

    if (path.endsWith('/extract')) {
      await jitter(LATENCY);
      console.log(`[mock tavily] extract ${body.urls?.length} urls`);
      return send(200, { results: (body.urls ?? []).map((url) => ({ url, raw_content: extractPage(url) })), failed_results: [] });
    }

    send(404, { detail: `mock: no route for ${req.method} ${req.url}` });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  await startMock(port);
  console.log(`Mock Token Factory + Tavily on http://localhost:${port}`);
  console.log(`  NEBIUS_BASE_URL=http://localhost:${port}/v1  TAVILY_BASE_URL=http://localhost:${port}`);
}

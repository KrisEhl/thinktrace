// Minimal OpenAI-compatible client for Nebius Token Factory.
import { getConfig } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body, key, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`Token Factory ${res.status}: ${text.slice(0, 300)}`);
  }
}

export async function chat({ messages, tools, model, maxTokens = 2048, temperature = 0.3, json = false, signal }) {
  const cfg = getConfig();
  const body = { model: model || cfg.model, messages, temperature, max_tokens: maxTokens };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (json) body.response_format = { type: 'json_object' };
  const data = await post(`${cfg.baseUrl}/chat/completions`, body, cfg.nebiusKey, signal);
  const message = data.choices?.[0]?.message ?? {};
  let content = message.content ?? '';
  let reasoning = message.reasoning_content ?? message.reasoning ?? '';
  // Some reasoning models inline their chain of thought in <think> tags.
  const think = content.match(/<think>([\s\S]*?)<\/think>/);
  if (think && !reasoning) reasoning = think[1];
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
  return {
    message,
    content,
    reasoning: String(reasoning).trim(),
    toolCalls: message.tool_calls ?? [],
    finishReason: data.choices?.[0]?.finish_reason,
    usage: data.usage,
    model: data.model || body.model,
  };
}

// Index of the brace closing the object that opens at `start`, or -1 (string-aware).
function closingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); // trailing commas
    } catch {
      return null;
    }
  }
}

// Find the first JSON object in a model reply that satisfies `accept`
// (handles code fences, chatter around the JSON and several candidate objects).
export function parseJson(text, accept = () => true) {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const c of [...fenced, text]) {
    for (let i = c.indexOf('{'); i !== -1; i = c.indexOf('{', i + 1)) {
      const end = closingBrace(c, i);
      if (end === -1) break; // unbalanced from here on: likely truncated
      const j = tryParse(c.slice(i, end + 1));
      if (j && typeof j === 'object' && accept(j)) return j;
    }
  }
  return null;
}

// Ask for JSON and retry when the reply is unusable. Reasoning models can burn
// most of `max_tokens` thinking and get cut off before the JSON, so each retry
// doubles the budget and switches on JSON mode.
export async function chatJson({ accept = () => true, attempts = 3, maxTokens = 4000, onRetry, ...opts }) {
  let last;
  let messages = opts.messages;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const budget = Math.min(maxTokens * 2 ** (attempt - 1), 32000);
    try {
      last = await chat({ ...opts, messages, maxTokens: budget, json: attempt > 1 });
    } catch (err) {
      // Some models reject response_format; fall back to plain mode.
      if (attempt === 1 || opts.signal?.aborted) throw err;
      last = await chat({ ...opts, messages, maxTokens: budget });
    }
    const json = parseJson(last.content, accept);
    if (json) return { json, response: last };
    const why = last.finishReason === 'length' ? `cut off at ${budget} tokens` : 'no usable JSON in the reply';
    onRetry?.(attempt, why);
    if (last.content && last.finishReason !== 'length') {
      messages = [
        ...opts.messages,
        { role: 'assistant', content: last.content.slice(0, 4000) },
        { role: 'user', content: 'That reply was not the requested JSON. Reply again with ONLY the JSON object. Escape any double quotes inside strings.' },
      ];
    }
  }
  const why = last?.finishReason === 'length' ? 'ran out of tokens while reasoning' : 'returned no usable JSON';
  const err = new Error(`The model ${why} after ${attempts} attempts.`);
  err.response = last;
  return { json: undefined, response: last, error: err };
}

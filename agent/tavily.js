// Tavily search + extract over plain fetch.
import { getConfig } from './config.js';

const API = (process.env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/+$/, '');

async function post(path, body, signal) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getConfig().tavilyKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function search(query, { maxResults = 5, depth = 'advanced', signal } = {}) {
  const data = await post(
    '/search',
    { query, search_depth: depth, max_results: maxResults, include_answer: false, include_raw_content: false },
    signal,
  );
  return (data.results ?? []).map((r) => ({
    url: r.url,
    title: r.title || r.url,
    content: r.content || '',
    score: r.score ?? 0,
  }));
}

export async function extract(urls, { signal } = {}) {
  const data = await post('/extract', { urls, extract_depth: 'basic' }, signal);
  return {
    results: (data.results ?? []).map((r) => ({ url: r.url, text: r.raw_content || '' })),
    failed: (data.failed_results ?? []).map((r) => (typeof r === 'string' ? r : r.url)),
  };
}

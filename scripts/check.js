// Verifies the API keys before a demo: lists Token Factory models and runs one Tavily search.
try {
  process.loadEnvFile();
} catch {
  /* no .env */
}
const { getConfig } = await import('../agent/config.js');
const { chat } = await import('../agent/llm.js');
const tavily = await import('../agent/tavily.js');

const cfg = getConfig();
let ok = true;

if (!cfg.nebiusKey) {
  console.log('✗ NEBIUS_API_KEY missing');
  ok = false;
} else {
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, { headers: { authorization: `Bearer ${cfg.nebiusKey}` } });
    if (!res.ok) throw new Error(`${cfg.baseUrl}/models ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const ids = (await res.json()).data?.map((m) => m.id) ?? [];
    console.log(`✓ Token Factory: ${ids.length} models`);
    const beam = ids.filter((id) => /beam/i.test(id));
    if (beam.length) console.log(`  Beam models: ${beam.join(', ')}`);
    for (const m of new Set([cfg.model, cfg.checkerModel])) {
      if (!ids.includes(m)) console.log(`  ! ${m} not in catalog`);
      const r = await chat({ model: m, messages: [{ role: 'user', content: 'Reply with the word pong.' }], maxTokens: 400 });
      console.log(`✓ ${m} replied: ${JSON.stringify(r.content.slice(0, 40))}`);
    }
  } catch (err) {
    console.log(`✗ Token Factory: ${err.message}`);
    ok = false;
  }
}

if (!cfg.tavilyKey) {
  console.log('✗ TAVILY_API_KEY missing');
  ok = false;
} else {
  try {
    const r = await tavily.search('first website CERN', { maxResults: 2, depth: 'basic' });
    console.log(`✓ Tavily: ${r.length} results (${r.map((x) => x.url).join(', ')})`);
  } catch (err) {
    console.log(`✗ Tavily: ${err.message}`);
    ok = false;
  }
}

process.exit(ok ? 0 : 1);

// Token Factory model catalog for the model picker. Cached for 10 minutes.
// Only text-out models that support tool calling are offered: the research
// agent depends on tools. The configured default is always included.
import { getConfig } from './config.js';

const TTL = 10 * 60 * 1000;
let cache = { at: 0, models: null };

function describe(m) {
  const features = m.supported_features ?? null;
  const price = (p) => (p == null ? null : Number(p) * 1e6); // $ per 1M tokens
  return {
    id: m.id,
    name: m.name || m.id,
    context: m.context_length ?? null,
    reasoning: features?.includes('reasoning') ?? false,
    pricing: m.pricing ? { prompt: price(m.pricing.prompt), completion: price(m.pricing.completion) } : null,
    // Catalogs without metadata (e.g. the mock) are assumed to be usable.
    usable: (!m.architecture || /->text$/.test(m.architecture.modality ?? '')) && (!features || features.includes('tools')),
  };
}

export async function listModels() {
  const cfg = getConfig();
  if (cache.models && Date.now() - cache.at < TTL) return cache.models;
  let models = [];
  try {
    const res = await fetch(`${cfg.baseUrl}/models?verbose=true`, { headers: { authorization: `Bearer ${cfg.nebiusKey}` } });
    if (!res.ok) throw new Error(`models ${res.status}`);
    models = ((await res.json()).data ?? []).map(describe).filter((m) => m.usable);
  } catch (err) {
    console.warn(`Could not load the model catalog: ${err.message}`);
    if (cache.models) return cache.models; // keep serving the last good list
  }
  if (!models.some((m) => m.id === cfg.model)) models.unshift({ id: cfg.model, name: cfg.model, usable: true });
  models.sort((a, b) => (a.id === cfg.model ? -1 : b.id === cfg.model ? 1 : a.name.localeCompare(b.name)));
  cache = { at: Date.now(), models };
  return models;
}

// The model a run should use: the requested one if it's in the catalog, else the default.
export async function resolveModel(requested) {
  const { model } = getConfig();
  if (!requested || requested === model) return model;
  const models = await listModels();
  return models.some((m) => m.id === requested) ? requested : model;
}

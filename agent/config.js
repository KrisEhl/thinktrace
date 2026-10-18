// Read lazily so `process.loadEnvFile()` in server.js has run before first use.
export function getConfig() {
  const env = process.env;
  // Also accept the variable names handed out at the hackathon.
  const nebiusKey = env.NEBIUS_API_KEY || env.NEBIUS_TOKEN_FACTORY_API_KEY || '';
  const tavilyKey = env.TAVILY_API_KEY || '';
  const model = env.NEBIUS_MODEL || env.MODEL_NAME || 'MiniMaxAI/MiniMax-M3';
  return {
    nebiusKey,
    tavilyKey,
    baseUrl: (env.NEBIUS_BASE_URL || env.MODEL_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, ''),
    model,
    // The fact-checker can run on a different model so it does not grade its own homework.
    checkerModel: env.NEBIUS_CHECKER_MODEL || model,
    live: Boolean(nebiusKey && tavilyKey),
    port: Number(process.env.PORT || 3000),
  };
}

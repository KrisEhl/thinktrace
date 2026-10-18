// Start the app against the local mock APIs: `npm run mock`.
// Environment variables set here take precedence over .env, so real keys stay unused.
import { startMock } from './mock-server.js';

const port = Number(process.env.MOCK_PORT ?? 4010);
await startMock(port);

Object.assign(process.env, {
  NEBIUS_API_KEY: 'mock',
  NEBIUS_BASE_URL: `http://localhost:${port}/v1`,
  NEBIUS_MODEL: 'mock/fake-llm',
  NEBIUS_CHECKER_MODEL: 'mock/fake-llm',
  TAVILY_API_KEY: 'mock',
  TAVILY_BASE_URL: `http://localhost:${port}`,
});
console.log(`Mock Token Factory + Tavily on http://localhost:${port} (no real API calls)`);

await import('../server.js');

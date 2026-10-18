// Search Shooter: zero-dependency Node server.
// Serves the game and streams agent events over Server-Sent Events.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  /* no .env file: rely on the real environment */
}

const { getConfig } = await import('./agent/config.js');
const { SourceRegistry } = await import('./agent/sources.js');
const { runResearch } = await import('./agent/research.js');
const { challengeClaim } = await import('./agent/factcheck.js');
const { runDemoResearch, demoChallenge, DEMO_QUESTION } = await import('./agent/demo.js');
const { toMarkdown } = await import('./agent/export.js');

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const runs = new Map();

function openStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const controller = new AbortController();
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    controller.abort();
  });
  return {
    signal: controller.signal,
    send(type, data) {
      if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      clearInterval(ping);
      res.end();
    },
  };
}

// Record every event on the run so the full trace can be exported afterwards.
function tracer(run, stream) {
  return (type, data) => {
    const event = { t: Date.now() - run.startedAt, type, ...data };
    run.trace.push(event);
    if (type !== 'report' && type !== 'claim') {
      const d = { ...data };
      delete d.results;
      console.log(`[${run.id.slice(0, 6)}] ${type}`, JSON.stringify(d).slice(0, 160));
    }
    stream.send(type, event);
  };
}

async function handleResearch(req, res, url) {
  const cfg = getConfig();
  const demo = !cfg.live || url.searchParams.get('demo') === '1';
  const question = demo ? DEMO_QUESTION : (url.searchParams.get('q') || '').trim().slice(0, 500);
  const stream = openStream(req, res);
  if (!question) {
    stream.send('fail', { message: 'Ask a question first.' });
    return stream.end();
  }
  const run = {
    id: randomUUID(),
    question,
    mode: demo ? 'demo' : 'live',
    model: demo ? 'offline demo' : cfg.model,
    checkerModel: demo ? 'offline demo' : cfg.checkerModel,
    sources: new SourceRegistry(),
    claims: [],
    trace: [],
    startedAt: Date.now(),
  };
  runs.set(run.id, run);
  const emit = tracer(run, stream);
  emit('run', { runId: run.id, question, mode: run.mode, model: run.model, checkerModel: run.checkerModel });
  try {
    await (demo ? runDemoResearch : runResearch)(run, emit, stream.signal);
    emit('done', { runId: run.id });
  } catch (err) {
    if (!stream.signal.aborted) {
      console.error(err);
      emit('fail', { message: err.message });
    }
  }
  stream.end();
}

async function handleChallenge(req, res, url) {
  const run = runs.get(url.searchParams.get('run'));
  const claim = run?.claims.find((c) => c.id === url.searchParams.get('claim'));
  const stream = openStream(req, res);
  if (!claim) {
    stream.send('fail', { message: 'Unknown run or claim.' });
    return stream.end();
  }
  const emit = tracer(run, stream);
  if (claim.status !== 'standing') {
    // Already judged (or in flight): replay the verdict instead of paying twice.
    if (claim.check) emit('verdict', { claimId: claim.id, ...claim.check, sourceInfo: [] });
    emit('done', {});
    return stream.end();
  }
  try {
    await (run.mode === 'demo' ? demoChallenge : challengeClaim)(run, claim, emit, stream.signal);
  } catch (err) {
    claim.status = 'standing';
    if (!stream.signal.aborted) {
      console.error(err);
      emit('fail', { claimId: claim.id, message: err.message });
    }
  }
  emit('done', {});
  stream.end();
}

function runJson(run) {
  return {
    id: run.id,
    question: run.question,
    mode: run.mode,
    model: run.model,
    checkerModel: run.checkerModel,
    plan: run.plan,
    report: run.report,
    claims: run.claims,
    sources: run.sources.list.map(({ text, ...s }) => ({ ...s, textChars: text.length })),
    trace: run.trace,
  };
}

async function serveStatic(res, pathname) {
  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname === '/api/config') {
      const cfg = getConfig();
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ live: cfg.live, model: cfg.model, checkerModel: cfg.checkerModel, demoQuestion: DEMO_QUESTION }),
      );
    } else if (pathname === '/api/research') {
      await handleResearch(req, res, url);
    } else if (pathname === '/api/challenge') {
      await handleChallenge(req, res, url);
    } else if (pathname.startsWith('/api/run/')) {
      const [id, ext] = pathname.slice('/api/run/'.length).split('.');
      const run = runs.get(id);
      if (!run) res.writeHead(404).end('Unknown run');
      else if (ext === 'md')
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }).end(toMarkdown(runJson(run)));
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(runJson(run), null, 2));
    } else {
      await serveStatic(res, decodeURIComponent(pathname));
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end(err.message);
  }
});

const cfg = getConfig();
server.listen(cfg.port, () => {
  console.log(`Search Shooter on http://localhost:${cfg.port}`);
  console.log(
    cfg.live
      ? `Live mode: ${cfg.model} on Token Factory (checker: ${cfg.checkerModel}) + Tavily`
      : 'Offline demo mode: set NEBIUS_API_KEY and TAVILY_API_KEY in .env for live research',
  );
});

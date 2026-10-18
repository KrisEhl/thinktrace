import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Dev server modes:
//   npm run dev                                       -> recorded runs from ../runs replayed over the backend's own
//                                                        endpoints (no backend, no API keys), plus ?mode=mock
//   GLASSBOX_API=http://localhost:8000 npm run dev    -> proxy /runs and /health to the live backend

const RUNS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../runs");
const SAFE = /^[\w.-]+$/;

function recordedRuns(): Plugin {
  const readEvents = (id: string) =>
    fs
      .readFileSync(path.join(RUNS, id, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  return {
    name: "glassbox-recorded-runs",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const parts = url.pathname.split("/").filter(Boolean);
        const send = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (parts[0] === "health") return send(200, { ok: true, mode: "recorded" });
        if (parts[0] !== "runs") return next();
        if (req.method !== "GET")
          return send(409, { detail: "Recorded runs only. Start the backend (uv run uvicorn glassbox.server:app --port 8000) and run the UI with GLASSBOX_API=http://localhost:8000 to start or steer runs." });

        if (parts.length === 1) {
          const runs = fs.existsSync(RUNS)
            ? fs.readdirSync(RUNS).filter((d) => fs.existsSync(path.join(RUNS, d, "events.jsonl")))
            : [];
          return send(
            200,
            runs.map((run_id) => {
              const ev = readEvents(run_id);
              return {
                run_id,
                question: ev.find((e) => e.type === "run.started")?.data?.question ?? "",
                status: ev.some((e) => e.type === "run.finished") ? "finished" : "incomplete",
                started_at: ev[0]?.ts,
              };
            }),
          );
        }
        const id = parts[1];
        if (!SAFE.test(id) || !fs.existsSync(path.join(RUNS, id, "events.jsonl"))) return send(404, { detail: "unknown run" });

        if (parts[2] === "events.jsonl") {
          res.setHeader("Content-Type", "application/x-ndjson");
          return res.end(fs.readFileSync(path.join(RUNS, id, "events.jsonl")));
        }
        if (parts[2] === "events") {
          // Replay with the original timing, scaled by ?speed (default 4, 0 = all at once); gaps capped at 2 s.
          const speed = Number(url.searchParams.get("speed") ?? 4);
          const from = Number(url.searchParams.get("from") ?? req.headers["last-event-id"] ?? 0);
          const events = readEvents(id).filter((e) => e.seq >= from);
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          let i = 0;
          let closed = false;
          req.on("close", () => (closed = true));
          const tick = () => {
            if (closed) return;
            if (i >= events.length) return res.end();
            const e = events[i++];
            res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
            const next = events[i];
            const gap = next && speed > 0 ? Math.min((Date.parse(next.ts) - Date.parse(e.ts)) / speed, 2000) : 0;
            setTimeout(tick, Math.max(gap, 0));
          };
          return tick();
        }
        if (parts[2] === "sources" && parts[3] && SAFE.test(parts[3])) {
          const sid = parts[3];
          const meta = readEvents(id).find((e) => e.type === "source.added" && e.data.source_id === sid)?.data ?? {};
          const file = path.join(RUNS, id, "sources", `${sid}.txt`);
          const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
          return send(200, { source_id: sid, url: meta.url ?? "", title: meta.title ?? sid, domain: meta.domain ?? "", text, read: text !== null });
        }
        return send(404, { detail: "not found" });
      });
    },
  };
}

const api = process.env.GLASSBOX_API;

export default defineConfig({
  plugins: [react(), ...(api ? [] : [recordedRuns()])],
  server: api ? { proxy: { "/runs": api, "/health": api } } : {},
});

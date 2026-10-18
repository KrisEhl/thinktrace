import { Translator, type Envelope } from "./glassbox";
import type { CreateRunRequest, RunInfo, Source, SteerRequest, Transport } from "./types";

// The real backend (glassbox/server.py, docs section 6). Same paths are served by the Vite dev plugin from runs/
// when no backend is running, so recorded runs replay without API keys.
//
// SSE replays the run's log from seq 0 and then tails it live; every envelope goes through the Translator.

export function httpTransport(base: string, opts: { speed?: number } = {}): Transport {
  let current: string | null = null;

  const json = async <T,>(res: Response): Promise<T> => {
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        detail = typeof body.detail === "string" ? body.detail : detail;
      } catch {
        /* not json */
      }
      throw new Error(detail);
    }
    return res.json() as Promise<T>;
  };

  return {
    async createRun(req: CreateRunRequest) {
      const r = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: req.question }),
      });
      return json<{ run_id: string }>(r);
    },

    subscribe(run_id, onEvent, onClose) {
      current = run_id;
      const t = new Translator();
      const q = opts.speed ? `?speed=${opts.speed}` : "";
      const es = new EventSource(`${base}/runs/${run_id}/events${q}`);
      let last = -1;
      es.onmessage = (m) => {
        const env = JSON.parse(m.data) as Envelope;
        if (env.seq <= last) return; // a reconnect may resend; the translator must see each seq once
        last = env.seq;
        t.apply(env).forEach(onEvent);
        if (env.type === "run.finished") {
          es.close();
          onClose?.();
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) onClose?.();
      };
      return () => es.close();
    },

    async steer(run_id, req: SteerRequest) {
      // UI "deactivate" is the backend's "redirect" (drop the direction, optionally research something else).
      const action = req.action === "deactivate" || req.action === "redirect" ? "redirect" : req.action === "dig_deeper" ? "dig_deeper" : null;
      if (!action) throw new Error(`"${req.action}" is not supported by the backend yet (only redirect and dig deeper).`);
      if (!req.node_id || req.node_id === "q") throw new Error("Select a direction to steer.");
      await json(
        await fetch(`${base}/runs/${run_id}/steer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, dir: req.node_id, text: req.text || null }),
        }),
      );
    },

    async getSource(source_id): Promise<Source> {
      if (!current) throw new Error("no run");
      const s = await json<{ source_id: string; url: string; title: string; domain: string; text: string | null; read?: boolean }>(
        await fetch(`${base}/runs/${current}/sources/${source_id}`),
      );
      return { id: s.source_id ?? source_id, url: s.url, title: s.title, domain: s.domain, origin_id: s.domain, text: s.text ?? "", origin: "web" };
    },

    health: () => fetch(`${base}/health`).then((r) => json<{ ok: boolean; mode?: string }>(r)),

    listRuns: () => fetch(`${base}/runs`).then((r) => json<RunInfo[]>(r)),
  };
}

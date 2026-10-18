import type { CreateRunRequest, GlassboxEvent, GraphSnapshot, Source, SteerRequest, Transport } from "./types";

// Real backend, endpoints exactly as in the Glassbox spec.
export function httpTransport(base: string): Transport {
  const json = async <T,>(res: Response): Promise<T> => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  };
  return {
    createRun: (req: CreateRunRequest) =>
      fetch(`${base}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      }).then((r) => json<{ run_id: string }>(r)),

    subscribe(run_id, onEvent, onClose) {
      const es = new EventSource(`${base}/runs/${run_id}/events`);
      es.onmessage = (m) => onEvent(JSON.parse(m.data) as GlassboxEvent);
      es.onerror = () => {
        es.close();
        onClose?.();
      };
      return () => es.close();
    },

    getGraph: (run_id) => fetch(`${base}/runs/${run_id}/graph`).then((r) => json<GraphSnapshot>(r)),

    steer: (run_id, req: SteerRequest) =>
      fetch(`${base}/runs/${run_id}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      }).then(() => undefined),

    getSource: (id) => fetch(`${base}/sources/${id}`).then((r) => json<Source>(r)),

    health: () => fetch(`${base}/health`).then((r) => json<{ ok: boolean; models?: string[]; tavily?: boolean }>(r)),
  };
}

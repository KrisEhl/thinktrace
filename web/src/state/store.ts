import { create } from "zustand";
import { transport } from "../api";
import type { GlassboxEvent, SteerAction } from "../api/types";
import { applyEvent, emptyRun, fromSnapshot, type RunState } from "./reducer";

export type DockTab = "node" | "answer" | "source" | "ledger" | "play";

interface Ui {
  focusId: string; // graph layer: this node is the centre
  selectedId: string | null;
  openNotes: Record<string, boolean>; // message id -> unfolded
  dockTab: DockTab;
  dockOpen: boolean;
  railOpen: boolean;
  traceOpen: boolean;
  railW: number;
  dockW: number;
  source: { source_id: string; claim_id?: string } | null;
  follow: boolean; // auto-fit the graph while it grows, until the user pans/zooms
  highlightClaim: string | null; // the claim being traced (provenance chain)
  traceOnly: boolean; // activity layer shows only the traced path
  view: "lanes" | "graph"; // vertical lanes per direction, or the zoomable graph
  rejectSource: string | null; // "what if I reject it" preview (client-side only, nothing is sent to the backend)
  notice: string | null; // short message in the stats bar (e.g. why a steer was refused)
}

interface Actions {
  start: (question: string, scenario?: string) => Promise<void>;
  hydrate: (run_id: string) => Promise<void>;
  steer: (action: SteerAction, opts?: { node_id?: string; text?: string }) => Promise<void>;
  ask: (text: string) => Promise<void>;
  select: (id: string | null) => void;
  drill: (id: string) => void;
  up: () => void;
  reveal: (node_id: string) => void;
  toggleNote: (message_id: string) => void;
  openSource: (source_id: string, claim_id?: string) => void;
  openClaim: (claim_id: string) => void;
  set: (p: Partial<Ui>) => void;
}

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("gb-ui") ?? "{}") as Partial<Ui>;
  } catch {
    return {};
  }
})();

let unsub: (() => void) | null = null;

export const useStore = create<{ run: RunState; ui: Ui } & Actions>((set, get) => {
  const setUi = (p: Partial<Ui>) => {
    set((s) => ({ ui: { ...s.ui, ...p } }));
    try {
      const { railW, dockW, railOpen, traceOpen, view } = get().ui;
      localStorage.setItem("gb-ui", JSON.stringify({ railW, dockW, railOpen, traceOpen, view }));
    } catch {
      /* storage can be unavailable */
    }
  };
  const onEvent = (e: GlassboxEvent) => set((s) => ({ run: applyEvent(s.run, e) }));

  const attach = (run_id: string) => {
    unsub?.();
    unsub = transport.subscribe(run_id, onEvent);
  };

  return {
    run: emptyRun(),
    ui: {
      focusId: "q",
      selectedId: null,
      openNotes: {},
      dockTab: "node",
      dockOpen: true,
      railOpen: true,
      traceOpen: true,
      railW: 300,
      dockW: 380,
      source: null,
      follow: true,
      highlightClaim: null,
      traceOnly: true,
      rejectSource: null,
      view: "lanes",
      notice: null,
      ...saved,
    },

    async start(question, scenario) {
      unsub?.();
      set({ run: { ...emptyRun(), status: "running", question } });
      setUi({ focusId: "q", selectedId: null, openNotes: {}, source: null, follow: true, dockTab: "node", rejectSource: null });
      try {
        const { run_id } = await transport.createRun({ question, scenario });
        set((s) => ({ run: { ...s.run, run_id } }));
        attach(run_id);
      } catch (err) {
        set({ run: emptyRun() });
        setUi({ notice: err instanceof Error ? err.message : String(err) });
      }
    },

    async hydrate(run_id) {
      // The event stream replays from seq 0, so a fresh state plus a subscription rebuilds the whole run.
      if (transport.getGraph) set({ run: fromSnapshot(await transport.getGraph(run_id)) });
      else set({ run: { ...emptyRun(), status: "running", run_id } });
      setUi({ focusId: "q", selectedId: null, openNotes: {}, source: null, follow: true, dockTab: "node", rejectSource: null });
      attach(run_id);
    },

    async steer(action, opts = {}) {
      const run_id = get().run.run_id;
      if (!run_id) return;
      try {
        await transport.steer(run_id, { action, ...opts });
        setUi({ notice: null });
      } catch (err) {
        setUi({ notice: err instanceof Error ? err.message : String(err) });
      }
    },

    async ask(text) {
      // A follow-up pins to the selected node and grows from it (decided in brainstorming).
      const node_id = get().ui.selectedId ?? "q";
      await get().steer("chat", { node_id, text });
    },

    select(id) {
      // The Playground tab stays put while you pick nodes to poke.
      const keep = get().ui.dockTab === "play";
      setUi({ selectedId: id, ...(id && !keep ? { dockTab: "node" as const, dockOpen: true } : {}) });
    },

    drill(id) {
      const n = get().run.nodes[id];
      if (!n) return;
      setUi({ focusId: id, selectedId: id, follow: true });
    },

    up() {
      const { focusId } = get().ui;
      const p = get().run.nodes[focusId]?.parent_id;
      if (p) setUi({ focusId: p, selectedId: focusId, follow: true });
    },

    reveal(node_id) {
      const n = get().run.nodes[node_id];
      if (!n) return;
      // Show the node's layer: its parent is the centre, unless it is the root or already drillable context.
      setUi({ focusId: n.parent_id ?? n.id, selectedId: n.id, dockTab: "node", dockOpen: true, follow: true });
    },

    toggleNote(message_id) {
      const o = get().ui.openNotes;
      setUi({ openNotes: { ...o, [message_id]: !o[message_id] } });
    },

    openSource(source_id, claim_id) {
      setUi({ source: { source_id, claim_id }, dockTab: "source", dockOpen: true, highlightClaim: claim_id ?? null });
    },

    openClaim(claim_id) {
      const c = get().run.claims[claim_id];
      if (!c) return;
      // Land in the direction's activity layer so the claim, its source and the decisions behind it are all visible.
      setUi({ focusId: c.node_id, selectedId: c.node_id, follow: true });
      get().openSource(c.source_id, claim_id);
    },

    set: setUi,
  };
});

import { useEffect } from "react";
import { GraphView } from "./components/GraphView";
import { Rail } from "./components/Rail";
import { Dock } from "./components/Dock";
import { StatsBar, TraceStrip } from "./components/Chrome";
import { useStore } from "./state/store";

/** Drag handle that resizes a side pane. */
function Resizer({ side }: { side: "rail" | "dock" }) {
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const { railW, dockW } = useStore.getState().ui;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (side === "rail") useStore.getState().set({ railW: Math.min(560, Math.max(200, railW + dx)) });
      else useStore.getState().set({ dockW: Math.min(720, Math.max(280, dockW - dx)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className="resizer" onPointerDown={onDown} />;
}

export function App() {
  const { railOpen, dockOpen, railW, dockW } = useStore((s) => s.ui);

  useEffect(() => {
    // ?run=<id> re-attaches to an existing run (uses GET /runs/{id}/graph then the event stream).
    const id = new URLSearchParams(location.search).get("run");
    if (id) void useStore.getState().hydrate(id);
  }, []);

  return (
    <div className="app">
      <StatsBar />
      <div className="main">
        {railOpen && (
          <>
            <aside style={{ width: railW }}>
              <Rail />
            </aside>
            <Resizer side="rail" />
          </>
        )}
        <section className="center">
          <GraphView />
          <TraceStrip />
        </section>
        {dockOpen && (
          <>
            <Resizer side="dock" />
            <aside style={{ width: dockW }}>
              <Dock />
            </aside>
          </>
        )}
      </div>
    </div>
  );
}

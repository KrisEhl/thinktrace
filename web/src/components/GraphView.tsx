import { useCallback, useEffect, useMemo, useRef } from "react";
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore } from "../state/store";
import { layoutLayer } from "../graph/layout";
import { nodeTypes } from "./nodes";

const ZOOM_IN_AT = 1.9; // zooming past this with a node selected drills into it
const ZOOM_OUT_AT = 0.35;

function Inner() {
  const run = useStore((s) => s.run);
  const { focusId, follow, highlightClaim, traceOnly } = useStore((s) => s.ui);
  const { select, drill, up, set } = useStore.getState();
  const rf = useReactFlow();
  const programmatic = useRef(false);

  const { nodes, edges } = useMemo(
    () => layoutLayer(run, focusId, { claim_id: highlightClaim, only: traceOnly }),
    [run, focusId, highlightClaim, traceOnly],
  );

  // Fit when the layer changes, and while the graph grows (until the user pans or zooms by hand).
  const sig = nodes.length + ":" + focusId + ":" + (highlightClaim ?? "") + traceOnly;
  useEffect(() => {
    if (!follow || !nodes.length) return;
    programmatic.current = true;
    const t = setTimeout(() => {
      const activity = useStore.getState().run.nodes[focusId]?.kind === "direction";
      rf.fitView({ padding: activity ? 0.1 : 0.3, duration: 450, maxZoom: activity ? 1.2 : 1.1 });
      setTimeout(() => (programmatic.current = false), 600);
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, follow]);

  const onMoveStart = useCallback(
    (ev: unknown) => {
      if (ev && !programmatic.current) set({ follow: false });
    },
    [set],
  );

  // Semantic zoom: zoom into the selected node to open its layer; zoom far out to go back up.
  const onMoveEnd = useCallback(
    (_e: unknown, vp: { zoom: number }) => {
      if (programmatic.current) return;
      const st = useStore.getState();
      const sel = st.ui.selectedId && st.run.nodes[st.ui.selectedId];
      if (vp.zoom > ZOOM_IN_AT && sel && sel.id !== st.ui.focusId && sel.kind !== "question") drill(sel.id);
      else if (vp.zoom < ZOOM_OUT_AT && st.run.nodes[st.ui.focusId]?.parent_id) up();
    },
    [drill, up],
  );

  const onNodeClick = useCallback((_: unknown, n: Node) => {
      if (n.type === "gb") select(n.id); // decision / source / claim cards handle their own clicks
    },
    [select],);
  const onNodeDoubleClick = useCallback(
    (_: unknown, n: Node) => {
      if (n.type !== "gb") return;
      const kind = useStore.getState().run.nodes[n.id]?.kind;
      if (kind && kind !== "question") drill(n.id);
    },
    [drill],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onPaneClick={() => select(null)}
      onMoveStart={onMoveStart}
      onMoveEnd={onMoveEnd}
      zoomOnDoubleClick={false}
      minZoom={0.15}
      maxZoom={3}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background gap={28} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function GraphView() {
  const run = useStore((s) => s.run);
  const { focusId, follow, highlightClaim, traceOnly } = useStore((s) => s.ui);
  const { up, set, drill } = useStore.getState();
  const tracedHere = highlightClaim && run.claims[highlightClaim]?.node_id === focusId;

  // breadcrumb: root > ... > focus
  const crumbs: string[] = [];
  for (let id: string | null | undefined = focusId; id; id = run.nodes[id]?.parent_id) crumbs.unshift(id);

  const kind = run.nodes[focusId]?.kind;
  const kidsAreDirections = Object.values(run.nodes).some((n) => n.parent_id === focusId && n.kind === "direction");
  const layerName =
    kind === "direction" ? "What the agent is doing" : kind === "dimension" ? "Sub-questions" : kidsAreDirections ? "Research directions" : "Dimensions";

  return (
    <div className="graph">
      {Object.keys(run.nodes).length === 0 ? (
        <div className="empty">
          <h2>Ask a question to grow the graph</h2>
          <p>The question breaks into dimensions, then sub-questions. Zoom into any node to see what the agent is doing there.</p>
        </div>
      ) : (
        <ReactFlowProvider>
          <Inner />
        </ReactFlowProvider>
      )}
      <div className="crumbs">
        <span className="layer">{layerName}</span>
        {crumbs.map((id, i) => (
          <span key={id}>
            {i > 0 && " › "}
            <button onClick={() => drill(id)} disabled={id === focusId}>
              {(run.nodes[id]?.label ?? id).length > 26 ? (run.nodes[id]?.label ?? id).slice(0, 25) + "…" : run.nodes[id]?.label ?? id}
            </button>
          </span>
        ))}
        {run.nodes[focusId]?.parent_id && <button className="ghost" onClick={up}>↑ up</button>}
        {!follow && <button className="ghost" onClick={() => set({ follow: true })}>⤢ refit</button>}
        {highlightClaim && run.claims[highlightClaim] && (
          <span className="trace-chip">
            Tracing [{highlightClaim}]
            {tracedHere ? (
              <button className="ghost" onClick={() => set({ traceOnly: !traceOnly, follow: true })}>
                {traceOnly ? "show all activity" : "only this trace"}
              </button>
            ) : (
              <button className="ghost" onClick={() => drill(run.claims[highlightClaim].node_id)}>go to path</button>
            )}
            <button className="ghost" onClick={() => set({ highlightClaim: null, follow: true })} title="Stop tracing">✕</button>
          </span>
        )}
      </div>
      <div className="legend">
        <i className="dot green" /> ≥0.75 <i className="dot orange" /> 0.5–0.75 <i className="dot red" /> &lt;0.5 <i className="dot grey" /> unverified <i className="dot off" /> off
      </div>
    </div>
  );
}

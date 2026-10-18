import { useState } from "react";
import { isMock, transport } from "../api";
import { useStore } from "../state/store";
import { circled } from "./nodes";
import { claimNumber, notes } from "../state/selectors";

export function Rail() {
  const run = useStore((s) => s.run);
  const selectedId = useStore((s) => s.ui.selectedId);
  const { start, ask, reveal, openClaim } = useStore.getState();
  const scenarios = transport.scenarios ?? [];
  const [scenario, setScenario] = useState(scenarios[0]?.id ?? "");
  const [text, setText] = useState(scenarios[0]?.question ?? "");
  const started = run.status !== "idle";
  const sel = selectedId ? run.nodes[selectedId] : null;
  const numberOf = Object.fromEntries(notes(run).map((x) => [x.user.id, x.n]));

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (!started) void start(t, scenario);
    else void ask(t);
    if (started) setText("");
  };

  return (
    <div className="rail">
      <div className="pane-title">Chat log</div>
      <div className="log">
        {!started && <p className="muted">Your questions and the model's answers stay here for the whole run. Each one is also pinned to a node as a sticky note.</p>}
        {run.messages.map((m) => {
          const node = run.nodes[m.node_id];
          return (
            <div key={m.id} className={`msg ${m.role} ${m.pending ? "pending" : ""}`} onClick={() => { reveal(m.node_id); if (m.role === "user") useStore.getState().set({ openNotes: { ...useStore.getState().ui.openNotes, [m.id]: true } }); }}>
              <div className="who">
                {m.role === "user" ? `${circled(numberOf[m.id] ?? 0)} You` : "Agent"}
                {node && m.node_id !== "q" && <span className="pin"> ⟶ pinned to “{node.label}”</span>}
              </div>
              <div>{m.text}</div>
              {m.claim_ids && m.claim_ids.length > 0 && (
                <div className="cites">
                  {m.claim_ids.map((c) => (
                    <button key={c} className="cite" onClick={(e) => { e.stopPropagation(); openClaim(c); }}>
                      [c{claimNumber(c)}]
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="composer">
        <textarea
          value={text}
          rows={3}
          placeholder={started ? (sel ? `Ask about “${sel.label}”…` : "Ask a follow-up…") : "Ask a research question…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {!started && scenarios.length > 0 && (
          <select
            value={scenario}
            onChange={(e) => {
              setScenario(e.target.value);
              setText(scenarios.find((x) => x.id === e.target.value)?.question ?? "");
            }}
          >
            {scenarios.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
        )}
        <div className="composer-row">
          <span className="muted">{isMock ? "mock backend" : "live backend"}</span>
          <button className="primary" onClick={submit}>
            {started ? "Ask" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}

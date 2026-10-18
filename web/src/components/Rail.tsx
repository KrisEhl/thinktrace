import { useEffect, useState } from "react";
import { backend, initialRun, isMock } from "../api";
import type { RunInfo } from "../api/types";
import { SCENARIOS } from "../mock/fixture";
import { useStore } from "../state/store";
import { circled } from "./nodes";
import { claimNumber, notes } from "../state/selectors";

export function Rail() {
  const run = useStore((s) => s.run);
  const selectedId = useStore((s) => s.ui.selectedId);
  const { start, ask, reveal, openClaim } = useStore.getState();
  const scenarios = SCENARIOS;
  const urlScenario = new URLSearchParams(location.search).get("scenario");
  const [scenario, setScenario] = useState(scenarios.find((x) => x.id === urlScenario)?.id ?? scenarios[0].id);
  const [text, setText] = useState(isMock ? (scenarios.find((x) => x.id === scenario)?.question ?? "") : "");
  const [runs, setRuns] = useState<RunInfo[]>([]);
  useEffect(() => {
    backend.listRuns?.().then(setRuns).catch(() => setRuns([]));
  }, []);
  const picked = isMock ? `mock:${scenario}` : initialRun ? `run:${initialRun}` : "live";
  const pick = (v: string) => {
    if (v.startsWith("mock:") && isMock && !started) {
      setScenario(v.slice(5));
      setText(scenarios.find((x) => x.id === v.slice(5))?.question ?? "");
      return;
    }
    const q = new URLSearchParams();
    if (v.startsWith("mock:")) (q.set("mode", "mock"), q.set("scenario", v.slice(5)));
    else if (v.startsWith("run:")) (q.set("run", v.slice(4)), q.set("speed", "4"));
    location.search = q.toString();
  };
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
              <div className={m.answer ? "muted" : ""}>{m.text}</div>
              {m.answer && (
                <div className="chat-answer">
                  {m.answer.map((s, i) => (
                    <p key={i}>
                      {s.text}
                      {s.claim_ids.map((c) => (
                        <button key={c} className="cite" onClick={(e) => { e.stopPropagation(); openClaim(c); }}>
                          [c{claimNumber(c)}]
                        </button>
                      ))}
                    </p>
                  ))}
                </div>
              )}
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
        <select value={picked} onChange={(e) => pick(e.target.value)} title="Where the run comes from">
          <option value="live">Live backend: ask a new question</option>
          {runs.length > 0 && (
            <optgroup label="Recorded / earlier runs">
              {runs.map((r) => (
                <option key={r.run_id} value={`run:${r.run_id}`}>
                  {r.run_id} · {r.question.slice(0, 48)} ({r.status})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Mock (playground)">
            {scenarios.map((x) => (
              <option key={x.id} value={`mock:${x.id}`}>{x.label}</option>
            ))}
          </optgroup>
        </select>
        <div className="composer-row">
          <span className="muted">{isMock ? "mock backend" : initialRun ? `run ${initialRun}` : "live backend"}</span>
          <button className="primary" onClick={submit}>
            {started ? "Ask" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}

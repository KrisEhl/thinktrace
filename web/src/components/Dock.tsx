import { useEffect, useRef, useState } from "react";
import { transport } from "../api";
import type { Source } from "../api/types";
import { useStore, type DockTab } from "../state/store";
import {
  answerSentencesCiting,
  children,
  provenance,
  claimNumber,
  claimsOfNode,
  claimsOfSource,
  claimTone,
  claimUsage,
  decisionsOfNode,
  nodeConfidence,
  nodeTone,
  originGroups,
  sourceUsage,
  toneLabel,
} from "../state/selectors";

const TABS: [DockTab, string][] = transport.simulate ? [
  ["node", "Node"],
  ["answer", "Answer"],
  ["source", "Source"],
  ["ledger", "Ledger"],
  ["play", "Play"],
] : [
  ["node", "Node"],
  ["answer", "Answer"],
  ["source", "Source"],
  ["ledger", "Ledger"],
];

export function Dock() {
  const tab = useStore((s) => s.ui.dockTab);
  const { set } = useStore.getState();
  return (
    <div className="dock">
      <div className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => set({ dockTab: k })}>
            {label}
          </button>
        ))}
      </div>
      <div className="dock-body">
        {tab === "node" && <NodePanel />}
        {tab === "answer" && <AnswerPanel />}
        {tab === "source" && <SourceViewer />}
        {tab === "ledger" && <Ledger />}
        {tab === "play" && <Playground />}
      </div>
    </div>
  );
}

function Cite({ id }: { id: string }) {
  const openClaim = useStore((s) => s.openClaim);
  return (
    <button className="cite" onClick={() => openClaim(id)} title="Open claim, quote and source">
      [c{claimNumber(id)}]
    </button>
  );
}

const matchLabel = (c: { verified: boolean | null; match?: string; verified_against?: string }) =>
  c.match === "fuzzy"
    ? "quote found (near match)"
    : c.match === "not_found" || c.verified === false
      ? "quote NOT found in the source"
      : c.verified_against === "snippet"
        ? "quote found in the search snippet only"
        : c.verified
          ? "quote found verbatim"
          : "checking…";

/* ---------- Node ---------- */

function NodePanel() {
  const run = useStore((s) => s.run);
  const { selectedId, focusId } = useStore((s) => s.ui);
  const { steer, drill, select } = useStore.getState();
  const id = selectedId ?? focusId;
  const n = run.nodes[id];
  if (!n) return <p className="muted pad">Nothing selected yet. Click a node.</p>;

  const tone = nodeTone(run, id);
  const conf = nodeConfidence(run, id);
  const claims = claimsOfNode(run, id);
  const decisions = decisionsOfNode(run, id);
  const kids = children(run, id);
  const dead = n.status === "deactivated";

  const fix = () => {
    const text = window.prompt("Fix a wrong assumption. What should the agent take as given?", "");
    if (text) void steer("fix", { node_id: id, text });
  };

  return (
    <div className="pad">
      <h3>{n.label}</h3>
      <div className="row">
        <span className={`chip tone-${tone}`}>{toneLabel[tone]}</span>
        {conf !== undefined && <span className="chip">confidence {conf.toFixed(2)}</span>}
        {n.verdict && <span className="chip">verdict: {n.verdict}</span>}
        <span className="chip">{n.status}</span>
      </div>
      {n.title && n.title !== n.label && <p>{n.title}</p>}
      {n.why && (
        <p className="muted">
          <b>Why it was planned:</b> {n.why}
        </p>
      )}
      {n.from_dir && <p className="muted">Replaces {run.nodes[n.from_dir]?.label ?? n.from_dir}, which you redirected.</p>}
      {n.queries && n.queries.length > 0 && <p className="muted">First queries: {n.queries.map((q) => `“${q}”`).join(" · ")}</p>}
      {run.needs_human[id] && <div className="callout">⚠ Needs you: {run.needs_human[id]}</div>}
      {run.stop_reasons[id] && <p className="muted">Stopped: {run.stop_reasons[id]}</p>}
      {n.budget_hit && <p className="muted">⏱ Hit its search/read budget.</p>}

      {n.kind !== "question" && (
        <div className="actions">
          <button onClick={() => void steer("deactivate", { node_id: id })} disabled={dead}>Deactivate</button>
          <button onClick={() => void steer("dig_deeper", { node_id: id })} disabled={dead}>Dig deeper</button>
          <button onClick={fix}>Fix…</button>
          <button onClick={() => void steer("accept", { node_id: id })}>Accept</button>
          {n.kind !== "direction" || focusId !== id ? <button className="primary" onClick={() => drill(id)}>Zoom in ⤢</button> : null}
        </div>
      )}
      {n.kind === "direction" && decisions.length + claims.length === 0 && <p className="muted">The agent has not started here yet.</p>}

      {kids.length > 0 && (
        <>
          <h4>Contains</h4>
          {kids.map((k) => (
            <div key={k.id} className="item clickable" onClick={() => select(k.id)}>
              <span className={`dot ${nodeTone(run, k.id)}`} /> {k.label}
              <span className="muted"> · {toneLabel[nodeTone(run, k.id)]}</span>
            </div>
          ))}
        </>
      )}

      {claims.length > 0 && <h4>Claims ({claims.length})</h4>}
      {claims.map((c) => {
        const u = claimUsage(run, c);
        const src = run.sources[c.source_id];
        return (
          <div key={c.id} className={`item claimcard tone-${claimTone(c)}`}>
            <div>
              <Cite id={c.id} /> {c.text}
            </div>
            <blockquote>“{c.quote}”</blockquote>
            <div className="muted">
              {matchLabel(c)} · {c.origin_ids.length} independent origin{c.origin_ids.length === 1 ? "" : "s"} · {src?.domain}
            </div>
            {(c.links ?? []).map((l, i) => (
              <div key={i} className={`muted link-${l.relation}`}>
                {l.relation === "corroborates" ? "↔ corroborates" : "⚡ contradicts"} <Cite id={l.target} /> {l.by === "checker" ? "(fact-checker)" : "(agent)"}
                {l.reason ? `: ${l.reason}` : ""}
              </div>
            ))}
            <div className={`use use-${u.state}`}>{u.state === "used" ? "● used in answer" : u.state === "pending" ? "○ answer pending" : `○ not used: ${u.reason}`}</div>
          </div>
        );
      })}

      {decisions.length > 0 && <h4>Decisions ({decisions.length})</h4>}
      {decisions.map((d) => (
        <div key={d.id} className="item">
          <b>{d.action}</b> {d.query && <>“{d.query}”</>}
          <div className="muted">because {d.why}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Answer ---------- */

function AnswerPanel() {
  const run = useStore((s) => s.run);
  const traced = useStore((s) => s.ui.highlightClaim);
  if (run.answer.length === 0) return <p className="muted pad">{run.status === "idle" ? "Run a question first." : "The answer is written after the research stops."}</p>;
  const unused = Object.values(run.claims).filter((c) => claimUsage(run, c).state === "unused");
  return (
    <div className="pad">
      <h3>Answer{run.answer_meta.version > 0 ? ` v${run.answer_meta.version}` : ""}</h3>
      <p className="muted">
        Every sentence cites claim ids. Click one to see the quote and the source.
        {run.answer_meta.dropped.length > 0 && ` ${run.answer_meta.dropped.length} uncited sentence(s) were dropped.`}
        {run.answer_meta.changed.length > 0 && ` Highlighted: changed since the previous version.`}
      </p>
      {run.answer.map((s, i) => (
        <p key={i} className={`${s.claim_ids.length === 0 ? "gap" : ""} ${traced && s.claim_ids.includes(traced) ? "traced" : ""} ${run.answer_meta.changed.some((c) => c.includes(s.text.slice(0, 40))) ? "changed" : ""}`}>
          {s.text} {s.claim_ids.map((c) => <Cite key={c} id={c} />)}
        </p>
      ))}
      {unused.length > 0 && (
        <>
          <h4>Collected but not used ({unused.length})</h4>
          {unused.map((c) => (
            <div key={c.id} className="item">
              <Cite id={c.id} /> {c.text}
              <div className="muted">{claimUsage(run, c).reason}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ---------- Source ---------- */

function SourceViewer() {
  const run = useStore((s) => s.run);
  const target = useStore((s) => s.ui.source);
  const { openClaim, openSource } = useStore.getState();
  const [fetched, setFetched] = useState<Source | null>(null);
  const markRef = useRef<HTMLElement | null>(null);

  const local = target ? run.sources[target.source_id] : undefined;
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => {
    setFetched(null);
    setLoadErr(null);
    if (target && !local?.text)
      transport
        .getSource(target.source_id)
        .then(setFetched)
        .catch((e) => setLoadErr(String(e?.message ?? e)));
  }, [target?.source_id, local?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = local?.text ? local : fetched ? { ...local, ...fetched } : local;
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [target?.claim_id, src?.id]);

  if (!target || !src) return <p className="muted pad">Click a citation or a source node to read the source with the quote highlighted.</p>;
  const noText = !src.text;

  const claims = claimsOfSource(run, src.id);
  const spans = claims
    .filter((c) => c.span)
    .map((c) => ({ c, s: c.span as [number, number] }))
    .sort((a, b) => a.s[0] - b.s[0]);

  const parts: React.ReactNode[] = [];
  let at = 0;
  spans.forEach(({ c, s }) => {
    if (s[0] < at) return;
    parts.push(src.text.slice(at, s[0]));
    const active = c.id === target.claim_id;
    parts.push(
      <mark key={c.id} ref={active ? (el) => { markRef.current = el; } : undefined} className={active ? "active" : ""} onClick={() => openSource(src.id, c.id)}>
        {src.text.slice(s[0], s[1])}
        <sup>c{claimNumber(c.id)}</sup>
      </mark>,
    );
    at = s[1];
  });
  parts.push(src.text.slice(at));

  const sameOrigin = (originGroups(run)[src.origin_id] ?? []).filter((s) => s.id !== src.id);
  const usage = sourceUsage(run, src);

  return (
    <div className="pad">
      {target.claim_id && <TraceCard claim_id={target.claim_id} />}
      <h3>{src.title}</h3>
      <div className="muted">
        <a href={src.url} target="_blank" rel="noreferrer">{src.domain}</a> · origin <code>{src.origin_id}</code>
        {sameOrigin.length > 0 && <> · counts as one with {sameOrigin.map((s) => s.domain).join(", ")} (echo)</>}
      </div>
      <div className={`use use-${usage.state}`}>{usage.state === "used" ? `● ${usage.used} claim(s) from here are used in the answer` : usage.state === "pending" ? "○ answer pending" : "○ nothing from this source is used in the answer"}</div>
      {noText ? (
        <div className="callout">
          {loadErr ? `Could not load the page text: ${loadErr}` : fetched ? "The agent never read this page in full; quotes from it were checked against the search snippet only." : "Loading page text…"}
        </div>
      ) : (
        <div className="srctext">{parts}</div>
      )}
      {claims.length > 0 && <h4>Claims quoted from this source</h4>}
      {claims.map((c) => {
        const cited = answerSentencesCiting(run, c.id);
        return (
          <div key={c.id} className="item clickable" onClick={() => openClaim(c.id)}>
            <Cite id={c.id} /> {c.text}
            <div className="muted">
              {c.verified === false ? "quote not found in this text" : c.span ? `chars ${c.span[0]}–${c.span[1]}` : "checking…"}
              {cited.length > 0 ? ` · cited in answer sentence${cited.length > 1 ? "s" : ""} ${cited.map((x) => x.i + 1).join(", ")}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Provenance chain ---------- */

function TraceCard({ claim_id }: { claim_id: string }) {
  const run = useStore((s) => s.run);
  const { drill, set, openClaim } = useStore.getState();
  const p = provenance(run, claim_id);
  if (!p) return null;
  const { claim: c, node, source, read, search, sentences, links, usage } = p;
  const showPath = () => {
    drill(c.node_id);
    set({ highlightClaim: c.id, traceOnly: true, follow: true });
  };
  const Step = ({ k, label, children }: { k: string; label: string; children: React.ReactNode }) => (
    <li className={`step step-${k}`}>
      <span className="step-label">{label}</span>
      <div>{children}</div>
    </li>
  );
  return (
    <div className="tracecard">
      <div className="tracecard-head">
        <b>Where [c{claimNumber(c.id)}] comes from</b>
        <button className="ghost" onClick={showPath}>show path in graph</button>
      </div>
      <ol className="chain">
        <Step k="answer" label="Answer">
          {sentences.length ? (
            sentences.map(({ s, i }) => (
              <div key={i}>
                sentence {i + 1}: “{s.text.length > 140 ? s.text.slice(0, 139) + "…" : s.text}”
              </div>
            ))
          ) : (
            <span className="muted">not cited: {usage.reason}</span>
          )}
        </Step>
        <Step k="claim" label="Claim">
          {c.text} <span className={`chip tone-${c.confidence === 0 ? "grey" : c.confidence >= 0.75 ? "green" : c.confidence >= 0.5 ? "orange" : "red"}`}>{c.origin_ids.length} origin{c.origin_ids.length === 1 ? "" : "s"}</span>
        </Step>
        <Step k="quote" label="Quote">
          “{c.quote.length > 160 ? c.quote.slice(0, 159) + "…" : c.quote}”
          <div className="muted">{matchLabel(c)}{c.span ? `, chars ${c.span[0]}–${c.span[1]}` : ""}</div>
        </Step>
        <Step k="source" label="Source">
          {source ? (
            <>
              {source.domain} · {source.title}{" "}
              <a href={source.url} target="_blank" rel="noreferrer">original ↗</a>
            </>
          ) : (
            c.source_id
          )}
        </Step>
        {read && (
          <Step k="read" label="Read">
            the agent opened this page because <i>{read.why}</i>
          </Step>
        )}
        <Step k="search" label="Found by">
          {search ? (
            <>
              search “{search.query}” because <i>{search.why}</i>
              {search.reflection && <details><summary className="muted">model reasoning</summary>{search.reflection}</details>}
            </>
          ) : (
            <span className="muted">no search in this direction returned it (read directly or found by another direction)</span>
          )}
        </Step>
        <Step k="direction" label="Direction">
          {node?.title ?? node?.label}
          {node?.why && <div className="muted">planned because {node.why}</div>}
          {run.stop_reasons[c.node_id] && <div className="muted">stopped: {run.stop_reasons[c.node_id]}</div>}
        </Step>
      </ol>
      {links.length > 0 && (
        <div className="muted">
          {links.map((l, i) => (
            <div key={i} className={`link-${l.relation}`}>
              {l.relation === "corroborates" ? "↔ corroborated with" : "⚡ contradicted by / contradicts"}{" "}
              <button className="cite" onClick={() => openClaim(l.other)}>[c{claimNumber(l.other)}]</button>
              {run.claims[l.other] && run.claims[l.other].node_id !== c.node_id ? ` (in ${run.nodes[run.claims[l.other].node_id]?.label})` : ""}
              {l.reason ? `: ${l.reason}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Ledger ---------- */

function Ledger() {
  const run = useStore((s) => s.run);
  const { openSource, openClaim } = useStore.getState();
  const groups = originGroups(run);
  const entries = Object.entries(groups);
  if (entries.length === 0) return <p className="muted pad">No sources yet.</p>;
  const claims = Object.values(run.claims);
  const used = claims.filter((c) => claimUsage(run, c).state === "used").length;
  return (
    <div className="pad">
      <h3>Evidence ledger</h3>
      <p className="muted">
        {Object.keys(run.sources).length} sources · {entries.length} independent origins · {claims.length} claims · {used} used in the answer
      </p>
      {entries.map(([origin, srcs]) => (
        <div key={origin} className="item">
          <div>
            <code>{origin}</code> <span className="muted">{srcs.length > 1 ? `${srcs.length} sources collapse to one origin` : ""}</span>
          </div>
          {srcs.map((s) => {
            const u = sourceUsage(run, s);
            return (
              <div key={s.id} className="clickable" onClick={() => openSource(s.id)}>
                <span className={`use use-${u.state}`}>{u.state === "used" ? "●" : "○"}</span> {s.domain} <span className="muted">· {s.title}</span>
                <div className="chips">
                  {u.claims.map((c) => (
                    <button key={c.id} className={`cite ${claimUsage(run, c).state}`} onClick={(e) => { e.stopPropagation(); openClaim(c.id); }}>
                      [c{claimNumber(c.id)}]
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------- Playground (mock only) ---------- */

function Playground() {
  const run = useStore((s) => s.run);
  const { selectedId } = useStore((s) => s.ui);
  const { ask } = useStore.getState();
  const sim = transport.simulate!;
  const n = selectedId ? run.nodes[selectedId] : undefined;
  const dir = n?.kind === "direction";
  const target = n ? `“${n.label}”` : "the root question";
  const prompts = ["Summarise the findings", "How sure are we?", "How many sources and origins?", "Look into something new about supplier insurance"];
  return (
    <div className="pad">
      <h3>Playground</h3>
      <p className="muted">Mock backend only. Select a node in the graph, then poke it. Everything here goes through the same event stream the real backend will use.</p>
      <h4>On {target}</h4>
      <div className="actions">
        <button onClick={() => sim("add_branch", selectedId ?? "q")}>+ Branch</button>
        <button disabled={!dir} onClick={() => sim("add_evidence", selectedId!)}>+ Evidence</button>
        <button disabled={!dir} onClick={() => sim("contradict", selectedId!)}>Contradict</button>
        <button disabled={!n} onClick={() => sim("mark_stale", selectedId!)}>Mark stale</button>
        <button onClick={() => sim("needs_you", selectedId ?? "q")}>Needs you</button>
      </div>
      <p className="muted">+ Evidence and Contradict need a sub-question (a direction) selected.</p>
      <h4>Run</h4>
      <div className="actions">
        <button onClick={() => sim("skip_to_end")}>Skip to end of run</button>
      </div>
      <h4>Chat prompts (pinned to {target})</h4>
      {prompts.map((p) => (
        <div key={p} className="item clickable" onClick={() => void ask(p)}>{p}</div>
      ))}
      <p className="muted">Or type anything in the chat box. It answers from the claims already in the graph, or opens a branch with an invented, traceable claim.</p>
    </div>
  );
}
